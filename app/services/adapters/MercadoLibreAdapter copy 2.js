const BaseAdapter = require('./BaseAdapter');
const axios = require('axios');
const logger = require('../../../config/logger');
const { MarketplaceCredentialRepository } = require('../../repositories');
const { SocksProxyAgent } = require('socks-proxy-agent');


class MercadoLibreAdapter extends BaseAdapter {

   static supportsCategoryPrediction() {
    return true;
  }
  async ensureValidCredentials() {
    this.credential = await MarketplaceCredentialRepository.findByMarketplaceAndContext(
      this.marketplaceId,
      this.companyId,
      this.branchId
    );

    if (!this.credential) {
      throw new Error('marketplace_credentials_not_found');
    }
    
    // 1. Si no hay access_token, necesitamos autenticación
    if (!this.credential.access_token) {
      logger.info('[MercadoLibreAdapter] No hay access_token disponible');
      return false;
    }

    // 2. **NO verificar la fecha de expiración - solo verificar si el token funciona**
    // Muchos tokens de ML siguen funcionando después de la fecha de "expiración"
    logger.info(`Bearer ${this.credential.access_token}`);
    const agent = new SocksProxyAgent('socks5://127.0.0.1:1080');

    try {
      // Verificación rápida del token
      const tokenCheck = await axios.get('https://api.mercadolibre.com/users/me', {
       httpAgent: agent,
        httpsAgent: agent,
        headers: {
          'Authorization': `Bearer ${this.credential.access_token}`
        },
        timeout: 3000
      });
      
      logger.info(`[MercadoLibreAdapter] ✅ Token válido para: ${tokenCheck.data.nickname}`);
      return true;
      
    } catch (error) {
      logger.info(`[MercadoLibreAdapter] Token no funciona: ${error.message}`);
      
      // Solo intentar refresh si el error NO es 403 (app en desarrollo)
      if (error.response?.status === 403) {
        logger.error('[MercadoLibreAdapter] Error 403 - App probablemente en modo Development. NO intentar refresh.');
        logger.error('[MercadoLibreAdapter] Para producción, cambia la app a modo Production en Mercado Libre Developers');
        return false; // Necesita re-autenticación
      }
      
      // Para otros errores, intentar refresh si hay refresh_token
      if (this.credential.refresh_token) {
        logger.info('[MercadoLibreAdapter] Intentando refresh del token...');
        try {
          await this.refreshAccessToken();
          return true;
        } catch (refreshError) {
          logger.error('[MercadoLibreAdapter] Refresh falló:', refreshError.message);
          return false;
        }
      }
      
      return false;
    }
  }

  async refreshAccessToken() {
    if (!this.credential.refresh_token) {
      throw new Error('refresh_token_not_available');
    }

    if (!this.credential.client_id || !this.credential.client_secret) {
      throw new Error('client_credentials_missing');
    }

    const oauthTokenUrl = 'https://api.mercadolibre.com/oauth/token';
    const params = new URLSearchParams();
    params.append('grant_type', 'refresh_token');
    params.append('client_id', this.credential.client_id);
    params.append('client_secret', this.credential.client_secret);
    params.append('refresh_token', this.credential.refresh_token);

    logger.info('[MercadoLibreAdapter] Refrescando token...');
    logger.info(`- Client ID: ${this.credential.client_id}`);
    logger.info(`- Refresh token: ${this.credential.refresh_token.substring(0, 15)}...`);
    const agent = new SocksProxyAgent('socks5://127.0.0.1:1080');
    
    try {
      const response = await axios.post(oauthTokenUrl, params, {
        httpAgent: agent,
        httpsAgent: agent,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json'
        },
        timeout: 10000
      });

      logger.info('[MercadoLibreAdapter] ✅ Refresh exitoso');
      
      // Calcular nueva fecha de expiración (6 horas)
      const expiresAt = new Date(Date.now() + (response.data.expires_in * 1000));
      
      const newTokenData = {
        id: this.credential.id,
        access_token: response.data.access_token,
        refresh_token: response.data.refresh_token || this.credential.refresh_token,
        expires_at: expiresAt,
        marketplace_id: this.marketplaceId,
        company_id: this.companyId,
        branch_id: this.branchId,
        scopes: response.data.scope || this.credential.scopes
      };

      await MarketplaceCredentialRepository.createOrUpdate(newTokenData);
      this.credential = { ...this.credential, ...newTokenData };
      
      logger.info(`[MercadoLibreAdapter] Nuevo token expira: ${expiresAt.toISOString()}`);
      return true;

    } catch (error) {
      logger.error('[MercadoLibreAdapter] ❌ Error refrescando token:');
      
      if (error.response) {
        const { status, data } = error.response;
        logger.error(`- Status: ${status}`);
        
        if (status === 403) {
          logger.error('[MercadoLibreAdapter] ERROR 403 - La app NO está autorizada para refresh');
          logger.error('[MercadoLibreAdapter] Razón: La aplicación está en modo "Development" en Mercado Libre Developers');
          logger.error('[MercadoLibreAdapter] Solución: Cambia a modo "Production" en https://developers.mercadolibre.cl');
          throw new Error('app_not_authorized_for_refresh');
        }
        
        if (data && typeof data === 'string' && data.includes('<html>')) {
          logger.error('[MercadoLibreAdapter] Respuesta HTML recibida - App no autorizada');
          throw new Error('app_not_in_production_mode');
        }
      }
      
      throw new Error(`refresh_failed: ${error.message}`);
    }
  }
  async predictCategory(title) {
    logger.info('Mercado Libre Adapter predecir categoría');
    logger.info(title);
    logger.info(this.credential.access_token);
    if (!this.credential.access_token) {
      throw new Error('No hay access_token disponible para predicción');
    }

    const siteId = this.getSiteId(); // MLC, MLA, etc.
    logger.info(siteId)
    const agent = new SocksProxyAgent('socks5://127.0.0.1:1080');
    try {
      // ⚠️ IMPORTANTE: NO usar proxy aquí (mercado libre bloquea proxies)
      //https://api.mercadolibre.com/sites/MLC/domain_discovery/search?q=Tinta%20HP%20664%20Magenta
      const response = await axios.get(
        `https://api.mercadolibre.com/sites/${siteId}/domain_discovery/search`,
        {
          params: { q: title, limit: 8 },
          httpAgent: agent,
          httpsAgent: agent
        }
      );

      if (!response.data || response.data.length === 0) {
        throw new Error('No se encontró categoría compatible');
      }

      const prediction = response.data[0];
      logger.info('Categoría predecida:');
      logger.info(JSON.stringify(prediction));
      const categoryRes = await axios.get(
      `https://api.mercadolibre.com/categories/${prediction.category_id}/attributes`,
      {
        httpAgent: agent,
        httpsAgent: agent,
        headers: { 'Authorization': `Bearer ${this.credential.access_token}` }
      }
    );
    logger.info('Categoría predecida atributos:');
      logger.info(JSON.stringify(prediction.attributes));
    const requiredFields = [];
      const catalogRequired = [];
      
      for (const attr of categoryRes.data) {
        if (attr.tags?.catalog_required) {
          catalogRequired.push(attr.id);
        }
        if (attr.tags?.required) {
          requiredFields.push(attr.id);
        }
      }
      
      // Verificar si family_name es requerido (puede estar en metadata de la categoría)
      // O hacer una llamada adicional para obtener settings de la categoría
      const categorySettingsRes = await axios.get(
        `https://api.mercadolibre.com/categories/${prediction.category_id}`,
        {
          httpAgent: agent,
          httpsAgent: agent
        }
      );
      
      return {
        category_id: prediction.category_id,
        attributes: prediction.attributes || [],
        required_fields: requiredFields,
        catalog_required: catalogRequired,
        category_settings: categorySettingsRes.data || {}
      };
    } catch (error) {
      logger.error(`[MercadoLibreAdapter] Error en predicción:`);
      logger.error(error.message);
      throw error;
    }
  }

  async publish(transformedProduct) {
    try {
      logger.info('[MercadoLibreAdapter] Iniciando publicación...');
      
      // 1. Verificar credenciales (pero NO basarse en fecha de expiración)
      const hasValidCredentials = await this.ensureValidCredentials();
      
      // 2. Si no hay credenciales válidas, redirigir a auth
      if (!hasValidCredentials) {
        logger.info('[MercadoLibreAdapter] Credenciales inválidas, redirigiendo a auth...');
        return await this.getAuthUrl();
      }

       // 👇 Construir payload según si es catálogo o no
    const productToPublish = {
      // Campos requeridos base
      title: transformedProduct.title,
      category_id: transformedProduct.category_id,
      price: transformedProduct.price,
      currency_id: transformedProduct.currency_id || 'CLP',
      available_quantity: transformedProduct.available_quantity || transformedProduct.stock || 1,
      buying_mode: transformedProduct.buying_mode || 'buy_it_now',
      listing_type_id: transformedProduct.listing_type_id || 'bronze',
      condition: transformedProduct.condition || 'new',
      pictures: transformedProduct.pictures || [],
      site_id: this.getSiteId(),
      attributes: transformedProduct.attributes || []
    };
    
    // Campos opcionales que pueden ser requeridos por categoría
    if (transformedProduct.seller_custom_field) {
      productToPublish.seller_custom_field = transformedProduct.seller_custom_field;
    }
    
    // family_name - VERIFICAR SI ES REQUERIDO
   if (transformedProduct.family_name) {
      productToPublish.family_name = transformedProduct.family_name;
    } else {
      // Si no viene, generarlo SIN DUPLICAR
      const brandAttr = transformedProduct.attributes?.find(a => a.id === 'BRAND');
      if (brandAttr?.value_name) {
        // Evitar duplicar si el título ya contiene la marca
        const title = transformedProduct.title || '';
        if (title.toUpperCase().includes(brandAttr.value_name.toUpperCase())) {
          // El título ya contiene la marca, usar solo el título
          productToPublish.family_name = title;
        } else {
          // Agregar marca al título para family_name
          productToPublish.family_name = `${brandAttr.value_name} ${title}`;
        }
        logger.info(`[MercadoLibreAdapter] Generando family_name: ${productToPublish.family_name}`);
      } else {
        // Fallback
        productToPublish.family_name = transformedProduct.title || 'Producto genérico';
      }
    }
    
    // warranty - convertir a atributo si existe
    if (transformedProduct.warranty) {
      logger.warn(`[MercadoLibreAdapter] warranty debe ser atributo, eliminando del payload`);
      // Agregar como atributo WTY_TIME si no existe
      const hasWarrantyAttr = productToPublish.attributes.some(a => 
        a.id === 'WARRANTY' || a.id === 'WTY_TIME'
      );
      if (!hasWarrantyAttr) {
        productToPublish.attributes.push({
          id: 'WTY_TIME',
          value_name: transformedProduct.warranty
        });
      }
    }
    
    // ELIMINAR warranty del objeto principal (debe ir como atributo)
    delete productToPublish.warranty;
    
    logger.info('[MercadoLibreAdapter] Payload COMPLETO a enviar:');
    logger.info(JSON.stringify(productToPublish, null, 2));
      const agent = new SocksProxyAgent('socks5://127.0.0.1:1080');
      // 5. Publicar en Mercado Libre
      
     const response = await axios.post( `https://api.mercadolibre.com/items?access_token=${this.credential.access_token}`, JSON.stringify(productToPublish),
          {
            httpAgent: agent,
            httpsAgent: agent,
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'application/json'
            },
            timeout: 30000
          }
        );

      logger.info(`[MercadoLibreAdapter] ✅ ¡Éxito! Producto publicado: ${response.data.id}`);
      
      return { 
        success: true, 
        data: response.data,
        external_id: response.data.id
      };

    } catch (error) {
      /*console.error("ERROR ML:", error.response?.data || error.message);
    throw error;*/
      logger.error('[MercadoLibreAdapter] Error en publicación:');
      logger.error(JSON.stringify(error.response?.data || error.message));
      
      // Si es error 401/403, verificar si es de auth o de publicación
      if (error.response && (error.response.status === 401 || error.response.status === 403)) {
        // Verificar si el token aún funciona
        try {
          await axios.get('https://api.mercadolibre.com/users/me', {
            headers: {
              'Authorization': `Bearer ${this.credential.access_token}`,
              'Accept': 'application/json'
            },
            timeout: 3000
          });
          
          // Si el token SÍ funciona, es error de publicación
          logger.info('[MercadoLibreAdapter] Token funciona, error es de publicación');
          return this.handlePublishError(errorerror.response?.data || error.message);
          
        } catch (tokenError) {
          // Token NO funciona, redirigir a auth
          logger.error('[MercadoLibreAdapter] Token no funciona, redirigiendo a auth...');
          return await this.getAuthUrl();
        }
      }
      
      // Otros errores
      return this.handlePublishError(error);
    }
  }

  handlePublishError(error) {
    if (error.response) {
      const { status, data } = error.response;
      
      logger.error(`[MercadoLibreAdapter] Error ${status}:`);
      
      let errorMessage = `Error ${status} en Mercado Libre`;
      
      if (data) {
        if (typeof data === 'string' && data.includes('<html>')) {
          const match = data.match(/<h4[^>]*>([^<]+)<\/h4>/);
          errorMessage = match ? match[1].trim() : 'Error en la API de Mercado Libre';
        } else if (data.message) {
          errorMessage = data.message;
        } else if (data.error) {
          errorMessage = data.error;
        }
      }
      
      return {
        success: false,
        error: errorMessage,
        status_code: status
      };
      
    } else if (error.request) {
      return {
        success: false,
        error: `Error de conexión: ${error.message}`
      };
    } else {
      return {
        success: false,
        error: error.message
      };
    }
  }

  async getAuthUrl() {
    const basicCred = await MarketplaceCredentialRepository.findByMarketplaceAndContext(
      this.marketplaceId,
      this.companyId,
      this.branchId
    );
    
    if (!basicCred || !basicCred.client_id || !basicCred.redirect_uri) {
      return {
        success: false,
        error: 'Credenciales incompletas para autenticación'
      };
    }

    const requiredScopes = [
      'write',
      'offline_access',
      'urn:ml:mktp:publish-sync:/read-write'
    ].join(' ');
    
    const state = `${this.marketplaceId}_${this.companyId}_${this.branchId || 'null'}`;
    const encodedState = encodeURIComponent(state);
    const encodedScopes = encodeURIComponent(requiredScopes);
    
    let authUrl;
    const siteId = this.getSiteId();
    
    if (siteId === 'MLC') {
      authUrl = `https://auth.mercadolibre.cl/authorization?response_type=code&client_id=${encodeURIComponent(basicCred.client_id)}&redirect_uri=${encodeURIComponent(basicCred.redirect_uri)}&state=${encodedState}&scope=${encodedScopes}`;
    } else {
      authUrl = `https://auth.mercadolibre.com.ar/authorization?response_type=code&client_id=${encodeURIComponent(basicCred.client_id)}&redirect_uri=${encodeURIComponent(basicCred.redirect_uri)}&state=${encodedState}&scope=${encodedScopes}`;
    }
    
    return {
      auth_required: true,
      auth_url: authUrl,
      message: 'Se requiere autorización en Mercado Libre'
    };
  }

  getSiteId() {
    const siteMap = {
      'mercadolibre.cl': 'MLC',
      'mercadolibre.com.ar': 'MLA',
      'mercadolibre.com.mx': 'MLM',
      'mercadolibre.com.co': 'MCO',
      'mercadolibre.com.br': 'MLB'
    };

    if (this.marketplace && this.marketplace.domain) {
      for (const [domain, siteId] of Object.entries(siteMap)) {
        if (this.marketplace.domain.includes(domain)) {
          return siteId;
        }
      }
    }

    return 'MLC';
  }

  static supports(marketplace) {
    return marketplace.domain?.includes('mercadolibre');
  }
}

module.exports = MercadoLibreAdapter;