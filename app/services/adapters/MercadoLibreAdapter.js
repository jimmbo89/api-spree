// src/services/adapters/MercadoLibreAdapter.js
const BaseAdapter = require("./BaseAdapter");
const logger = require("../../../config/logger");
const { MarketplaceCredentialRepository } = require("../../repositories");
const axios = require('axios');
const MarketplaceTransformerMercadoLibre = require("../MarketplaceTransformerMercadoLibre");
const MercadoLibreAttributesService = require('../MercadoLibreAttributesService'); // 🔑 Nuevo requerimiento

class MercadoLibreAdapter extends BaseAdapter {
  static supportsCategoryPrediction() {
    return true;
  }

  static getTransformer() {
    return MarketplaceTransformerMercadoLibre;
  }

  // 🔑 NUEVO MÉTODO: Preprocesamiento específico de MercadoLibre
async prepareProduct(productData) {
  logger.info('[MercadoLibreAdapter] Preparando producto para publicación', {
    productId: productData.id,
    name: productData.name,
    variantsCount: productData.variants?.length || 0
  });

  if (!productData.mercado_libre || Object.keys(productData.mercado_libre).length === 0) {
    throw new Error('No se encontró información de MercadoLibre para el producto');
  }

  const marketId = Object.keys(productData.mercado_libre)[0];
  const mlData = productData.mercado_libre[marketId];

  if (!mlData?.category?.category_id) {
    throw new Error('Falta category_id para MercadoLibre');
  }

  // ✅ PASO 1: Obtener SOLO metadatos de la categoría (tags, settings, allow_variations)
  const credential = await this.ensureValidCredentials();
  const categoryInfo = await this.getCategoryMetadata(
    mlData.category.category_id,
    credential.access_token
  );

  const prepared = {
    title: productData.name?.trim() || '',
    category_id: mlData.category.category_id,
    price: Number(productData.price) || 0,
    currency_id: 'CLP',
    available_quantity: Number(productData.totalStock) || 0,
    buying_mode: 'buy_it_now',
    listing_type_id: 'gold_special',
    condition: productData.condition?.toLowerCase() === 'new' ? 'new' : 'used',
    description: {
      plain_text: productData.description?.trim() || productData.name?.trim() || ''
    },
    shipping: {
      mode: 'me2',
      local_pick_up: true,
      free_shipping: false
    },
    sale_terms: [],
    attributes: [],
    variations: undefined,
    // ✅ PRESERVAR metadatos para publish()
    category_settings: categoryInfo.settings || {},
    __ml_has_variation_attributes: categoryInfo.hasVariationAttributes || false
  };

  // ✅ PASO 2: USAR atributos con valores DEL FRONTEND (fuente de verdad)
  if (Array.isArray(mlData.attributes) && mlData.attributes.length > 0) {
    prepared.attributes = mlData.attributes
      .filter(attr => attr.id && (attr.value_name || attr.value_id))
      .map(attr => ({
        id: attr.id,
        value_name: attr.value_name ? String(attr.value_name).trim() : undefined,
        value_id: attr.value_id ? String(attr.value_id).trim() : undefined
      }));
  }

  // ✅ PASO 3: Detectar variantes publicables
  const publishableVariants = (productData.variants || []).filter(v => v.publish && v.price > 0);
  const hasMultipleVariants = publishableVariants.length > 1;
  const hasSingleVariant = publishableVariants.length === 1;

  // ✅ PASO 4: Identificar atributos de variación (usando SOLO metadatos de ML)
  const variationAttrIds = new Set(categoryInfo.variationAttributeIds || []);

  if (hasMultipleVariants && categoryInfo.hasVariationAttributes) {
    // ✅ MÚLTIPLES variantes + categoría con variaciones → construir variations[]
    logger.info(`[ML Adapter] Producto con ${publishableVariants.length} variantes. Construyendo array variations.`);
    
    // Filtrar atributos de variación del nivel base
    const baseAttributes = prepared.attributes.filter(
      a => !variationAttrIds.has(a.id)
    );
    prepared.attributes = baseAttributes;
    
    // Construir variaciones (requiere categoryInfo.attributes con valores permitidos)
    const variations = this.buildValidMercadoLibreVariations(
      publishableVariants,
      categoryInfo.attributes // ← Solo metadatos, NO valores
    );
    
    if (variations && variations.length >= 2) {
      prepared.variations = variations;
      prepared.family_name = productData.name?.trim() || `Producto ${productData.sku || Date.now().toString().slice(-6)}`;
      delete prepared.title;
      logger.info(`[ML Adapter] ✅ Variaciones construidas: ${variations.length}`);
    } else {
      // Fallback: restaurar atributos si falla construcción
      logger.warn(`[ML Adapter] ⚠️ No se construyeron variaciones válidas. Restaurando atributos.`);
      prepared.attributes = mlData.attributes
        .filter(attr => attr.id && (attr.value_name || attr.value_id))
        .map(attr => ({
          id: attr.id,
          value_name: attr.value_name ? String(attr.value_name).trim() : undefined,
          value_id: attr.value_id ? String(attr.value_id).trim() : undefined
        }));
      prepared.variations = undefined;
      delete prepared.family_name;
    }
  } else if (hasSingleVariant) {
    // ✅ 1 sola variante → ML acepta atributos de variación en nivel base
    logger.info(`[ML Adapter] Producto con 1 variante. Permitiendo atributos de variación en nivel base.`);
    
    // ✅ MANTENER TODOS los atributos (incluyendo COLOR, MAIN_COLOR, etc.)
    prepared.attributes = mlData.attributes
      .filter(attr => attr.id && (attr.value_name || attr.value_id))
      .map(attr => ({
        id: attr.id,
        value_name: attr.value_name ? String(attr.value_name).trim() : undefined,
        value_id: attr.value_id ? String(attr.value_id).trim() : undefined
      }));
    
    // Ajustar stock/precio según variante
    const singleVariant = publishableVariants[0];
    prepared.available_quantity = Number(singleVariant.publishStock ?? singleVariant.totalStock ?? productData.totalStock) || 0;
    prepared.price = Number(singleVariant.price) || Number(productData.price) || 0;
    
    prepared.variations = undefined;
    delete prepared.family_name;
  } else {
    // ✅ Sin variantes → producto simple
    logger.info(`[ML Adapter] Producto sin variantes publicables.`);
    prepared.variations = undefined;
    delete prepared.family_name;
  }

  // Validación final
  if (!prepared.title && !prepared.family_name) {
    prepared.title = productData.name?.trim() || 'Producto sin título';
    logger.warn(`[ML Adapter] ⚠️ Forzando título: "${prepared.title}"`);
  }

  logger.info(`[ML Adapter] ✅ Producto preparado:`, {
    category_id: prepared.category_id,
    has_variations: !!prepared.variations,
    variations_count: prepared.variations?.length || 0,
    attributes_count: prepared.attributes?.length || 0,
    has_family_name: !!prepared.family_name,
    ml_has_variation_attrs: prepared.__ml_has_variation_attributes,
    is_catalog: !!(prepared.category_settings?.catalog_domain && prepared.category_settings.catalog_domain !== "MLC-UNCLASSIFIED_PRODUCTS")
  });

  return prepared;
}

// ✅ NUEVO MÉTODO: Obtener SOLO metadatos de la categoría (sin valores de atributos)
async getCategoryMetadata(categoryId, accessToken) {
  try {
    // Obtener settings de la categoría
    const [attributesRes, categoryRes] = await Promise.all([
      axios.get(`https://api.mercadolibre.com/categories/${categoryId}/attributes`, {
        headers: { 'Authorization': `Bearer ${accessToken}` },
        timeout: 10000
      }),
      axios.get(`https://api.mercadolibre.com/categories/${categoryId}`, {
        headers: { 'Authorization': `Bearer ${accessToken}` },
        timeout: 10000
      })
    ]);

    const rawAttributes = Array.isArray(attributesRes.data) ? attributesRes.data : [];
    const categoryData = categoryRes.data || {};

    // ✅ EXTRAER SOLO metadatos (tags, allow_variations, hierarchy, values[])
    const attributes = rawAttributes.map(attr => ({
      id: attr.id,
      name: attr.name,
      tags: attr.tags || {},
      values: attr.values || [], // ← Solo para buildValidMercadoLibreVariations()
      hierarchy: attr.hierarchy
    }));

    const variationAttributes = attributes.filter(
      a => a.tags?.allow_variations === true || a.hierarchy === 'CHILD_PK'
    );

    const hasVariationAttributes = variationAttributes.length > 0;
    const variationAttributeIds = new Set(variationAttributes.map(a => a.id));

    return {
      success: true,
      attributes, // ← Metadatos + valores permitidos (para coincidencias)
      settings: categoryData.settings || {},
      hasVariationAttributes,
      variationAttributeIds,
      isCatalog: !!(categoryData.settings?.catalog_domain && categoryData.settings.catalog_domain !== "MLC-UNCLASSIFIED_PRODUCTS")
    };
  } catch (error) {
    logger.error(`[ML Adapter] Error obteniendo metadatos de categoría ${categoryId}:`, error.message);
    throw new Error(`No se pudieron obtener metadatos de categoría ${categoryId}: ${error.message}`);
  }
}
  // 🔑 Validación específica para MercadoLibre
  validateProduct(product) {
    const errors = [];

    if (!product.category_id) {
      errors.push('category_id es requerido');
    }

    if (product.price <= 0) {
      errors.push('price debe ser mayor a 0');
    }

    // Validación específica: si tiene variaciones, requiere family_name
    if (Array.isArray(product.variations) && product.variations.length > 0 && !product.family_name) {
      errors.push('family_name es requerido cuando existen variaciones');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  // 🔑 MÉTODO AUXILIAR: Construir variaciones (migrado de PublishingService)
  buildValidMercadoLibreVariations(variants, categoryAttributes) {
    if (!Array.isArray(variants) || variants.length === 0) return null;

    const variationAttrs = categoryAttributes.filter(
      a => a.tags?.allow_variations === true || a.hierarchy === 'CHILD_PK'
    );

    if (variationAttrs.length === 0) return null;

    const validVariations = [];

    for (const variant of variants.filter(v => v.publish)) {
      const combinations = [];

      for (const mlAttr of variationAttrs) {
        const match = Object.entries(variant.attributes || {}).find(
          ([key]) => this.normalizeForComparison(key) === this.normalizeForComparison(mlAttr.name)
        );

        if (!match) {
          combinations.length = 0;
          break;
        }

        const value = match[1];
        const combo = { id: mlAttr.id };

        const valueMatch = mlAttr.values?.find(
          v => this.normalizeForComparison(v.name) === this.normalizeForComparison(value)
        );

        if (valueMatch) {
          combo.value_id = valueMatch.id;
          combo.value_name = valueMatch.name;
        } else {
          combo.value_name = String(value);
        }

        combinations.push(combo);
      }

      if (combinations.length === variationAttrs.length) {
        validVariations.push({
          seller_custom_field: variant.sku || String(variant.id),
          price: Number(variant.price),
          available_quantity: Number(variant.publishStock ?? variant.totalStock ?? 0),
          attribute_combinations: combinations
        });
      }
    }

    return validVariations.length >= 1 ? validVariations : null;
  }

  // 🔑 MÉTODO AUXILIAR: Normalización para comparación (migrado de PublishingService)
  normalizeForComparison(str) {
    if (typeof str !== 'string') return '';
    return str
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]/g, ' ')
      .trim()
      .replace(/\s+/g, ' ');
  }

  // === MÉTODOS EXISTENTES (SIN CAMBIOS) ===
  async ensureValidCredentials() {
    this.credential = await MarketplaceCredentialRepository.findByMarketplaceAndUser(
      this.marketplaceId,
      this.userId
    );

    if (!this.credential) {
      logger.info(`[MercadoLibreAdapter] No existe credencial para marketplace ${this.marketplaceId} y user ${this.userId}`);
      const authResponse = await this.getAuthUrl();
      if (authResponse.auth_required) {
        return {
          valid: false,
          auth_required: true,
          auth_url: authResponse.auth_url,
          message: authResponse.message
        };
      } else {
        return {
          valid: false,
          error: "marketplace_credentials_incomplete"
        };
      }
    }

    if (!this.credential.access_token) {
      logger.info("[MercadoLibreAdapter] No hay access_token disponible");
      const authResponse = await this.getAuthUrl();
      return {
        valid: false,
        auth_required: true,
        auth_url: authResponse.auth_url,
        message: authResponse.message
      };
    }

    try {
      const tokenCheck = await axios.get("https://api.mercadolibre.com/users/me", {
        headers: { Authorization: `Bearer ${this.credential.access_token}` },
        timeout: 3000,
      });
      logger.info(`[MercadoLibreAdapter] ✅ Token válido para: ${tokenCheck.data.nickname}`);
      return { valid: true };
    } catch (error) {
      logger.info(`[MercadoLibreAdapter] Token inválido: ${error.message}`);

      if (error.response?.status === 403) {
        logger.error("[MercadoLibreAdapter] Error 403 - App en modo Development. NO intentar refresh.");
        const authResponse = await this.getAuthUrl();
        return {
          valid: false,
          auth_required: true,
          auth_url: authResponse.auth_url,
          message: "App en modo desarrollo. Requiere nueva autorización."
        };
      }

      if (this.credential.refresh_token) {
        try {
          await this.refreshAccessToken();
          return { valid: true };
        } catch (refreshError) {
          logger.error("[MercadoLibreAdapter] Refresh falló:", refreshError.message);
        }
      }

      const authResponse = await this.getAuthUrl();
      return {
        valid: false,
        auth_required: true,
        auth_url: authResponse.auth_url,
        message: "Token expirado o inválido. Requiere reautorización."
      };
    }
  }

  async refreshAccessToken() {
    if (!this.credential.refresh_token) throw new Error("refresh_token_not_available");
    if (!this.credential.client_id || !this.credential.client_secret) throw new Error("client_credentials_missing");

    const oauthTokenUrl = "https://api.mercadolibre.com/oauth/token";
    const params = new URLSearchParams();
    params.append("grant_type", "refresh_token");
    params.append("client_id", this.credential.client_id);
    params.append("client_secret", this.credential.client_secret);
    params.append("refresh_token", this.credential.refresh_token);

    try {
      const response = await axios.post(oauthTokenUrl, params, {
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        timeout: 10000,
      });

      const expiresAt = new Date(Date.now() + response.data.expires_in * 1000);
      const newTokenData = {
        id: this.credential.id,
        access_token: response.data.access_token,
        refresh_token: response.data.refresh_token || this.credential.refresh_token,
        expires_at: expiresAt,
        marketplace_id: this.marketplaceId,
        user_id: this.userId
      };

      await MarketplaceCredentialRepository.createOrUpdate(newTokenData);
      this.credential = { ...this.credential, ...newTokenData };
      logger.info(`[MercadoLibreAdapter] Nuevo token expira: ${expiresAt.toISOString()}`);
      return true;
    } catch (error) {
      if (error.response?.status === 403) {
        logger.error("[MercadoLibreAdapter] ERROR 403 - La app NO está autorizada para refresh");
        throw new Error("app_not_authorized_for_refresh");
      }
      throw new Error(`refresh_failed: ${error.message}`);
    }
  }

  async predictCategory(title) {
    logger.info(`[MercadoLibreAdapter] Prediciendo categoría para título: ${title}`);
    if (!this.credential.access_token) {
      throw new Error("No hay access_token disponible para predicción");
    }

    const siteId = this.getSiteId().trim();
    try {
      const domainDiscoveryUrl = `https://api.mercadolibre.com/sites/${siteId}/domain_discovery/search`;
      const response = await axios.get(domainDiscoveryUrl, {
        params: { q: title.trim(), limit: 8 },
        headers: { Authorization: `Bearer ${this.credential.access_token}` }
      });

      if (!response.data || !Array.isArray(response.data) || response.data.length === 0) {
        throw new Error("No se encontró categoría compatible");
      }

      const prediction = response.data[0];
      const categoryId = prediction.category_id.trim();

      const [attributesRes, categoryRes] = await Promise.all([
        axios.get(`https://api.mercadolibre.com/categories/${categoryId}/attributes`, {
          headers: { Authorization: `Bearer ${this.credential.access_token}` }
        }),
        axios.get(`https://api.mercadolibre.com/categories/${categoryId}`, {
          headers: { Authorization: `Bearer ${this.credential.access_token}` }
        })
      ]);

      const categoryAttributes = Array.isArray(attributesRes.data) ? attributesRes.data : [];
      const categoryInfoData = categoryRes.data || {};

      const catalogDomain = categoryInfoData.settings?.catalog_domain;
      const isUserProduct = !catalogDomain || catalogDomain === "MLC-UNCLASSIFIED_PRODUCTS";

      const requiredAttrs = categoryAttributes.filter(
        attr => attr.tags && (attr.tags.required === true || attr.tags.catalog_required === true)
      );
      const missingAttrs = requiredAttrs.filter(
        attr => !prediction.attributes?.some(a => a.id === attr.id)
      );

      return {
        category_id: categoryId,
        domain_id: prediction.domain_id,
        is_user_product: isUserProduct,
        attributes: prediction.attributes || [],
        missing_required_attributes: missingAttrs,
        category_attributes: categoryAttributes,
        category_settings: categoryInfoData
      };
    } catch (error) {
      logger.error(`[MercadoLibreAdapter] Error en predicción:`, error.message);
      throw error;
    }
  }

  async publish(transformedProduct) {
    try {
      logger.info("[MercadoLibreAdapter] === INICIANDO PUBLICACIÓN ===");
      logger.info(`[DEBUG] Título recibido: "${transformedProduct.title}" (${transformedProduct.title?.length || 0} caracteres)`);
      logger.info(`[DEBUG] Name recibido: "${transformedProduct.name}"`);
      logger.info(`[DEBUG] Family_name recibido: "${transformedProduct.family_name}"`);
      logger.info(`[DEBUG] Category ID: ${transformedProduct.category_id}`);
      logger.info(`[DEBUG] Tiene variaciones: ${!!(Array.isArray(transformedProduct.variations) && transformedProduct.variations.length > 0)}`);
      logger.info(`[DEBUG] Variaciones count: ${transformedProduct.variations?.length || 0}`);

      const credentialStatus = await this.ensureValidCredentials();
      if (!credentialStatus?.valid) {
        return credentialStatus;
      }

      const categoryId = transformedProduct.category_id || '';
      const categorySettings = transformedProduct.category_settings || {};
      const catalogDomain = categorySettings?.settings?.catalog_domain;
      const isCatalogProduct = !!catalogDomain && catalogDomain !== "MLC-UNCLASSIFIED_PRODUCTS";

      const hasVariations =
        Array.isArray(transformedProduct.variations) &&
        transformedProduct.variations.length > 0;

      // 🔑 AJUSTE POST-TRANSFORMACIÓN: Regla ML específica
      if (transformedProduct.__ml_has_variation_attributes) {
        if (!transformedProduct.family_name && transformedProduct.title) {
          // Convertir title → family_name (regla ML para categorías con variaciones)
          transformedProduct.family_name = transformedProduct.title;
          delete transformedProduct.title;
          logger.info(`[ML Adapter] 🔑 Convirtiendo title a family_name: "${transformedProduct.family_name}"`);
        }
      }

      // 🔑 Fallback genérico de seguridad (igual que PublishingService original)
      if (!transformedProduct.family_name && !transformedProduct.title) {
        transformedProduct.title = 
          transformedProduct.name || 
          `Producto ${Date.now().toString().slice(-6)}`;
        logger.warn(`[ML Adapter] ⚠️ Sin family_name ni title → usando fallback: "${transformedProduct.title}"`);
      }

      const productToPublish = {
        site_id: this.getSiteId(),
        category_id: categoryId,
        price: transformedProduct.price,
        available_quantity:
          transformedProduct.available_quantity ??
          transformedProduct.stock ??
          0,
        currency_id: "CLP",
        buying_mode: "buy_it_now",
        listing_type_id: "bronze",
        condition: "new",
        pictures: transformedProduct.pictures || []
      };

      if (Array.isArray(transformedProduct.attributes)) {
        productToPublish.attributes = transformedProduct.attributes;
      }

      if (Array.isArray(transformedProduct.sale_terms)) {
        productToPublish.sale_terms = transformedProduct.sale_terms;
      }

      if (hasVariations) {
        productToPublish.variations = transformedProduct.variations;
      }

      // 🔑 APLICAR REGLA DEFINITIVA DE NAMING
      if (hasVariations) {
        if (isCatalogProduct) {
          let titleValue = (transformedProduct.title || transformedProduct.name || "Producto").toString().trim();
          if (!titleValue || titleValue.length === 0) titleValue = `Producto ${Date.now().toString().slice(-6)}`;
          if (titleValue.length < 6) titleValue = titleValue.padEnd(6, " ");
          if (titleValue.length > 60) titleValue = titleValue.substring(0, 60);
          productToPublish.title = titleValue;
          logger.info(`[DEBUG] 📦 Catálogo con variaciones → title: "${titleValue}"`);
        } else {
          let familyValue = (transformedProduct.family_name || transformedProduct.name || transformedProduct.title || "Producto").toString().trim();
          if (!familyValue || familyValue.length === 0) familyValue = `Producto ${Date.now().toString().slice(-6)}`;
          if (familyValue.length > 60) familyValue = familyValue.substring(0, 60);
          productToPublish.family_name = familyValue;
          logger.info(`[DEBUG] 📦 Variaciones → family_name: "${familyValue}"`);
        }
      } else {
        if (transformedProduct.family_name) {
          let familyValue = transformedProduct.family_name.toString().trim();
          if (familyValue.length > 60) familyValue = familyValue.substring(0, 60);
          productToPublish.family_name = familyValue;
          logger.info(`[DEBUG] 📦 Sin variaciones pero con family_name → usando: "${familyValue}"`);
        } else {
          let title = (transformedProduct.title || transformedProduct.name || "").toString().trim();
          if (!title || title.length === 0) title = `Producto ${Date.now().toString().slice(-6)}`;
          if (title.length < 6) title = title.padEnd(6, " ");
          if (title.length > 60) title = title.substring(0, 60);
          productToPublish.title = title;
          logger.info(`[DEBUG] 📦 Sin variaciones ni family_name → title: "${title}"`);
        }
      }

      logger.info("[MercadoLibreAdapter] === PAYLOAD FINAL QUE SE ENVIARÁ A MERCADO LIBRE ===");
      logger.info(JSON.stringify(productToPublish, null, 2));

      const response = await axios.post(
        "https://api.mercadolibre.com/items",
        productToPublish,
        {
          headers: {
            Authorization: `Bearer ${this.credential.access_token}`,
            "Content-Type": "application/json",
            Accept: "application/json"
          },
          timeout: 30000
        }
      );

      logger.info(`[MercadoLibreAdapter] ✅ Publicado exitosamente: ${response.data.id}`);
      return {
        success: true,
        external_id: response.data.id,
        data: response.data
      };
    } catch (error) {
      logger.error("[MercadoLibreAdapter] ❌ Error en publicación:");
      logger.error(`Error message: ${error.message}`);
      
      if (error.response) {
        logger.error(`Status: ${error.response.status}`);
        logger.error(`Response: ${JSON.stringify(error.response.data, null, 2)}`);
      }
      
      return this.handlePublishError(error);
    }
  }

  handlePublishError(error) {
    if (error.response) {
      const { status, data } = error.response;
      let errorMessage = data?.message || data?.error || `Error ${status} en MercadoLibre`;
      if (data?.cause?.length) {
        errorMessage += ` - ${data.cause.map(c => c.message).join(", ")}`;
      }
      return { success: false, error: errorMessage, status_code: status };
    } else if (error.request) {
      return { success: false, error: `Error de conexión: ${error.message}` };
    } else {
      return { success: false, error: error.message || "Error interno" };
    }
  }

  async getAuthUrl() {
    let basicCred = await MarketplaceCredentialRepository.findByMarketplaceAndUser(
      this.marketplaceId,
      this.userId
    );
    if (!basicCred || !basicCred.client_id || !basicCred.redirect_uri) {
      return { success: false, error: "Credenciales incompletas para autenticación" };
    }

    const requiredScopes = "write offline_access urn:ml:mktp:publish-sync:/read-write";
    const state = `${this.marketplaceId}_${this.userId}`;
    const authUrl = `https://auth.mercadolibre.cl/authorization?response_type=code&client_id=${encodeURIComponent(basicCred.client_id)}&redirect_uri=${encodeURIComponent(basicCred.redirect_uri)}&state=${encodeURIComponent(state)}&scope=${encodeURIComponent(requiredScopes)}`;

    return { auth_required: true, auth_url: authUrl, message: "Se requiere autorización en Mercado Libre" };
  }

  getSiteId() {
    const siteMap = {
      "mercadolibre.cl": "MLC",
      "mercadolibre.com.ar": "MLA",
      "mercadolibre.com.mx": "MLM",
      "mercadolibre.com.co": "MCO",
      "mercadolibre.com.br": "MLB"
    };
    if (this.marketplace?.domain) {
      for (const [domain, siteId] of Object.entries(siteMap)) {
        if (this.marketplace.domain.includes(domain)) return siteId;
      }
    }
    return "MLC";
  }

  static supports(marketplace) {
    return marketplace.domain?.includes("mercadolibre");
  }
}

module.exports = MercadoLibreAdapter;