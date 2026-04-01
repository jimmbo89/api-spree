// src/services/PublishingService.js
const PublishingAdapterFactory = require('./adapters/PublishingAdapterFactory');
const MarketplaceTransformer = require('./MarketplaceTransformer');
const MercadoLibreAttributesService = require('./MercadoLibreAttributesService');
const {
  ProductPublishingTaskRepository,
  ProductMarketplaceLinkRepository,
  MarketplaceCredentialRepository
} = require('../repositories');
const logger = require('../../config/logger');

class PublishingService {

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

      if (result.auth_required) {
        // ✅ Crear task en estado pending para auth_required (esperando re-autorización)
        const pendingTask = await ProductPublishingTaskRepository.create({
          product_id: productData.id,
          marketplace_id: marketplace.marketplace_id,
          credential_id: credentialId,
          warehouse_id: warehouse.id,
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
        const hasWarnings = result.has_warnings === true ||
                          (Array.isArray(result.warnings) && result.warnings.length > 0);

        // ✅ Determinar status según si hay warnings
        // Los warnings NO son errores, el producto SÍ se publicó
        const status = hasWarnings ? 'published_with_warnings' : 'published';

        // ✅ Preparar mensaje de warnings para UI (claro y entendible)
        const warningMessage = hasWarnings
          ? `Advertencias del marketplace: ${result.warnings.map(w => {
              const field = w.field ? `${w.field}` : '';
              const message = w.message || 'Sin detalle';
              return field ? `${field}: ${message}` : message;
            }).join('; ')}`
          : null;

        // ✅ Estructura de warnings para guardar (más clara para el front)
        const warningsData = hasWarnings ? {
          has_warnings: true,
          warnings: result.warnings.map(w => ({
            field: w.field || 'unknown',
            message: w.message || 'Sin detalle',
            value: w.value || null
          })),
          // ✅ Flag para que el front sepa que aunque hay warnings, la publicación fue exitosa
          published_successfully: true
        } : null;

        const task = await ProductPublishingTaskRepository.create({
          product_id: productData.id,
          marketplace_id: marketplace.marketplace_id,
          credential_id: credentialId,
          warehouse_id: warehouse.id,
          user_id: userId,
          date: new Date(),
          status: status,
          payload: transformed,
          external_id: result.external_id || result.data?.id,
          external_url: result.data?.permalink,
          // ✅ Guardar warnings como error_message para compatibilidad con el front
          error_message: hasWarnings ? warningMessage : null,
          // ✅ Guardar warnings estructurados en error_details
          error_details: warningsData,
          api_response: result.data,
          batch_id: batch_id || null,
        });

        await ProductMarketplaceLinkRepository.upsert({
          product_id: productData.id,
          marketplace_id: marketplace.marketplace_id,
          credential_id: credentialId,
          company_id: warehouse.company_id,
          branch_id: warehouse.branch_id,
          status: status,
          external_id: result.external_id || result.data?.id,
          external_url: result.data?.permalink,
          last_synced_at: new Date()
        });

        logger.info(`[PublishingService] ✅ Producto publicado ${hasWarnings ? 'con advertencias' : 'exitosamente'}`);
        return {
          success: true,
          task_id: task.id,
          external_id: result.external_id || result.data?.id,
          product_id: productData.id,
          credential_id: credentialId,
          has_warnings: hasWarnings,
          warnings: hasWarnings ? result.warnings : null,
          status: status
        };
      }

      const failedTask = await ProductPublishingTaskRepository.create({
        product_id: productData.id,
        marketplace_id: marketplace.marketplace_id,
        credential_id: credentialId,
        warehouse_id: warehouse.id,
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

    // ✅ Detectar si hay warnings
    const hasWarnings = result.has_warnings === true ||
                       (Array.isArray(result.warnings) && result.warnings.length > 0);

    // ✅ Determinar status según si hay warnings
    const status = hasWarnings ? 'published_with_warnings' : (result.success ? 'published' : 'failed');

    // ✅ Preparar mensaje de warnings para UI (claro y entendible)
    const warningMessage = hasWarnings
      ? `Advertencias del marketplace: ${result.warnings?.map(w => {
          const field = w.field ? `${w.field}` : '';
          const message = w.message || 'Sin detalle';
          return field ? `${field}: ${message}` : message;
        }).join('; ')}`
      : null;

    // ✅ Estructura de warnings para guardar
    const warningsData = hasWarnings ? {
      has_warnings: true,
      warnings: result.warnings?.map(w => ({
        field: w.field || 'unknown',
        message: w.message || 'Sin detalle',
        value: w.value || null
      })) || [],
      published_successfully: true
    } : null;

    // ✅ Si hay warnings, actualizar la tarea con el estado correspondiente
    if (hasWarnings) {
      await ProductPublishingTaskRepository.updateTask(task, {
        status: status,  // ← 'published_with_warnings'
        error_message: warningMessage,
        error_details: warningsData,
        external_id: result.external_id,
        external_url: result.data?.permalink,
        api_response: result.data
      });
    } else if (result.success) {
      // ✅ Éxito sin warnings
      await ProductPublishingTaskRepository.updateTask(task, {
        status: 'published',
        error_message: null,
        error_details: null,
        external_id: result.external_id,
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

    return {
      success: result.success,
      task_id: task.id,
      external_id: result.external_id,
      data: result.data,
      error: result.error,
      details: result.details,
      auth_required: result.auth_required,
      auth_url: result.auth_url,
      has_warnings: hasWarnings,
      warnings: hasWarnings ? result.warnings : null,
      status: status
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