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
const axios = require('axios');

/**
 * Normaliza strings para comparación ML
 */
function normalizeForComparison(str) {
  if (typeof str !== 'string') return '';
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

class PublishingService {

  /**
   * 🔑 CONSTRUCCIÓN CANÓNICA DE VARIATIONS ML
   * Regla: todas o ninguna
   */
  static buildValidMercadoLibreVariations(variants, categoryAttributes) {
  if (!Array.isArray(variants) || variants.length === 0) return null;

  const variationAttrs = categoryAttributes.filter(
    a => a.tags?.allow_variations === true || a.hierarchy === 'CHILD_PK'
  );

  if (variationAttrs.length === 0) return null;

  const variationAttrIds = variationAttrs.map(a => a.id);

  const validVariations = [];

  for (const variant of variants.filter(v => v.publish)) {
    const combinations = [];

    for (const mlAttr of variationAttrs) {
      const match = Object.entries(variant.attributes || {}).find(
        ([key]) => normalizeForComparison(key) === normalizeForComparison(mlAttr.name)
      );

      if (!match) {
        combinations.length = 0;
        break;
      }

      const value = match[1];
      const combo = { id: mlAttr.id };

      const valueMatch = mlAttr.values?.find(
        v => normalizeForComparison(v.name) === normalizeForComparison(value)
      );

      if (valueMatch) {
        combo.value_id = valueMatch.id;
        combo.value_name = valueMatch.name;
      } else {
        combo.value_name = String(value);
      }

      combinations.push(combo);
    }

    if (combinations.length === variationAttrIds.length) {
      validVariations.push({
        seller_custom_field: variant.sku || String(variant.id),
        price: Number(variant.price),
        available_quantity: Number(variant.publishStock ?? variant.totalStock ?? 0),
        attribute_combinations: combinations
      });
    }
  }

  // 🔧 CORREGIDO: Aceptar 1 o más variaciones (no solo 2+)
  return validVariations.length >= 1 ? validVariations : null;
}

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
    // --- Datos base del producto ---
    const productForTransform = {
      ...productData,
      price: productData.price,
      available_quantity: productData.stock ?? 0,
      pictures: productData.images || [],
      name: productData.name,  // 🔑 PRESERVAR name original
      title: productData.title || productData.name  // 🔑 Asegurar title desde name
    };

    logger.info(`[PublishingService] === DATOS ORIGINALES DEL PRODUCTO ===`);
    logger.info(`Product ID: ${productData.id}`);
    logger.info(`Name: "${productData.name}"`);
    logger.info(`Title: "${productData.title}"`);
    logger.info(`Price: ${productData.price}`);
    logger.info(`Stock: ${productData.stock}`);
    logger.info(`Tiene variaciones: ${!!productData.variants}`);
    logger.info(`Variaciones count: ${productData.variants?.length || 0}`);

    // --- Flujo específico MercadoLibre ---
    if (marketplace.domain.includes('mercadolibre') && productData.mercado_libre?.[marketplace.id]) {
      const mlData = productData.mercado_libre[marketplace.id];
      productForTransform.category_id = mlData.category.category_id;

      const credential = await MarketplaceCredentialRepository.findByMarketplaceAndUser(
        marketplace.id,
        userId
      );

      const { attributes: categoryAttributes, success: attrsSuccess } =
        await MercadoLibreAttributesService.getCategoryAttributes(
          productForTransform.category_id,
          credential.access_token
        );

      if (!attrsSuccess) {
        logger.error(`[PublishingService] No se pudieron obtener atributos de categoría ${productForTransform.category_id}`);
        return { success: false, error: 'category_attributes_fetch_failed', product_id: productData.id };
      }

      const variationAttrIds = new Set(
        categoryAttributes.filter(a => a.tags?.allow_variations).map(a => a.id)
      );

      // Atributos que no son variaciones
      productForTransform.attributes = mlData.attributes.filter(
        a => !variationAttrIds.has(a.id)
      );

      // Construir variaciones válidas (aceptar 1 o más)
      const variations = this.buildValidMercadoLibreVariations(
        productData.variants,
        categoryAttributes
      );
      
      if (variations && variations.length > 0) {
        productForTransform.variations = variations;
        logger.info(`[PublishingService] ✅ Variaciones construidas: ${variations.length}`);
      } else {
        logger.warn(`[PublishingService] ⚠️ No se construyeron variaciones válidas`);
      }

      // 🔑 CORREGIDO: Si la categoría TIENE atributos de variación, FORZAR family_name
      const hasVariationAttributes = categoryAttributes.some(a => a.tags?.allow_variations);
      
      if (hasVariationAttributes) {
        // La categoría espera variaciones → SIEMPRE requerir family_name
        productForTransform.family_name = 
          productData.family_name || 
          productData.name || 
          productData.title || 
          "Producto";
        
        logger.info(`[PublishingService] 🔑 Categoría con atributos de variación → FORZANDO family_name: "${productForTransform.family_name}"`);
      }

      logger.info(`[PublishingService] === DATOS MERCADO LIBRE ===`);
      logger.info(`Category ID: ${productForTransform.category_id}`);
      logger.info(`Atributos count: ${productForTransform.attributes?.length || 0}`);
      logger.info(`Tiene variaciones construidas: ${!!productForTransform.variations}`);
      logger.info(`Variaciones count: ${productForTransform.variations?.length || 0}`);
      logger.info(`Tiene family_name: ${!!productForTransform.family_name}`);
      if (productForTransform.family_name) {
        logger.info(`Family_name: "${productForTransform.family_name}"`);
      }
    }

    // --- Transformar a payload del marketplace ---
    const [transformed] = await MarketplaceTransformer.transformProducts(
      [productForTransform],
      marketplace.id
    );

    if (!transformed) {
      logger.error(`[PublishingService] Transformación de producto fallida:`, productForTransform);
      return { success: false, error: 'productTransformFailed', product_id: productData.id };
    }

    // 🔑 CORREGIDO: Último fallback para family_name/title
    if (!transformed.family_name && !transformed.title) {
      transformed.title = productData.name || productData.title || `Producto ${productData.id}`;
      logger.warn(`[PublishingService] ⚠️ Sin family_name ni title → usando título fallback: "${transformed.title}"`);
    } else if (!transformed.family_name && transformed.title) {
      // Si hay title pero no family_name, y la categoría requiere variaciones, convertir title a family_name
      const mlData = productData.mercado_libre?.[marketplace.id];
      if (mlData?.category?.category_id) {
        const credential = await MarketplaceCredentialRepository.findByMarketplaceAndUser(
          marketplace.id,
          userId
        );
        const { attributes: categoryAttributes } = await MercadoLibreAttributesService.getCategoryAttributes(
          mlData.category.category_id,
          credential.access_token
        );
        
        const hasVariationAttributes = categoryAttributes.some(a => a.tags?.allow_variations);
        if (hasVariationAttributes) {
          transformed.family_name = transformed.title;
          delete transformed.title; // MercadoLibre no permite ambos simultáneamente
          logger.info(`[PublishingService] 🔑 Categoría requiere variaciones → convirtiendo title a family_name: "${transformed.family_name}"`);
        }
      }
    }

    logger.info(`[PublishingService] === PRODUCTO TRANSFORMADO (ANTES DE ENVIAR AL ADAPTER) ===`);
    logger.info(`Title: "${transformed.title}" (${transformed.title?.length || 0} caracteres)`);
    logger.info(`Name: "${transformed.name}"`);
    logger.info(`Family_name: "${transformed.family_name}"`);
    logger.info(`Tiene variaciones: ${!!transformed.variations}`);
    logger.info(`Variaciones count: ${transformed.variations?.length || 0}`);
    logger.info(`Atributos count: ${transformed.attributes?.length || 0}`);
    logger.info(`Payload completo:`);
    logger.info(JSON.stringify(transformed, null, 2));

    // --- Publicar producto ---
    const result = await adapter.publish(transformed);

    logger.info(`[PublishingService] === RESULTADO DEL ADAPTER ===`);
    logger.info(JSON.stringify(result, null, 2));

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
      logger.info(`Task ID: ${task.id}`);
      logger.info(`External ID: ${result.external_id}`);

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
    logger.error(`Stack trace:`, error.stack);
    
    if (error.message && (error.message.includes('auth') || error.message.includes('credencial'))) {
      return {
        success: false,
        auth_required: true,
        error: error.message,
        product_id: productData.id,
        message: 'Error de autenticación'
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
