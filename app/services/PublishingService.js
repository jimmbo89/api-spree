const PublishingAdapterFactory = require('./adapters/PublishingAdapterFactory');
const MarketplaceTransformer = require('./MarketplaceTransformer');
const MercadoLibreAttributesService = require('./MercadoLibreAttributesService');
const {
  ProductPublishingTaskRepository,
  ProductMarketplaceLinkRepository,
  WarehouseProductRepository,
  MarketplaceCredentialRepository
} = require('../repositories');
const logger = require('../../config/logger');
const axios = require('axios');

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
  static async validateRequiredAttributes(transformed, categoryId, accessToken, marketplaceDomain) {
    if (!categoryId) {
      logger.warn(`[PublishingService] category_id no proporcionado. Saltando validación.`);
      return { valid: true };
    }

    try {
      const url = `${marketplaceDomain}/categories/${categoryId}/attributes`;
      const response = await axios.get(url, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });

      const requiredAttrs = response.data
        .filter(attr => attr.tags?.required || attr.tags?.catalog_required)
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
      logger.warn(`[PublishingService] No se pudieron validar atributos: ${err.message}`);
      return { valid: true };
    }
  }

static async buildProductAttributes(productData, categoryAttributes = []) {
  const attrs = [];
  const frontendAttrs = new Map();

  // 1. Cargar atributos del frontend (atributos personalizados del producto)
  if (Array.isArray(productData.attributes)) {
    for (const attr of productData.attributes) {
      if (attr.name && attr.value) {
        const key = normalizeForComparison(attr.name);
        frontendAttrs.set(key, { value: attr.value });
      }
    }
  }

  // 2. Asegurar atributos clave: brand y model (siempre presentes si existen)
  if (productData.brand) {
    frontendAttrs.set('marca', { value: productData.brand });
    frontendAttrs.set('brand', { value: productData.brand }); // fallback inglés
  }
  if (productData.model) {
    frontendAttrs.set('modelo', { value: productData.model });
    frontendAttrs.set('model', { value: productData.model });
  }

  // 3. Mapear atributos de categoría
  for (const catAttr of categoryAttributes) {
    if (!catAttr.id || !catAttr.name) continue;

    const catKey = normalizeForComparison(catAttr.name);
    let match = frontendAttrs.get(catKey);

    // ✅ CASO ESPECIAL: atributos por ID conocido (críticos para ML)
    if (!match) {
      const knownMapping = {
        'BRAND': productData.brand,
        'MODEL': productData.model,
        'COLOR': productData.attributes?.find?.(a => normalizeForComparison(a.name) === 'color')?.value,
        'SIZE': productData.attributes?.find?.(a => normalizeForComparison(a.name) === 'talla')?.value,
      };
      if (knownMapping[catAttr.id]) {
        match = { value: knownMapping[catAttr.id] };
      }
    }

    if (match) {
      const entry = { id: catAttr.id, value_name: match.value };

      // ✅ Siempre intentar resolver value_id si hay valores predefinidos (incluso si value_type no es "list")
      if (Array.isArray(catAttr.values) && catAttr.values.length > 0) {
        const valueMatch = catAttr.values.find(v =>
          normalizeForComparison(v.name) === normalizeForComparison(match.value) ||
          (v.id && normalizeForComparison(v.id) === normalizeForComparison(match.value))
        );
        if (valueMatch) {
          entry.value_id = valueMatch.id;
          entry.value_name = valueMatch.name; // ML prefiere el nombre oficial
        }
        // Si no hay coincidencia, ML puede rechazar, pero aún así enviamos value_name como fallback
      }

      attrs.push(entry);
    }
  }

  return attrs;
}
  static async buildMercadoLibreVariations(variants = [], categoryAttributes = []) {
  if (!Array.isArray(variants) || variants.length === 0) return null;

  // Atributos que permiten variaciones
  const variationAttrs = categoryAttributes.filter(attr =>
    attr.tags?.allow_variations === true || attr.hierarchy === 'CHILD_PK'
  );

  const validVariants = variants.filter(v => v.publish && v.attributes && Object.keys(v.attributes).length > 0);
  if (validVariants.length === 0) return null;

  return validVariants.map(v => {
    const attrCombinations = [];
    for (const [key, value] of Object.entries(v.attributes)) {
      if (!key || !value) continue;
      const frontendKey = normalizeForComparison(key);
      const matchedAttr = variationAttrs.find(attr =>
        normalizeForComparison(attr.name) === frontendKey
      );
      if (!matchedAttr) continue;

      const combination = { id: matchedAttr.id };

      // ✅ CORRECCIÓN CLAVE:
      // Si el atributo tiene valores predefinidos (values), usar value_id, incluso si value_type es "string"
      if (Array.isArray(matchedAttr.values) && matchedAttr.values.length > 0) {
        const matchedValue = matchedAttr.values.find(
          val => normalizeForComparison(val.name) === normalizeForComparison(value)
        );
        if (matchedValue) {
          combination.value_id = matchedValue.id;
          combination.value_name = matchedValue.name; // opcional, pero recomendado
        } else {
          // Si no coincide, usar value_name como fallback (aunque ML puede rechazarlo)
          combination.value_name = value;
        }
      } else {
        // Atributo libre (sin valores predefinidos)
        combination.value_name = value;
      }

      attrCombinations.push(combination);
    }

    if (attrCombinations.length === 0) return null;

    return {
      seller_custom_field: v.sku || v.id?.toString(),
      price: v.price,
      available_quantity: v.publishStock ?? v.totalStock ?? 0,
      attribute_combinations: attrCombinations
    };
  }).filter(Boolean);
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
  let product;
  let transformed;

  try {
    product = productData;

    // --- Imágenes ---
    let images = [];
    if (product.images) {
      images = Array.isArray(product.images) ? product.images : [product.images];
    }
    if (images.length === 0) {
      logger.info(`[PublishingService] Producto ${product.id} sin imágenes`);
    }

    // --- Datos base ---
    const baseProductForTransform = {
      ...productData,
      name: product.name,
      title: productData.title || product.name,
      description: product.description || null,
      sku: product.sku,
      images,
      pictures: images,
      price: product.price,
      stock: product.stock ?? product.totalStock ?? product.publishStock ?? 0, // mapear stock
      brand: product.brand || productData.brand,
      model: product.model || productData.model,
      warranty: productData.warranty || (product.warranty_months ? `${product.warranty_months} ${product.warranty_text}` : null)
    };

    const adapter = PublishingAdapterFactory.getAdapter(marketplace, warehouse.company_id, warehouse.branch_id, userId);
    if (!adapter) {
      return { success: false, error: 'adapter_not_found', product_id: product.id };
    }

    logger.info(`[PublishingService] Usando adapter: ${marketplace.name}`);

    let productForTransform = { ...baseProductForTransform };

    // --- Predicción de categoría ---
    if (adapter.constructor.supportsCategoryPrediction?.()) {
      const hasValidCreds = await adapter.ensureValidCredentials();
      try {
        const prediction = await adapter.predictCategory(productForTransform.title || product.name || '');
        productForTransform.category_id = prediction.category_id;
        productForTransform.is_user_product = prediction.is_user_product;
        productForTransform.category_settings = prediction.category_settings;
        productForTransform.category_attributes = prediction.category_attributes;

        if (prediction.is_user_product) {
          const categoryName = prediction.category_settings?.name || 'Producto';
          productForTransform.title = `${categoryName} - ${product.name.substring(0, 30)}`;
        }

        // --- Construir atributos ---
        const builtAttributes = await this.buildProductAttributes(productData, prediction.category_attributes);
        productForTransform.suggested_attributes = builtAttributes;

        // --- Garantía ---
        if (productForTransform.warranty) {
          const warrantyText = productForTransform.warranty;
          productForTransform.sale_terms = [
            { id: 'WARRANTY_TIME', value_name: warrantyText },
            { id: 'WARRANTY_TYPE', value_name: 'Garantía del vendedor' }
          ];
          delete productForTransform.warranty;
        }

        // --- Variaciones ---
        const supportsVariations = prediction.category_settings?.attribute_types === "variations";
        if (supportsVariations) {
          const mlVariations = await this.buildMercadoLibreVariations(
            productData.variants,
            prediction.category_attributes
          );

          if (mlVariations && mlVariations.length > 0) {
            productForTransform.variations = mlVariations;
            // family_name obligatorio si hay variaciones
            productForTransform.family_name = productForTransform.name;
          }
        }

        logger.info(`[PublishingService] Categoría: ${prediction.category_id}`);
      } catch (predError) {
        logger.warn(`[PublishingService] Predicción falló:`, predError.message);
      }
    }

    // --- Transformar producto ---
    const [transformedResult] = await MarketplaceTransformer.transformProducts([productForTransform], marketplace.id);
    transformed = transformedResult;
    if (!transformed) {
      return { success: false, error: 'productTransformFailed', product_id: product.id };
    }

    if (productForTransform.family_name) {
  transformed.family_name = productForTransform.family_name;
}
    // --- Reasignar datos importantes después de la transformación ---
    if (productForTransform.category_id) transformed.category_id = productForTransform.category_id;
    if (!transformed.listing_type_id) transformed.listing_type_id = 'bronze';
    if (productForTransform.sale_terms && !transformed.sale_terms) transformed.sale_terms = productForTransform.sale_terms;
    if (transformed.warranty) delete transformed.warranty;
    if (productForTransform.suggested_attributes && (!transformed.attributes || transformed.attributes.length === 0)) {
      transformed.attributes = productForTransform.suggested_attributes;
    }
    if (productForTransform.variations) {
      transformed.variations = productForTransform.variations;
    }

    // --- Siempre asegurar price y available_quantity en raíz ---
    if (transformed.price == null) transformed.price = productForTransform.price;
    if (transformed.available_quantity == null) transformed.available_quantity = productForTransform.stock;

    if (productForTransform.stock === 0) {
      logger.warn(`[PublishingService] Producto ${product.id} tiene stock 0 → publicación será PAUSADA.`);
    }

    // --- Eliminar descripción para ML si aplica ---
    if (marketplace.domain?.includes('mercadolibre')) {
      delete transformed.description;
    }

    // --- Publicar ---
    const result = await adapter.publish(transformed);
    logger.info(`[PublishingService] Resultado del adapter.publish():`, JSON.stringify(result, null, 2));

    if (result.auth_required) {
      return {
        auth_required: true,
        auth_url: result.auth_url,
        message: result.message || 'Autenticación requerida',
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

    logger.error(`[PublishingService] Error del adapter: ${result.error || 'Desconocido'}`);
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