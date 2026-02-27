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

  static async publishProduct(productData, marketplace, warehouse, userId, credentialId = null) {
    // ← NUEVO: credentialId opcional
    //logger.info(`datos llegados al servicio: \n productsData:\n ${JSON.stringify(productData)} \n marketplace: \n ${JSON.stringify(marketplace)} \n warehouse: \n ${JSON.stringify(warehouse)} \n userId: ${userId} \n crdentialId: \n ${credentialId}`);
    // ✅ Pasar credentialId al adapter factory
    const adapter = PublishingAdapterFactory.getAdapter(
      marketplace,
      warehouse.company_id,
      warehouse.branch_id,
      userId,
      credentialId  // ← NUEVO: credential_id específico
    );

    if (!adapter) {
      logger.error(`[PublishingService] Adapter no encontrado para marketplace ${marketplace.name}`);
      return { success: false, error: 'adapter_not_found', product_id: productData.id };
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
        return { success: false, error: 'productTransformFailed', product_id: productData.id };
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
        return {
          success: false,
          error: 'validation_failed',
          details: validation.errors,
          product_id: productData.id
        };
      }

      // === 4. Publicar ===
      const result = await adapter.publish(transformed);

      if (result.auth_required) {
        return {
          success: false,
          auth_required: true,
          auth_url: result.auth_url,
          message: result.message || 'Autenticación requerida',
          product_id: productData.id,
          credential_id: credentialId  // ← NUEVO
        };
      }

      if (result.success) {
        // Guardar resultados
        const task = await ProductPublishingTaskRepository.create({
          product_id: productData.id,
          marketplace_id: marketplace.marketplace_id,
          credential_id: credentialId,  // ← NUEVO: Guardar credential_id
          warehouse_id: warehouse.id,
          user_id: userId,
          date: new Date(),
          status: 'published',
          payload: transformed,
          external_id: result.external_id || result.data?.id,
          external_url: result.data?.permalink
        });

        await ProductMarketplaceLinkRepository.upsert({
          product_id: productData.id,
          marketplace_id: marketplace.marketplace_id,
          credential_id: credentialId,  // ← NUEVO
          company_id: warehouse.company_id,
          branch_id: warehouse.branch_id,
          status: 'published',
          external_id: result.external_id || result.data?.id,
          external_url: result.data?.permalink,
          last_synced_at: new Date()
        });

        logger.info(`[PublishingService] ✅ Producto publicado exitosamente`);
        return {
          success: true,
          task_id: task.id,
          external_id: result.external_id || result.data?.id,
          product_id: productData.id,
          credential_id: credentialId  // ← NUEVO
        };
      }

      logger.error(`[PublishingService] ❌ Error del adapter: ${result.error || 'Desconocido'}`);
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
        attempt_count: 1
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
      
      if (error.message && (error.message.includes('auth') || error.message.includes('credencial'))) {
        return {
          success: false,
          auth_required: true,
          error: error.message,
          product_id: productData.id,
          credential_id: credentialId  // ← NUEVO
        };
      }
      
      return {
        success: false,
        error: error.message || 'internal_error',
        product_id: productData.id,
        credential_id: credentialId  // ← NUEVO
      };
    }
  }
}

module.exports = PublishingService;