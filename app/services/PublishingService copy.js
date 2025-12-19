const PublishingAdapterFactory = require('./adapters/PublishingAdapterFactory');
const MarketplaceTransformer = require('./MarketplaceTransformer');
const {
  ProductPublishingTaskRepository,
  ProductMarketplaceLinkRepository
} = require('../repositories');
const logger = require('../../config/logger');

/**
 * Normaliza un string para comparación flexible (minúsculas, sin acentos, trim)
 */
function normalizeString(str) {
  if (typeof str !== 'string') return '';
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

/**
 * Mapea atributos internos ({ name, value }) a atributos de MercadoLibre ({ id, value_name })
 * Solo si el nombre normalizado coincide EXACTAMENTE con el nombre de un atributo real de la categoría.
 */
function mapInternalAttributesToML(internalAttrs, mlCategoryAttributes) {
  if (!Array.isArray(internalAttrs) || !Array.isArray(mlCategoryAttributes)) {
    return [];
  }

  const mlAttrMap = new Map();
  for (const attr of mlCategoryAttributes) {
    if (attr.id && attr.name) {
      mlAttrMap.set(normalizeString(attr.name), attr);
    }
  }

  const mapped = [];
  for (const internal of internalAttrs) {
    if (!internal?.name || !internal?.value) continue;
    const normName = normalizeString(internal.name);
    const mlAttr = mlAttrMap.get(normName);
    if (mlAttr) {
      mapped.push({
        id: mlAttr.id,
        value_name: internal.value.toString().trim() || 'No especificado'
      });
    } else {
      logger.warn(`[PublishingService] Atributo ignorado (no existe en categoría): "${internal.name}"`);
    }
  }
  return mapped;
}

/**
 * Rellena atributos obligatorios que falten con valores por defecto.
 */
function fillRequiredAttributes(mappedAttrs, mlCategoryAttributes) {
  const mappedIds = new Set(mappedAttrs.map(a => a.id));
  for (const attr of mlCategoryAttributes) {
    if ((attr.tags?.required || attr.tags?.catalog_required) && !mappedIds.has(attr.id)) {
      let value = "No especificado";
      if (attr.value_type === "list" && Array.isArray(attr.values) && attr.values.length) {
        value = attr.values[0].name; // tomar primer valor válido
      }
      mappedAttrs.push({ id: attr.id, value_name: value });
    }
  }
  return mappedAttrs;
}

class PublishingService {
  static async publishProducts(products, marketplace, warehouse, userId, companyId, mode = 'quick', config = {}) {
    const success = [];
    const errors = [];

    for (const product of products) {
      try {
        const result = await this.publishProduct(product, marketplace, warehouse, userId, companyId, mode, config);
        if (result.auth_required) {
          return { auth_required: true, auth_url: result.auth_url };
        }
        if (result.success) {
          success.push({
            product_id: result.product_id,
            marketplace_id: marketplace.id,
            task_id: result.task_id,
            external_id: result.external_id
          });
        } else {
          const task = await ProductPublishingTaskRepository.create({
            product_id: result.product_id,
            marketplace_id: marketplace.id,
            warehouse_id: warehouse.id,
            user_id: userId,
            date: new Date(),
            status: 'error',
            error_message: result.error,
            payload: { product, marketplace_id: marketplace.id, warehouse_id: warehouse.id, mode, config }
          });
          errors.push({
            product_id: result.product_id,
            marketplace_id: marketplace.id,
            task_id: task.id,
            error: result.error
          });
        }
      } catch (err) {
        logger.error(`[PublishingService] Error en producto ${product.id} para ${marketplace.name}:`, err.message);
        errors.push({
          product_id: product?.id,
          marketplace_id: marketplace.id,
          error: err.message || 'Error interno'
        });
      }
    }

    return { success, errors };
  }

  static async publishProduct(productData, marketplace, warehouse, userId, companyId, mode = 'quick', config = {}) {
    let product, transformed;
    try {
      product = productData;
      const images = Array.isArray(productData.images) ? productData.images : (productData.images ? [productData.images] : []);

      let familyName = '';
      if (productData.brand) familyName += productData.brand;
      if (productData.model) familyName += (familyName ? ' ' : '') + productData.model;
      if (!familyName) familyName = productData.name;

      const baseProductForTransform = {
        ...productData,
        name: productData.name,
        title: productData.name,
        description: productData?.description || null,
        sku: productData.sku,
        family_name: familyName,
        images,
        pictures: images,
        price: productData.price,
        stock: productData.totalStock ?? 0
      };

      if (productData.warranty_months && productData.warranty_text) {
        baseProductForTransform.warranty = `${productData.warranty_months} ${productData.warranty_text}`;
      }

      let finalPrice = baseProductForTransform.price;
      let finalStock = baseProductForTransform.stock;
      if (config.priceMode === 'fixed' && config.fixedPrice != null) finalPrice = config.fixedPrice;
      if (config.stockMode === 'limit' && config.stockLimit != null) finalStock = Math.min(baseProductForTransform.stock, config.stockLimit);
      const allowPromotions = config.allowPromotions !== undefined ? config.allowPromotions : true;

      const productForTransform = {
        ...baseProductForTransform,
        price: finalPrice,
        stock: finalStock,
        allowPromotions,
        available_quantity: finalStock
      };

      const adapter = PublishingAdapterFactory.getAdapter(marketplace, companyId, warehouse.branch_id);
      if (!adapter) return { success: false, error: 'adapter_not_found', product_id: productData.id };

      // Predicción de categoría
      if (adapter.constructor.supportsCategoryPrediction?.()) {
        await adapter.ensureValidCredentials();
        try {
          const prediction = await adapter.predictCategory(product.name);

          productForTransform.category_id = prediction.category_id;
          productForTransform.is_user_product = prediction.is_user_product;
          productForTransform.category_settings = prediction.category_settings;
          productForTransform.category_attributes = prediction.category_attributes;

          let internalAttributes = productData.attributes || [];
          if (productData.brand) internalAttributes.push({ name: "Marca", value: productData.brand });
          if (productData.model) internalAttributes.push({ name: "Modelo", value: productData.model });

          let mappedAttrs = mapInternalAttributesToML(internalAttributes, prediction.category_attributes);
          mappedAttrs = fillRequiredAttributes(mappedAttrs, prediction.category_attributes);

          // GTIN obligatorio
          const hasGTIN = mappedAttrs.some(a => a.id === 'GTIN');
          if (!hasGTIN) {
            mappedAttrs.push({
              id: 'EMPTY_GTIN_REASON',
              value_id: prediction.category_attributes.find(a => a.id === 'EMPTY_GTIN_REASON')?.values?.[0]?.id || null
            });
          }

          productForTransform.attributes = mappedAttrs;

          // warranty → sale_terms
          if (productForTransform.warranty) {
            productForTransform.sale_terms = [
              { id: 'WARRANTY_TIME', value_name: productForTransform.warranty },
              { id: 'WARRANTY_TYPE', value_name: 'Garantía del vendedor' }
            ];
            delete productForTransform.warranty;
          }

        } catch (predError) {
          logger.error(`[PublishingService] Predicción falló: ${predError.message}`);
        }
      }

      const AdapterClass = adapter.constructor;
      const TransformerClass = AdapterClass.getTransformer();
      const [transformedResult] = await TransformerClass.transformProducts([productForTransform], marketplace.id);
      transformed = transformedResult;

      if (!transformed) return { success: false, error: 'productTransformFailed', product_id: productData.id };

      transformed.category_id = productForTransform.category_id || transformed.category_id;
      if (!transformed.listing_type_id) transformed.listing_type_id = 'bronze';
      if (productForTransform.sale_terms) transformed.sale_terms = productForTransform.sale_terms;
      transformed.category_settings = productForTransform.category_settings;
      transformed.category_attributes = productForTransform.category_attributes;
      transformed.is_user_product = productForTransform.is_user_product;
      transformed.family_name = productForTransform.family_name;
      transformed.attributes = productForTransform.attributes;

      if (marketplace.domain?.includes('mercadolibre')) delete transformed.description;

      const result = await adapter.publish(transformed);
      if (result.auth_required) return { auth_required: true, auth_url: result.auth_url, product_id: productData.id };

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
          company_id: companyId,
          branch_id: warehouse.branch_id,
          status: 'published',
          external_id: result.external_id || result.data?.id,
          external_url: result.data?.permalink,
          last_synced_at: new Date()
        });
        return { success: true, task_id: task.id, external_id: result.external_id || result.data?.id, product_id: product.id };
      }

      return { success: false, error: result.error || 'unknown_publish_error', payload: transformed, product_id: product.id };

    } catch (error) {
      logger.error(`[PublishingService] Error fatal en publishProduct:`, error);
      if (error.message?.includes('auth') || error.message?.includes('credencial')) {
        return { success: false, auth_required: true, error: error.message, product_id: productData.id };
      }
      return { success: false, error: error.message || 'internal_error', product_id: productData.id };
    }
  }
}

module.exports = PublishingService;
