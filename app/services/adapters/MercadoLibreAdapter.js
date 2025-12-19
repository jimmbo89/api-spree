const BaseAdapter = require("./BaseAdapter");
const logger = require("../../../config/logger");
const { MarketplaceCredentialRepository } = require("../../repositories");
const proxyHelper = require("../../util/proxyHelper");
const MarketplaceTransformerMercadoLibre = require("../MarketplaceTransformerMercadoLibre");

class MercadoLibreAdapter extends BaseAdapter {
  static supportsCategoryPrediction() {
    return true;
  }
  static getTransformer() {
    return MarketplaceTransformerMercadoLibre;
  }
  async ensureValidCredentials() {
    this.credential = await MarketplaceCredentialRepository.findByMarketplaceAndContext(
      this.marketplaceId,
      this.companyId,
      this.branchId
    );
    if (!this.credential) {
      throw new Error("marketplace_credentials_not_found");
    }
    if (!this.credential.access_token) {
      logger.info("[MercadoLibreAdapter] No hay access_token disponible");
      return false;
    }
    try {
      const tokenCheck = await proxyHelper.get("https://api.mercadolibre.com/users/me", {
        headers: { Authorization: `Bearer ${this.credential.access_token}` },
        timeout: 3000,
      });
      logger.info(`[MercadoLibreAdapter] ✅ Token válido para: ${tokenCheck.data.nickname}`);
      return true;
    } catch (error) {
      logger.info(`[MercadoLibreAdapter] Token no funciona: ${error.message}`);
      if (error.response?.status === 403) {
        logger.error("[MercadoLibreAdapter] Error 403 - App en modo Development. NO intentar refresh.");
        return false;
      }
      if (this.credential.refresh_token) {
        try {
          await this.refreshAccessToken();
          return true;
        } catch (refreshError) {
          logger.error("[MercadoLibreAdapter] Refresh falló:", refreshError.message);
          return false;
        }
      }
      return false;
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
      const response = await proxyHelper.post(oauthTokenUrl, params, {
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
        company_id: this.companyId,
        branch_id: this.branchId,
        scopes: response.data.scope || this.credential.scopes,
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
      const response = await proxyHelper.get(domainDiscoveryUrl, {
        params: { q: title.trim(), limit: 8 },
        headers: { Authorization: `Bearer ${this.credential.access_token}` }
      });

      if (!response.data || !Array.isArray(response.data) || response.data.length === 0) {
        throw new Error("No se encontró categoría compatible");
      }

      const prediction = response.data[0];
      const categoryId = prediction.category_id.trim();

      const [attributesRes, categoryRes] = await Promise.all([
        proxyHelper.get(`https://api.mercadolibre.com/categories/${categoryId}/attributes`, {
          headers: { Authorization: `Bearer ${this.credential.access_token}` }
        }),
        proxyHelper.get(`https://api.mercadolibre.com/categories/${categoryId}`, {
          headers: { Authorization: `Bearer ${this.credential.access_token}` }
        })
      ]);

      logger.info(`[MercadoLibreAdapter] Atributos obtenidos para categoría ${categoryId}:`);
      logger.info(JSON.stringify(attributesRes.data));
      logger.info(JSON.stringify(categoryRes.data));

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
    logger.info("[MercadoLibreAdapter] Iniciando publicación...");
    const hasValidCredentials = await this.ensureValidCredentials();
    if (!hasValidCredentials) {
      return await this.getAuthUrl();
    }

    const categoryId = transformedProduct.category_id?.trim();
    const categorySettings = transformedProduct.category_settings;
    let isUserProduct = false;

    if (categorySettings?.settings?.catalog_domain) {
      const catalogDomain = categorySettings.settings.catalog_domain;
      isUserProduct = !catalogDomain || catalogDomain === "MLC-UNCLASSIFIED_PRODUCTS";
    } else {
      isUserProduct = !!transformedProduct.is_user_product;
    }

    const supportsVariations = categorySettings?.attribute_types === "variations";

    // ✅ Siempre incluir price y available_quantity en raíz (ML lo exige)
    const productToPublish = {
      category_id: categoryId,
      price: transformedProduct.price, // ✅ SIEMPRE
      available_quantity: transformedProduct.available_quantity || transformedProduct.stock || 1, // ✅ SIEMPRE
      currency_id: "CLP",
      buying_mode: "buy_it_now",
      listing_type_id: "bronze",
      condition: "new",
      pictures: transformedProduct.pictures || [],
      site_id: this.getSiteId(),
    };

    // ✅ Solo agregar variations si existen
    if (Array.isArray(transformedProduct.variations) && transformedProduct.variations.length > 0) {
      productToPublish.variations = transformedProduct.variations;
    }

    // ✅ family_name solo si NO hay variaciones
    if (!transformedProduct.variations || transformedProduct.variations.length === 0) {
      if (isUserProduct) {
        let familyName = transformedProduct.family_name || (transformedProduct.title || transformedProduct.name || "Producto").substring(0, 60);
        productToPublish.family_name = familyName.trim().substring(0, 60);
      } else {
        const cleanTitle = (transformedProduct.title || transformedProduct.name || "").trim();
        if (cleanTitle.length >= 6 && cleanTitle.length <= 60) {
          productToPublish.title = cleanTitle;
        } else {
          return { success: false, error: "Título inválido. Debe tener entre 6 y 60 caracteres." };
        }
      }
    }

    // atributos
    if (Array.isArray(transformedProduct.attributes)) {
      productToPublish.attributes = transformedProduct.attributes;
    }

    // warranty
    if (Array.isArray(transformedProduct.sale_terms)) {
      productToPublish.sale_terms = transformedProduct.sale_terms;
    }

    logger.info("[MercadoLibreAdapter] === PAYLOAD FINAL ===");
    logger.info(JSON.stringify(productToPublish, null, 2));

    const response = await proxyHelper.post(
      "https://api.mercadolibre.com/items",
      productToPublish,
      {
        headers: {
          Authorization: `Bearer ${this.credential.access_token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        timeout: 30000,
      }
    );

    logger.info(`[MercadoLibreAdapter] ✅ ¡Éxito! ID: ${response.data.id}`);
    return {
      success: true,
      data: response.data,
      external_id: response.data.id,
    };
  } catch (error) {
    logger.error("[MercadoLibreAdapter] Error en publicación:");
    if (error.response) {
      logger.error(`Status: ${error.response.status}`);
      logger.error(`Error: ${JSON.stringify(error.response.data)}`);
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
    const basicCred = await MarketplaceCredentialRepository.findByMarketplaceAndContext(
      this.marketplaceId,
      this.companyId,
      this.branchId
    );
    if (!basicCred || !basicCred.client_id || !basicCred.redirect_uri) {
      return { success: false, error: "Credenciales incompletas para autenticación" };
    }

    const requiredScopes = "write offline_access urn:ml:mktp:publish-sync:/read-write";
    const state = `${this.marketplaceId}_${this.companyId}_${this.branchId || "null"}`;
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