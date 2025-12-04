const BaseAdapter = require('./BaseAdapter');
const axios = require('axios');
const logger = require('../../../config/logger');
const { MarketplaceCredentialRepository } = require('../../repositories');
const proxyHelper = require('../../util/proxyHelper');

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

    try {
      // Verificación rápida del token
      const tokenCheck = await proxyHelper.get('https://api.mercadolibre.com/users/me', {
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
        return false;
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
    
    try {
      const response = await proxyHelper.post(oauthTokenUrl, params, {
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

      // 🔴 ESTO ES LO QUE YA FUNCIONABA EN TU CÓDIGO - NO CAMBIAR
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
          throw new Error('app_not_authorized_for_refresh');
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

  const siteId = this.getSiteId();
  logger.info(siteId);
  
  try {
    const response = await proxyHelper.get(
      `https://api.mercadolibre.com/sites/${siteId}/domain_discovery/search`,
      {
        params: { q: title, limit: 8 },
        headers: { 'Authorization': `Bearer ${this.credential.access_token}` } // AÑADIR token
      }
    );

    if (!response.data || response.data.length === 0) {
      throw new Error('No se encontró categoría compatible');
    }

    const prediction = response.data[0];
    logger.info('Categoría predecida:');
    logger.info(JSON.stringify(prediction));
    
    // 🔴 NUEVO: Obtener información COMPLETA de la categoría para detectar User Products
    const [categoryRes, categoryInfo] = await Promise.all([
      proxyHelper.get(
        `https://api.mercadolibre.com/categories/${prediction.category_id}/attributes`,
        {
          headers: { 'Authorization': `Bearer ${this.credential.access_token}` }
        }
      ),
      proxyHelper.get(
        `https://api.mercadolibre.com/categories/${prediction.category_id}`,
        {
          headers: { 'Authorization': `Bearer ${this.credential.access_token}` }
        }
      )
    ]);
    
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
    
    // Verificar si family_name es requerido
    const categorySettingsRes = await proxyHelper.get(
      `https://api.mercadolibre.com/categories/${prediction.category_id}`,
      {
        headers: { 'Authorization': `Bearer ${this.credential.access_token}` }
      }
    );
    
    // 🔴 NUEVO: Detectar dinámicamente si es User Product
    // User Products generalmente aplica a categorías con:
    // 1. catalog_domain en settings
    // 2. catalog_required attributes
    // 3. domain_id específico
    const isUserProduct = 
      categorySettingsRes.data?.settings?.catalog_domain || // Tiene catalog_domain
      catalogRequired.length > 0 || // Tiene atributos catalog_required
      prediction.domain_id?.includes('CATALOG') || // Dominio es catálogo
      categoryInfo.data?.tags?.includes('catalog_only'); // Solo catálogo
    
    return {
      category_id: prediction.category_id,
      domain_id: prediction.domain_id,
      is_user_product: isUserProduct, // 🔴 NUEVO: Indicador dinámico
      attributes: prediction.attributes || [],
      required_fields: requiredFields,
      catalog_required: catalogRequired,
      category_settings: categorySettingsRes.data || {},
      requires_family_name: categorySettingsRes.data?.settings?.catalog_domain ? true : false
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
      
      // 1. Verificar credenciales
      const hasValidCredentials = await this.ensureValidCredentials();
      
      // 2. Si no hay credenciales válidas, redirigir a auth
      if (!hasValidCredentials) {
        logger.info('[MercadoLibreAdapter] Credenciales inválidas, redirigiendo a auth...');
        return await this.getAuthUrl();
      }

     
    // 🔴 CORRECCIÓN: Verificar si es User Product DE FORMA MÁS PRECISA
    const isUserProduct = transformedProduct.is_user_product || 
                         transformedProduct.category_id === 'MLC7415'; // Categoría específica de cartuchos
    
    logger.info(`[MercadoLibreAdapter] is_user_product: ${isUserProduct}, category: ${transformedProduct.category_id}`);
    
    // 3. CONSTRUIR PAYLOAD SEGÚN EJEMPLO DE DOCUMENTACIÓN
    const productToPublish = {
      // Campos requeridos según ejemplo
      category_id: transformedProduct.category_id,
      price: transformedProduct.price,
      currency_id: transformedProduct.currency_id || 'CLP',
      available_quantity: transformedProduct.available_quantity || transformedProduct.stock || 1,
      buying_mode: transformedProduct.buying_mode || 'buy_it_now',
      listing_type_id: transformedProduct.listing_type_id || 'bronze',
      condition: transformedProduct.condition || 'new',
      pictures: transformedProduct.pictures || [],
      site_id: this.getSiteId()
    };
    
    // 🔴 CORRECCIÓN CRÍTICA: MANEJO EXACTO DEL TÍTULO
    if (transformedProduct.title) {
      // Para User Products (cartuchos MLC7415), usar título GENÉRICO
      if (isUserProduct) {
        // NO usar cleanTitleForUserProduct que elimina todo
        // Usar un título genérico basado en la categoría
        //productToPublish.title = 'Cartucho de tinta';
        logger.info(`[MercadoLibreAdapter] User Product - Título no enviado"`);
      } else {
        // Para productos normales, usar el título original
        productToPublish.title = transformedProduct.title;
        logger.info(`[MercadoLibreAdapter] Producto normal - Título: "${transformedProduct.title}"`);
      }
    } else if (isUserProduct) {
      // Si es User Product y no tiene título, usar genérico
      //productToPublish.title = 'Cartucho de tinta';
      logger.info(`[MercadoLibreAdapter] User Product sin título - Usando genérico: "Cartucho de tinta"`);
    }
      
      // 🔴 CRÍTICO: family_name - REQUERIDO PARA ALGUNAS CATEGORÍAS
      if (transformedProduct.family_name) {
        let familyName = transformedProduct.family_name;
        // Limpiar duplicados (ej: "HP HP" -> "HP")
        familyName = familyName.replace(/(\b\w+\b)(?:\s+\1)+/gi, '$1');
        familyName = familyName.replace(/\s+/g, ' ').trim();
        
        // Asegurar que no esté vacío
        if (familyName && familyName.length >= 3) {
          productToPublish.family_name = familyName;
          logger.info(`[MercadoLibreAdapter] Family_name: "${familyName}"`);
        } else {
          logger.warn(`[MercadoLibreAdapter] Family_name inválido o muy corto: "${familyName}"`);
        }
      }
      
      // 🔴 CRÍTICO: sale_terms - PARA WARRANTY
      if (transformedProduct.sale_terms && Array.isArray(transformedProduct.sale_terms)) {
        productToPublish.sale_terms = transformedProduct.sale_terms;
        logger.info(`[MercadoLibreAdapter] Sale_terms incluido: ${transformedProduct.sale_terms.length} términos`);
      }
      
      // 🔴 ELIMINAR WARRANTY - NO DEBE ESTAR EN EL PAYLOAD
      delete productToPublish.warranty;
      if (transformedProduct.warranty) {
        logger.warn(`[MercadoLibreAdapter] Eliminando warranty del payload (debe ir en sale_terms)`);
      }
      
      // 6. attributes
      if (transformedProduct.attributes && transformedProduct.attributes.length > 0) {
        // Filtrar atributos de warranty (van en sale_terms, no como atributos)
        const attributesWithoutWarranty = transformedProduct.attributes.filter(
          attr => attr.id !== 'WTY_TIME' && 
                 attr.id !== 'WARRANTY' && 
                 attr.id !== 'WARRANTY_TIME' && 
                 attr.id !== 'WARRANTY_TYPE'
        );
        
        productToPublish.attributes = attributesWithoutWarranty.map(attr => {
          return {
            id: attr.id,
            value_name: attr.value_name || attr.value || 'No especificado'
          };
        });
        
        logger.info(`[MercadoLibreAdapter] Atributos: ${attributesWithoutWarranty.length}`);
      }
      
      // 7. seller_custom_field (si existe)
      if (transformedProduct.seller_custom_field) {
        productToPublish.seller_custom_field = transformedProduct.seller_custom_field;
      }
      
      // 🔴 VALIDACIÓN FINAL DEL PAYLOAD
      logger.info('[MercadoLibreAdapter] === PAYLOAD FINAL VALIDADO ===');

      logger.info(JSON.stringify(productToPublish));
      
      // Verificar que no haya warranty en el payload
      if (productToPublish.warranty) {
        logger.error('[MercadoLibreAdapter] ❌ ERROR: warranty aún presente en payload');
        throw new Error('warranty no debe estar en payload, debe ir en sale_terms');
      }
      
      const response = await proxyHelper.post(
        'https://api.mercadolibre.com/items',
        productToPublish,
        {
          headers: {
            'Authorization': `Bearer ${this.credential.access_token}`,
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
      logger.error('[MercadoLibreAdapter] Error en publicación:');
      
      // Log detallado del error
       logger.error('[MercadoLibreAdapter] Error en publicación:');
  
  // Log detallado del error
  if (error.response) {
    logger.error(`Status: ${error.response.status}`);
    logger.error(`Error: ${JSON.stringify(error.response.data)}`);
    
    // 🔴 NUEVO: Si es error 400 con invalid_fields [title], intentar sin título
    if (error.response.status === 400 && 
        error.response.data.error === 'body.invalid_fields' &&
        error.response.data.message?.includes('[title]')) {
      
      logger.info('[MercadoLibreAdapter] Intentando publicación SIN título...');
      
      // Reintentar sin título (para User Products)
      try {
        const productToPublishWithoutTitle = { ...productToPublish };
        delete productToPublishWithoutTitle.title;
        
        const retryResponse = await proxyHelper.post(
          'https://api.mercadolibre.com/items',
          productToPublishWithoutTitle,
          {
            headers: {
              'Authorization': `Bearer ${this.credential.access_token}`,
              'Content-Type': 'application/json',
              'Accept': 'application/json'
            },
            timeout: 30000
          }
        );
        
        logger.info(`[MercadoLibreAdapter] ✅ ¡Éxito en reintento! Producto publicado: ${retryResponse.data.id}`);
        
        return { 
          success: true, 
          data: retryResponse.data,
          external_id: retryResponse.data.id,
          retried: true
        };
        
      } catch (retryError) {
        logger.error('[MercadoLibreAdapter] Reintento falló:', retryError.message);
      }
    } else {
        logger.error(`Error: ${error.message}`);
      }
      
      return this.handlePublishError(error);
    }
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
        
        // Incluir causas si existen
        if (data.cause && data.cause.length > 0) {
          errorMessage += ` - Causas: ${data.cause.map(c => c.message).join(', ')}`;
        }
      }
      
      return {
        success: false,
        error: errorMessage,
        status_code: status,
        details: data
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