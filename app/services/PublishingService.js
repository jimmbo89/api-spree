// src/services/PublishingService.js
const PublishingAdapterFactory = require('./adapters/PublishingAdapterFactory');
const MarketplaceTransformer = require('./MarketplaceTransformer');
const {
  ProductPublishingTaskRepository,
  ProductMarketplaceLinkRepository
} = require('../repositories');
const logger = require('../../config/logger');

class PublishingService {

  static async publishProducts(products, marketplace, warehouse, userId, companyId, mode, config) {
    const success = [];
    const errors = [];

    for (const productData of products) {
      try {
        const fullWarehouse = {
          id: warehouse.id,
          company_id: companyId,
          branch_id: null
        };

        const result = await this.publishProduct(productData, marketplace, fullWarehouse, userId);

        if (result.auth_required) {
          return { auth_required: true, auth_url: result.auth_url };
        }

        if (result.success) {
          success.push({ product_id: productData.id, external_id: result.external_id });
        } else {
          errors.push({
            product_id: productData.id,
            marketplace_id: marketplace.id,
            error: result.error || 'unknown_error'
          });
        }
      } catch (err) {
        logger.error(`Error al publicar producto ${productData.id}:`, err);
        errors.push({
          product_id: productData.id,
          marketplace_id: marketplace.id,
          error: err.message || 'internal_error'
        });
      }
    }

    return { success, errors };
  }

  static async publishProduct(productData, marketplace, warehouse, userId) {
    const adapter = PublishingAdapterFactory.getAdapter(
      marketplace,
      warehouse.company_id,
      warehouse.branch_id,
      userId
    );

    if (!adapter) {
      logger.error(`[PublishingService] Adapter no encontrado para marketplace ${marketplace.name}`);
      return { success: false, error: 'adapter_not_found', product_id: productData.id };
    }

    try {
      // === 1. Preparar producto (responsabilidad del adapter) ===
      const preparedProduct = await adapter.prepareProduct(productData);
      
      logger.info(`[PublishingService] Producto preparado para ${marketplace.name}`);
      logger.info(`Preparado:\n ${JSON.stringify(preparedProduct, null, 2)}`);

      // === 2. Transformar usando mapeos genéricos ===
      let transformer = MarketplaceTransformer; // Default genérico
    if (typeof adapter.constructor.getTransformer === 'function') {
      transformer = adapter.constructor.getTransformer();
      logger.info(`[PublishingService] ✅ Usando transformer específico: ${transformer.name || 'Custom'}`);
    }

    const [transformed] = await transformer.transformProducts(
      [preparedProduct],
      marketplace.id
    );


      if (!transformed) {
        logger.error(`[PublishingService] Transformación fallida`);
        return { success: false, error: 'productTransformFailed', product_id: productData.id };
      }

      logger.info(`[PublishingService] Producto transformado`);
      logger.info(`Transformado:\n ${JSON.stringify(transformed, null, 2)}`);

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
          product_id: productData.id
        };
      }

      if (result.success) {
        // Guardar resultados
        const task = await ProductPublishingTaskRepository.create({
          product_id: productData.id,
          marketplace_id: marketplace.id,
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
          marketplace_id: marketplace.id,
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
          product_id: productData.id
        };
      }

      logger.error(`[PublishingService] ❌ Error del adapter: ${result.error || 'Desconocido'}`);
      return {
        success: false,
        error: result.error || 'unknown_error',
        details: result.details,
        status_code: result.status_code,
        payload: transformed,
        product_id: productData.id
      };

    } catch (error) {
      logger.error(`[PublishingService] ❌ Error al publicar producto ${productData.id}:`, error);
      
      if (error.message && (error.message.includes('auth') || error.message.includes('credencial'))) {
        return {
          success: false,
          auth_required: true,
          error: error.message,
          product_id: productData.id
        };
      }
      
      return {
        success: false,
        error: error.message || 'internal_error',
        product_id: productData.id
      };
    }
  }
}

module.exports = PublishingService;