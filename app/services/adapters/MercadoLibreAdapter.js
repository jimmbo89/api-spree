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
    // Copia base del producto
    const prepared = {
      ...productData,
      price: productData.price,
      available_quantity: productData.stock ?? 0,
      pictures: productData.images || [],
      name: productData.name,
      title: productData.title || productData.name
    };

    // Solo procesar si tiene datos de MercadoLibre
    const mlData = productData.mercado_libre?.[this.marketplaceId];
    if (!mlData?.category?.category_id) {
      logger.warn(`[ML Adapter] No hay datos de MercadoLibre para producto ${productData.id}`);
      return prepared;
    }

    try {
      // Obtener credenciales y atributos de categoría
      const credential = await MarketplaceCredentialRepository.findByMarketplaceAndUser(
        this.marketplaceId,
        this.userId
      );

      const { attributes: categoryAttributes, success: attrsSuccess } =
        await MercadoLibreAttributesService.getCategoryAttributes(
          mlData.category.category_id,
          credential.access_token
        );

      if (!attrsSuccess) {
        throw new Error(`No se pudieron obtener atributos de categoría ${mlData.category.category_id}`);
      }

      // Asignar categoría
      prepared.category_id = mlData.category.category_id;

      // Separar atributos de variaciones
      const variationAttrIds = new Set(
        categoryAttributes.filter(a => a.tags?.allow_variations).map(a => a.id)
      );

      // Atributos que NO son variaciones
      prepared.attributes = mlData.attributes.filter(
        a => !variationAttrIds.has(a.id)
      );

      // Construir variaciones válidas
      const variations = this.buildValidMercadoLibreVariations(
        productData.variants,
        categoryAttributes
      );

      if (variations && variations.length > 0) {
        prepared.variations = variations;
        logger.info(`[ML Adapter] ✅ Variaciones construidas: ${variations.length}`);
      } else {
        logger.warn(`[ML Adapter] ⚠️ No se construyeron variaciones válidas`);
      }

      // 🔑 family_name si la categoría requiere variaciones
      const hasVariationAttributes = categoryAttributes.some(a => a.tags?.allow_variations);
      if (hasVariationAttributes) {
        prepared.family_name = 
          productData.family_name || 
          productData.name || 
          productData.title || 
          "Producto";
        
        // 🔑 Almacenar flag para ajuste POST-transformación
        prepared.__ml_has_variation_attributes = true;
        logger.info(`[ML Adapter] 🔑 Categoría con atributos de variación → FORZANDO family_name: "${prepared.family_name}"`);
      } else {
        prepared.__ml_has_variation_attributes = false;
      }

      // Preservar category_settings para validación posterior
      prepared.category_settings = mlData.category.settings || {};

      return prepared;

    } catch (error) {
      logger.error(`[ML Adapter] Error preparando producto:`, error);
      throw error;
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

      const categoryId = (transformedProduct.category_id || '').trim();
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