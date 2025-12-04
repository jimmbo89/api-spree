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
      return { valid: true };
    }
  }

  /**
   * Publica un producto en un marketplace dado.
   */
  static async publishProduct(productData, marketplace, warehouse, userId) {
    let product;
    let transformed;

    try {
      // 1. Obtener datos del producto
      const { product: productDataResult, warehouseProduct } = await WarehouseProductRepository.getProductAndWarehouseData(
        productData.product_id,
        warehouse.id
      );
      product = productDataResult;

      // 2. Normalizar imágenes
      let images = [];
      if (warehouseProduct.image) {
        images = Array.isArray(warehouseProduct.image) ? warehouseProduct.image : [warehouseProduct.image];
      } else if (product.images) {
        images = Array.isArray(product.images) ? product.images : [product.images];
      }
      if (images.length === 0) {
        logger.info(`[PublishingService] Producto ${product.id} no tiene imágenes definidas`);
      }

      // 3. Preparar datos base
      const baseProductForTransform = {
        ...productData,
        name: product.name,
        title: productData.title || product.name,
        description: product.description || null,
        sku: product.sku,
        images,
        pictures: images,
        price: warehouseProduct.price !== null ? warehouseProduct.price : product.base_price,
        stock: warehouseProduct.stock
      };

      // 4. Obtener adapter
      const adapter = PublishingAdapterFactory.getAdapter(marketplace, warehouse.company_id, warehouse.branch_id);
      if (!adapter) {
        return { success: false, error: 'adapter_not_found', product_id: product.id };
      }

      logger.info(`[PublishingService] Usando adapter para marketplace ${marketplace.name} (${marketplace.domain})`);

      // 5. 🔑 PREDICCIÓN CONDICIONAL: Solo si el adapter soporta categoría (MercadoLibre)
      let productForTransform = { ...baseProductForTransform };
      // 🔑 Paso 2: Asegurar credenciales VÁLIDAS antes de cualquier operación que requiera token
      if (adapter.constructor.supportsCategoryPrediction?.()) {
        const hasValidCreds = await adapter.ensureValidCredentials();
        try {
          const prediction = await adapter.predictCategory(product.name);
          productForTransform.category_id = prediction.category_id;

             if (prediction.attributes && prediction.attributes.length > 0) {
      logger.info(`[PublishingService] Atributos de predicción: ${JSON.stringify(prediction.attributes)}`);
      
      productForTransform.suggested_attributes = prediction.attributes.map(attr => ({
        id: attr.id,
        value_name: attr.value_name,
        value_id: attr.value_id
      }));
    }
    
    // 👇 AGREGAR family_name SI LA CATEGORÍA LO REQUIERE
    if (prediction.required_fields?.includes('family_name') || 
        prediction.category_settings?.settings?.requires_family_name) {
      
      // Crear un family_name apropiado
      const brandAttr = prediction.attributes?.find(a => a.id === 'BRAND');
      const modelAttr = prediction.attributes?.find(a => a.id === 'MODEL');
      const colorAttr = prediction.attributes?.find(a => a.id === 'COLOR');
      
      let familyName = 'Tinta ';
      if (brandAttr?.value_name) familyName += brandAttr.value_name + ' ';
      if (modelAttr?.value_name) familyName += modelAttr.value_name + ' ';
      if (colorAttr?.value_name) familyName += colorAttr.value_name;
      else familyName += 'Magenta';
      
      productForTransform.family_name = familyName;
      logger.info(`[PublishingService] Family_name requerido: ${familyName}`);
    }
           // Guardar catalog_product_id si existe
        if (prediction.catalog_product_id) {
          productForTransform.catalog_product_id = prediction.catalog_product_id;
        }
          logger.info(`[PublishingService] Categoría predicha: ${prediction.category_id}`);
        } catch (predError) {
          logger.warn(`[PublishingService] Predicción falló:`, predError.message);
        }
      }

      if (!productForTransform.title) {
        productForTransform.title = productData.title || product.name;
      }
      // 6. Transformar producto
      const [transformedResult] = await MarketplaceTransformer.transformProducts([productForTransform], marketplace.id);
      transformed = transformedResult;
      if (!transformed) {
        return { success: false, error: 'productTransformFailed', product_id: product.id };
      }
      if (productForTransform.category_id) {
        transformed.category_id = productForTransform.category_id;
      }

      // 👇 También asegurar attributes si es necesario
      if (productForTransform.suggested_attributes && (!transformed.attributes || transformed.attributes.length === 0)) {
        transformed.attributes = productForTransform.suggested_attributes;
      }
      // 8. Advertencia de stock 0
      if (productForTransform.stock === 0) {
        logger.warn(`[PublishingService] Producto ${product.id} tiene stock 0 → publicación será PAUSADA.`);
      }

      // 9. Validar si el adapter lo soporta
      if (adapter.validateProduct) {
        try {
          await adapter.validateProduct(transformed);
        } catch (validationError) {
          logger.error(`[PublishingService] Validación falló:`, validationError.message);
          return { 
            success: false, 
            error: validationError.message,
            payload: transformed,
            product_id: product.id
          };
        }
      }
      // 👇 Eliminar 'description' si es MercadoLibre
      if (marketplace.domain?.includes('mercadolibre')) {
        delete transformed.description;
      }
      // 10. Publicar
      const result = await adapter.publish(transformed);
      logger.info(`[PublishingService] Resultado del adapter.publish():`, JSON.stringify(result, null, 2));

      // 11. Manejo de resultados
      if (result.auth_required) {
        return {
          auth_required: true,
          auth_url: result.auth_url,
          message: result.message || 'Se requiere autenticación en Mercado Libre',
          product_id: product.id
        };
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
          external_id: result.external_id || result.data?.id,
          external_url: result.data?.permalink
        });

        await ProductMarketplaceLinkRepository.upsert({
          product_id: product.id,
          marketplace_id: marketplace.id,
          company_id: warehouse.company_id,
          branch_id: warehouse.branch_id,
          status: 'published',
          external_id: result.external_id || result.data?.id,
          external_url: result.data?.permalink,
          last_synced_at: new Date()
        });

        return { 
          success: true, 
          task_id: task.id, 
          external_id: result.external_id || result.data?.id,
          product_id: product.id
        };
      }

      // Error en publicación
      logger.error(`[PublishingService] Error del adapter: ${result.error || 'Error desconocido'}`);
      return { 
        success: false, 
        error: result.error || 'unknown_error',
        details: result.details,
        status_code: result.status_code,
        payload: transformed,
        product_id: product.id
      };

    } catch (error) {
      logger.error(`[PublishingService] Error al publicar producto:`, error);
      if (error.message && (error.message.includes('auth') || error.message.includes('credencial'))) {
        return {
          success: false,
          auth_required: true,
          error: error.message,
          product_id: productData.product_id,
          message: 'Error de autenticación. Se requiere configurar credenciales.'
        };
      }
      return { 
        success: false, 
        error: error.message || 'internal_error',
        product_id: productData.product_id
      };
    }
  }
}

module.exports = PublishingService;