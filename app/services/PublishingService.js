// src/services/PublishingService.js
const PublishingAdapterFactory = require('./adapters/PublishingAdapterFactory');
const MarketplaceTransformer = require('./MarketplaceTransformer');
const {
  ProductPublishingTaskRepository,
  ProductMarketplaceLinkRepository,
  WarehouseProductRepository
} = require('../repositories');
const logger = require('../../config/logger');

class PublishingService {
  /**
   * Publica un producto en un marketplace dado.
   * @param {Object} productData - Datos del producto desde el request (ej: { product_id, category_id_ml, ... })
   * @param {Object} marketplace - Instancia de Marketplace
   * @param {Object} warehouse - Instancia de Warehouse
   * @param {number} userId - ID del usuario que publica
   * @returns {Promise<Object>} - Resultado de la publicación
   */
  static async publishProduct(productData, marketplace, warehouse, userId) {
    try {
      // 1. Cargar producto y warehouse_product
      const { product, warehouseProduct } = await WarehouseProductRepository.getProductAndWarehouseData(
        productData.product_id,
        warehouse.id
      );

      // 2. Construir objeto para transformación (solo con datos reales)
      const productForTransform = {
        ...productData, // incluye category_id_ml si el frontend lo envía
        name: product.name,
        description: product.description || null,
        sku: product.sku,
        images: product.images || [],
        price: warehouseProduct.price !== null ? warehouseProduct.price : product.base_price,
        stock: warehouseProduct.stock
      };

      // 3. Transformar usando los mapeos del marketplace
      const [transformed] = await MarketplaceTransformer.transformProducts(
        [productForTransform],
        marketplace.id
      );

      if (!transformed) {
        return { success: false, error: 'productTransformFailed' };
      }

      // 4. Obtener adapter dinámico
      const adapter = PublishingAdapterFactory.getAdapter(
        marketplace,
        warehouse.company_id,
        warehouse.branch_id
      );

      // 5. Publicar
      const result = await adapter.publish(transformed);

      if (result.auth_required) {
        return { auth_required: true, auth_url: result.auth_url };
      }

      if (result.success) {
        // Guardar tarea de publicación
        const task = await ProductPublishingTaskRepository.create({
          product_id: product.id,
          marketplace_id: marketplace.id,
          warehouse_id: warehouse.id,
          user_id: userId,
          date: new Date(),
          status: 'published',
          payload: transformed,
          external_id: result.data.id,
          external_url: result.data.permalink
        });

        // Guardar link de publicación
        await ProductMarketplaceLinkRepository.upsert({
          product_id: product.id,
          marketplace_id: marketplace.id,
          company_id: warehouse.company_id,
          branch_id: warehouse.branch_id,
          status: 'published',
          external_id: result.data.id,
          external_url: result.data.permalink,
          last_synced_at: new Date()
        });

        return { 
          success: true, 
          task_id: task.id, 
          external_id: result.data.id,
          product_id: product.id
        };
      }

      return { 
        success: false, 
        error: result.error || 'unknown_error',
        payload: transformed,
        product_id: product.id
      };

    } catch (error) {
      logger.error(`[PublishingService] Error al publicar producto:`, error.message);
      return { 
        success: false, 
        error: error.message || 'internal_error',
        product_id: productData.product_id
      };
    }
  }
}

module.exports = PublishingService;