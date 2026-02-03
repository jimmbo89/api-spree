const BaseAdapter = require("./BaseAdapter");
const logger = require("../../../config/logger");
const { MarketplaceCredentialRepository } = require("../../repositories");
const axios = require('axios');
const MarketplaceTransformerMercadoLibre = require("../MarketplaceTransformerMercadoLibre");

class MercadoLibreAdapter extends BaseAdapter {
  static supportsCategoryPrediction() {
    return true;
  }
  static getTransformer() {
    return MarketplaceTransformerMercadoLibre;
  }
   async ensureValidCredentials() {
  this.credential = await MarketplaceCredentialRepository.findByMarketplaceAndUser(
    this.marketplaceId,
    this.userId
  );

  // Caso 1: No existe credencial → pedir auth
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

  // Caso 2: No hay access_token → pedir auth
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

  // Caso 3: Verificar validez del token
  try {
    const tokenCheck = await axios.get("https://api.mercadolibre.com/users/me", {
      headers: { Authorization: `Bearer ${this.credential.access_token}` },
      timeout: 3000,
    });
    logger.info(`[MercadoLibreAdapter] ✅ Token válido para: ${tokenCheck.data.nickname}`);
    return { valid: true };
  } catch (error) {
    logger.info(`[MercadoLibreAdapter] Token inválido: ${error.message}`);

    // Si es 403 (modo desarrollo), no intentar refresh
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

    // Intentar refresh si hay refresh_token
    if (this.credential.refresh_token) {
      try {
        await this.refreshAccessToken();
        return { valid: true };
      } catch (refreshError) {
        logger.error("[MercadoLibreAdapter] Refresh falló:", refreshError.message);
      }
    }

    // Si todo falla, pedir nueva autorización
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
        //company_id: this.companyId,
        //branch_id: this.branchId,
        //scopes: response.data.scope || this.credential.scopes,
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
    logger.info(`${title}`);
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

      //logger.info(`[MercadoLibreAdapter] Atributos obtenidos para categoría ${categoryId}:`);
      //logger.info(JSON.stringify(attributesRes.data));
      //logger.info(JSON.stringify(categoryRes.data));

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

    /**
     * 🔑 REGLA DEFINITIVA MERCADO LIBRE
     * - Si hay variaciones → SIEMPRE family_name (a menos que sea catálogo)
     * - Si NO hay variaciones pero la categoría permite variaciones → family_name
     * - Si NO hay variaciones y NO es categoría de variaciones → title
     */
    if (hasVariations) {
      if (isCatalogProduct) {
        // Catálogo con variaciones → title
        let titleValue = (transformedProduct.title || transformedProduct.name || "Producto").toString().trim();
        if (!titleValue || titleValue.length === 0) titleValue = `Producto ${Date.now().toString().slice(-6)}`;
        if (titleValue.length < 6) titleValue = titleValue.padEnd(6, " ");
        if (titleValue.length > 60) titleValue = titleValue.substring(0, 60);
        productToPublish.title = titleValue;
        logger.info(`[DEBUG] 📦 Catálogo con variaciones → title: "${titleValue}"`);
      } else {
        // No catálogo con variaciones → family_name (OBLIGATORIO)
        let familyValue = (transformedProduct.family_name || transformedProduct.name || transformedProduct.title || "Producto").toString().trim();
        if (!familyValue || familyValue.length === 0) familyValue = `Producto ${Date.now().toString().slice(-6)}`;
        if (familyValue.length > 60) familyValue = familyValue.substring(0, 60);
        productToPublish.family_name = familyValue;
        logger.info(`[DEBUG] 📦 Variaciones → family_name: "${familyValue}"`);
      }
    } else {
      // Sin variaciones → determinar por presencia de family_name
      if (transformedProduct.family_name) {
        // Si se proporcionó family_name, usarlo (categoría lo requiere)
        let familyValue = transformedProduct.family_name.toString().trim();
        if (familyValue.length > 60) familyValue = familyValue.substring(0, 60);
        productToPublish.family_name = familyValue;
        logger.info(`[DEBUG] 📦 Sin variaciones pero con family_name → usando: "${familyValue}"`);
      } else {
        // Usar title como fallback
        let title = (transformedProduct.title || transformedProduct.name || "").toString().trim();
        if (!title || title.length === 0) title = `Producto ${Date.now().toString().slice(-6)}`;
        if (title.length < 6) title = title.padEnd(6, " ");
        if (title.length > 60) title = title.substring(0, 60);
        productToPublish.title = title;
        logger.info(`[DEBUG] 📦 Sin variaciones ni family_name → title: "${title}"`);
      }
    }

    // 🔥 LOGGING COMPLETO DEL PAYLOAD FINAL
    logger.info("[MercadoLibreAdapter] === PAYLOAD FINAL QUE SE ENVIARÁ A MERCADO LIBRE ===");
    logger.info(JSON.stringify(productToPublish, null, 2));
    logger.info(`[DEBUG] Campos en payload: ${Object.keys(productToPublish).join(', ')}`);

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
      logger.error(`Response  ${JSON.stringify(error.response.data, null, 2)}`);
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
    logger.info('basicCred');
    logger.info(JSON.stringify(basicCred));
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