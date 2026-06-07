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
    userId = null,
    credentialId = null
  }) {
    const latestTask = await ProductPublishingTaskRepository.findLatestPublishedByProductMarketplaceAndCredential(
      productId,
      marketplaceId,
      credentialId,
      userId
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
    // ← NUEVO: credentialId opcional
    //logger.info(`datos llegados al servicio: \n productsData:\n ${JSON.stringify(productData)} \n marketplace: \n ${JSON.stringify(marketplace)} \n warehouse: \n ${JSON.stringify(warehouse)} \n userId: ${userId} \n crdentialId: \n ${credentialId}`);
    // ✅ Pasar credentialId al adapter factory
      const { batch_id, job_id } = options || {};
      const adapter = PublishingAdapterFactory.getAdapter(
      marketplace,
      warehouse.company_id,
      warehouse.branch_id,
      userId,
      credentialId  // ← NUEVO: credential_id específico
    );

    if (!adapter) {
      logger.error(`[PublishingService] Adapter no encontrado para marketplace ${marketplace.name}`);
      // ✅ Crear task fallido incluso para adapter_not_found
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

    try {
      // === 1. Preparar producto (el adapter ya usa credentialId internamente) ===
      const preparedProduct = await adapter.prepareProduct(productData);

      //logger.info(`[PublishingService] Producto preparado para ${marketplace.name}`);
      //logger.info(`Preparado:\n ${JSON.stringify(preparedProduct, null, 2)}`);

      // === 2. Transformar usando mapeos genéricos ===
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
        // ✅ Crear task fallido para productTransformFailed
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
          userId,
          credentialId
        });

        if (publicationContext?.external_id) {
          transformed.__ml_existing_item_id = publicationContext.external_id;
          transformed.__ml_publication_source = publicationContext.source;
        }
      }

      // ✅ Fallback para family_name/title
      if (!transformed.family_name && !transformed.title) {
        transformed.title = productData.name || productData.title || `Producto ${productData.id}`;
        logger.warn(`[PublishingService] ⚠️ Sin family_name ni title → usando título fallback: "${transformed.title}"`);
      }

      //logger.info(`[PublishingService] Producto transformado`);
      //logger.info(`Transformado:\n ${JSON.stringify(transformed, null, 2)}`);

      // === 3. Validar antes de publicar ===
      const validation = adapter.validateProduct(transformed);
      if (!validation.valid) {
        logger.error(`[PublishingService] Validación fallida: ${JSON.stringify(validation.errors)}`);
        // ✅ Crear task fallido para validation_failed
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

      // === 4. Publicar ===
      const result = await adapter.publish(transformed);
      const externalId = resolveExternalId(result);
      const shouldVerifyMlPublication = Boolean(
        result.success &&
        externalId &&
        isMercadoLibreMarketplace(marketplace)
      );
      const verification = shouldVerifyMlPublication
        ? await verifyMercadoLibreItem({
            itemId: externalId,
            accessToken: adapter.credential?.access_token
          })
        : null;

      if (result.auth_required) {
        // ✅ Crear task en estado pending para auth_required (esperando re-autorización)
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
        // ✅ Detectar si hay warnings
        const verificationWarningMessage = buildVerificationWarningMessage(verification);
        const warningsArtifacts = buildWarningArtifacts({
          marketplaceWarnings: result.warnings,
          hasWarningsFlag: result.has_warnings === true,
          fallbackMessage: result.warning_message || result.message || result.error || null,
          verificationWarningMessage
        });

        // ✅ Determinar status según si hay warnings
        // Los warnings NO son errores, el producto SÍ se publicó
        const verificationFailed = shouldVerifyMlPublication && verification && !verification.item_found;
        const finalSuccess = result.success && !verificationFailed;
        const status = finalSuccess
          ? (warningsArtifacts.hasWarnings ? 'published_with_warnings' : 'published')
          : 'failed';

        const hasWarnings = warningsArtifacts.hasWarnings;
        const warningMessage = warningsArtifacts.warningMessage;
        const warningsData = warningsArtifacts.warningsData;

        const verificationDetails = buildVerificationDetails(verification);

        const externalId = resolveExternalId(result);

        const task = await ProductPublishingTaskRepository.create({
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
          // ✅ Guardar warnings como error_message para compatibilidad con el front
          error_message: warningMessage,
          // ✅ Guardar warnings estructurados en error_details
          error_details: verificationDetails || warningsData,
          api_response: result.data,
          batch_id: batch_id || null,
        });

        if (finalSuccess) {
        await ProductMarketplaceLinkRepository.upsert({
          product_id: productData.id,
          marketplace_id: marketplace.marketplace_id,
          credential_id: credentialId,
          user_id: userId,
          company_id: warehouse.company_id,
          branch_id: warehouse.branch_id,
          status: status,
          external_id: externalId,
            external_url: result.data?.permalink,
            published_stock: normalizePublishedStock(transformed),
            published_payload: transformed,
            last_synced_at: new Date()
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

      const failedTask = await ProductPublishingTaskRepository.create({
        product_id: productData.id,
        marketplace_id: marketplace.marketplace_id,
        credential_id: credentialId,
        warehouse_id: warehouse.id,
        company_id: warehouse.company_id || null,
        branch_id: warehouse.branch_id || null,
        user_id: userId,
        date: new Date(),
        status: 'failed',  // ← Error de publicación real
        payload: transformed,  // ← Para editar y reintentar
        error_message: result.error || 'Error desconocido en el adapter',
        error_details: result.details || null,
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
        details: result.details,
        status_code: result.status_code,
        payload: transformed,
        product_id: productData.id,
        credential_id: credentialId,
        task_id: failedTask.id  // ← Para referencia en frontend
      };

    } catch (error) {
      logger.error(`[PublishingService] ❌ Error al publicar producto ${productData.id}:`, error);

      // ✅ Crear task fallido para errores excepcionales
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
          error_code: 'exception',
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
        userId: task.user_id,
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
    const status = finalSuccess
      ? (warningsArtifacts.hasWarnings ? 'published_with_warnings' : 'published')
      : 'failed';

    const hasWarnings = warningsArtifacts.hasWarnings;
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
        company_id: task.company_id,
        branch_id: task.branch_id,
        status,
        external_id: externalId,
        external_url: result.data?.permalink,
        published_stock: normalizePublishedStock(task.payload),
        published_payload: task.payload,
        last_synced_at: new Date()
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
