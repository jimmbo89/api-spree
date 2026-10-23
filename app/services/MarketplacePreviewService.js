'use strict';

const { Op } = require('sequelize');
const { v4: uuidv4 } = require('uuid');
const {
  Product,
  ProductVariant,
  ProductMarketplaceLink
} = require('../models');
const {
  MarketplaceCredentialRepository,
  UserMarketplaceCredentialRepository,
  UserCompanyRepository,
  ProductRepository,
  MarketplacePreviewRepository
} = require('../repositories');
const {
  MercadoLibrePreviewReader,
  FalabellaPreviewReader,
  errorData
} = require('./MarketplacePreviewReaders');
const MarketplaceImageService = require('./MarketplaceImageService');
const AuditEventService = require('./AuditEventService');

const DEFAULT_OPTIONS = Object.freeze({
  page_size: 100,
  request_concurrency: 2,
  include_descriptions: true,
  include_prices: true,
  include_sale_price: true,
  include_user_products: true,
  include_family: true,
  include_family_members: true,
  include_stock: true,
  include_fulfillment: true
});

const TERMINAL_STATUSES = new Set(['completed', 'completed_with_errors', 'failed', 'cancelled']);

function plain(value) {
  return value && typeof value.get === 'function' ? value.get({ plain: true }) : value;
}

function normalizeSku(value) {
  const sku = String(value || '').trim();
  return sku || null;
}

function errorObject(error) {
  return errorData(error);
}

function isGlobalUser(user) {
  return Boolean(user?.role_id);
}

const PREVIEW_AUDIT_MODULE = 'marketplace_preview';

function requestAuditContext(requestMetadata = {}) {
  return {
    ip_address: requestMetadata.ip_address || null,
    user_agent: requestMetadata.user_agent || null
  };
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const result = new Array(values.length);
  let cursor = 0;
  const workers = Array.from({
    length: Math.max(1, Math.min(Number(concurrency) || 1, values.length || 1))
  }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      result[index] = await mapper(values[index], index);
    }
  });

  await Promise.all(workers);
  return result;
}

class MarketplacePreviewService {
  static mergeOptions(options = {}) {
    return {
      ...DEFAULT_OPTIONS,
      ...options,
      page_size: Math.min(Math.max(Number(options.page_size || DEFAULT_OPTIONS.page_size), 1), 100),
      request_concurrency: Math.min(Math.max(Number(options.request_concurrency || DEFAULT_OPTIONS.request_concurrency), 1), 4)
    };
  }

  static async authorizeCredential({ credentialId, companyId, user }) {
    const credential = await MarketplaceCredentialRepository.findById(credentialId);
    if (!credential) {
      const error = new Error('La conexión de marketplace no existe');
      error.statusCode = 404;
      error.code = 'marketplace_credential_not_found';
      throw error;
    }

    if (!credential.active) {
      const error = new Error('La conexión de marketplace está inactiva');
      error.statusCode = 409;
      error.code = 'marketplace_credential_inactive';
      throw error;
    }

    if (Number(credential.company_id) !== Number(companyId)) {
      const error = new Error('La conexión no pertenece a la empresa indicada');
      error.statusCode = 403;
      error.code = 'marketplace_credential_company_forbidden';
      throw error;
    }

    if (!isGlobalUser(user)) {
      const membership = await UserCompanyRepository.findByUserIdAndCompanyId(user?.id, companyId);
      if (!membership || Number(membership.status) !== 1) {
        const error = new Error('La membresía activa de la empresa es requerida');
        error.statusCode = 403;
        error.code = 'company_membership_inactive';
        throw error;
      }
    }

    if (!isGlobalUser(user) && Number(credential.user_id) !== Number(user?.id)) {
      const allowed = await UserMarketplaceCredentialRepository.hasActiveAccess({
        userId: user?.id,
        marketplaceCredentialId: credential.id,
        companyId
      });
      if (!allowed) {
        const error = new Error('No tienes acceso a esta conexión de marketplace');
        error.statusCode = 403;
        error.code = 'marketplace_credential_forbidden';
        throw error;
      }
    }

    return credential;
  }

  static readerFor(credential, companyId, userId) {
    const marketplace = credential.marketplace || {};
    const domain = String(marketplace.domain || '').toLowerCase();

    if (domain.includes('mercadolibre')) {
      return new MercadoLibrePreviewReader({ credential, companyId, userId });
    }

    if (Number(marketplace.id) === 4 || domain.includes('falabella')) {
      return new FalabellaPreviewReader({ credential, companyId, userId });
    }

    const error = new Error('El marketplace de esta conexión no soporta importación de publicaciones');
    error.statusCode = 422;
    error.code = 'marketplace_preview_not_supported';
    throw error;
  }

  static async start({ credentialId, companyId, user, options = {}, requestMetadata = {} }) {
    const credential = await this.authorizeCredential({ credentialId, companyId, user });
    const normalizedOptions = this.mergeOptions(options);
    const operationId = uuidv4();
    const now = new Date();
    const ttlHours = Math.max(Number(process.env.MARKETPLACE_PREVIEW_TTL_HOURS) || 6, 1);

    await this.readerFor(credential, companyId, user.id);

    const operation = await MarketplacePreviewRepository.createOperation({
      id: operationId,
      company_id: companyId,
      user_id: user.id,
      credential_id: credential.id,
      marketplace_id: credential.marketplace_id,
      status: 'queued',
      phase: 'queued',
      options: normalizedOptions,
      expires_at: new Date(now.getTime() + ttlHours * 60 * 60 * 1000)
    });

    await this.auditOperationEvent({
      operation,
      credential,
      action: 'marketplace_preview.started',
      result: AuditEventService.RESULTS.PENDING,
      user,
      requestMetadata,
      dedupeKey: `marketplace_preview:${operation.id}:started`,
      description: `Consulta de publicaciones iniciada para ${credential.marketplace?.name || credential.marketplace?.domain || 'marketplace'}`,
      metadata: {
        status: operation.status,
        phase: operation.phase,
        options: normalizedOptions
      }
    });

    return this.publicOperation(operation);
  }

  static publicOperation(operation) {
    const value = plain(operation) || {};
    return {
      id: value.id,
      company_id: value.company_id,
      credential_id: value.credential_id,
      marketplace_id: value.marketplace_id,
      status: value.status,
      phase: value.phase,
      total: value.total,
      processed: value.processed,
      success_count: value.success_count,
      error_count: value.error_count,
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
      sequence: value.sequence,
      external_id: value.external_id,
      external_variant_id: value.external_variant_id,
      sku: value.sku,
      status: value.status,
      detail_status: value.data?.detail_status || 'base',
      detail_loaded_at: value.data?.detail_loaded_at || null,
      data: value.data,
      error: value.error,
      source_payload: value.source_payload,
      fetched_at: value.fetched_at
    };
  }

  static auditActor({ operation, user, workerId }) {
    if (workerId) {
      return {
        actor_type: AuditEventService.ACTOR_TYPES.AUTOMATIC_PROCESS,
        actor_id: String(workerId),
        actor_name: 'MarketplacePreviewWorker'
      };
    }

    const actorId = user?.id || operation?.user_id;
    if (actorId) {
      return {
        actor_type: AuditEventService.ACTOR_TYPES.USER,
        actor_id: String(actorId),
        actor_name: user?.name || user?.email || `Usuario ${actorId}`
      };
    }

    return AuditEventService.systemActor('Spree');
  }

  static async auditOperationEvent({
    operation,
    credential = null,
    action,
    result,
    description,
    metadata = {},
    user = null,
    workerId = null,
    requestMetadata = {},
    dedupeKey = null
  }) {
    const marketplaceLabel = credential?.marketplace?.name
      || credential?.marketplace?.domain
      || `Marketplace ${operation.marketplace_id}`;

    return AuditEventService.safeRecord({
      ...this.auditActor({ operation, user, workerId }),
      ...requestAuditContext(requestMetadata),
      company_id: operation.company_id,
      module: PREVIEW_AUDIT_MODULE,
      action,
      result,
      resource_type: 'marketplace_preview_operation',
      resource_id: operation.id,
      resource_label: `Consulta de publicaciones - ${marketplaceLabel}`,
      marketplace_id: operation.marketplace_id,
      marketplace_credential_id: operation.credential_id,
      correlation_id: operation.id,
      dedupe_key: dedupeKey,
      description,
      metadata: {
        operation_id: operation.id,
        company_id: operation.company_id,
        marketplace_id: operation.marketplace_id,
        credential_id: operation.credential_id,
        requested_by_user_id: operation.user_id,
        ...metadata
      }
    });
  }

  static async auditItemEvent({
    operation,
    credential = null,
    item,
    action,
    result,
    description,
    metadata = {},
    user = null,
    requestMetadata = {},
    dedupeKey = null
  }) {
    const value = plain(item) || {};
    const marketplaceLabel = credential?.marketplace?.name
      || credential?.marketplace?.domain
      || `Marketplace ${operation.marketplace_id}`;
    const itemLabel = [value.sku, value.external_id].filter(Boolean).join(' / ') || `Item ${value.id}`;

    return AuditEventService.safeRecord({
      ...this.auditActor({ operation, user }),
      ...requestAuditContext(requestMetadata),
      company_id: operation.company_id,
      module: PREVIEW_AUDIT_MODULE,
      action,
      result,
      resource_type: 'marketplace_preview_item',
      resource_id: value.id,
      resource_label: `${itemLabel} - ${marketplaceLabel}`,
      related_resource_type: 'marketplace_preview_operation',
      related_resource_id: operation.id,
      marketplace_id: operation.marketplace_id,
      marketplace_credential_id: operation.credential_id,
      correlation_id: operation.id,
      dedupe_key: dedupeKey,
      description,
      metadata: {
        operation_id: operation.id,
        item_id: value.id,
        external_id: value.external_id,
        external_variant_id: value.external_variant_id,
        sku: value.sku,
        item_status: value.status,
        detail_status: value.data?.detail_status || null,
        ...metadata
      }
    });
  }

  static async getOperation({ operationId, companyId, user }) {
    const operation = await MarketplacePreviewRepository.findOperation(operationId);
    if (!operation) {
      const error = new Error('La operación de importación no existe');
      error.statusCode = 404;
      error.code = 'marketplace_preview_not_found';
      throw error;
    }

    if (!isGlobalUser(user) && Number(operation.company_id) !== Number(companyId)) {
      const error = new Error('No tienes acceso a esta operación');
      error.statusCode = 403;
      error.code = 'marketplace_preview_forbidden';
      throw error;
    }

    if (!isGlobalUser(user)) {
      await this.authorizeCredential({
        credentialId: operation.credential_id,
        companyId,
        user
      });
    }

    return operation;
  }

  static async status({ operationId, companyId, user }) {
    const operation = await this.getOperation({ operationId, companyId, user });
    return this.publicOperation(operation);
  }

  static async items({ operationId, companyId, user, cursor, limit }) {
    await this.getOperation({ operationId, companyId, user });
    const result = await MarketplacePreviewRepository.listItems({
      operationId,
      cursor,
      limit: Math.min(Math.max(Number(limit) || 100, 1), 100)
    });
    return {
      items: result.items.map(item => this.publicItem(item)),
      has_more: result.hasMore,
      next_cursor: result.nextCursor
    };
  }

  static maximumDetailOptions(options = {}) {
    return {
      ...this.mergeOptions(options),
      include_descriptions: true,
      include_prices: true,
      include_sale_price: true,
      include_user_products: true,
      include_family: true,
      include_family_members: true,
      include_stock: true,
      include_fulfillment: true
    };
  }

  static async preparePreviewImages(rows, { concurrency = 2 } = {}) {
    return mapWithConcurrency(rows, concurrency, async row => {
      if (row?.data?.source !== 'falabella') return row;

      const prepared = await MarketplaceImageService.preparePreviewImages({
        images: row.data.images,
        mainImage: row.data.main_image
      });
      const data = {
        ...row.data,
        images: prepared.images,
        main_image: prepared.main_image
      };

      if (prepared.errors.length) data.image_errors = prepared.errors;
      else delete data.image_errors;

      return { ...row, data };
    });
  }

  static async detail({ operationId, itemId, companyId, user, refresh = false, requestMetadata = {} }) {
    const operation = await this.getOperation({ operationId, companyId, user });
    const item = await MarketplacePreviewRepository.findItem({ operationId, itemId });

    if (!item) {
      const error = new Error('La publicación de la vista previa no existe');
      error.statusCode = 404;
      error.code = 'marketplace_preview_item_not_found';
      throw error;
    }

    const current = plain(item);
    const forceRefresh = refresh === true || refresh === 'true';
    if (!forceRefresh && current.data?.detail_status === 'loaded') {
      await this.auditItemEvent({
        operation,
        item,
        action: 'marketplace_preview.item_detail_viewed',
        result: AuditEventService.RESULTS.SUCCESS,
        user,
        requestMetadata,
        description: 'Detalle de publicación consultado desde la información enriquecida almacenada',
        metadata: {
          source: 'temporary_storage',
          refreshed: false
        }
      });
      return this.publicItem(item);
    }

    let credential = null;
    try {
      credential = await this.authorizeCredential({
        credentialId: operation.credential_id,
        companyId: operation.company_id,
        user
      });
      const reader = this.readerFor(credential, operation.company_id, user?.id || operation.user_id);
      await reader.initialize();

      const sourcePayload = current.source_payload || {
        id: current.external_id,
        ShopSku: current.external_id,
        SellerSku: current.sku,
        title: current.data?.name,
        Name: current.data?.name
      };
      const enrichedItems = await reader.enrichItems(
        [sourcePayload],
        this.maximumDetailOptions(operation.options || {})
      );
      const enrichedRows = enrichedItems.flatMap(enriched => this.expandPublication(enriched));
      const matchingRow = enrichedRows.find(row => (
        String(row.external_variant_id || '') === String(current.external_variant_id || '')
        && normalizeSku(row.sku) === normalizeSku(current.sku)
      )) || enrichedRows.find(row => normalizeSku(row.sku) === normalizeSku(current.sku)) || enrichedRows[0];

      if (!matchingRow) {
        const error = new Error('No se pudo reconstruir el detalle de la publicación');
        error.statusCode = 502;
        error.code = 'marketplace_preview_detail_unavailable';
        throw error;
      }

      const detailLoadedAt = new Date();
      const detailStatus = matchingRow.data?.errors?.length ? 'partial' : 'loaded';
      const comparedRows = await this.compareRows({
        rows: await this.preparePreviewImages([{
          ...matchingRow,
          data: {
            ...matchingRow.data,
            detail_status: detailStatus,
            detail_loaded_at: detailLoadedAt.toISOString()
          }
        }], { concurrency: 1 }),
        operation
      });
      const compared = comparedRows[0];
      const updated = await MarketplacePreviewRepository.updateItem({
        operationId,
        itemId,
        values: {
          external_id: String(compared.external_id || current.external_id),
          external_variant_id: compared.external_variant_id ? String(compared.external_variant_id) : null,
          sku: compared.sku || null,
          status: compared.status,
          data: compared.data,
          source_payload: compared.source_payload,
          error: compared.error,
          fetched_at: detailLoadedAt
        }
      });

      if (!updated) {
        const error = new Error('La publicación de la vista previa ya no existe');
        error.statusCode = 404;
        error.code = 'marketplace_preview_item_not_found';
        throw error;
      }

      await this.auditItemEvent({
        operation,
        credential,
        item: updated,
        action: 'marketplace_preview.item_detail_enriched',
        result: compared.error ? AuditEventService.RESULTS.WARNING : AuditEventService.RESULTS.SUCCESS,
        user,
        requestMetadata,
        description: compared.error
          ? 'Detalle de publicación enriquecido con advertencias'
          : 'Detalle de publicación enriquecido correctamente',
        metadata: {
          refreshed: forceRefresh,
          enrichment_result: compared.error ? 'partial' : 'complete',
          error: compared.error ? { code: compared.error.code, details: compared.error.details } : null
        }
      });

      return this.publicItem(updated);
    } catch (error) {
      await this.auditItemEvent({
        operation,
        credential,
        item,
        action: 'marketplace_preview.item_detail_enrichment_failed',
        result: AuditEventService.RESULTS.ERROR,
        user,
        requestMetadata,
        description: 'No se pudo enriquecer el detalle de la publicación',
        metadata: {
          refreshed: forceRefresh,
          error: errorObject(error)
        }
      });
      throw error;
    }
  }

  static async cancel({ operationId, companyId, user, requestMetadata = {} }) {
    const previousOperation = await this.getOperation({ operationId, companyId, user });
    const operation = await MarketplacePreviewRepository.requestCancel(operationId);
    if (operation?.cancel_requested) {
      await this.auditOperationEvent({
        operation,
        action: 'marketplace_preview.cancel_requested',
        result: AuditEventService.RESULTS.PENDING,
        user,
        requestMetadata,
        dedupeKey: `marketplace_preview:${operation.id}:cancel_requested`,
        description: 'Cancelación de la consulta de publicaciones solicitada',
        metadata: {
          previous_status: previousOperation.status,
          current_status: operation.status
        }
      });
    }
    return this.publicOperation(operation);
  }

  static expandPublication(item) {
    const { source_payload: sourcePayload, ...itemWithoutSourcePayload } = item;
    const variations = Array.isArray(item.variations)
      ? item.variations.filter(variation => normalizeSku(variation?.sku))
      : [];

    if (!variations.length) {
      return [{
        external_id: item.external_id,
        external_variant_id: item.external_variant_id || null,
        sku: normalizeSku(item.sku),
        data: itemWithoutSourcePayload,
        source_payload: sourcePayload || item
      }];
    }

    return variations.map(variation => ({
      external_id: item.external_id,
      external_variant_id: variation.id || null,
      sku: normalizeSku(variation.sku),
      data: {
        ...itemWithoutSourcePayload,
        external_variant_id: variation.id || null,
        sku: normalizeSku(variation.sku),
        attributes: variation.attributes || item.attributes,
        price: variation.price ?? item.price,
        stock: variation.stock ?? item.stock,
        selected_variation: variation
      },
      source_payload: sourcePayload || item
    }));
  }

  static async loadComparisonCatalog({ companyId, marketplaceId, credentialId, rows }) {
    const skus = [...new Set(rows.map(row => normalizeSku(row.sku)).filter(Boolean))];
    const externalIds = [...new Set(rows.map(row => String(row.external_id || '')).filter(Boolean))];
    if (!skus.length && !externalIds.length) return { productsBySku: new Map(), linksByExternalId: new Map() };

    const [directProducts, variantMatches, links] = await Promise.all([
      skus.length
        ? Product.findAll({
          where: { company_id: companyId, sku: { [Op.in]: skus } },
          attributes: ['id', 'sku']
        })
        : [],
      skus.length
        ? ProductVariant.findAll({
          where: { sku: { [Op.in]: skus } },
          attributes: ['id', 'sku', 'product_id'],
          include: [{
            model: Product,
            as: 'product',
            where: { company_id: companyId },
            attributes: ['id', 'sku']
          }]
        })
        : [],
      externalIds.length
        ? ProductMarketplaceLink.findAll({
          where: {
            company_id: companyId,
            marketplace_id: marketplaceId,
            credential_id: credentialId,
            external_id: { [Op.in]: externalIds }
          },
          attributes: ['id', 'product_id', 'external_id', 'status', 'external_url']
        })
        : []
    ]);

    const productIds = [...new Set([
      ...directProducts.map(product => Number(product.id)),
      ...variantMatches.map(variant => Number(variant.product_id)),
      ...links.map(link => Number(link.product_id))
    ].filter(Number.isInteger))];

    const products = productIds.length
      ? await ProductRepository.findFiltered({ companyId, productId: productIds, includeInactive: true })
      : [];
    const productById = new Map(products.map(product => [String(product.id), product]));
    const productsBySku = new Map();

    for (const product of directProducts) {
      productsBySku.set(normalizeSku(product.sku), productById.get(String(product.id)) || null);
    }
    for (const variant of variantMatches) {
      const sku = normalizeSku(variant.sku);
      if (!productsBySku.has(sku)) {
        productsBySku.set(sku, productById.get(String(variant.product_id)) || null);
      }
    }

    const linksByExternalId = new Map(links.map(link => [String(link.external_id), {
      ...plain(link),
      product: productById.get(String(link.product_id)) || null
    }]));

    return { productsBySku, linksByExternalId };
  }

  static async compareRows({ rows, operation }) {
    const catalog = await this.loadComparisonCatalog({
      companyId: operation.company_id,
      marketplaceId: operation.marketplace_id,
      credentialId: operation.credential_id,
      rows
    });

    return rows.map(row => {
      const sku = normalizeSku(row.sku);
      const product = sku ? catalog.productsBySku.get(sku) : null;
      const link = row.external_id ? catalog.linksByExternalId.get(String(row.external_id)) : null;
      const composition = row.data?.composition || {};
      const missingFields = [];
      let status = 'new';
      let reason = null;

      if (!row.external_id) {
        status = 'not_importable';
        reason = 'external_id_missing';
        missingFields.push('external_id');
      } else if (!sku) {
        status = 'not_importable';
        reason = 'sku_missing';
        missingFields.push('sku');
      } else if (!String(row.data?.name || '').trim()) {
        status = 'not_importable';
        reason = 'insufficient_data';
        missingFields.push('name');
      } else if (composition.status === 'explicit_composite') {
        status = 'not_importable';
        reason = 'external_composite_product';
      } else if (link) {
        status = 'linked';
      } else if (product) {
        status = 'existing';
      }

      const variant = product?.variants?.find(candidate => normalizeSku(candidate.sku) === sku);
      const purchasePrice = status === 'new' || status === 'not_importable'
        ? 0
        : numberFrom(product?.purchase_price ?? variant?.purchase_price, 0);

      const comparison = {
        status,
        reason,
        missing_fields: missingFields,
        product_id: product?.id || link?.product_id || null,
        sku,
        name: product?.name || null,
        description: product?.description || null,
        images: product?.images || [],
        attributes: product?.attributes || [],
        purchase_price: purchasePrice,
        purchase_price_proposal: purchasePrice,
        warehouses: product?.warehouses || [],
        stock: numberFrom(product?.stock, 0),
        link: link ? {
          id: link.id,
          status: link.status,
          external_id: link.external_id,
          external_url: link.external_url
        } : null
      };

      return {
        ...row,
        data: {
          ...row.data,
          comparison,
          purchase_price: purchasePrice
        },
        status,
        error: row.data?.errors?.length ? { code: 'enrichment_partial', details: row.data.errors } : null
      };
    });
  }

  static async run(operationId, workerId) {
    const operation = await MarketplacePreviewRepository.findOperation(operationId);
    if (!operation || TERMINAL_STATUSES.has(operation.status)) return;

    const options = this.mergeOptions(operation.options || {});
    const credential = await MarketplaceCredentialRepository.findById(operation.credential_id);
    if (!credential) throw new Error('marketplace_credential_not_found');

    const reader = this.readerFor(credential, operation.company_id, operation.user_id);
    const heartbeatMs = Math.max(Number(process.env.MARKETPLACE_PREVIEW_LEASE_MS) || 120000, 30000);
    const heartbeat = setInterval(() => {
      MarketplacePreviewRepository.updateOperation(operationId, {
        lease_until: new Date(Date.now() + heartbeatMs),
        worker_id: workerId
      }).catch(() => null);
    }, Math.floor(heartbeatMs / 3));

    try {
      await reader.initialize();

      let current = await MarketplacePreviewRepository.findOperation(operationId);
      if (current?.processed > 0 && current?.checkpoint) {
        await MarketplacePreviewRepository.deleteItems(operationId);
        current = await MarketplacePreviewRepository.updateOperation(operationId, {
          processed: 0,
          success_count: 0,
          error_count: 0,
          checkpoint: null
        });
      }

      let sequence = 0;
      let processed = 0;
      let successCount = 0;
      let errorCount = 0;

      for await (const page of reader.enumerate({ pageSize: options.page_size })) {
        current = await MarketplacePreviewRepository.findOperation(operationId);
        if (current?.cancel_requested) {
          const cancelledOperation = await MarketplacePreviewRepository.updateOperation(operationId, {
            status: 'cancelled',
            phase: 'cancelled',
            completed_at: new Date(),
            lease_until: null
          });
          await this.auditOperationEvent({
            operation: cancelledOperation || current || operation,
            credential,
            action: 'marketplace_preview.cancelled',
            result: AuditEventService.RESULTS.SUCCESS,
            workerId,
            dedupeKey: `marketplace_preview:${operationId}:cancelled`,
            description: 'Consulta de publicaciones cancelada',
            metadata: {
              processed: current.processed,
              total: current.total,
              success_count: current.success_count,
              error_count: current.error_count
            }
          });
          return;
        }

        await MarketplacePreviewRepository.updateOperation(operationId, {
          phase: 'enriching',
          total: page.total
        });
        const baseItems = await reader.readBaseItems(page.items);
        let expandedRows = baseItems
          .flatMap(item => this.expandPublication(item))
          .map(row => ({
            ...row,
            data: {
              ...row.data,
              detail_status: 'base',
              detail_loaded_at: null
            }
          }));

        expandedRows = await this.preparePreviewImages(expandedRows, {
          concurrency: options.request_concurrency
        });

        await MarketplacePreviewRepository.updateOperation(operationId, { phase: 'comparing' });
        const comparedRows = await this.compareRows({
          rows: expandedRows,
          operation: current || operation
        });

        const now = new Date();
        const records = comparedRows.map(row => ({
          operation_id: operationId,
          sequence: sequence++,
          external_id: String(row.external_id || 'unknown'),
          external_variant_id: row.external_variant_id ? String(row.external_variant_id) : null,
          sku: row.sku || null,
          status: row.status,
          data: row.data,
          source_payload: row.source_payload,
          error: row.error,
          fetched_at: now
        }));

        await MarketplacePreviewRepository.updateOperation(operationId, { phase: 'persisting' });
        await MarketplacePreviewRepository.insertItems(records);

        processed += records.length;
        errorCount += records.filter(record => record.error).length;
        successCount += records.length - records.filter(record => record.error).length;

        await MarketplacePreviewRepository.updateOperation(operationId, {
          processed,
          success_count: successCount,
          error_count: errorCount,
          checkpoint: page.checkpoint || null,
          phase: 'enumerating',
          total: page.total
        });

        if (options.max_items && processed >= Number(options.max_items)) break;
      }

      const finalStatus = errorCount > 0 ? 'completed_with_errors' : 'completed';
      const completedOperation = await MarketplacePreviewRepository.updateOperation(operationId, {
        status: finalStatus,
        phase: 'completed',
        processed,
        success_count: successCount,
        error_count: errorCount,
        completed_at: new Date(),
        lease_until: null
      });
      await this.auditOperationEvent({
        operation: completedOperation || operation,
        credential,
        action: 'marketplace_preview.completed',
        result: errorCount > 0 ? AuditEventService.RESULTS.WARNING : AuditEventService.RESULTS.SUCCESS,
        workerId,
        dedupeKey: `marketplace_preview:${operationId}:${finalStatus}`,
        description: errorCount > 0
          ? 'Consulta de publicaciones completada con errores parciales'
          : 'Consulta de publicaciones completada correctamente',
        metadata: {
          final_status: finalStatus,
          total: completedOperation?.total ?? null,
          processed,
          success_count: successCount,
          error_count: errorCount
        }
      });
    } catch (error) {
      await MarketplacePreviewRepository.updateOperation(operationId, {
        status: 'failed',
        phase: 'failed',
        last_error: errorObject(error),
        completed_at: new Date(),
        lease_until: null
      }).catch(() => null);
      await this.auditOperationEvent({
        operation,
        credential,
        action: 'marketplace_preview.failed',
        result: AuditEventService.RESULTS.ERROR,
        workerId,
        dedupeKey: `marketplace_preview:${operationId}:failed`,
        description: 'Consulta de publicaciones fallida',
        metadata: {
          error: errorObject(error)
        }
      });
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
  }
}

function numberFrom(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

module.exports = MarketplacePreviewService;
