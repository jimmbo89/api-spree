/**
 * Servicio para obtener capacidades dinámicas de MercadoLibre
 * Basado en: https://developers.mercadolibre.com.ar/es_ar/tipos-de-publicacion-y-actualizaciones-de-articulos
 */
const logger = require("../../config/logger");
const axios = require("axios");
const { getFromCache, saveToCache } = require("../../helpers/marketplaceCacheHelper");
const { getMercadoLibreSiteId } = require("../util/marketplaceUtil");

const MercadoLibreCapabilitiesService = {
  
  /**
   * Obtiene los listing types disponibles para un site de ML
   * Endpoint oficial: GET /sites/{site_id}/listing_types
   */
  async getAvailableListingTypes(credential, categoryId = null) {
    const TRACE_ID = `[ML-LT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}]`;
    
    try {
      if (!credential?.access_token) {
        logger.warn(`${TRACE_ID} [ML Capabilities] Sin access_token para consultar listing types`, {
          credential_id: credential?.id,
          has_token: !!credential?.access_token
        });
        return this._buildFallbackResponse('listing_types', 'no_access_token');
      }

      const marketplace = credential.marketplace || {};
      const siteId = getMercadoLibreSiteId(marketplace.domain);
      
      if (!siteId) {
        logger.warn(`${TRACE_ID} [ML Capabilities] No se pudo determinar site_id`, {
          domain: marketplace.domain,
          available_domains: ['mercadolibre.cl', 'mercadolibre.com.ar', 'mercadolivre.com.br']
        });
        return this._buildFallbackResponse('listing_types', 'unknown_site');
      }

      // === Obtener ml_user_id ===
      const mlUserId = this.getMercadoLibreUserId(credential);
      
      // === Cache key ===
      const cacheKey = `listing_types_${siteId}${categoryId ? `_cat${categoryId}` : ''}`;
      const cacheNamespace = `credential_${credential.id}`;
      
      const cached = getFromCache(cacheNamespace, 'capabilities', cacheKey);
      if (cached?.listing_types) {
        logger.info(`${TRACE_ID} [CACHE HIT] Listing types para site ${siteId}`);
        return cached;
      }

      // === CONSULTA 1: Listing types del site (para todos los usuarios) ===
      // Endpoint oficial: https://api.mercadolibre.com/sites/{site_id}/listing_types
      const listingTypesUrl = `https://api.mercadolibre.com/sites/${siteId}/listing_types`;
      
      logger.info(`${TRACE_ID} [ML API] Consultando listing types del site`, {
        url: listingTypesUrl,
        site_id: siteId,
        credential_id: credential.id
      });
      
      let siteListingTypes = [];
      try {
        const ltResponse = await axios.get(listingTypesUrl, {
          headers: { 
            Authorization: `Bearer ${credential.access_token}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          timeout: 10000
        });
        
        logger.info(`${TRACE_ID} [ML API] Respuesta listing types`, {
          status: ltResponse.status,
          count: Array.isArray(ltResponse.data) ? ltResponse.data.length : 0,
          data_sample: Array.isArray(ltResponse.data) ? ltResponse.data.slice(0, 2) : null
        });
        
        if (Array.isArray(ltResponse.data)) {
          siteListingTypes = ltResponse.data.map(lt => ({
            value: lt.id,
            title: lt.id,
            description: lt.name || `Tipo de publicación ${lt.id}`,
            ml_metadata: {
              name: lt.name,
              site_id: lt.site_id,
              // Estos campos pueden venir en la respuesta detallada
              configuration: lt.configuration || null
            }
          }));
        }
      } catch (ltError) {
        logger.error(`${TRACE_ID} [ML API ERROR] listing_types`, {
          url: listingTypesUrl,
          status: ltError.response?.status,
          status_text: ltError.response?.statusText,
          error_message: ltError.message,
          response_data: ltError.response?.data,
          stack: process.env.NODE_ENV === 'development' ? ltError.stack : undefined
        });
        // No retornar fallback aún, intentemos con el endpoint de usuario
      }

      // === CONSULTA 2 (OPCIONAL): Listing types disponibles para este usuario ===
      // Endpoint: /users/{user_id}/available_listing_types?category_id={id}
      let userAvailableTypes = [];
      if (mlUserId) {
        const userLtUrl = `https://api.mercadolibre.com/users/${mlUserId}/available_listing_types`;
        const params = categoryId ? { category_id: categoryId } : {};
        
        logger.info(`${TRACE_ID} [ML API] Consultando listing types disponibles para usuario`, {
          url: userLtUrl,
          params,
          ml_user_id: mlUserId
        });
        
        try {
          const userLtResponse = await axios.get(userLtUrl, {
            params,
            headers: { 
              Authorization: `Bearer ${credential.access_token}`,
              'Content-Type': 'application/json'
            },
            timeout: 10000
          });
          
          // La respuesta puede ser: { available: [...] } o directamente [...]
          const availableData = userLtResponse.data?.available || userLtResponse.data || [];
          
          if (Array.isArray(availableData)) {
            userAvailableTypes = availableData
              .filter(lt => lt.id) // Filtrar tipos con ID válido
              .map(lt => ({
                value: lt.id,
                title: lt.id,
                description: lt.name || `Tipo ${lt.id}`,
                ml_metadata: {
                  name: lt.name,
                  site_id: lt.site_id,
                  remaining_listings: lt.remaining_listings, // Cuotas disponibles
                  user_specific: true // Indicador de que es específico del usuario
                }
              }));
              
            logger.info(`${TRACE_ID} [ML API] Listing types disponibles para usuario`, {
              count: userAvailableTypes.length,
              types: userAvailableTypes.map(t => t.value)
            });
          }
        } catch (userLtError) {
          logger.warn(`${TRACE_ID} [ML API WARN] No se pudieron obtener listing types específicos del usuario`, {
            error: userLtError.message,
            status: userLtError.response?.status,
            fallback_to_site_types: true
          });
          // Si falla, usamos los del site como fallback
        }
      }

      // === Combinar resultados: priorizar los específicos del usuario ===
      const finalListingTypes = userAvailableTypes.length > 0 
        ? userAvailableTypes 
        : (siteListingTypes.length > 0 ? siteListingTypes : []);

      // === Si no hay datos de ninguna fuente, usar fallback ===
      if (finalListingTypes.length === 0) {
        logger.info(`${TRACE_ID} [ML Capabilities] Sin listing types de ninguna fuente, usando fallback`, {
          site_listing_types_count: siteListingTypes.length,
          user_listing_types_count: userAvailableTypes.length
        });
        return this._buildFallbackResponse('listing_types', 'no_data_from_api');
      }

      // === Guardar en cache ===
      const result = {
        listing_types: finalListingTypes,
        _meta: {
          is_fallback: false,
          source: userAvailableTypes.length > 0 ? 'user_specific' : 'site_general',
          fetched_at: new Date().toISOString(),
          site_id: siteId,
          category_id: categoryId || null,
          total_available: finalListingTypes.length
        }
      };
      
      saveToCache(cacheNamespace, 'capabilities', cacheKey, result, 86400); // 24h
      
      // === Persistir en additional_data (best-effort) ===
      await this.persistCapabilitiesInCredential(credential, { 
        listing_types: finalListingTypes.map(lt => lt.value),
        last_listing_types_update: new Date().toISOString()
      });

      logger.info(`${TRACE_ID} [ML Capabilities] Listing types obtenidos exitosamente`, {
        count: finalListingTypes.length,
        source: result._meta.source,
        types: finalListingTypes.map(t => t.value)
      });
      
      return result;

    } catch (error) {
      logger.error(`${TRACE_ID} [ML Capabilities] Error general obteniendo listing types`, {
        error_name: error.name,
        error_message: error.message,
        error_code: error.code,
        response_status: error.response?.status,
        response_data: error.response?.data,
        credential_id: credential?.id,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
      
      return this._buildFallbackResponse('listing_types', 'exception', error.message);
    }
  },

  /**
   * Shipping modes: Valores estáticos documentados
   * Nota: No existe endpoint público /sites/{site}/shipping_modes
   */
  async getAvailableShippingModes(credential) {
    const TRACE_ID = `[ML-SM-${Date.now()}]`;
    
    try {
      const marketplace = credential.marketplace || {};
      const siteId = getMercadoLibreSiteId(marketplace.domain);
      
      logger.info(`${TRACE_ID} [Shipping Modes] Usando valores estáticos documentados`, {
        site_id: siteId,
        reason: 'No existe endpoint público para shipping_modes'
      });
      
      // Valores basados en documentación y comportamiento observado
      const shippingModes = [
        { 
          value: "me2", 
          title: "me2", 
          description: "Mercado Envíos 2 - Logística gestionada por Mercado Libre",
          ml_metadata: {
            name: "Mercado Envíos 2",
            is_default: true,
            supports_logistic_types: ['drop_off', 'cross_docking', 'fulfillment', 'xd_drop_off', 'self_service', 'turbo']
          }
        },
        { 
          value: "me1", 
          title: "me1", 
          description: "Mercado Envíos 1 - Logística propia del vendedor",
          ml_metadata: {
            name: "Mercado Envíos 1",
            is_default: false,
            supports_logistic_types: ['default']
          }
        },
        { 
          value: "custom", 
          title: "custom", 
          description: "Envío personalizado con tabla de precios del vendedor",
          ml_metadata: {
            name: "Custom",
            is_default: false,
            requires_manual_config: true
          }
        },
        { 
          value: "not_specified", 
          title: "not_specified", 
          description: "Sin modo de envío especificado",
          ml_metadata: {
            name: "Not Specified",
            is_default: false
          }
        }
      ];

      return {
        shipping_modes: shippingModes,
        _meta: {
          is_fallback: false,  // No es fallback, son valores oficiales documentados
          source: 'static_documented',
          fetched_at: new Date().toISOString(),
          note: 'Valores basados en documentación oficial de MercadoLibre'
        }
      };

    } catch (error) {
      logger.error(`${TRACE_ID} [Shipping Modes] Error inesperado`, {
        error: error.message
      });
      
      return this._buildFallbackResponse('shipping_modes', 'exception', error.message);
    }
  },

  /**
   * Logistic types: Valores estáticos documentados
   * Nota: No existe endpoint público /sites/{site}/logistic_types
   */
  async getAvailableLogisticTypes(credential) {
    const TRACE_ID = `[ML-LG-${Date.now()}]`;
    
    try {
      const marketplace = credential.marketplace || {};
      const siteId = getMercadoLibreSiteId(marketplace.domain);
      
      logger.info(`${TRACE_ID} [Logistic Types] Usando valores estáticos documentados`, {
        site_id: siteId,
        reason: 'No existe endpoint público para logistic_types'
      });
      
      // Valores basados en documentación y comportamiento observado
      const logisticTypes = [
        { 
          value: "drop_off", 
          title: "drop_off", 
          description: "Drop Off - El vendedor lleva el paquete a un punto de entrega",
          ml_metadata: {
            name: "Drop Off",
            compatible_shipping_mode: "me2",
            is_available_by_default: true
          }
        },
        { 
          value: "cross_docking", 
          title: "cross_docking", 
          description: "Colecta - Mercado Libre recoge el paquete en el domicilio del vendedor",
          ml_metadata: {
            name: "Cross Docking",
            compatible_shipping_mode: "me2",
            requires_approval: true
          }
        },
        { 
          value: "xd_drop_off", 
          title: "xd_drop_off", 
          description: "Places - Puntos de entrega asociados a tiendas físicas",
          ml_metadata: {
            name: "XD Drop Off",
            compatible_shipping_mode: "me2"
          }
        },
        { 
          value: "self_service", 
          title: "self_service", 
          description: "Flex - Logística flexible con horarios extendidos",
          ml_metadata: {
            name: "Self Service",
            compatible_shipping_mode: "me2"
          }
        },
        { 
          value: "turbo", 
          title: "turbo", 
          description: "Turbo - Entrega en menos de 2 horas (disponible en zonas seleccionadas)",
          ml_metadata: {
            name: "Turbo",
            compatible_shipping_mode: "me2",
            geo_restricted: true
          }
        },
        { 
          value: "fulfillment", 
          title: "fulfillment", 
          description: "Full - Almacenamiento y envío gestionado 100% por Mercado Libre",
          ml_metadata: {
            name: "Fulfillment",
            compatible_shipping_mode: "me2",
            requires_enrollment: true
          }
        },
        { 
          value: "default", 
          title: "default", 
          description: "Por defecto - Configuración estándar de logística",
          ml_metadata: {
            name: "Default",
            compatible_shipping_mode: "me1"
          }
        },
        { 
          value: "custom", 
          title: "custom", 
          description: "Personalizado - Configuración manual de logística",
          ml_metadata: {
            name: "Custom",
            compatible_shipping_mode: "custom",
            requires_manual_config: true
          }
        },
        { 
          value: "not_specified", 
          title: "not_specified", 
          description: "No especificado",
          ml_metadata: {
            name: "Not Specified"
          }
        }
      ];

      return {
        logistic_types: logisticTypes,
        _meta: {
          is_fallback: false,  // Valores documentados, no fallback
          source: 'static_documented',
          fetched_at: new Date().toISOString(),
          note: 'Valores basados en documentación oficial de MercadoLibre'
        }
      };

    } catch (error) {
      logger.error(`${TRACE_ID} [Logistic Types] Error inesperado`, {
        error: error.message
      });
      
      return this._buildFallbackResponse('logistic_types', 'exception', error.message);
    }
  },

  /**
   * Helper: Construir respuesta de fallback con metadata clara
   */
  _buildFallbackResponse(resourceType, reason, errorMessage = null) {
    const fallbacks = {
      listing_types: this.getFallbackListingTypes(),
      shipping_modes: this.getFallbackShippingModes(),
      logistic_types: this.getFallbackLogisticTypes()
    };

    return {
      [resourceType]: fallbacks[resourceType] || [],
      _meta: {
        is_fallback: true,
        reason: reason,
        error_message: errorMessage,
        fetched_at: null,
        source: 'static_fallback',
        documentation_url: 'https://developers.mercadolibre.com.ar/es_ar/tipos-de-publicacion-y-actualizaciones-de-articulos'
      }
    };
  },

  /**
   * Extrae ml_user_id de la credencial
   */
  getMercadoLibreUserId(credential) {
    if (!credential) return null;
    if (credential.ml_user_id) return credential.ml_user_id;
    
    const additional = credential.additional_data;
    if (!additional) return null;
    
    if (typeof additional === 'object' && additional !== null) {
      return additional.ml_user_id || null;
    }
    
    if (typeof additional === 'string') {
      try {
        const parsed = JSON.parse(additional);
        return parsed?.ml_user_id || null;
      } catch (e) {
        return null;
      }
    }
    
    return null;
  },

  /**
   * Persiste capabilities en additional_data
   */
  async persistCapabilitiesInCredential(credential, capabilities) {
    try {
      if (!credential?.id) return;
      
      const { MarketplaceCredentialRepository } = require("../repositories");
      
      let additional = credential.additional_data || {};
      if (typeof additional === 'string') {
        try { additional = JSON.parse(additional); } catch (e) { additional = {}; }
      }
      
      await MarketplaceCredentialRepository.updatePartial(credential.id, {
        additional_data: {
          ...additional,
          ml_capabilities: {
            ...(additional.ml_capabilities || {}),
            ...capabilities,
            last_updated: new Date().toISOString()
          }
        }
      });
    } catch (error) {
      logger.warn(`[ML Capabilities] No se pudo persistir en additional_data: ${error.message}`);
    }
  },

  /**
   * Fallbacks estáticos (último recurso)
   */
  getFallbackListingTypes() {
    return [
      { value: "free", title: "free", description: "Publicación gratuita", _is_static_fallback: true, ml_metadata: null },
      { value: "bronze", title: "bronze", description: "Publicación básica", _is_static_fallback: true, ml_metadata: null },
      { value: "silver", title: "silver", description: "Nivel intermedio", _is_static_fallback: true, ml_metadata: null },
      { value: "gold", title: "gold", description: "Publicación premium", _is_static_fallback: true, ml_metadata: null },
      { value: "gold_special", title: "gold_special", description: "Destacada/promocionada", _is_static_fallback: true, ml_metadata: null },
      { value: "gold_pro", title: "gold_pro", description: "Nivel profesional", _is_static_fallback: true, ml_metadata: null },
    ];
  },

  getFallbackShippingModes() {
    return [
      { value: "me2", title: "me2", description: "Mercado Envíos 2", _is_static_fallback: true, ml_metadata: null },
      { value: "me1", title: "me1", description: "Mercado Envíos 1", _is_static_fallback: true, ml_metadata: null },
      { value: "custom", title: "custom", description: "Envío personalizado", _is_static_fallback: true, ml_metadata: null },
      { value: "not_specified", title: "not_specified", description: "Sin modo especificado", _is_static_fallback: true, ml_metadata: null },
    ];
  },

  getFallbackLogisticTypes() {
    return [
      { value: "drop_off", title: "drop_off", description: "Drop Off", _is_static_fallback: true, ml_metadata: null },
      { value: "cross_docking", title: "cross_docking", description: "Colecta", _is_static_fallback: true, ml_metadata: null },
      { value: "xd_drop_off", title: "xd_drop_off", description: "Places", _is_static_fallback: true, ml_metadata: null },
      { value: "self_service", title: "self_service", description: "Flex", _is_static_fallback: true, ml_metadata: null },
      { value: "turbo", title: "turbo", description: "Turbo", _is_static_fallback: true, ml_metadata: null },
      { value: "fulfillment", title: "fulfillment", description: "Full", _is_static_fallback: true, ml_metadata: null },
      { value: "default", title: "default", description: "Por defecto", _is_static_fallback: true, ml_metadata: null },
      { value: "custom", title: "custom", description: "Personalizado", _is_static_fallback: true, ml_metadata: null },
      { value: "not_specified", title: "not_specified", description: "No especificado", _is_static_fallback: true, ml_metadata: null },
    ];
  },

  /**
   * Verifica si una credencial es de MercadoLibre
   */
  isMercadoLibreCredential(credential) {
    if (!credential?.marketplace) return false;
    
    const mp = credential.marketplace;
    const domain = String(mp.domain || '').toLowerCase();
    const type = String(mp.type || '').toLowerCase();
    const code = String(mp.code || '').toUpperCase();
    
    return (
      domain.includes('mercadolibre') ||
      domain.includes('mercadolivre') ||
      type === 'mercadolibre' ||
      ['MLC', 'MLA', 'MLB', 'MCO', 'MPE', 'MLM', 'MLU', 'MLV', 'MPY', 'MBO'].includes(code)
    );
  }
};

module.exports = MercadoLibreCapabilitiesService;