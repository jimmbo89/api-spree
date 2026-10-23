'use strict';

const { Op } = require('sequelize');
const { v4: uuidv4 } = require('uuid');
const {
  Product,
  ProductVariant,
  ProductMarketplaceLink,
  ProductPublishingTask,
  Warehouse,
  Branch,
  PoolWarehouse,
  WarehouseProduct,
  WarehouseProductVariant,
  MarketplacePreviewItem,
  MarketplaceImportItem,
  MarketplaceOrderItem,
  User,
  sequelize
} = require('../models');
const {
  MarketplaceImportRepository,
  MarketplacePreviewRepository,
  ProductMarketplaceLinkRepository,
  ProductPublishingTaskRepository,
  WarehouseRepository,
  UserAclScopeRepository,
  InventoryMovementRepository
} = require('../repositories');
const MarketplacePreviewService = require('./MarketplacePreviewService');
const MarketplaceImageService = require('./MarketplaceImageService');
const AuditEventService = require('./AuditEventService');
const logger = require('../../config/logger');

const TERMINAL_STATUSES = new Set(['completed', 'completed_with_errors', 'failed', 'cancelled']);
const IMPORTABLE_PREVIEW_STATUSES = new Set(['completed', 'completed_with_errors']);
const IMPORT_AUDIT_MODULE = 'marketplace_import';
const PRODUCT_FIELDS = [
  'sku', 'name', 'description', 'brand', 'model', 'condition', 'gtin', 'mpn',
  'attributes', 'warranty_months', 'warranty_text', 'weight_grams', 'length_cm',
  'width_cm', 'height_cm', 'product_measurements', 'packaging_measurements',
  'category_id', 'sale_price', 'state'
];
const PRODUCT_AUDIT_FIELDS = [...PRODUCT_FIELDS, 'purchase_price', 'images'];
const WAREHOUSE_PRODUCT_AUDIT_FIELDS = ['active', 'code', 'minimum_stock'];
const WAREHOUSE_VARIANT_AUDIT_FIELDS = [
  'price', 'purchase_price', 'promotional_price', 'stock', 'local_sku', 'active', 'published'
];

function plain(value) {
  return value && typeof value.get === 'function' ? value.get({ plain: true }) : value;
}

function snapshot(value) {
  if (value === null || value === undefined) return null;
  const raw = typeof value.toJSON === 'function' ? value.toJSON() : plain(value);
  if (raw === null || raw === undefined) return raw;
  try {
    return JSON.parse(JSON.stringify(raw));
  } catch (error) {
    return raw;
  }
}

function auditChanges(previous, current, fields) {
  const before = previous || {};
  const after = current || {};
  return fields.reduce((changes, field) => {
    const oldValue = before[field] ?? null;
    const newValue = after[field] ?? null;
    if (JSON.stringify(oldValue) === JSON.stringify(newValue)) return changes;
    changes.push({ field, old_value: oldValue, new_value: newValue });
    return changes;
  }, []);
}

function auditSnapshot(changes, key) {
  return changes.reduce((result, change) => {
    result[change.field] = change[key];
    return result;
  }, {});
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function integerOrNull(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function normalizeSku(value) {
  const sku = String(value || '').trim();
  return sku || null;
}

function errorObject(error) {
  return {
    code: error?.code || 'marketplace_import_error',
    message: error?.message || 'No se pudo importar el producto'
  };
}

function throwImportError(code, message, statusCode = 422) {
  const error = new Error(message || code);
  error.code = code;
  error.statusCode = statusCode;
  throw error;
}

function sourceData(previewItem) {
  return previewItem?.data && typeof previewItem.data === 'object' ? previewItem.data : {};
}

function objectValue(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    return {};
  }
}

function externalPrice(data) {
  return numberOrNull(data.sale_price ?? data.price);
}

function externalImages(data) {
  return Array.isArray(data.images) ? data.images : [];
}

function productOverrides(payload) {
  if (payload?.product && typeof payload.product === 'object') return payload.product;
  return {};
}

function compactPublishedPayload(previewItem, data, importedAt) {
  const payload = {
    origin: 'imported',
    imported_at: importedAt,
    external_id: previewItem.external_id,
    external_variant_id: previewItem.external_variant_id || null,
    sku: previewItem.sku || null,
    price: externalPrice(data),
    stock: numberOrNull(data.stock),
    published_stock: numberOrNull(data.stock),
    status: data.status || null,
    external_url: data.permalink || data.url || null,
    source: data.source || null
  };

  if (data.source !== 'falabella') return payload;

  const imageUrls = externalImages(data)
    .map(image => typeof image === 'string' ? image : image?.url)
    .filter(Boolean);

  return {
    ...payload,
    ShopSku: data.shop_sku || previewItem.external_id || null,
    SellerSku: data.seller_sku || data.sku || previewItem.sku || null,
    Url: data.url || data.permalink || null,
    MainImage: data.main_image || imageUrls[0] || null,
    ...(imageUrls.length ? { Images: imageUrls } : {}),
    QCStatus: data.qc_status || null,
    product_errors: Array.isArray(data.errors) ? data.errors : [],
    BusinessUnits: {
      BusinessUnit: {
        Status: data.status || null,
        IsPublished: data.is_published ?? null,
        QCStatus: data.qc_status || null,
        Price: numberOrNull(data.price),
        SpecialPrice: numberOrNull(data.sale_price),
        Stock: numberOrNull(data.stock)
      }
    }
  };
}

function userAction(input, previewItem) {
  if (input.action) return input.action;
  return ['existing', 'linked'].includes(previewItem.status) ? 'update' : 'create';
}

function isGlobalUser(user) {
  return Boolean(user?.role_id);
}

function accessError(message) {
  const error = new Error(message);
  error.statusCode = 403;
  error.code = 'marketplace_import_warehouse_forbidden';
  return error;
}

class MarketplaceImportService {
  static publicOperation(operation) {
    const value = plain(operation) || {};
    return {
      id: value.id,
      preview_id: value.preview_operation_id,
      company_id: value.company_id,
      credential_id: value.credential_id,
      marketplace_id: value.marketplace_id,
      status: value.status,
      phase: value.phase,
      total: value.total,
      processed: value.processed,
      success_count: value.success_count,
      error_count: value.error_count,
      skipped_count: value.skipped_count,
      cancel_requested: Boolean(value.cancel_requested),
      expires_at: value.expires_at,
      started_at: value.started_at,
      completed_at: value.completed_at,
      last_error: value.last_error || null,
      created_at: value.createdAt,
      updated_at: value.updatedAt
    };
  }

  static publicItem(item) {
    const value = plain(item) || {};
    return {
      id: value.id,
      preview_item_id: value.preview_item_id,
      action: value.action,
      status: value.status,
      product_id: value.product_id,
      link_id: value.link_id,
      result: value.result || null,
      error: value.error || null,
      started_at: value.started_at,
      completed_at: value.completed_at
    };
  }

  static auditActor({ operation, workerId, user }) {
    if (workerId) {
      return {
        actor_type: AuditEventService.ACTOR_TYPES.AUTOMATIC_PROCESS,
        actor_id: String(workerId),
        actor_name: 'MarketplaceImportWorker'
      };
    }
    if (user?.id || operation?.user_id) {
      const id = user?.id || operation.user_id;
      return {
        actor_type: AuditEventService.ACTOR_TYPES.USER,
        actor_id: String(id),
        actor_name: user?.name || user?.email || `Usuario ${id}`
      };
    }
    return AuditEventService.systemActor('Spree');
  }

  static async auditOperation({ operation, action, result, description, metadata = {}, user = null, workerId = null, dedupeKey = null, requestMetadata = {} }) {
    return AuditEventService.safeRecord({
      ...this.auditActor({ operation, user, workerId }),
      company_id: operation.company_id,
      module: IMPORT_AUDIT_MODULE,
      action,
      result,
      resource_type: 'marketplace_import_operation',
      resource_id: operation.id,
      resource_label: `Importación de publicaciones ${operation.id}`,
      marketplace_id: operation.marketplace_id,
      marketplace_credential_id: operation.credential_id,
      correlation_id: operation.id,
      dedupe_key: dedupeKey,
      ip_address: requestMetadata.ip_address || null,
      user_agent: requestMetadata.user_agent || null,
      description,
      metadata: {
        operation_id: operation.id,
        preview_operation_id: operation.preview_operation_id,
        ...metadata
      }
    });
  }

  static async auditItem({ operation, item, action, result, description, metadata = {}, workerId = null }) {
    const value = plain(item) || {};
    return AuditEventService.safeRecord({
      ...this.auditActor({ operation, workerId }),
      company_id: operation.company_id,
      module: IMPORT_AUDIT_MODULE,
      action,
      result,
      resource_type: 'marketplace_import_item',
      resource_id: value.id,
      resource_label: `Importación de publicación ${value.preview_item_id}`,
      related_resource_type: 'marketplace_import_operation',
      related_resource_id: operation.id,
      marketplace_id: operation.marketplace_id,
      marketplace_credential_id: operation.credential_id,
      correlation_id: operation.id,
      description,
      metadata: {
        operation_id: operation.id,
        import_item_id: value.id,
        preview_item_id: value.preview_item_id,
        action: value.action,
        status: value.status,
        product_id: value.product_id,
        link_id: value.link_id,
        ...metadata
      }
    });
  }

  static async auditFunctionalEvent({
    operation,
    importItem,
    previewItem,
    transaction,
    module,
    action,
    result = AuditEventService.RESULTS.SUCCESS,
    resourceType,
    resourceId,
    resourceLabel,
    relatedResourceType = null,
    relatedResourceId = null,
    warehouseId = null,
    branchId = null,
    previousValue = null,
    newValue = null,
    changes = [],
    description,
    metadata = {},
    dedupeSuffix
  }) {
    const itemValue = plain(importItem) || {};
    const previewValue = plain(previewItem) || {};
    const externalId = previewValue.external_id || null;
    const actorId = operation.user_id != null ? String(operation.user_id) : null;

    const auditEvent = await AuditEventService.safeRecord({
      actor_type: actorId
        ? AuditEventService.ACTOR_TYPES.USER
        : AuditEventService.ACTOR_TYPES.SYSTEM,
      actor_id: actorId,
      actor_name: actorId ? `Usuario ${actorId}` : 'Spree',
      company_id: operation.company_id,
      module,
      action,
      result,
      resource_type: resourceType,
      resource_id: resourceId,
      resource_label: resourceLabel || null,
      related_resource_type: relatedResourceType,
      related_resource_id: relatedResourceId,
      marketplace_id: operation.marketplace_id,
      marketplace_credential_id: operation.credential_id,
      warehouse_id: warehouseId,
      branch_id: branchId,
      correlation_id: operation.id,
      previous_value: previousValue,
      new_value: newValue,
      changes,
      description,
      dedupe_key: `marketplace_import:${operation.id}:item:${itemValue.id || 'unknown'}:${dedupeSuffix || action}`,
      metadata: {
        source: 'marketplace_import',
        import_operation_id: operation.id,
        import_item_id: itemValue.id || null,
        preview_item_id: itemValue.preview_item_id || previewValue.id || null,
        external_id: externalId,
        external_variant_id: previewValue.external_variant_id || null,
        initiated_by_user_id: operation.user_id || null,
        ...metadata
      }
    }, { transaction });
    if (auditEvent) {
      logger.info(
        `[MarketplaceImportService] Auditoría funcional creada action=${action} ` +
        `event_id=${auditEvent.id} resource_type=${resourceType} resource_id=${resourceId}`
      );
    } else {
      logger.warn(
        `[MarketplaceImportService] No se pudo crear auditoría funcional action=${action} ` +
        `resource_type=${resourceType} resource_id=${resourceId}`
      );
    }
    return auditEvent;
  }

  static async getOperation({ operationId, companyId, user }) {
    const operation = await MarketplaceImportRepository.findOperation(operationId);
    if (!operation) throwImportError('marketplace_import_not_found', 'La operación de importación no existe', 404);

    if (!isGlobalUser(user) && Number(operation.company_id) !== Number(companyId)) {
      throwImportError('marketplace_import_forbidden', 'No tienes acceso a esta operación', 403);
    }

    await MarketplacePreviewService.authorizeCredential({
      credentialId: operation.credential_id,
      companyId: operation.company_id,
      user
    });
    return operation;
  }

  static async start({ previewId, companyId, user, items, requestMetadata = {} }) {
    const preview = await MarketplacePreviewService.getOperation({ operationId: previewId, companyId, user });
    if (!IMPORTABLE_PREVIEW_STATUSES.has(preview.status)) {
      throwImportError('marketplace_preview_not_ready_for_import', 'La vista previa todavía no está lista para importar', 409);
    }

    const requestedIds = [...new Set(items.map(item => Number(item.item_id)))];
    if (requestedIds.length !== items.length) {
      throwImportError('duplicate_preview_items', 'La lista contiene publicaciones repetidas', 400);
    }
    const previewItems = await MarketplacePreviewItem.findAll({
      where: { operation_id: preview.id, id: { [Op.in]: requestedIds } }
    });
    if (previewItems.length !== requestedIds.length) {
      throwImportError('marketplace_preview_item_not_found', 'Una o más publicaciones no pertenecen a la vista previa indicada', 404);
    }

    const byId = new Map(previewItems.map(item => [Number(item.id), item]));
    const now = new Date();
    const ttlHours = Math.max(Number(process.env.MARKETPLACE_IMPORT_TTL_HOURS) || 24, 1);
    const operation = await MarketplaceImportRepository.createOperation({
      id: uuidv4(),
      preview_operation_id: preview.id,
      company_id: preview.company_id,
      user_id: user.id,
      credential_id: preview.credential_id,
      marketplace_id: preview.marketplace_id,
      status: 'queued',
      phase: 'queued',
      total: requestedIds.length,
      expires_at: new Date(now.getTime() + ttlHours * 60 * 60 * 1000)
    });

    const rows = items.map(input => {
      const previewItem = byId.get(Number(input.item_id));
      return {
        operation_id: operation.id,
        preview_item_id: previewItem.id,
        action: userAction(input, previewItem),
        payload: {
          product: input.product || {},
          ...(hasOwn(input, 'purchase_price') ? { purchase_price: input.purchase_price } : {}),
          ...(hasOwn(input, 'warehouses') ? { warehouses: input.warehouses } : {}),
          ...(hasOwn(input, 'inventory') ? { inventory: input.inventory } : {})
        },
        status: input.action === 'skip' ? 'skipped' : 'queued',
        result: input.action === 'skip' ? { reason: 'user_skipped' } : null,
        completed_at: input.action === 'skip' ? now : null
      };
    });
    await MarketplaceImportRepository.createItems(rows);

    const skippedCount = rows.filter(row => row.status === 'skipped').length;
    const current = skippedCount
      ? await MarketplaceImportRepository.updateOperation(operation.id, {
        processed: skippedCount,
        skipped_count: skippedCount
      })
      : operation;

    await this.auditOperation({
      operation: current || operation,
      action: 'marketplace_import.started',
      result: AuditEventService.RESULTS.PENDING,
      description: 'Importación de publicaciones confirmada por el usuario',
      user,
      requestMetadata,
      dedupeKey: `marketplace_import:${operation.id}:started`,
      metadata: { requested_items: requestedIds.length, skipped_count: skippedCount }
    });
    return this.publicOperation(current || operation);
  }

  static async status({ operationId, companyId, user }) {
    return this.publicOperation(await this.getOperation({ operationId, companyId, user }));
  }

  static async items({ operationId, companyId, user, cursor, limit }) {
    await this.getOperation({ operationId, companyId, user });
    const result = await MarketplaceImportRepository.listItems({ operationId, cursor, limit });
    return {
      items: result.items.map(item => this.publicItem(item)),
      has_more: result.hasMore,
      next_cursor: result.nextCursor
    };
  }

  static async cancel({ operationId, companyId, user }) {
    const previous = await this.getOperation({ operationId, companyId, user });
    const operation = await MarketplaceImportRepository.requestCancel(operationId);
    await this.auditOperation({
      operation: operation || previous,
      action: 'marketplace_import.cancel_requested',
      result: AuditEventService.RESULTS.PENDING,
      description: 'Cancelación de importación solicitada',
      user,
      dedupeKey: `marketplace_import:${operationId}:cancel_requested`,
      metadata: { previous_status: previous.status }
    });
    return this.publicOperation(operation || previous);
  }

  static async run(operationId, workerId) {
    const operation = await MarketplaceImportRepository.findOperation(operationId);
    if (!operation || TERMINAL_STATUSES.has(operation.status)) return;

    const leaseMs = Math.max(Number(process.env.MARKETPLACE_IMPORT_LEASE_MS) || 120000, 30000);
    await MarketplaceImportRepository.resetProcessingItems(operationId);
    const heartbeat = setInterval(() => {
      MarketplaceImportRepository.updateOperation(operationId, {
        worker_id: workerId,
        lease_until: new Date(Date.now() + leaseMs)
      }).catch(() => null);
    }, Math.floor(leaseMs / 3));

    let processed = Number(operation.processed) || 0;
    let successCount = Number(operation.success_count) || 0;
    let errorCount = Number(operation.error_count) || 0;
    let skippedCount = Number(operation.skipped_count) || 0;

    try {
      const queuedItems = await MarketplaceImportRepository.listQueuedItems(operationId);
      for (const item of queuedItems) {
        const current = await MarketplaceImportRepository.findOperation(operationId);
        if (current?.cancel_requested) {
          await MarketplaceImportRepository.updateOperation(operationId, {
            status: 'cancelled', phase: 'cancelled', completed_at: new Date(), lease_until: null,
            processed, success_count: successCount, error_count: errorCount, skipped_count: skippedCount
          });
          await this.auditOperation({
            operation: current,
            action: 'marketplace_import.cancelled',
            result: AuditEventService.RESULTS.SUCCESS,
            description: 'Importación cancelada',
            workerId,
            dedupeKey: `marketplace_import:${operationId}:cancelled`,
            metadata: { processed, success_count: successCount, error_count: errorCount, skipped_count: skippedCount }
          });
          return;
        }

        const started = await MarketplaceImportRepository.updateItem({
          operationId,
          itemId: item.id,
          values: { status: 'processing', started_at: new Date(), error: null }
        });

        try {
          const result = item.action === 'skip'
            ? { status: 'skipped', result: { reason: 'user_skipped' } }
            : await this.processItem({ operation, importItem: item });
          const finished = await MarketplaceImportRepository.updateItem({
            operationId,
            itemId: item.id,
            values: {
              status: result.status,
              product_id: result.product_id || null,
              link_id: result.link_id || null,
              result: result.result || null,
              error: null,
              completed_at: new Date()
            }
          });

          processed += 1;
          if (result.status === 'skipped') skippedCount += 1;
          else successCount += 1;
          await this.auditItem({
            operation,
            item: finished || started,
            action: 'marketplace_import.item_processed',
            result: result.status === 'skipped' ? AuditEventService.RESULTS.WARNING : AuditEventService.RESULTS.SUCCESS,
            description: result.status === 'skipped' ? 'Publicación omitida' : 'Publicación importada correctamente',
            workerId,
            metadata: result.result || {}
          });
        } catch (error) {
          const failed = await MarketplaceImportRepository.updateItem({
            operationId,
            itemId: item.id,
            values: { status: 'failed', error: errorObject(error), completed_at: new Date() }
          });
          processed += 1;
          errorCount += 1;
          await this.auditItem({
            operation,
            item: failed || started,
            action: 'marketplace_import.item_failed',
            result: AuditEventService.RESULTS.ERROR,
            description: 'Publicación no importada',
            workerId,
            metadata: { error: errorObject(error) }
          });
          logger.error(`[MarketplaceImportService] Item ${item.id} falló: ${error.message}`);
        }

        await MarketplaceImportRepository.updateOperation(operationId, {
          processed,
          success_count: successCount,
          error_count: errorCount,
          skipped_count: skippedCount,
          phase: 'processing'
        });
      }

      const finalStatus = errorCount > 0 ? 'completed_with_errors' : 'completed';
      const completed = await MarketplaceImportRepository.updateOperation(operationId, {
        status: finalStatus,
        phase: 'completed',
        processed,
        success_count: successCount,
        error_count: errorCount,
        skipped_count: skippedCount,
        completed_at: new Date(),
        lease_until: null
      });
      await this.auditOperation({
        operation: completed || operation,
        action: 'marketplace_import.completed',
        result: errorCount > 0 ? AuditEventService.RESULTS.WARNING : AuditEventService.RESULTS.SUCCESS,
        description: errorCount > 0 ? 'Importación completada con errores parciales' : 'Importación completada correctamente',
        workerId,
        dedupeKey: `marketplace_import:${operationId}:${finalStatus}`,
        metadata: { processed, success_count: successCount, error_count: errorCount, skipped_count: skippedCount }
      });
    } catch (error) {
      await MarketplaceImportRepository.updateOperation(operationId, {
        status: 'failed', phase: 'failed', last_error: errorObject(error), completed_at: new Date(), lease_until: null
      }).catch(() => null);
      await this.auditOperation({
        operation,
        action: 'marketplace_import.failed',
        result: AuditEventService.RESULTS.ERROR,
        description: 'Importación fallida',
        workerId,
        dedupeKey: `marketplace_import:${operationId}:failed`,
        metadata: { error: errorObject(error) }
      });
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
  }

  static async processItem({ operation, importItem }) {
    const previewItem = await MarketplacePreviewRepository.findItem({
      operationId: operation.preview_operation_id,
      itemId: importItem.preview_item_id
    });
    if (!previewItem) throwImportError('marketplace_preview_item_not_found', 'La publicación de la vista previa ya no existe', 404);

    const data = sourceData(previewItem);
    if (!previewItem.external_id) throwImportError('external_id_missing', 'La publicación no tiene identificador externo');
    if (data.composition?.status === 'explicit_composite') {
      throwImportError('external_composite_product', 'Los packs o kits no son importables en esta versión');
    }

    const payload = importItem.payload || {};
    const overrides = productOverrides(payload);
    const action = importItem.action;
    const externalVariantId = previewItem.external_variant_id || null;
    const existingLink = await this.findLink({
      operation,
      externalId: previewItem.external_id,
      externalVariantId
    });
    const existingLinkBefore = snapshot(existingLink);

    if (existingLink && action === 'create') {
      return {
        status: 'skipped',
        product_id: existingLink.product_id,
        link_id: existingLink.id,
        result: { reason: 'already_imported', existing_link_id: existingLink.id }
      };
    }

    const transaction = await sequelize.transaction();
    const createdImagePaths = [];
    try {
      const siblingProductId = await this.findSiblingProductId({ operation, previewItem, importItem });
      let product = await this.resolveProduct({
        operation,
        previewItem,
        data,
        overrides,
        existingLink,
        action,
        siblingProductId,
        transaction
      });
      const productBefore = snapshot(product);
      const isNew = !product;
      const productData = this.buildProductData({ product, previewItem, data, overrides, payload, isNew });

      if (!isNew && productData.sku && String(productData.sku) !== String(product.sku)) {
        const duplicateSku = await Product.findOne({
          where: {
            company_id: operation.company_id,
            sku: productData.sku,
            id: { [Op.ne]: product.id }
          },
          transaction
        });
        if (duplicateSku) throwImportError('product_sku_already_exists', 'El nuevo SKU ya existe en la empresa');
      }

      if (isNew) {
        product = await Product.create({
          ...productData,
          company_id: operation.company_id,
          user_id: operation.user_id,
          purchase_price: productData.purchase_price,
          images: []
        }, { transaction });
      } else if (Object.keys(productData).length > 0) {
        await product.update(productData, { transaction });
      }

      const imageSelection = this.imageSelection({ isNew, data, overrides, product });
      if (imageSelection) {
        const materialized = await MarketplaceImageService.materialize({
          images: imageSelection,
          productId: product.id
        });
        createdImagePaths.push(...materialized.createdPaths);
        await product.update({ images: materialized.paths }, { transaction });
      }

      const productAfter = snapshot(product);
      const productChanges = auditChanges(productBefore, productAfter, PRODUCT_AUDIT_FIELDS);
      if (isNew || productChanges.length > 0) {
        await this.auditFunctionalEvent({
          operation,
          importItem,
          previewItem,
          transaction,
          module: 'product',
          action: isNew ? 'product.created' : 'product.updated',
          resourceType: 'product',
          resourceId: product.id,
          resourceLabel: [productAfter?.sku, productAfter?.name].filter(Boolean).join(' / ') || 'Producto sin nombre',
          previousValue: isNew ? null : auditSnapshot(productChanges, 'old_value'),
          newValue: isNew ? productAfter : auditSnapshot(productChanges, 'new_value'),
          changes: productChanges,
          description: isNew
            ? `Producto creado por importación: ${productAfter?.name || productAfter?.sku || product.id}`
            : `Producto actualizado por importación: ${productAfter?.name || productAfter?.sku || product.id}`,
          metadata: {
            sku: productAfter?.sku || null,
            producto: [productAfter?.sku, productAfter?.name].filter(Boolean).join(' / ') || null,
            action: isNew ? 'create' : 'update',
            fields_changed: productChanges.map(change => change.field)
          },
          dedupeSuffix: isNew ? 'product_created' : 'product_updated'
        });
      }

      const variantResult = await this.ensureVariant({
        product,
        previewItem,
        data,
        transaction,
        isNew
      });
      const variant = variantResult.variant;
      if (variantResult.created) {
        const variantSnapshot = snapshot(variant);
        const variantChanges = auditChanges(null, variantSnapshot, ['sku', 'attributes']);
        await this.auditFunctionalEvent({
          operation,
          importItem,
          previewItem,
          transaction,
          module: 'product',
          action: 'product.variant_created',
          resourceType: 'product',
          resourceId: product.id,
          resourceLabel: [productAfter?.sku, productAfter?.name].filter(Boolean).join(' / ') || 'Producto sin nombre',
          relatedResourceType: 'product_variant',
          relatedResourceId: variant.id,
          newValue: variantSnapshot,
          changes: variantChanges,
          description: `Variante creada por importación: ${variantSnapshot?.sku || variant.id}`,
          metadata: {
            variant_id: variant.id,
            variant_sku: variantSnapshot?.sku || null
          },
          dedupeSuffix: `variant_created:${variant.id}`
        });
      }
      const warehouseResult = await this.applyWarehouses({
        operation,
        product,
        variant,
        payload,
        isNew,
        transaction
      });
      await this.auditWarehouseResults({
        operation,
        importItem,
        previewItem,
        product,
        variant,
        warehouseEvents: warehouseResult.audit_events,
        transaction
      });
      const importedAt = new Date().toISOString();
      const link = await this.persistLink({
        operation,
        product,
        previewItem,
        data,
        externalVariantId,
        importedAt,
        existingLink,
        transaction
      });
      const publishingTask = await this.persistImportedPublishingTask({
        operation,
        product,
        previewItem,
        data,
        importedAt,
        transaction
      });
      await this.auditFunctionalEvent({
        operation,
        importItem,
        previewItem,
        transaction,
        module: 'published_product',
        action: existingLinkBefore ? 'published_product.synced' : 'published_product.created',
        resourceType: 'product_marketplace_publication',
        resourceId: publishingTask.id,
        resourceLabel: [productAfter?.sku, productAfter?.name, data.source]
          .filter(Boolean)
          .join(' / ') || 'Publicación de producto',
        relatedResourceType: 'product',
        relatedResourceId: product.id,
        previousValue: existingLinkBefore ? {
          external_id: existingLinkBefore.external_id,
          status: existingLinkBefore.status,
          published_stock: existingLinkBefore.published_stock,
          external_url: existingLinkBefore.external_url
        } : null,
        newValue: {
          status: data.status || 'published',
          external_id: previewItem.external_id,
          external_variant_id: externalVariantId,
          external_url: data.permalink || data.url || null,
          published_stock: numberOrNull(data.stock)
        },
        description: existingLinkBefore
          ? 'Publicación externa actualizada por importación'
          : 'Publicación externa importada y vinculada al producto',
        metadata: {
          link_id: link.id,
          publishing_task_id: publishingTask.id,
          source_marketplace: data.source || null,
          marketplace: data.source || null,
          producto: [productAfter?.sku, productAfter?.name].filter(Boolean).join(' / ') || null,
          precio_publicado: externalPrice(data),
          stock_publicado: numberOrNull(data.stock),
          estado_de_publicacion: data.status || null,
          product_id: product.id,
          variant_id: variant.id
        },
        dedupeSuffix: existingLinkBefore ? 'publication_synced' : 'publication_created'
      });
      const historicalItems = await this.linkHistoricalSales({
        operation,
        previewItem,
        product,
        variant,
        transaction
      });

      await transaction.commit();
      return {
        status: 'succeeded',
        product_id: product.id,
        link_id: link.id,
        result: {
          action: isNew ? 'created' : 'updated',
          product_id: product.id,
          variant_id: variant.id,
          link_id: link.id,
          publishing_task_id: publishingTask.id,
          warehouse_ids: warehouseResult.warehouse_ids,
          inventory_movements: warehouseResult.inventory_movements,
          historical_sales_linked: historicalItems,
          warnings: warehouseResult.warnings
        }
      };
    } catch (error) {
      await transaction.rollback();
      await MarketplaceImageService.remove(createdImagePaths);
      throw error;
    }
  }

  static buildProductData({ product, previewItem, data, overrides, payload, isNew }) {
    const external = {
      sku: normalizeSku(previewItem.sku),
      name: data.name || null,
      description: data.description ?? null,
      brand: data.brand || 'Generico',
      model: data.model ?? null,
      condition: data.condition || 'new',
      gtin: data.gtin ?? null,
      mpn: data.mpn ?? null,
      attributes: data.attributes ?? [],
      sale_price: externalPrice(data)
    };
    const values = {};
    if (isNew) {
      for (const field of PRODUCT_FIELDS) {
        if (external[field] !== undefined) values[field] = external[field];
      }
      values.purchase_price = 0;
    }

    if (!isNew) {
      for (const field of PRODUCT_FIELDS) {
        if (hasOwn(overrides, field)) values[field] = overrides[field];
      }
    } else {
      for (const field of PRODUCT_FIELDS) {
        if (hasOwn(overrides, field)) values[field] = overrides[field];
      }
    }

    if (hasOwn(payload, 'purchase_price')) values.purchase_price = payload.purchase_price;
    else if (hasOwn(overrides, 'purchase_price')) values.purchase_price = overrides.purchase_price;
    else if (!isNew) delete values.purchase_price;

    if (!isNew && product && hasOwn(values, 'sku')) {
      values.sku = normalizeSku(values.sku);
    }
    values.sku = normalizeSku(values.sku || product?.sku || previewItem.sku);
    values.name = String(values.name || product?.name || '').trim();
    if (!values.sku) throwImportError('sku_required', 'El SKU es requerido para importar la publicación');
    if (!values.name) throwImportError('name_required', 'El nombre es requerido para importar la publicación');
    if (isNew && values.purchase_price === undefined) values.purchase_price = 0;
    return values;
  }

  static imageSelection({ isNew, data, overrides, product }) {
    if (hasOwn(overrides, 'images')) return overrides.images;
    if (isNew) return externalImages(data);
    return null;
  }

  static async resolveProduct({ operation, previewItem, overrides, existingLink, action, siblingProductId, transaction }) {
    if (existingLink) {
      const linked = await Product.findOne({
        where: { id: existingLink.product_id, company_id: operation.company_id },
        transaction
      });
      if (!linked) throwImportError('linked_product_not_found', 'La publicación está vinculada a un producto que ya no pertenece a la empresa', 409);
      return linked;
    }

    if (action === 'create' && siblingProductId) {
      const sibling = await Product.findOne({
        where: { id: siblingProductId, company_id: operation.company_id },
        transaction
      });
      if (sibling) return sibling;
    }

    const comparison = sourceData(previewItem).comparison || {};
    if (action === 'update') {
      const targetId = integerOrNull(comparison.product_id);
      if (targetId) {
        const product = await Product.findOne({ where: { id: targetId, company_id: operation.company_id }, transaction });
        if (!product) throwImportError('product_company_mismatch', 'El producto seleccionado no pertenece a la empresa', 403);
        return product;
      }
      const originalSku = normalizeSku(previewItem.sku);
      if (originalSku) {
        const product = await Product.findOne({ where: { company_id: operation.company_id, sku: originalSku }, transaction });
        if (product) return product;
        const variant = await ProductVariant.findOne({
          where: { sku: originalSku },
          include: [{ model: Product, as: 'product', where: { company_id: operation.company_id } }],
          transaction
        });
        if (variant?.product) return variant.product;
      }
      throwImportError('product_to_update_not_found', 'No se encontró el producto existente a actualizar', 409);
    }

    const finalSku = normalizeSku(overrides.sku || previewItem.sku);
    if (finalSku) {
      const duplicate = await Product.findOne({ where: { company_id: operation.company_id, sku: finalSku }, transaction });
      if (duplicate) throwImportError('product_sku_already_exists', 'El SKU ya existe en la empresa; use la acción actualizar');
    }
    return null;
  }

  static async findSiblingProductId({ operation, previewItem, importItem }) {
    const siblings = await MarketplacePreviewItem.findAll({
      where: {
        operation_id: operation.preview_operation_id,
        external_id: String(previewItem.external_id),
        id: { [Op.ne]: previewItem.id }
      },
      attributes: ['id']
    });
    if (!siblings.length) return null;

    const siblingImport = await MarketplaceImportItem.findOne({
      where: {
        operation_id: operation.id,
        preview_item_id: { [Op.in]: siblings.map(sibling => sibling.id) },
        status: 'succeeded'
      },
      order: [['id', 'ASC']]
    });
    return integerOrNull(siblingImport?.result?.product_id || siblingImport?.product_id);
  }

  static async ensureVariant({ product, previewItem, data, transaction, isNew }) {
    const sourceSku = normalizeSku(previewItem.sku);
    const preferredSku = isNew ? product.sku : (sourceSku || product.sku);
    let variant = preferredSku
      ? await ProductVariant.findOne({ where: { product_id: product.id, sku: preferredSku }, transaction })
      : null;
    if (!variant && !isNew && preferredSku !== product.sku) {
      variant = await ProductVariant.findOne({ where: { product_id: product.id, sku: product.sku }, transaction });
    }
    if (variant) return { variant, created: false };

    const globalSkuMatch = await ProductVariant.findOne({ where: { sku: preferredSku }, transaction });
    if (globalSkuMatch && Number(globalSkuMatch.product_id) !== Number(product.id)) {
      throwImportError('variant_sku_already_exists', 'El SKU de variante ya pertenece a otro producto');
    }
    const createdVariant = await ProductVariant.create({
      product_id: product.id,
      sku: preferredSku || product.sku,
      attributes: data.selected_variation?.attributes || data.attributes || {}
    }, { transaction });
    return { variant: createdVariant, created: true };
  }

  static async findLink({ operation, externalId, externalVariantId }) {
    const where = {
      company_id: operation.company_id,
      marketplace_id: operation.marketplace_id,
      credential_id: operation.credential_id,
      external_id: String(externalId),
      external_variant_id: externalVariantId || null
    };
    return ProductMarketplaceLink.findOne({ where });
  }

  static async applyWarehouses({ operation, product, variant, payload, isNew, transaction }) {
    let entries;
    if (hasOwn(payload, 'warehouses')) entries = Array.isArray(payload.warehouses) ? payload.warehouses : [];
    else if (hasOwn(payload, 'inventory') && payload.inventory?.warehouse_id) entries = [payload.inventory];
    else if (isNew) {
      const defaultWarehouse = await Warehouse.findOne({
        where: { company_id: operation.company_id, branch_id: null, type: 'central', status: 'activo' },
        order: [['id', 'ASC']],
        transaction
      });
      entries = defaultWarehouse ? [{ warehouse_id: defaultWarehouse.id }] : [];
    } else entries = [];

    if (!entries.length) {
      return {
        warehouse_ids: [],
        inventory_movements: 0,
        warnings: isNew ? ['No existe un almacén central activo; el producto quedó sin asociación a almacén'] : [],
        audit_events: []
      };
    }

    const warehouseIds = [...new Set(entries.map(entry => Number(entry.warehouse_id)).filter(Number.isInteger))];
    const warehouses = await Warehouse.findAll({
      where: { id: { [Op.in]: warehouseIds } },
      include: [{ model: Branch, as: 'branch', attributes: ['company_id'], required: false }],
      transaction
    });
    if (warehouses.length !== warehouseIds.length) throwImportError('warehouse_not_found', 'Uno de los almacenes seleccionados no existe');

    await this.authorizeWarehouses({ operation, warehouses, userId: operation.user_id });
    const warehouseMap = new Map(warehouses.map(warehouse => [Number(warehouse.id), warehouse]));
    let inventoryMovements = 0;
    const warnings = [];
    const auditEvents = [];

    for (const entry of entries) {
      const warehouse = warehouseMap.get(Number(entry.warehouse_id));
      const existingWarehouseProduct = await WarehouseProduct.findOne({
        where: { product_id: product.id, warehouse_id: warehouse.id },
        transaction
      });
      const warehouseProductBefore = snapshot(existingWarehouseProduct);
      const warehouseProduct = existingWarehouseProduct || await WarehouseProduct.create({
        product_id: product.id,
        warehouse_id: warehouse.id,
        active: entry.active !== false,
        minimum_stock: entry.minimum_stock !== undefined ? entry.minimum_stock : 5,
        company_id: warehouse.company_id || operation.company_id,
        branch_id: warehouse.branch_id || null,
        user_id: operation.user_id
      }, { transaction });

      let warehouseVariant = await WarehouseProductVariant.findOne({
        where: { warehouse_product_id: warehouseProduct.id, variant_id: variant.id },
        order: [['createdAt', 'ASC']],
        transaction
      });
      const warehouseVariantBefore = snapshot(warehouseVariant);
      let warehouseVariantCreated = false;
      const stockProvided = hasOwn(entry, 'stock') || hasOwn(entry, 'quantity');
      if (!warehouseVariant) {
        warehouseVariant = await WarehouseProductVariant.create({
          warehouse_product_id: warehouseProduct.id,
          variant_id: variant.id,
          active: entry.active !== false,
          local_sku: variant.sku,
          price: entry.price !== undefined ? entry.price : (numberOrNull(product.sale_price) || 0),
          purchase_price: entry.purchase_price !== undefined
            ? entry.purchase_price
            : (numberOrNull(product.purchase_price) || 0),
          stock: 0
        }, { transaction });
        warehouseVariantCreated = true;
      } else {
        const updates = {};
        if (entry.price !== undefined) updates.price = entry.price;
        if (entry.purchase_price !== undefined) updates.purchase_price = entry.purchase_price;
        if (Object.keys(updates).length) await warehouseVariant.update(updates, { transaction });
      }

      const previous = Number(warehouseVariant.stock) || 0;
      let movement = null;
      let delta = 0;
      if (stockProvided) {
        const requested = integerOrNull(entry.stock ?? entry.quantity);
        if (requested === null || requested < 0) throwImportError('stock_invalid', 'La cantidad de inventario es inválida');
        const mode = entry.stock_operation || 'set';
        const after = mode === 'add' ? previous + requested : requested;
        if (after < 0) throwImportError('stock_negative', 'El inventario no puede quedar negativo');
        delta = after - previous;
        if (delta !== 0) {
          await warehouseVariant.update({ stock: after }, { transaction });
          movement = await InventoryMovementRepository.create({
            warehouse_id: warehouse.id,
            product_id: product.id,
            variant_id: variant.id,
            company_id: warehouse.company_id || operation.company_id,
            branch_id: warehouse.branch_id || null,
            user_id: operation.user_id,
            movement_type: isNew && previous === 0 && mode === 'set' ? 'initial_stock' : (delta > 0 ? 'entry' : 'exit'),
            quantity: Math.abs(delta),
            stock_before: previous,
            stock_after: after,
            unit_price: entry.price !== undefined ? entry.price : warehouseVariant.price,
            purchase_price: entry.purchase_price !== undefined ? entry.purchase_price : warehouseVariant.purchase_price,
            total_value: (Number(entry.purchase_price ?? warehouseVariant.purchase_price) || 0) * Math.abs(delta),
            reference_type: 'marketplace_import',
            reference_id: `${operation.id}:${product.id}`,
            reason: isNew ? 'Stock inicial de producto importado' : 'Ajuste de inventario de producto importado',
            meta: { import_operation_id: operation.id, warehouse_product_id: warehouseProduct.id, warehouse_product_variant_id: warehouseVariant.id }
          }, { transaction });
          inventoryMovements += 1;
        }
      }

      const warehouseProductAfter = snapshot(warehouseProduct);
      const warehouseVariantAfter = snapshot(warehouseVariant);
      const warehouseProductChanges = auditChanges(
        warehouseProductBefore,
        warehouseProductAfter,
        WAREHOUSE_PRODUCT_AUDIT_FIELDS
      );
      const warehouseVariantChanges = auditChanges(
        warehouseVariantBefore,
        warehouseVariantAfter,
        WAREHOUSE_VARIANT_AUDIT_FIELDS
      );
      if (!warehouseProductBefore || warehouseVariantCreated || warehouseProductChanges.length || warehouseVariantChanges.length) {
        auditEvents.push({
          warehouse: snapshot(warehouse),
          warehouse_product_before: warehouseProductBefore,
          warehouse_product_after: warehouseProductAfter,
          warehouse_variant_before: warehouseVariantBefore,
          warehouse_variant_after: warehouseVariantAfter,
          warehouse_product_changes: warehouseProductChanges,
          warehouse_variant_changes: warehouseVariantChanges,
          movement: snapshot(movement),
          delta,
          is_new_warehouse_product: !warehouseProductBefore,
          warehouse_variant_created: warehouseVariantCreated
        });
      }
    }

    return {
      warehouse_ids: warehouseIds,
      inventory_movements: inventoryMovements,
      warnings,
      audit_events: auditEvents
    };
  }

  static async auditWarehouseResults({ operation, importItem, previewItem, product, variant, warehouseEvents = [], transaction }) {
    const productSnapshot = snapshot(product) || {};
    const productLabel = [productSnapshot.sku, productSnapshot.name].filter(Boolean).join(' / ') || `Producto ${product.id}`;

    for (const event of warehouseEvents) {
      const warehouse = event.warehouse || {};
      const warehouseProductChanges = event.warehouse_product_changes || [];
      const warehouseVariantChanges = event.warehouse_variant_changes || [];
      const changes = [
        ...warehouseProductChanges,
        ...warehouseVariantChanges.map(change => ({
          ...change,
          field: `variant.${change.field}`
        }))
      ];
      const warehouseProductBefore = event.warehouse_product_before;
      const isNewAssociation = event.is_new_warehouse_product || event.warehouse_variant_created;
      const warehouseLabel = [warehouse.code, warehouse.name].filter(Boolean).join(' / ') || `Almacén ${warehouse.id}`;

      await this.auditFunctionalEvent({
        operation,
        importItem,
        previewItem,
        transaction,
        module: 'warehouse',
        action: isNewAssociation ? 'warehouse.product_added' : 'warehouse.product_config_updated',
        resourceType: 'warehouse',
        resourceId: warehouse.id,
        resourceLabel: warehouseLabel,
        relatedResourceType: 'product',
        relatedResourceId: product.id,
        warehouseId: warehouse.id,
        branchId: warehouse.branch_id || null,
        previousValue: warehouseProductBefore || event.warehouse_variant_before
          ? {
            warehouse_product: warehouseProductBefore,
            variant: event.warehouse_variant_before
          }
          : null,
        newValue: {
          warehouse_product: event.warehouse_product_after,
          variant: event.warehouse_variant_after
        },
        changes,
        description: isNewAssociation
          ? `Producto configurado en almacén por importación: ${productLabel}`
          : `Configuración de producto actualizada en almacén por importación: ${productLabel}`,
        metadata: {
          product_label: productLabel,
          warehouse_label: warehouseLabel,
          operation: isNewAssociation ? 'created' : 'updated',
          source: 'marketplace_import',
          product_id: product.id,
          variant_id: variant.id,
          warehouse_product_id: event.warehouse_product_after?.id || null,
          warehouse_product_variant_id: event.warehouse_variant_after?.id || null,
          inventory_movement_id: event.movement?.id || null,
          is_new_association: isNewAssociation
        },
        dedupeSuffix: `warehouse_config:${warehouse.id}`
      });

      const movement = event.movement;
      if (!movement?.id) continue;
      const movementAction = movement.movement_type === 'exit'
        ? 'warehouse.stock_exit'
        : movement.movement_type === 'entry' || movement.movement_type === 'initial_stock'
          ? 'warehouse.stock_entry'
          : 'warehouse.stock_adjustment';
      await this.auditFunctionalEvent({
        operation,
        importItem,
        previewItem,
        transaction,
        module: 'warehouse',
        action: movementAction,
        resourceType: 'warehouse',
        resourceId: warehouse.id,
        resourceLabel: warehouseLabel,
        relatedResourceType: 'inventory_movement',
        relatedResourceId: movement.id,
        warehouseId: warehouse.id,
        branchId: warehouse.branch_id || null,
        previousValue: { stock: movement.stock_before },
        newValue: { stock: movement.stock_after },
        changes: [{
          field: 'stock',
          old_value: movement.stock_before,
          new_value: movement.stock_after
        }],
        description: `${movementAction === 'warehouse.stock_exit' ? 'Salida' : 'Entrada'} de stock por importación: ${productLabel}`,
        metadata: {
          product_label: productLabel,
          warehouse_label: warehouseLabel,
          source: 'marketplace_import',
          product_id: product.id,
          variant_id: variant.id,
          quantity: movement.quantity,
          movement_type: movement.movement_type,
          reference_type: movement.reference_type,
          reference_id: movement.reference_id
        },
        dedupeSuffix: `stock_movement:${movement.id}`
      });
    }
  }

  static async authorizeWarehouses({ operation, warehouses, userId }) {
    for (const warehouse of warehouses) {
      const belongsToCompany = Number(warehouse.company_id) === Number(operation.company_id)
        || Number(warehouse.branch?.company_id) === Number(operation.company_id);
      if (!belongsToCompany) throw accessError('El almacén no pertenece a la empresa de la operación');
    }
    if (operation.user_id == null) return;
    const actor = await User.findByPk(userId, { attributes: ['role_id'] });
    if (actor?.role_id) return;
    const scopes = await UserAclScopeRepository.findByUserAndCompany(userId, operation.company_id);
    if (!scopes.length) return;
    const companyScope = scopes.some(scope => !scope.warehouse_id && !scope.pool_id);
    if (companyScope) return;
    const directIds = new Set(scopes.map(scope => Number(scope.warehouse_id)).filter(Boolean));
    const poolIds = scopes.map(scope => Number(scope.pool_id)).filter(Boolean);
    if (poolIds.length) {
      const poolRows = await PoolWarehouse.findAll({ where: { pool_id: { [Op.in]: poolIds } }, attributes: ['warehouse_id'] });
      poolRows.forEach(row => directIds.add(Number(row.warehouse_id)));
    }
    const unauthorized = warehouses.find(warehouse => !directIds.has(Number(warehouse.id)));
    if (unauthorized) throw accessError('No tienes acceso al almacén seleccionado');
  }

  static async persistLink({ operation, product, previewItem, data, externalVariantId, importedAt, existingLink, transaction }) {
    const payload = compactPublishedPayload(previewItem, data, importedAt);
    const linkData = {
      product_id: product.id,
      marketplace_id: operation.marketplace_id,
      credential_id: operation.credential_id,
      user_id: operation.user_id,
      company_id: operation.company_id,
      branch_id: null,
      status: data.status || 'published',
      external_id: String(previewItem.external_id),
      external_variant_id: externalVariantId,
      external_url: data.permalink || data.url || null,
      published_stock: numberOrNull(data.stock),
      published_payload: payload,
      last_synced_at: new Date()
    };
    if (existingLink) {
      await existingLink.update(linkData, { transaction });
      return existingLink;
    }
    return ProductMarketplaceLinkRepository.upsert(linkData, { transaction });
  }

  static async persistImportedPublishingTask({ operation, product, previewItem, data, importedAt, transaction }) {
    const externalId = String(previewItem.external_id);
    const taskWhere = {
      external_id: externalId,
      marketplace_id: operation.marketplace_id,
      credential_id: operation.credential_id,
      company_id: operation.company_id,
      branch_id: null
    };
    const existingTask = await ProductPublishingTask.findOne({
      where: taskWhere,
      order: [['createdAt', 'DESC'], ['id', 'DESC']],
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    const publishedPayload = compactPublishedPayload(previewItem, data, importedAt);
    const previousDetails = objectValue(existingTask?.error_details);
    const warnings = [
      ...(Array.isArray(data.errors) ? data.errors : []),
      ...(Array.isArray(data.image_errors) ? data.image_errors : [])
    ];
    const taskStatus = warnings.length ? 'published_with_warnings' : 'published';
    const taskData = {
      product_id: product.id,
      marketplace_id: operation.marketplace_id,
      warehouse_id: existingTask?.warehouse_id || null,
      branch_id: null,
      user_id: operation.user_id,
      company_id: operation.company_id,
      credential_id: operation.credential_id,
      date: new Date(importedAt),
      status: taskStatus,
      payload: publishedPayload,
      external_id: externalId,
      external_url: data.permalink || data.url || null,
      error_message: warnings.length ? 'Publicación importada con advertencias' : null,
      error_details: {
        ...previousDetails,
        source: 'marketplace_import',
        action: 'MarketplaceImport',
        import_operation_id: operation.id,
        preview_item_id: previewItem.id,
        external_variant_id: previewItem.external_variant_id || null,
        imported_at: importedAt,
        warnings: warnings.length ? warnings : null
      },
      api_response: publishedPayload,
      published_at: new Date(importedAt),
      batch_id: existingTask?.batch_id || null,
      attempt_count: existingTask?.attempt_count || 1
    };

    if (existingTask) {
      await existingTask.update(taskData, { transaction });
      logger.info(`[MarketplaceImportService] Tarea de publicación actualizada por importación task_id=${existingTask.id} external_id=${externalId}`);
      return existingTask;
    }

    const createdTask = await ProductPublishingTaskRepository.create(taskData, { transaction });
    logger.info(`[MarketplaceImportService] Tarea de publicación creada por importación task_id=${createdTask.id} external_id=${externalId}`);
    return createdTask;
  }

  static async linkHistoricalSales({ operation, previewItem, product, variant, transaction }) {
    const where = {
      company_id: operation.company_id,
      listing_id: String(previewItem.external_id)
    };
    if (previewItem.sku) where.sku = previewItem.sku;
    const [updated] = await MarketplaceOrderItem.update({
      product_id: product.id,
      variant_id: variant.id
    }, { where, transaction });
    return updated || 0;
  }
}

module.exports = MarketplaceImportService;
