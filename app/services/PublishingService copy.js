const PublishingAdapterFactory = require('./adapters/PublishingAdapterFactory');
const MarketplaceTransformer = require('./MarketplaceTransformer');
const {
  ProductPublishingTaskRepository,
  ProductMarketplaceLinkRepository,
  WarehouseProductRepository,
  MarketplaceCredentialRepository
} = require('../repositories');
const logger = require('../../config/logger');
const axios = require('axios');

class PublishingService {
  /**
   * Valida atributos obligatorios por categoría (requiere accessToken y dominio)
   */
  static async validateRequiredAttributes(transformed, categoryId, accessToken, marketplaceDomain) {
    if (!categoryId) {
      logger.warn(`[PublishingService] category_id no proporcionado. Saltando validación de atributos obligatorios.`);
      return { valid: true };
    }

    try {
      const url = `${marketplaceDomain}/categories/${categoryId}/attributes`;
      const response = await axios.get(url, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });

      const requiredAttrs = response.data
        .filter(attr => attr.tags?.includes('required') || attr.tags?.includes('catalog_required'))
        .map(attr => attr.id);

      const providedAttrs = (transformed.attributes || []).map(a => a.id);
      const missing = requiredAttrs.filter(id => !providedAttrs.includes(id));

      if (missing.length > 0) {
        const msg = `Faltan atributos obligatorios: ${missing.join(', ')}`;
        logger.error(`[PublishingService] ${msg}`);
        return { valid: false, error: msg };
      }

      return { valid: true };
    } catch (err) {
      logger.warn(`[PublishingService] No se pudieron validar atributos obligatorios: ${err.message}`);
      // No bloquear publicación si falla la consulta (ej: rate limit, red)
      return { valid: true };
    }
  }

  /**
   * Publica un producto en un marketplace dado.
   */
  static async publishProduct(productData, marketplace, warehouse, userId) {
    try {
      const { product, warehouseProduct } = await WarehouseProductRepository.getProductAndWarehouseData(
        productData.product_id,
        warehouse.id
      );

      const productForTransform = {
        ...productData,
        name: product.name,
        description: product.description || null,
        sku: product.sku,
        images: product.images || [],
        price: warehouseProduct.price !== null ? warehouseProduct.price : product.base_price,
        stock: warehouseProduct.stock
      };

      // Advertencia explícita si stock = 0
      if (productForTransform.stock === 0) {
        logger.warn(`[PublishingService] Producto ${product.id} tiene stock 0 → publicación será PAUSADA.`);
      }

      const [transformed] = await MarketplaceTransformer.transformProducts(
        [productForTransform],
        marketplace.id
      );

      if (!transformed) {
        return { success: false, error: 'productTransformFailed' };
      }

      const adapter = PublishingAdapterFactory.getAdapter(
        marketplace,
        warehouse.company_id,
        warehouse.branch_id
      );

      logger.info(`[PublishingService] Usando adapter para marketplace ${marketplace.name} (${marketplace.domain})`);
      // Asegurar credenciales válidas (esto carga this.credential en el adapter)
      await adapter.ensureValidCredentials();

      const result = await adapter.publish(transformed);

      if (result.auth_required) {
        return { auth_required: true, auth_url: result.auth_url };
      }

      if (result.success) {
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
      logger.error(`[PublishingService] Error al publicar producto:`);
      logger.error(error.message);
      return { 
        success: false, 
        error: error.message || 'internal_error',
        product_id: productData.product_id
      };
    }
  }
}

module.exports = PublishingService;