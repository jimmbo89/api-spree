// src/services/PublishingService.js
const PublishingAdapterFactory = require('./adapters/PublishingAdapterFactory');
const MarketplaceTransformer = require('./MarketplaceTransformer');
const MercadoLibreAttributesService = require('./MercadoLibreAttributesService');
const {
  ProductPublishingTaskRepository,
  ProductMarketplaceLinkRepository,
  MarketplaceCredentialRepository
} = require('../repositories');
const {
  isMercadoLibreMarketplace,
  verifyMercadoLibreItem
} = require('./MarketplaceItemVerificationService');
const logger = require('../../config/logger');
const PublicationAuditService = require('./PublicationAuditService');

function normalizePublishedStock(payload) {
  if (!payload || typeof payload !== 'object') return null;

  const directFields = [
    payload.available_quantity,
    payload.stock,
    payload.publishStock,
    payload.initial_quantity,
    payload.totalPublishingStock,
    payload.totalStock
  ];

  for (const value of directFields) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.round(parsed);
    }
  }

  const variations = Array.isArray(payload.variations)
    ? payload.variations
    : Array.isArray(payload.items)
      ? payload.items
      : [];

  if (variations.length === 0) return null;

  const totals = variations
    .map((variation) => {
      const value =
        variation?.available_quantity ??
        variation?.stock ??
        variation?.publishStock ??
        variation?.initial_quantity ??
        variation?.quantity;
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
    })
    .filter((value) => value !== null);

  if (totals.length === 0) return null;
  return totals.reduce((sum, value) => sum + value, 0);
}

function buildProductMarketplaceLinkScope(warehouse = {}) {
  if (warehouse.company_id != null) {
    return {
      company_id: warehouse.company_id,
      branch_id: null
    };
  }

  if (warehouse.branch_id != null) {
    return {
      company_id: null,
      branch_id: warehouse.branch_id
    };
  }

  return {
    company_id: null,
    branch_id: null
  };
}

function resolveExternalId(result, fallback = null) {
  return result?.external_id || result?.data?.id || fallback || null;
}

function buildVerificationWarningMessage(verification) {
  if (!verification) return null;
  if (!verification.item_found) {
    return `Verificación ML fallida: ${verification.error || 'item_not_found'}`;
  }
  if (verification.status === 'active') {
    return null;
  }
  const subStatus = Array.isArray(verification.sub_status) && verification.sub_status.length > 0
    ? ` (${verification.sub_status.join(', ')})`
    : '';
  return `Verificación ML: estado ${verification.status || 'desconocido'}${subStatus}`;
}

function buildVerificationDetails(verification) {
  if (!verification) return null;

  const subStatus = Array.isArray(verification.sub_status) && verification.sub_status.length > 0
    ? verification.sub_status
    : Array.isArray(verification.item?.sub_status) && verification.item.sub_status.length > 0
      ? verification.item.sub_status
      : null;

  return {
    marketplace: 'mercado_libre',
    verified: verification.verified,
    item_found: verification.item_found,
    status: verification.status,
    sub_status: subStatus,
    sub_status_text: subStatus ? subStatus.join(', ') : null,
    attempts: verification.attempts,
    note: verification.note,
    error: verification.error || null
  };
}

function normalizeMarketplaceStatus(status) {
  return status ? String(status).trim().toLowerCase() : null;
}

function hasMercadoLibreSubStatus(verification, expectedSubStatus) {
  const subStatus = Array.isArray(verification?.sub_status)
    ? verification.sub_status
    : Array.isArray(verification?.item?.sub_status)
      ? verification.item.sub_status
      : [];

  return subStatus.some((value) => (
    String(value).trim().toLowerCase() === expectedSubStatus
  ));
}

function isMercadoLibrePictureProcessing(verification) {
  return normalizeMarketplaceStatus(verification?.status) === 'paused'
    && hasMercadoLibreSubStatus(verification, 'picture_download_pending');
}

function resolveMercadoLibreTaskStatus({ finalSuccess, hasWarnings, verification }) {
  if (!finalSuccess) return 'failed';

  if (isMercadoLibrePictureProcessing(verification)) return 'processing';

  return hasWarnings ? 'published_with_warnings' : 'published';
}

function resolveMercadoLibreLinkStatus(taskStatus, verification) {
  if (isMercadoLibrePictureProcessing(verification)) return 'processing';
  return normalizeMarketplaceStatus(verification?.status) || taskStatus;
}

function normalizeDetailsObject(details) {
  if (!details) return {};
  if (typeof details === 'object' && !Array.isArray(details)) return details;
  if (typeof details !== 'string') return {};

  try {
    const parsed = JSON.parse(details);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    return {};
  }
}

function buildPublishFailureDetails(result) {
  if (result?.details) return result.details;
  if (result?.validation) {
    return {
      error_code: result.error || 'mercadolibre_validation_failed',
      validation: result.validation
    };
  }
  return null;
}

function resolvePublishFailureMessage(result, fallback = 'Error desconocido en el adapter') {
  const details = normalizeDetailsObject(result?.details);
  return (
    result?.message ||
    details.marketplace_primary_error?.message ||
    details.marketplace_message ||
    details.validation?.errors?.[0]?.message ||
    result?.error ||
    fallback
  );
}

function normalizeWarningEntry(warning) {
  if (typeof warning === 'string') {
    const message = warning.trim();
    return {
      field: 'warning',
      message: message || 'Sin detalle',
      value: null
    };
  }

  if (!warning || typeof warning !== 'object') return null;

  const message = warning.message || warning.error || warning.detail || 'Sin detalle';
  return {
    field: warning.field || warning.code || 'unknown',
    message,
    value: warning.value ?? null
  };
}

function buildWarningArtifacts({ marketplaceWarnings = [], hasWarningsFlag = false, fallbackMessage = null, verificationWarningMessage = null }) {
  const normalizedMarketplaceWarnings = Array.isArray(marketplaceWarnings)
    ? marketplaceWarnings.map(normalizeWarningEntry).filter(Boolean)
    : [];

  const inferredMarketplaceWarnings = normalizedMarketplaceWarnings.length > 0
    ? normalizedMarketplaceWarnings
    : (hasWarningsFlag
      ? [{
          field: 'marketplace',
          message: fallbackMessage || 'Advertencias reportadas por el marketplace',
          value: null
        }]
      : []);

  const verificationWarnings = verificationWarningMessage
    ? [{
        field: 'verification',
        message: verificationWarningMessage,
        value: null
      }]
    : [];

  const combinedWarnings = [...inferredMarketplaceWarnings, ...verificationWarnings];
  const marketplaceWarningMessage = normalizedMarketplaceWarnings.length > 0
    ? `Advertencias del marketplace: ${normalizedMarketplaceWarnings.map(w => {
        const field = w.field ? `${w.field}` : '';
        const message = w.message || 'Sin detalle';
        return field ? `${field}: ${message}` : message;
      }).join('; ')}`
    : null;

  const warningMessage = [
    marketplaceWarningMessage,
    verificationWarningMessage
  ].filter(Boolean).join(' | ') || null;

  const warningsData = combinedWarnings.length > 0 ? {
    has_warnings: true,
    warnings: combinedWarnings,
    published_successfully: true
  } : null;

  return {
    hasWarnings: combinedWarnings.length > 0,
    warnings: combinedWarnings.length > 0 ? combinedWarnings : null,
    warningMessage,
    warningsData
  };
}

class PublishingService {

  static async resolveMercadoLibrePublicationContext({
    productId,
    marketplaceId,
    companyId = null,
    userId = null,
    credentialId = null
  }) {
    const latestTask = await ProductPublishingTaskRepository.findLatestPublishedByProductMarketplaceAndCredential(
      productId,
      marketplaceId,
      credentialId,
      companyId
    );

    if (latestTask?.external_id) {
      return {
        external_id: latestTask.external_id,
        source: 'task',
        task: latestTask
      };
    }

    return null;
  }

  static async publishFalabellaIndependentItems({
    adapter,
    transformed,
    productData,
    marketplace,
    warehouse,
    userId,
    credentialId,
    batch_id = null
  }) {
    const publicationItems = Array.isArray(transformed?.falabella_publication_items)
      ? transformed.falabella_publication_items.filter((item) => item && String(item?.sku || '').trim())
      : [];

    if (publicationItems.length === 0) {
      return null;
    }

    const linkScope = buildProductMarketplaceLinkScope(warehouse);
    const successfulItems = [];
    const failedItems = [];

    for (const publicationItem of publicationItems) {
      const itemSku = String(publicationItem?.sku || '').trim();
      if (!itemSku) continue;

      const payload = {
        ...publicationItem,
        sku: itemSku
      };

      const falabellaTask = await ProductPublishingTaskRepository.create({
        product_id: productData.id,
        marketplace_id: marketplace.marketplace_id,
        credential_id: credentialId,
        warehouse_id: warehouse.id,
        company_id: warehouse.company_id || null,
        branch_id: warehouse.branch_id || null,
        user_id: userId,
        date: new Date(),
        status: 'processing',
        payload,
        external_id: itemSku,
        external_url: null,
        error_message: 'Producto enviado a Falabella, esperando confirmación del webhook...',
        error_details: {
          feed_id: null,
          action: 'ProductCreate',
          status: 'pending',
          sku: itemSku,
          category_id: payload.PrimaryCategory,
          category_name: payload.categoryName,
          sent_at: new Date().toISOString(),
          pending_webhook: true
        },
        api_response: {
          status: 'queued'
        },
        batch_id: batch_id || null,
        attempt_count: 1
      });

      await ProductMarketplaceLinkRepository.upsert({
        product_id: productData.id,
        marketplace_id: marketplace.marketplace_id,
        credential_id: credentialId,
        user_id: userId,
        ...linkScope,
        status: 'processing',
        external_id: itemSku,
        external_url: null,
        published_stock: normalizePublishedStock(payload),
        published_payload: payload,
        last_synced_at: new Date()
      });

      logger.info(`[PublishingService] ✅ Tarea Falabella creada para SKU independiente ${itemSku}. task_id=${falabellaTask.id}`);
      logger.info(
        `[PublishingService] ========= [FALABELLA][INDEPENDENT_ITEM_BEFORE_PUBLISH] ========= sku=${itemSku} task_id=${falabellaTask.id} product_id=${productData.id} =========`
      );
      try {
        logger.info(JSON.stringify(payload, null, 2));
      } catch (error) {
        logger.info(String(payload));
      }
      logger.info(
        `[PublishingService] ========= [FALABELLA][PAYLOAD_TO_SEND] ========= sku=${itemSku} task_id=${falabellaTask.id} product_id=${productData.id} =========`
      );
      try {
        logger.info(JSON.stringify(payload, null, 2));
      } catch (error) {
        logger.info(String(payload));
      }

      const result = await adapter.publish(payload);

      if (result.auth_required) {
        await ProductPublishingTaskRepository.updateTask(falabellaTask, {
          status: 'pending',
          error_message: 'Autenticación requerida',
          error_details: {
            error_code: 'auth_required',
            auth_url: result.auth_url,
            message: result.message || 'Autenticación requerida'
          },
          api_response: result.data || null
        });

        return {
          auth_required: true,
          auth_url: result.auth_url,
          message: result.message || 'Autenticación requerida',
          product_id: productData.id,
          credential_id: credentialId,
          task_id: falabellaTask.id
        };
      }

      const publishedExternalId = resolveExternalId(result, itemSku);
      const falabellaFeedId = result.data?.feed_id || result.data?.feed?.FeedID || result.request_id || null;
      const falabellaWarnings = Array.isArray(result.warnings) ? result.warnings : [];
      const hasWarnings = result.has_warnings === true || falabellaWarnings.length > 0;
      const errorDetails = {
        feed_id: falabellaFeedId,
        action: result.data?.action || payload.__falabella_action || 'ProductCreate',
        status: 'processing',
        sku: itemSku,
        category_id: payload.PrimaryCategory,
        category_name: payload.categoryName,
        sent_at: new Date().toISOString()
      };

      if (hasWarnings) {
        errorDetails.warnings = falabellaWarnings;
        errorDetails.warning_message = result.warning_message || null;
      }

      if (result.success) {
        await ProductPublishingTaskRepository.updateTask(falabellaTask, {
          status: 'pending',
          external_id: publishedExternalId || itemSku,
          external_url: result.data?.permalink || null,
          error_message: result.warning_message || 'Producto enviado a Falabella, esperando confirmación del webhook...',
          error_details: errorDetails,
          api_response: result.data || null
        });

        await ProductMarketplaceLinkRepository.upsert({
          product_id: productData.id,
          marketplace_id: marketplace.marketplace_id,
          credential_id: credentialId,
          user_id: userId,
          ...linkScope,
          status: 'processing',
          external_id: publishedExternalId || itemSku,
          external_url: result.data?.permalink || null,
          published_stock: normalizePublishedStock(payload),
          published_payload: payload,
          last_synced_at: new Date()
        });

        successfulItems.push({
          sku: itemSku,
          external_id: publishedExternalId || itemSku,
          task_id: falabellaTask.id,
          feed_id: falabellaFeedId,
          warnings: falabellaWarnings,
          has_warnings: hasWarnings
        });
      } else {
        await ProductPublishingTaskRepository.updateTask(falabellaTask, {
          status: 'failed',
          error_message: result.error || 'Error desconocido en Falabella',
          error_details: {
            error_code: result.error_code || 'falabella_publish_failed',
            sku: itemSku,
            category_id: payload.PrimaryCategory,
            category_name: payload.categoryName,
            ...(result.details || {})
          },
          api_response: result.data || null
        });

        await ProductMarketplaceLinkRepository.upsert({
          product_id: productData.id,
          marketplace_id: marketplace.marketplace_id,
          credential_id: credentialId,
          user_id: userId,
          ...linkScope,
          status: 'failed',
          external_id: itemSku,
          external_url: null,
          published_stock: normalizePublishedStock(payload),
          published_payload: payload,
          last_synced_at: new Date()
        });

        failedItems.push({
          sku: itemSku,
          task_id: falabellaTask.id,
          error: result.error || 'Error desconocido en Falabella',
          details: result.details || null
        });
      }
    }

    const hasSuccess = successfulItems.length > 0;
    const hasFailures = failedItems.length > 0;
    const failureDetails = hasFailures
      ? {
          error_code: 'falabella_publication_failed',
          action: 'ProductCreate',
          failed_items: failedItems
        }
      : null;

    return {
      success: hasSuccess,
      partial_success: hasSuccess && hasFailures,
      external_id: successfulItems[0]?.external_id || failedItems[0]?.sku || publicationItems[0]?.sku || transformed?.sku || null,
      product_id: productData.id,
      credential_id: credentialId,
      task_id: successfulItems[0]?.task_id || failedItems[0]?.task_id || null,
      has_warnings: successfulItems.some((item) => item.has_warnings) || false,
      warnings: successfulItems.flatMap((item) => Array.isArray(item.warnings) ? item.warnings : []),
      warning_message: hasSuccess
        ? 'Producto enviado a Falabella en items independientes; la confirmación final llegará por webhook'
        : 'Ninguna variante independiente pudo publicarse en Falabella',
      status: hasSuccess ? (hasFailures ? 'published_with_warnings' : 'pending') : 'failed',
      error: hasSuccess ? null : 'falabella_publication_failed',
      details: hasSuccess ? null : failureDetails,
      data: {
        action: 'ProductCreate',
        status: hasSuccess ? 'pending' : 'failed',
        sku: successfulItems[0]?.external_id || failedItems[0]?.sku || null,
        published_skus: successfulItems.map((item) => item.external_id),
        failed_skus: failedItems.map((item) => item.sku),
        feed_ids: successfulItems.map((item) => item.feed_id).filter(Boolean),
        has_variants: successfulItems.length + failedItems.length > 1
      },
      items: {
        successful: successfulItems,
        failed: failedItems
      }
    };
  }

  static async publishProducts(products, marketplace, warehouse, userId, companyId, mode, config, credentialId = null) {
    // ← NUEVO: credentialId opcional
    const success = [];
    const errors = [];

    for (const productData of products) {
      try {
        const fullWarehouse = {
          id: warehouse.id,
          company_id: companyId,
          branch_id: null
        };

        // ✅ Pasar credentialId al método publishProduct
        const result = await this.publishProduct(
          productData, 
          marketplace, 
          fullWarehouse, 
          userId,
          credentialId  // ← NUEVO
        );

        if (result.auth_required) {
          return { auth_required: true, auth_url: result.auth_url, credential_id: credentialId };
        }

        if (result.success) {
          success.push({ 
            product_id: productData.id, 
            external_id: result.external_id,
            credential_id: credentialId  // ← NUEVO
          });
        } else {
          errors.push({
            product_id: productData.id,
            marketplace_id: marketplace.marketplace_id,
            credential_id: credentialId,  // ← NUEVO
            error: result.error || 'unknown_error'
          });
        }
      } catch (err) {
        logger.error(`Error al publicar producto ${productData.id}:`, err);
        errors.push({
          product_id: productData.id,
          marketplace_id: marketplace.marketplace_id,
          credential_id: credentialId,  // ← NUEVO
          error: err.message || 'internal_error'
        });
      }
    }

    return { success, errors };
  }

      static async publishProduct(productData, marketplace, warehouse, userId, credentialId = null, options = {}) {
    const { batch_id, job_id } = options || {};
    const adapter = PublishingAdapterFactory.getAdapter(
      marketplace,
      warehouse.company_id,
      warehouse.branch_id,
      userId,
      credentialId
    );

    if (!adapter) {
      logger.error(`[PublishingService] Adapter no encontrado para marketplace ${marketplace.name}`);
      const failedTask = await ProductPublishingTaskRepository.create({
        product_id: productData.id,
        marketplace_id: marketplace.marketplace_id,
        credential_id: credentialId,
        warehouse_id: warehouse.id,
        company_id: warehouse.company_id || null,
        branch_id: warehouse.branch_id || null,
        user_id: userId,
        date: new Date(),
        status: 'failed',
        payload: productData ? JSON.parse(JSON.stringify(productData)) : null,
        error_message: 'Adapter no encontrado para este marketplace',
        error_details: { error_code: 'adapter_not_found', marketplace: marketplace.name },
        batch_id: batch_id || null,
        attempt_count: 1
      });
      return { 
        success: false, 
        error: 'adapter_not_found', 
        product_id: productData.id,
        task_id: failedTask.id
      };
    }
    adapter.auditContext = {
      actor_type: userId ? 'user' : undefined,
      actor_id: userId || null,
      actor_name: userId ? `Usuario ${userId}` : null,
      source: 'publishing_service',
      triggered_by: userId ? 'user' : 'automatic',
      job_id: job_id || null,
      correlation_id: batch_id || null
    };

    try {
      // === 1. Preparar producto ===
      const preparedProduct = await adapter.prepareProduct(productData);
      if (preparedProduct && preparedProduct.success === false) {
        logger.error(`[PublishingService] Preparación fallida: ${preparedProduct.error || 'prepare_failed'}`);
        const failedTask = await ProductPublishingTaskRepository.create({
          product_id: productData.id,
          marketplace_id: marketplace.marketplace_id,
          credential_id: credentialId,
          warehouse_id: warehouse.id,
          company_id: warehouse.company_id || null,
          branch_id: warehouse.branch_id || null,
          user_id: userId,
          date: new Date(),
          status: 'failed',
          payload: productData ? JSON.parse(JSON.stringify(productData)) : null,
          error_message: preparedProduct.details?.message || preparedProduct.message || preparedProduct.error || 'Preparación fallida',
          error_details: preparedProduct.details || { error_code: preparedProduct.error || 'prepare_failed' },
          batch_id: batch_id || null,
          attempt_count: 1
        });
        return {
          success: false,
          error: preparedProduct.error || 'prepare_failed',
          details: preparedProduct.details || null,
          product_id: productData.id,
          task_id: failedTask.id
        };
      }

      // === 2. Transformar ===
      let transformer = MarketplaceTransformer;
      if (typeof adapter.constructor.getTransformer === 'function') {
        transformer = adapter.constructor.getTransformer();
        logger.info(`[PublishingService] ✅ Usando transformer específico: ${transformer.name || 'Custom'}`);
      }

      const [transformed] = await transformer.transformProducts(
        [preparedProduct],
        marketplace.marketplace_id
      );

      if (!transformed) {
        logger.error(`[PublishingService] Transformación fallida`);
        const failedTask = await ProductPublishingTaskRepository.create({
          product_id: productData.id,
          marketplace_id: marketplace.marketplace_id,
          credential_id: credentialId,
          warehouse_id: warehouse.id,
          company_id: warehouse.company_id || null,
          branch_id: warehouse.branch_id || null,
          user_id: userId,
          date: new Date(),
          status: 'failed',
          payload: productData ? JSON.parse(JSON.stringify(productData)) : null,
          error_message: 'Transformación del producto fallida',
          error_details: { error_code: 'productTransformFailed' },
          batch_id: batch_id || null,
          attempt_count: 1
        });
        return { 
          success: false, 
          error: 'productTransformFailed', 
          product_id: productData.id,
          task_id: failedTask.id
        };
      }

      if (String(marketplace?.domain || '').toLowerCase().includes('mercadolibre')) {
        const publicationContext = await this.resolveMercadoLibrePublicationContext({
          productId: productData.id,
          marketplaceId: marketplace.marketplace_id,
          companyId: warehouse.company_id || null,
          userId,
          credentialId
        });

        if (publicationContext?.external_id) {
          transformed.__ml_existing_item_id = publicationContext.external_id;
          transformed.__ml_publication_source = publicationContext.source;
        }
      }

      if (!transformed.family_name && !transformed.title) {
        transformed.title = productData.name || productData.title || `Producto ${productData.id}`;
        logger.warn(`[PublishingService] ⚠️ Sin family_name ni title → usando título fallback: "${transformed.title}"`);
      }

      const isFalabellaMarketplace = Boolean(
        String(marketplace?.domain || '').toLowerCase().includes('falabella')
      );
      const isMercadoLibre = isMercadoLibreMarketplace(marketplace);

      if (isFalabellaMarketplace && Array.isArray(transformed.falabella_publication_items) && transformed.falabella_publication_items.length > 0) {
        return await PublishingService.publishFalabellaIndependentItems({
          adapter,
          transformed,
          productData,
          marketplace,
          warehouse,
          userId,
          credentialId,
          batch_id
        });
      }

      // === 3. Validar ===
      const validation = adapter.validateProduct(transformed);
      if (!validation.valid) {
        logger.error(`[PublishingService] Validación fallida: ${JSON.stringify(validation.errors)}`);
        const failedTask = await ProductPublishingTaskRepository.create({
          product_id: productData.id,
          marketplace_id: marketplace.marketplace_id,
          credential_id: credentialId,
          warehouse_id: warehouse.id,
          company_id: warehouse.company_id || null,
          branch_id: warehouse.branch_id || null,
          user_id: userId,
          date: new Date(),
          status: 'failed',
          payload: transformed,
          error_message: 'Validación fallida',
          error_details: { error_code: 'validation_failed', errors: validation.errors },
          batch_id: batch_id || null,
          attempt_count: 1
        });
        return {
          success: false,
          error: 'validation_failed',
          details: validation.errors,
          product_id: productData.id,
          task_id: failedTask.id
        };
      }

      let falabellaTask = null;

      if (isFalabellaMarketplace) {
        falabellaTask = await ProductPublishingTaskRepository.create({
          product_id: productData.id,
          marketplace_id: marketplace.marketplace_id,
          credential_id: credentialId,
          warehouse_id: warehouse.id,
          company_id: warehouse.company_id || null,
          branch_id: warehouse.branch_id || null,
          user_id: userId,
          date: new Date(),
          status: 'processing',
          payload: transformed,
          external_id: transformed.sku,
          external_url: null,
          error_message: 'Producto enviado a Falabella, esperando confirmación del webhook...',
          error_details: {
            feed_id: null,
            action: 'ProductCreate',
            status: 'pending',
            sku: transformed.sku,
            category_id: transformed.PrimaryCategory,
            category_name: transformed.categoryName,
            sent_at: new Date().toISOString(),
            pending_webhook: true
          },
          api_response: {
            status: 'queued'
          },
          batch_id: batch_id || null,
          attempt_count: 1
        });

        const falabellaLinkScope = buildProductMarketplaceLinkScope(warehouse);
        await ProductMarketplaceLinkRepository.upsert({
          product_id: productData.id,
          marketplace_id: marketplace.marketplace_id,
          credential_id: credentialId,
          user_id: userId,
          ...falabellaLinkScope,
          status: 'processing',
          external_id: transformed.sku,
          external_url: null,
          published_stock: normalizePublishedStock(transformed),
          published_payload: transformed,
          last_synced_at: new Date()
        });

        logger.info(`[PublishingService] ✅ Tarea Falabella creada antes del POST. task_id=${falabellaTask.id}, sku=${transformed.sku}`);
      }

      let mercadoLibreInitialTask = null;
      const mercadoLibreCreatedItems = [];
      const mercadoLibreLinkScope = buildProductMarketplaceLinkScope(warehouse);

      const persistMercadoLibreCreatedItem = async (createdItem = {}) => {
        const itemId = createdItem.itemId || createdItem.response?.id || null;
        if (!itemId) {
          throw new Error('mercadolibre_created_item_without_id');
        }

        const itemPayload = createdItem.payload || transformed;
        const itemSku = createdItem.sku || itemPayload?.sku || transformed.sku || null;
        const itemDetails = {
          marketplace: 'mercado_libre',
          operation: createdItem.operation || 'create',
          item_model: createdItem.model || null,
          status: 'processing',
          item_id: itemId,
          seller_sku: itemSku,
          credential_id: credentialId || null,
          category_id: itemPayload?.category_id || transformed.category_id || null,
          validation: createdItem.validation || null,
          persisted_after_marketplace_response: true,
          persisted_at: new Date().toISOString()
        };

        let taskForItem = null;
        if (mercadoLibreInitialTask && !mercadoLibreInitialTask.external_id && mercadoLibreCreatedItems.length === 0) {
          const mergedDetails = {
            ...normalizeDetailsObject(mercadoLibreInitialTask.error_details),
            ...itemDetails
          };
          await ProductPublishingTaskRepository.updateTask(mercadoLibreInitialTask, {
            status: 'processing',
            payload: itemPayload,
            external_id: itemId,
            external_url: createdItem.response?.permalink || null,
            error_message: 'Producto creado en Mercado Libre, pendiente de confirmacion final...',
            error_details: mergedDetails,
            api_response: createdItem.response || null
          });
          mercadoLibreInitialTask.external_id = itemId;
          mercadoLibreInitialTask.error_details = mergedDetails;
          taskForItem = mercadoLibreInitialTask;
        } else {
          taskForItem = await ProductPublishingTaskRepository.create({
            product_id: productData.id,
            marketplace_id: marketplace.marketplace_id,
            credential_id: credentialId,
            warehouse_id: warehouse.id,
            company_id: warehouse.company_id || null,
            branch_id: warehouse.branch_id || null,
            user_id: userId,
            date: new Date(),
            status: 'processing',
            payload: itemPayload,
            external_id: itemId,
            external_url: createdItem.response?.permalink || null,
            error_message: 'Producto creado en Mercado Libre, pendiente de confirmacion final...',
            error_details: itemDetails,
            api_response: createdItem.response || null,
            batch_id: batch_id || null,
            attempt_count: 1
          });
        }

        await ProductMarketplaceLinkRepository.upsert({
          product_id: productData.id,
          marketplace_id: marketplace.marketplace_id,
          credential_id: credentialId,
          user_id: userId,
          ...mercadoLibreLinkScope,
          status: 'processing',
          external_id: itemId,
          external_url: createdItem.response?.permalink || null,
          published_stock: normalizePublishedStock(itemPayload),
          published_payload: itemPayload,
          last_synced_at: new Date()
        });

        mercadoLibreCreatedItems.push({
          task: taskForItem,
          item_id: itemId,
          sku: itemSku,
          payload: itemPayload,
          response: createdItem.response || null
        });

        logger.info(
          `[PublishingService] ML item persistido inmediatamente item_id=${itemId} sku=${itemSku || 'n/a'} task_id=${taskForItem.id}`
        );
      };

      if (isMercadoLibre) {
        mercadoLibreInitialTask = await ProductPublishingTaskRepository.create({
          product_id: productData.id,
          marketplace_id: marketplace.marketplace_id,
          credential_id: credentialId,
          warehouse_id: warehouse.id,
          company_id: warehouse.company_id || null,
          branch_id: warehouse.branch_id || null,
          user_id: userId,
          date: new Date(),
          status: 'processing',
          payload: transformed,
          external_id: null,
          external_url: null,
          error_message: 'Publicacion enviada a Mercado Libre, esperando respuesta...',
          error_details: {
            marketplace: 'mercado_libre',
            operation: transformed.__ml_existing_item_id ? 'update_or_relist' : 'create',
            status: 'processing',
            credential_id: credentialId || null,
            category_id: transformed.category_id || null,
            created_before_marketplace_response: true,
            created_at: new Date().toISOString()
          },
          api_response: { status: 'processing' },
          batch_id: batch_id || null,
          attempt_count: 1
        });

        logger.info(`[PublishingService] Tarea ML creada antes del POST. task_id=${mercadoLibreInitialTask.id}`);
      }

      // === 4. Publicar ===
      if (isFalabellaMarketplace) {
        const falabellaPayloadPreview = {
          action: transformed.__falabella_action || (transformed.__ml_existing_item_id ? 'ProductUpdate' : 'ProductCreate'),
          sku: transformed.sku || null,
          product_id: productData.id,
          credential_id: credentialId,
          marketplace_id: marketplace.marketplace_id,
          category_id: transformed.PrimaryCategory || null,
          category_name: transformed.categoryName || null,
          images_count: Array.isArray(transformed.images) ? transformed.images.length : 0,
          has_main_image: Boolean(transformed.MainImage || transformed.main_image || transformed.image)
        };

        logger.info(`[PublishingService] 📦 Falabella payload preview antes de adapter.publish:`);
        logger.info(JSON.stringify(falabellaPayloadPreview, null, 2));
        logger.info(`[PublishingService] ========= [FALABELLA][PAYLOAD_TO_SEND] ========= product_id=${productData.id} marketplace_id=${marketplace.marketplace_id} credential_id=${credentialId || 'n/a'} =========`);
        try {
          logger.info(JSON.stringify(transformed, null, 2));
        } catch (error) {
          logger.info(String(transformed));
        }
      }

      if (String(marketplace?.domain || '').toLowerCase().includes('mercadolibre')) {
        logger.info(
          `[PublishingService] ========= [MELI][PREPARE_TO_PUBLISH] ========= product_id=${productData.id} marketplace_id=${marketplace.marketplace_id} credential_id=${credentialId || 'n/a'} =========`
        );
        try {
          logger.info(JSON.stringify({
            sku: transformed.sku || null,
            title: transformed.title || null,
            family_name: transformed.family_name || null,
            has_variations: Array.isArray(transformed.variations) && transformed.variations.length > 0,
            model: transformed.__ml_existing_item_id ? 'update_or_relist' : 'create'
          }, null, 2));
        } catch (error) {
          logger.info(String(transformed?.sku || 'n/a'));
        }
        logger.info(`[PublishingService] ========= [MELI][PAYLOAD_TO_SEND] ========= product_id=${productData.id} marketplace_id=${marketplace.marketplace_id} credential_id=${credentialId || 'n/a'} =========`);
        try {
          logger.info(JSON.stringify(transformed, null, 2));
        } catch (error) {
          logger.info(String(transformed));
        }
      }

      const result = await adapter.publish(
        transformed,
        isMercadoLibre ? { onItemCreated: persistMercadoLibreCreatedItem } : undefined
      );
      const externalId = resolveExternalId(result);
      const shouldVerifyMlPublication = Boolean(
        result.success &&
        externalId &&
        isMercadoLibre
      );
      const verification = shouldVerifyMlPublication
        ? await verifyMercadoLibreItem({
            itemId: externalId,
            accessToken: adapter.credential?.access_token
          })
        : null;

      if (result.auth_required) {
        if (isFalabellaMarketplace) {
          if (falabellaTask) {
            await ProductPublishingTaskRepository.updateTask(falabellaTask, {
              status: 'pending',
              error_message: 'Autenticación requerida',
              error_details: {
                error_code: 'auth_required',
                auth_url: result.auth_url,
                message: result.message || 'Autenticación requerida'
              },
              api_response: result.data || null
            });
          }

          return {
            success: false,
            auth_required: true,
            auth_url: result.auth_url,
            message: result.message || 'Autenticación requerida',
            product_id: productData.id,
            credential_id: credentialId,
            task_id: falabellaTask?.id || null
          };
        }

        if (isMercadoLibre && mercadoLibreInitialTask) {
          await ProductPublishingTaskRepository.updateTask(mercadoLibreInitialTask, {
            status: 'pending',
            error_message: 'Autenticacion requerida',
            error_details: {
              ...normalizeDetailsObject(mercadoLibreInitialTask.error_details),
              error_code: 'auth_required',
              auth_url: result.auth_url,
              message: result.message || 'Autenticacion requerida'
            },
            api_response: result.data || null
          });

          return {
            success: false,
            auth_required: true,
            auth_url: result.auth_url,
            message: result.message || 'Autenticacion requerida',
            product_id: productData.id,
            credential_id: credentialId,
            task_id: mercadoLibreInitialTask.id
          };
        }

        const pendingTask = await ProductPublishingTaskRepository.create({
          product_id: productData.id,
          marketplace_id: marketplace.marketplace_id,
          credential_id: credentialId,
          warehouse_id: warehouse.id,
          company_id: warehouse.company_id || null,
          branch_id: warehouse.branch_id || null,
          user_id: userId,
          date: new Date(),
          status: 'pending',
          payload: transformed,
          error_message: 'Autenticación requerida',
          error_details: { 
            error_code: 'auth_required', 
            auth_url: result.auth_url,
            message: result.message || 'Autenticación requerida'
          },
          batch_id: batch_id || null,
          attempt_count: 1
        });
        return {
          success: false,
          auth_required: true,
          auth_url: result.auth_url,
          message: result.message || 'Autenticación requerida',
          product_id: productData.id,
          credential_id: credentialId,
          task_id: pendingTask.id
        };
      }

      if (result.success) {
        if (isFalabellaMarketplace) {
          const falabellaFeedId = result.data?.feed_id || result.data?.feed?.FeedID || result.request_id || null;
          const falabellaWarnings = Array.isArray(result.warnings) ? result.warnings : [];
          const falabellaHasWarnings = result.has_warnings === true || falabellaWarnings.length > 0;

          const falabellaErrorDetails = {
            feed_id: falabellaFeedId,
            action: result.data?.action || 'ProductCreate',
            status: falabellaHasWarnings ? 'pending' : (result.data?.status || 'processing'),
            sku: transformed.sku,
            category_id: transformed.PrimaryCategory,
            category_name: transformed.categoryName,
            image_upload: result.data?.image_upload || null,
            sent_at: new Date().toISOString()
          };

          if (falabellaHasWarnings) {
            falabellaErrorDetails.warnings = falabellaWarnings;
            falabellaErrorDetails.warning_message = result.warning_message || null;
          }

          if (result.data?.feed_status_result) {
            falabellaErrorDetails.feed_status = result.data.feed_status_result;
            falabellaErrorDetails.feed_confirmed = result.data.feed_confirmed === true;
          }

          if (falabellaTask) {
            await ProductPublishingTaskRepository.updateTask(falabellaTask, {
              status: 'pending',
              external_id: externalId || transformed.sku,
              external_url: result.data?.permalink || null,
              error_message: result.warning_message || 'Producto enviado a Falabella, esperando confirmación del webhook...',
              error_details: falabellaErrorDetails,
              api_response: result.data || null
            });
          }

          logger.info(`[PublishingService] ✅ Falabella quedó en ${falabellaErrorDetails.status}; webhook o feed posterior terminará la confirmación si aplica.`);

          return {
            success: true,
            task_id: falabellaTask?.id || null,
            external_id: externalId || transformed.sku,
            product_id: productData.id,
            credential_id: credentialId,
            has_warnings: falabellaHasWarnings,
            warnings: falabellaWarnings,
            warning_message: result.warning_message || 'Producto enviado a Falabella. El estado se actualizará automáticamente.',
            verification: null,
            status: 'pending',
            error: null
          };
        }
        // ✅ Para otros marketplaces (ML), mantener lógica existente
        const verificationWarningMessage = buildVerificationWarningMessage(verification);
        const warningsArtifacts = buildWarningArtifacts({
          marketplaceWarnings: result.warnings,
          hasWarningsFlag: result.has_warnings === true,
          fallbackMessage: result.warning_message || result.message || result.error || null,
          verificationWarningMessage
        });

        const verificationFailed = shouldVerifyMlPublication && verification && !verification.item_found;
        const finalSuccess = result.success && !verificationFailed;
        const hasWarnings = warningsArtifacts.hasWarnings;
        const status = resolveMercadoLibreTaskStatus({
          finalSuccess,
          hasWarnings,
          verification
        });
        const linkStatus = isMercadoLibre
          ? resolveMercadoLibreLinkStatus(status, verification)
          : status;
        const warningMessage = warningsArtifacts.warningMessage;
        const warningsData = warningsArtifacts.warningsData;

        const verificationDetails = buildVerificationDetails(verification);

        let task = null;
        if (isMercadoLibre && mercadoLibreInitialTask) {
          const tasksToUpdate = mercadoLibreCreatedItems.length > 0
            ? mercadoLibreCreatedItems
            : [{
                task: mercadoLibreInitialTask,
                item_id: externalId,
                sku: transformed.sku || null,
                payload: transformed,
                response: result.data || null
              }];

          for (const createdItem of tasksToUpdate) {
            const currentTask = createdItem.task || mercadoLibreInitialTask;
            await ProductPublishingTaskRepository.updateTask(currentTask, {
              status,
              payload: createdItem.payload || transformed,
              external_id: createdItem.item_id || externalId,
              external_url: createdItem.response?.permalink || result.data?.permalink || null,
              error_message: warningMessage,
              error_details: {
                ...normalizeDetailsObject(currentTask.error_details),
                ...(verificationDetails || {}),
                ...(warningsData || {}),
                created_items: mercadoLibreCreatedItems.map((item) => ({
                  item_id: item.item_id,
                  sku: item.sku
                }))
              },
              api_response: createdItem.response || result.data,
              published_at: finalSuccess ? new Date() : null
            });
          }

          task = tasksToUpdate[0].task || mercadoLibreInitialTask;
        } else {
          task = await ProductPublishingTaskRepository.create({
            product_id: productData.id,
            marketplace_id: marketplace.marketplace_id,
            credential_id: credentialId,
            warehouse_id: warehouse.id,
            company_id: warehouse.company_id || null,
            branch_id: warehouse.branch_id || null,
            user_id: userId,
            date: new Date(),
            status: status,
            payload: transformed,
            external_id: externalId,
            external_url: result.data?.permalink,
            error_message: warningMessage,
            error_details: {
              ...(verificationDetails || {}),
              ...(warningsData || {})
            },
            api_response: result.data,
            batch_id: batch_id || null,
          });
        }

        if (finalSuccess && isMercadoLibre && mercadoLibreCreatedItems.length > 0) {
          for (const createdItem of mercadoLibreCreatedItems) {
            await ProductMarketplaceLinkRepository.upsert({
              product_id: productData.id,
              marketplace_id: marketplace.marketplace_id,
              credential_id: credentialId,
              user_id: userId,
              ...mercadoLibreLinkScope,
              status: linkStatus,
              external_id: createdItem.item_id,
              external_url: createdItem.response?.permalink || null,
              published_stock: normalizePublishedStock(createdItem.payload),
              published_payload: createdItem.payload,
              last_synced_at: new Date()
            });
          }
        }

        if (finalSuccess && !(isMercadoLibre && mercadoLibreCreatedItems.length > 0)) {
          await ProductMarketplaceLinkRepository.upsert({
            product_id: productData.id,
            marketplace_id: marketplace.marketplace_id,
            credential_id: credentialId,
            user_id: userId,
            company_id: warehouse.company_id,
            branch_id: warehouse.branch_id,
            status: linkStatus,
            external_id: externalId,
            external_url: result.data?.permalink,
            published_stock: normalizePublishedStock(transformed),
            published_payload: transformed,
            last_synced_at: new Date()
          });
        }

        if (finalSuccess) {
          await PublicationAuditService.recordPublishedProductByUser(userId, {
            ...task.get?.({ plain: true }),
            ...task,
            product_id: productData.id,
            marketplace_id: marketplace.marketplace_id,
            credential_id: credentialId,
            company_id: warehouse.company_id || null,
            branch_id: warehouse.branch_id || null,
            warehouse_id: warehouse.id,
            external_id: externalId,
            external_url: result.data?.permalink || null,
            batch_id: batch_id || null,
            payload: transformed
          }, 'published_product.created', {
            new_value: {
              status,
              external_id: externalId,
              external_url: result.data?.permalink || null,
              published_stock: normalizePublishedStock(transformed)
            },
            description: `Publicacion realizada en ${marketplace.name || marketplace.domain || 'marketplace'}`,
            metadata: {
              job_id,
              batch_id,
              has_warnings: hasWarnings,
              product_label: [productData.sku, productData.name].filter(Boolean).join(' / ') || null,
              marketplace_name: marketplace.name || null,
              marketplace_domain: marketplace.domain || null,
              credential_name: adapter?.credential?.name || null
            },
            job_id: job_id || null
          });
        }

        logger.info(
          `[PublishingService] ${finalSuccess ? '✅' : '⚠️'} Producto publicado ` +
          `${finalSuccess ? (hasWarnings ? 'con advertencias' : 'exitosamente') : 'sin confirmación final'}`
        );
        return {
          success: finalSuccess,
          task_id: task.id,
          external_id: externalId,
          product_id: productData.id,
          credential_id: credentialId,
          has_warnings: hasWarnings,
          warnings: warningsArtifacts.warnings,
          warning_message: warningMessage,
          verification: verificationDetails,
          status: status,
          error: verificationFailed ? verificationWarningMessage : null
        };
      }

      const publishFailureDetails = buildPublishFailureDetails(result);
      const publishFailureMessage = resolvePublishFailureMessage(result);

      if (isFalabellaMarketplace && falabellaTask) {
        const falabellaFeedId = result.data?.feed_id || result.data?.feed?.FeedID || result.request_id || null;
        const falabellaFailureDetails = {
          ...normalizeDetailsObject(falabellaTask.error_details),
          ...(publishFailureDetails || {}),
          feed_id: falabellaFeedId,
          action: result.data?.action || 'ProductCreate',
          sku: transformed.sku,
          category_id: transformed.PrimaryCategory,
          category_name: transformed.categoryName,
          source: result.data?.feed_status_checked_immediately
            ? 'product_create_immediate_feed_status'
            : 'adapter_publish',
          failed_at: new Date().toISOString()
        };

        await ProductPublishingTaskRepository.updateTask(falabellaTask, {
          status: 'failed',
          external_id: externalId || transformed.sku,
          external_url: null,
          error_message: publishFailureMessage,
          error_details: falabellaFailureDetails,
          api_response: result.data || result.details || null
        });

        await ProductMarketplaceLinkRepository.upsert({
          product_id: productData.id,
          marketplace_id: marketplace.marketplace_id,
          credential_id: credentialId,
          user_id: userId,
          ...buildProductMarketplaceLinkScope(warehouse),
          status: 'failed',
          external_id: externalId || transformed.sku,
          external_url: null,
          published_stock: normalizePublishedStock(transformed),
          published_payload: transformed,
          last_synced_at: new Date()
        });

        logger.info(`[PublishingService] Falabella cerrada como failed desde FeedStatus inmediato. task_id=${falabellaTask.id}`);

        return {
          success: false,
          error: result.error || 'falabella_publish_failed',
          message: publishFailureMessage,
          details: falabellaFailureDetails,
          status_code: result.status_code,
          payload: transformed,
          product_id: productData.id,
          credential_id: credentialId,
          task_id: falabellaTask.id
        };
      }

      if (isMercadoLibre && mercadoLibreInitialTask) {
        if (mercadoLibreCreatedItems.length > 0) {
          for (const createdItem of mercadoLibreCreatedItems) {
            await ProductPublishingTaskRepository.updateTask(createdItem.task, {
              status: 'published_with_warnings',
              error_message: result.error || 'Publicacion parcial en Mercado Libre; requiere revision',
              error_details: {
                ...normalizeDetailsObject(createdItem.task.error_details),
                partial_publication: true,
                adapter_error: result.error || 'unknown_error',
                details: publishFailureDetails
              },
              api_response: createdItem.response || result.data || null,
              published_at: new Date()
            });

            await ProductMarketplaceLinkRepository.upsert({
              product_id: productData.id,
              marketplace_id: marketplace.marketplace_id,
              credential_id: credentialId,
              user_id: userId,
              ...mercadoLibreLinkScope,
              status: 'published_with_warnings',
              external_id: createdItem.item_id,
              external_url: createdItem.response?.permalink || null,
              published_stock: normalizePublishedStock(createdItem.payload),
              published_payload: createdItem.payload,
              last_synced_at: new Date()
            });
          }

          return {
            success: true,
            partial_success: true,
            external_id: mercadoLibreCreatedItems[0]?.item_id || null,
            product_id: productData.id,
            credential_id: credentialId,
            task_id: mercadoLibreCreatedItems[0]?.task?.id || mercadoLibreInitialTask.id,
            has_warnings: true,
            warnings: [{
              field: 'partial_publication',
              message: result.error || 'Publicacion parcial en Mercado Libre',
              value: mercadoLibreCreatedItems.map((item) => item.item_id)
            }],
            warning_message: result.error || 'Publicacion parcial en Mercado Libre; requiere revision',
            status: 'published_with_warnings',
            error: null
          };
        }

        await ProductPublishingTaskRepository.updateTask(mercadoLibreInitialTask, {
          status: 'failed',
          error_message: publishFailureMessage,
          error_details: publishFailureDetails,
          api_response: result.status_code ? {
            status_code: result.status_code,
            payload: result.payload
          } : null
        });

        return {
          success: false,
          error: result.error || 'unknown_error',
          message: publishFailureMessage,
          details: publishFailureDetails,
          status_code: result.status_code,
          payload: transformed,
          product_id: productData.id,
          credential_id: credentialId,
          task_id: mercadoLibreInitialTask.id
        };
      }

      const failedTask = await ProductPublishingTaskRepository.create({
        product_id: productData.id,
        marketplace_id: marketplace.marketplace_id,
        credential_id: credentialId,
        warehouse_id: warehouse.id,
        company_id: warehouse.company_id || null,
        branch_id: warehouse.branch_id || null,
        user_id: userId,
        date: new Date(),
        status: 'failed',
        payload: transformed,
        error_message: publishFailureMessage,
        error_details: publishFailureDetails,
        api_response: result.status_code ? {
          status_code: result.status_code,
          payload: result.payload
        } : null,
        attempt_count: 1,
        batch_id: batch_id || null,
      });

      logger.info(`[PublishingService] 📝 Tarea fallida guardada (ID: ${failedTask.id}) para reintentar`);

      return {
        success: false,
        error: result.error || 'unknown_error',
        message: publishFailureMessage,
        details: publishFailureDetails,
        status_code: result.status_code,
        payload: transformed,
        product_id: productData.id,
        credential_id: credentialId,
        task_id: failedTask.id
      };

    } catch (error) {
      logger.error(`[PublishingService] ❌ Error al publicar producto ${productData.id}:`, error);

      const failedTask = await ProductPublishingTaskRepository.create({
        product_id: productData.id,
        marketplace_id: marketplace.marketplace_id,
        credential_id: credentialId,
        warehouse_id: warehouse.id,
        company_id: warehouse.company_id || null,
        branch_id: warehouse.branch_id || null,
        user_id: userId,
        date: new Date(),
        status: 'failed',
        payload: productData ? JSON.parse(JSON.stringify(productData)) : null,
        error_message: error.message || 'Error interno al publicar',
        error_details: {
          ...(error.details && typeof error.details === 'object' ? error.details : {}),
          error_code: error.details?.error_code || 'exception',
          marketplace: String(marketplace?.domain || '').toLowerCase().includes('mercadolibre')
            ? 'mercadolibre'
            : marketplace?.name || null,
          message: error.message || null,
          stack: error.stack
        },
        batch_id: batch_id || null,
        attempt_count: 1
      });

      if (error.message && (error.message.includes('auth') || error.message.includes('credencial'))) {
        return {
          success: false,
          auth_required: true,
          error: error.message,
          product_id: productData.id,
          credential_id: credentialId,
          task_id: failedTask.id
        };
      }

      return {
        success: false,
        error: error.message || 'internal_error',
        product_id: productData.id,
        credential_id: credentialId,
        task_id: failedTask.id
        };
      }
    }
  /**
 * ✅ REPUBLICAR producto con payload YA construido
 * NO transforma, NO prepara, publica directo
 */
static async republishProduct(task, marketplace, credential, userId) {
  try {
    const normalizePayload = (rawPayload) => {
      if (!rawPayload) return null;
      let parsed = rawPayload;
      if (typeof parsed === 'string') {
        try {
          parsed = JSON.parse(parsed);
        } catch (e) {
          return null;
        }
      }
      if (parsed && typeof parsed === 'object' && parsed.payload && typeof parsed.payload === 'object') {
        parsed = parsed.payload;
      }
      return (parsed && typeof parsed === 'object') ? parsed : null;
    };

    const effectivePayload = normalizePayload(task.payload);
    if (!effectivePayload) {
      return {
        success: false,
        error: 'validation_failed',
        details: ['payload inválido para republicar']
      };
    }
    task.payload = effectivePayload;

    if (String(marketplace?.domain || '').toLowerCase().includes('mercadolibre') && !task.payload.__ml_existing_item_id) {
      const publicationContext = await PublishingService.resolveMercadoLibrePublicationContext({
        productId: task.product_id,
        marketplaceId: task.marketplace_id,
        companyId: task.company_id || null,
        credentialId: task.credential_id
      });

      if (publicationContext?.external_id) {
        task.payload.__ml_existing_item_id = publicationContext.external_id;
        task.payload.__ml_publication_source = publicationContext.source;
      }
    }

    // 1. Obtener adapter correcto
    const adapter = PublishingAdapterFactory.getAdapter(
      marketplace,
      task.company_id,
      task.branch_id,  // branch_id
      userId,
      credential
    );

    if (!adapter) {
      return {
        success: false,
        error: 'adapter_not_found',
        marketplace_id: marketplace.marketplace_id
      };
    }
    adapter.auditContext = {
      actor_type: userId ? 'user' : undefined,
      actor_id: userId || null,
      actor_name: userId ? `Usuario ${userId}` : null,
      source: 'publishing_service',
      triggered_by: userId ? 'user' : 'automatic',
      job_id: task.job_id || null,
      correlation_id: task.batch_id || null
    };
    // 2. ✅ VALIDAR payload (opcional pero recomendado)
    const validation = adapter.validateProduct(task.payload);
    logger.info(`Errores de validación:\n ${JSON.stringify(validation)}`);
    if (!validation.valid) {
      return {
        success: false,
        error: 'validation_failed',
        details: validation.errors
      };
    }


    // 3. ✅ PUBLICAR DIRECTO (SIN prepareProduct, SIN transformer)
    const result = await adapter.publish(task.payload);
    const externalId = resolveExternalId(result, task.external_id);
    const isFalabellaMarketplace = String(marketplace?.domain || '').toLowerCase().includes('falabella');

    if (isFalabellaMarketplace && result.success) {
      const falabellaWarnings = Array.isArray(result.warnings) ? result.warnings : [];
      const falabellaHasWarnings = result.has_warnings === true || falabellaWarnings.length > 0;
      const falabellaFeedId = result.data?.feed_id || result.data?.feed?.FeedID || result.request_id || null;

      await ProductPublishingTaskRepository.updateTask(task, {
        status: 'processing',
        error_message: result.warning_message || 'Producto reenviado a Falabella, esperando confirmación del webhook...',
        error_details: {
          ...(task.error_details && typeof task.error_details === 'object' ? task.error_details : {}),
          feed_id: falabellaFeedId,
          action: result.data?.action || 'ProductCreate',
          status: 'processing',
          sku: task.payload?.sku || task.external_id || null,
          warnings: falabellaHasWarnings ? falabellaWarnings : undefined,
          warning_message: falabellaHasWarnings ? (result.warning_message || null) : undefined
        },
        external_id: externalId || task.external_id,
        external_url: result.data?.permalink || task.external_url || null,
        api_response: result.data || null
      });

      await ProductMarketplaceLinkRepository.upsert({
        product_id: task.product_id,
        marketplace_id: task.marketplace_id,
        credential_id: task.credential_id,
        user_id: task.user_id,
        ...buildProductMarketplaceLinkScope(task),
        status: 'processing',
        external_id: externalId || task.external_id,
        external_url: result.data?.permalink || task.external_url || null,
        published_stock: normalizePublishedStock(task.payload),
        published_payload: task.payload,
        last_synced_at: new Date()
      });

      return {
        success: true,
        task_id: task.id,
        external_id: externalId || task.external_id,
        data: result.data,
        error: result.error,
        details: result.details,
        auth_required: result.auth_required,
        auth_url: result.auth_url,
        has_warnings: falabellaHasWarnings,
        warnings: falabellaWarnings,
        warning_message: result.warning_message || 'Producto reenviado a Falabella. El estado se actualizará automáticamente.',
        verification: null,
        status: 'processing',
        error_details: null
      };
    }

    const shouldVerifyMlPublication = Boolean(
      result.success &&
      externalId &&
      isMercadoLibreMarketplace(marketplace)
    );
    const verification = shouldVerifyMlPublication
      ? await verifyMercadoLibreItem({
          itemId: externalId,
          accessToken: credential?.access_token
        })
      : null;

    // ✅ Detectar si hay warnings
    const verificationWarningMessage = buildVerificationWarningMessage(verification);
    const warningsArtifacts = buildWarningArtifacts({
      marketplaceWarnings: result.warnings,
      hasWarningsFlag: result.has_warnings === true,
      fallbackMessage: result.warning_message || result.message || result.error || null,
      verificationWarningMessage
    });

    // ✅ Determinar status según si hay warnings
    const verificationFailed = shouldVerifyMlPublication && verification && !verification.item_found;
    const finalSuccess = result.success && !verificationFailed;
    const hasWarnings = warningsArtifacts.hasWarnings;
    const status = resolveMercadoLibreTaskStatus({
      finalSuccess,
      hasWarnings,
      verification
    });
    const linkStatus = resolveMercadoLibreLinkStatus(status, verification);
    const warningMessage = warningsArtifacts.warningMessage;
    const warningsData = warningsArtifacts.warningsData;

    const verificationDetails = buildVerificationDetails(verification);

    // ✅ Si hay warnings, actualizar la tarea con el estado correspondiente
    if (hasWarnings) {
      await ProductPublishingTaskRepository.updateTask(task, {
        status: status,  // ← 'published_with_warnings'
        error_message: warningMessage,
        error_details: verificationDetails || warningsData,
        external_id: externalId,
        external_url: result.data?.permalink,
        api_response: result.data
      });
    } else if (result.success) {
      // ✅ Éxito sin warnings
      await ProductPublishingTaskRepository.updateTask(task, {
        status: status,
        error_message: warningMessage,
        error_details: verificationDetails,
        external_id: externalId,
        external_url: result.data?.permalink,
        api_response: result.data
      });
    } else {
      // ✅ Error real de publicación
      await ProductPublishingTaskRepository.updateTask(task, {
        status: 'failed',
        error_message: result.error || 'Error desconocido',
        error_details: result.details || null,
        api_response: result.data
      });
    }

    if (finalSuccess) {
      await ProductMarketplaceLinkRepository.upsert({
        product_id: task.product_id,
        marketplace_id: task.marketplace_id,
        credential_id: task.credential_id,
        user_id: task.user_id,
        ...buildProductMarketplaceLinkScope(task),
        status: linkStatus,
        external_id: externalId,
        external_url: result.data?.permalink,
        published_stock: normalizePublishedStock(task.payload),
        published_payload: task.payload,
        last_synced_at: new Date()
      });

      await PublicationAuditService.recordPublishedProductByUser(userId, {
        ...task.get?.({ plain: true }),
        ...task,
        external_id: externalId,
        external_url: result.data?.permalink || task.external_url || null
      }, 'published_product.reprocessed', {
        new_value: {
          status,
          external_id: externalId,
          external_url: result.data?.permalink || null,
          published_stock: normalizePublishedStock(task.payload)
        },
        description: `Publicacion reprocesada en ${marketplace.name || marketplace.domain || 'marketplace'}`,
        metadata: {
          source: 'spree_reprocess',
          product_label: [task.product?.sku, task.product?.name].filter(Boolean).join(' / ') || null,
          marketplace_name: marketplace.name || null,
          marketplace_domain: marketplace.domain || null,
          credential_name: task.credential?.name || null,
          has_warnings: hasWarnings
        }
      });
    }

    return {
      success: finalSuccess,
      task_id: task.id,
      external_id: externalId,
      data: result.data,
      error: result.error,
      details: result.details,
      auth_required: result.auth_required,
      auth_url: result.auth_url,
      has_warnings: hasWarnings,
      warnings: warningsArtifacts.warnings,
      warning_message: warningMessage,
      verification: verificationDetails,
      status: status,
      error_details: verificationFailed ? { verification: verificationDetails } : null
    };

  } catch (error) {
    logger.error(`[PublishingService] Error en republishProduct:`, error);
    return {
      success: false,
      task_id: task.id,
      error: error.message || 'internal_error',
      error_details: error.response?.data || null
    };
  }
}
}

module.exports = PublishingService;


