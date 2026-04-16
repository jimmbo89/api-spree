const logger = require("../../config/logger");
const axios = require("axios");
const qs = require("qs");
const {
  MarketplaceCredentialRepository,
  LogRepository,
  CategoryCommissionRepository,
} = require("../repositories");
const { getRequestMetadata } = require("../util/requestUtil");
const { getUserId } = require("../../config/context");
const crypto = require("crypto");
const { getFromCache, clearMarketplaceCache, clearAllCache, saveToCache, getCacheStats } = require("../../helpers/marketplaceCacheHelper");
const { marketplaceRateLimiter } = require("../../config/rateLimiter");
const { getMercadoLibreSiteId } = require("../util/marketplaceUtil");

const rfc3986Encode = (str) =>
  encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );

const timestampMinus03 = (date = new Date()) => {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}-03:00`
  );
};

const OAuthController = {
async mercadoLibreCallback(req, res) {
  const { code, state } = req.body;
  logger.info("Datos recibidos actualizar las credenciales de mercado libre:");
  logger.info(JSON.stringify(req.body));
  const metadata = getRequestMetadata(req);
  let credentialIdForCleanup = null;

  if (!code || !state) {
    logger.warn("OAuth callback sin code o state");
    return res.status(400).json({ error: 'Datos incompletos: se requieren "code" y "state"' });
  }

  try {
    // ✅ Parsear credential_id del state (formato: marketplaceId_userId_credentialId)
    const stateParts = state.split("_");
    const marketplaceId = stateParts[0];
    const userId = stateParts[1];
    const credentialId = stateParts[2];

    credentialIdForCleanup = credentialId; 
    
    // ✅ Buscar credencial específica por ID
    const credential = credentialId 
      ? await MarketplaceCredentialRepository.findById(credentialId)
      : await MarketplaceCredentialRepository.findByMarketplaceAndUser(marketplaceId, userId);

    logger.info("Credenciales básicas obtenidas para OAuth Mercado Libre");
    logger.info(JSON.stringify(credential));

    const marketplace = credential?.marketplace || {};

    if (!credential || !marketplace.client_id || !marketplace.client_secret) {
      throw new Error("Credenciales OAuth incompletas en la base de datos");
    }

    // ✅ URL oficial de tokens (sin espacios)
    const oauthTokenUrl = "https://api.mercadolibre.com/oauth/token";

    logger.info("[OAuth] Enviando solicitud a Mercado Libre");

    // ✅ Obtener tokens
    const tokenRes = await axios.post(
      oauthTokenUrl,
      qs.stringify({
        grant_type: "authorization_code",
        client_id: marketplace.client_id,
        client_secret: marketplace.client_secret,
        code: code,
        redirect_uri: marketplace.redirect_uri.trim(),
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      },
    );

    logger.info("[OAuth] Tokens recibidos correctamente");

    if (!tokenRes.data.access_token || !tokenRes.data.refresh_token) {
      throw new Error(
        "Respuesta de Mercado Libre no contiene access_token o refresh_token",
      );
    }

    // ✅ NUEVO: Obtener datos del usuario de ML para validar duplicados
    const mlUserRes = await axios.get("https://api.mercadolibre.com/users/me", {
      headers: { Authorization: `Bearer ${tokenRes.data.access_token}` },
      timeout: 5000,
    });

    const mlUserId = mlUserRes.data?.id;
    
    if (!mlUserId) {
      throw new Error("No se pudo obtener el ID del usuario de MercadoLibre");
    }

    logger.info(`[OAuth] ML User ID obtenido: ${mlUserId}`);

    const allCredentials = await MarketplaceCredentialRepository.findByUser(userId);

    function getMLUserIdFromCredential(cred) {
  if (!cred.additional_data) return null;
  
  // Si ya es objeto (depende de configuración de Sequelize)
  if (typeof cred.additional_data === 'object') {
    return cred.additional_data.ml_user_id;
  }
  
  // Si es string JSON, parsearlo
  try {
    const parsed = JSON.parse(cred.additional_data);
    return parsed?.ml_user_id;
  } catch (e) {
    return null;
  }
}
    
    // Filtrar las que son de este marketplace y tienen el mismo ml_user_id
    const duplicateCredential = allCredentials.find(c => 
      c.marketplace_id === Number(marketplaceId) &&
      c.id !== credential.id &&  // Excluir la credencial actual
      getMLUserIdFromCredential(c) === mlUserId  // Mismo usuario de ML
    );

    if (duplicateCredential) {
      logger.warn(`[OAuth] DUPLICADO DETECTADO: ML user ${mlUserId} ya existe en credencial ${duplicateCredential.id}`);
      
      // ✅ ELIMINAR la credencial en proceso (la que se está creando)
      // ELIMINAR la credencial en proceso (la que se está creando)
      try {
        await MarketplaceCredentialRepository.deleteById(credential.id);
        logger.info(`[OAuth] Credencial ${credential.id} eliminada por duplicado`);
      } catch (deleteError) {
        logger.error('[OAuth] Error eliminando credencial duplicada:', deleteError.message);
      }

      return res.status(409).json({
        success: false,
        error: "duplicate_ml_account",
        message: `Ya tienes una conexión con esta cuenta de MercadoLibre (Usuario ML: ${mlUserId}). Nombre de conexión existente: "${duplicateCredential.name}"`,
        existing_credential: {
          id: duplicateCredential.id,
          name: duplicateCredential.name,
          country: duplicateCredential.country,
          ml_user_id: mlUserId
        }
      });
    }


    // ✅ No hay duplicado: guardar tokens + ml_user_id en additional_data
    const updatedAdditionalData = {
      ...(credential.additional_data || {}),
      ml_user_id: mlUserId  // ← Guardar ID de usuario de ML
    };

    await MarketplaceCredentialRepository.updatePartial(credential.id, {
      access_token: tokenRes.data.access_token,
      refresh_token: tokenRes.data.refresh_token,
      expires_at: new Date(Date.now() + tokenRes.data.expires_in * 1000),
      additional_data: updatedAdditionalData  // ← NUEVO: Incluir ml_user_id
    });

    await LogRepository.create({
      user_id: userId,
      action: "oauth.mercadolibre.success",
      description: `Tokens guardados para ML user ${mlUserId}`,
      ip_address: metadata.ip_address,
      user_agent: metadata.user_agent,
      status: "success",
      meta: { 
        marketplace_id: marketplaceId,
        credential_id: credential.id,
        ml_user_id: mlUserId
      },
    });
    credentialIdForCleanup = null;
    return res.status(200).json({
      success: true,
      message: "Tokens de Mercado Libre guardados correctamente",
      data: {
        marketplace_id: marketplaceId,
        credential_id: credential.id,
        ml_user_id: mlUserId,  // ← NUEVO: Para referencia del frontend
        access_token: "[REDACTADO]",
        refresh_token: "[REDACTADO]",
        expires_in: tokenRes.data.expires_in,
      },
    });

  } catch (error) {
    logger.error("OAuth callback error:", {
      message: error.message,
      stack: error.stack,
      code: req.body.code?.substring(0, 10),
      state: req.body.state,
    });

     if (credentialIdForCleanup) {
      try {
        const cred = await MarketplaceCredentialRepository.findById(credentialIdForCleanup);
        // Solo eliminar si NO tiene access_token (está pendiente de OAuth)
        if (cred && !cred.access_token) {
          await MarketplaceCredentialRepository.deleteById(credentialIdForCleanup);
          logger.info(`[OAuth] Credencial huérfana eliminada: ${credentialIdForCleanup}`);
        }
      } catch (deleteError) {
        logger.error('[OAuth] Error limpiando credencial huérfana:', deleteError.message);
      }
    }

    await LogRepository.create({
      user_id: req.body.userId,
      action: "oauth.mercadolibre.error",
      description: `Error en OAuth: ${error.message}`,
      ip_address: metadata.ip_address,
      user_agent: metadata.user_agent,
      status: "error",
      meta: { error: error.message },
    });

    return res.status(500).json({
      success: false,
      error: error.message || "Error interno al procesar el callback de Mercado Libre",
    });
  }
},
  async mercadoLibreCategory(req, res) {
    const {
      productName,
      site_id,
      marketplace_id,
      user_id: bodyUserId,
    } = req.body;
    const user_id = bodyUserId || getUserId();
    logger.info(
      "Datos recibidos al optener ls categorías de un producto en mercado libre:",
    );
    logger.info(JSON.stringify(req.body));

    try {
      const credential =
        await MarketplaceCredentialRepository.findByMarketplaceAndUser(
          marketplace_id,
          user_id,
        );
      logger.info("Credenciales básicas obtenidas para OAuth Mercado Libre");
      logger.info(JSON.stringify(credential));

      const domainDiscoveryUrl = `https://api.mercadolibre.com/sites/${site_id}/domain_discovery/search`;
      const response = await axios.get(domainDiscoveryUrl, {
        params: { q: productName, limit: 8 }, //,
        //headers: { Authorization: `Bearer ${credential.access_token}` }
      });

      return res.status(200).json({
        success: true,
        categories: response.data,
      });
    } catch (error) {
      logger.error("OAuth Category error:", {
        message: error.message,
        stack: error.stack,
      });

      return res.status(500).json({
        success: false,
        error:
          error.message ||
          "Error interno al obtener las categorías de Mercado Libre",
      });
    }
  },

  async mercadoLibreAttributes(req, res) {
    const { category_id, marketplace_id, user_id: bodyUserId } = req.body;
    const user_id = bodyUserId || getUserId();
    logger.info(
      "Datos recibidos al optener los atributos de una categoría en mercado libre:",
    );
    logger.info(JSON.stringify(req.body));

    try {
      const credential =
        await MarketplaceCredentialRepository.findByMarketplaceAndUser(
          marketplace_id,
          user_id,
        );
      logger.info("Credenciales básicas obtenidas para OAuth Mercado Libre");
      logger.info(JSON.stringify(credential));

      const domainCategoriesUrl = `https://api.mercadolibre.com/categories/${category_id}/attributes`;
      const response = await axios.get(domainCategoriesUrl, {
        headers: { Authorization: `Bearer ${credential.access_token}` },
      });

      return res.status(200).json({
        success: true,
        attributes: response.data,
      });
    } catch (error) {
      logger.error("OAuth Category error:", {
        message: error.message,
        stack: error.stack,
      });

      return res.status(500).json({
        success: false,
        error:
          error.message ||
          "Error interno al obtener los atributos de Mercado Libre",
      });
    }
  },

  // controllers/marketplace/mercadoLibreController.js

/*async mercadoLibreSuggestedCategoriesWithAttributes(req, res) {
  logger.info(`Datos recibidos para categorías sugeridas con atributos en MercadoLibre:\n ${JSON.stringify(req.body)}`);

  const { marketplace_id, site_id, products } = req.body;
  const user_id = req.user?.id || req.body.user_id;

  if (!site_id || !['MLC', 'MLA', 'MLB', 'MCO', 'MPE', 'MLM', 'MLU', 'MLV', 'MPY', 'MBO', 'MEC', 'MCR', 'MPA', 'MRD', 'MGT', 'MHN', 'MNI', 'MSV', 'MCU'].includes(site_id)) {
    return res.status(400).json({
      success: false,
      error: "site_id inválido o no soportado"
    });
  }

  if (!Array.isArray(products) || products.length === 0) {
    return res.status(400).json({
      success: false,
      error: "Se requiere un array no vacío de productos con 'id' y 'name'."
    });
  }

  try {
    // === PASO 1: Aplicar Rate Limit por usuario ===
    try {
      await marketplaceRateLimiter.consume(user_id);
    } catch (rateLimitError) {
      logger.warn(`Rate limit excedido para usuario ${user_id}`);
      return res.status(429).json({
        success: false,
        error: "Demasiadas solicitudes. Por favor, espera un momento."
      });
    }

    // === PASO 2: Obtener Credenciales ===
    const credential = await MarketplaceCredentialRepository.findByMarketplaceAndUser(
      marketplace_id,
      user_id
    );

    if (!credential) {
      return res.status(400).json({
        success: false,
        error: "Credenciales no encontradas"
      });
    }

    const suggestions = [];
    let cacheHits = 0;
    let apiCalls = 0;

    // === PASO 3: Procesar Cada Producto ===
    for (const product of products) {
      if (!product.id || !product.name) {
        logger.warn(`Producto inválido omitido: ${JSON.stringify(product)}`);
        continue;
      }

      const nameFixed = product.name.trim();

      // === PASO 4: Verificar Caché GLOBAL para este Producto ===
      const cachedProductResult = getFromCache(marketplace_id, `product_suggestion_${site_id}`, nameFixed);

      if (cachedProductResult) {
        logger.info(`[CACHE HIT] Producto "${nameFixed}" en MercadoLibre ${site_id} (compartido)`);
        cacheHits++;
        
        suggestions.push({
          product_id: product.id,
          categories: cachedProductResult
        });
        continue;
      }

      logger.info(`[CACHE MISS] Producto "${nameFixed}" en MercadoLibre ${site_id}`);
      apiCalls++;

      let categories = [];

      // === PASO 5: Obtener Categorías Sugeridas ===
      try {
        // ✅ URL CORREGIDA: sin espacios
        const domainDiscoveryUrl = `https://api.mercadolibre.com/sites/${site_id}/domain_discovery/search`;
        const catResponse = await axios.get(domainDiscoveryUrl, {
          params: { q: nameFixed, limit: 3 },
          timeout: 20000
        });

        const rawCategories = catResponse.data || [];
        logger.info(`Categorías obtenidas:\n ${JSON.stringify(rawCategories)}`);
        
        // ✅ Mapeo correcto de campos
        categories = rawCategories.map(cat => ({
          category_id: cat.category_id,
          category_name: cat.category_name,
          domain_id: cat.domain_id,
          domain_name: cat.domain_name,
          path: cat.domain_name || ''
        }));
      } catch (catErr) {
        logger.error(`Error al obtener categorías para "${nameFixed}": ${catErr.message}`);
        continue;
      }

      // === PASO 6: Para cada categoría, cargar atributos ===
      const categoriesWithAttrs = [];
      
      for (const cat of categories) {
        if (!cat.category_id) {
          logger.warn(`Categoría sin ID omitida: ${JSON.stringify(cat)}`);
          continue;
        }

        // === PASO 7: Verificar Caché GLOBAL para esta Categoría ===
        const cachedCategory = getFromCache(marketplace_id, `category_attributes_${site_id}`, cat.category_id);

        if (cachedCategory) {
          logger.info(`[CACHE HIT] Categoría ${cat.category_id} en MercadoLibre ${site_id} (compartido)`);
          categoriesWithAttrs.push(cachedCategory);
          continue;
        }

        logger.info(`[CACHE MISS] Categoría ${cat.category_id} en MercadoLibre ${site_id}`);

        let attributes = [];
        try {
          // ✅ URL CORREGIDA: sin espacios
          const attrUrl = `https://api.mercadolibre.com/categories/${cat.category_id}/attributes`;
          const attrResponse = await axios.get(attrUrl, {
            headers: { Authorization: `Bearer ${credential.access_token}` },
            timeout: 20000
          });

          const rawAttrs = attrResponse.data || [];
          logger.info(`Atributos obtenidos para categoría ${cat.category_id}: ${rawAttrs.length} atributos`);
          
          // ✅ DEVOLVER ATRIBUTOS SIN MODIFICAR - TAL CUAL COMO VIENEN DE MERCADOLIBRE
          attributes = rawAttrs;
        } catch (attrErr) {
          logger.error(`Error al cargar atributos para categoría ${cat.category_id}: ${attrErr.message}`);
        }

        // === PASO 8: Guardar Categoría en Caché GLOBAL ===
        const categoryData = {
          category_id: cat.category_id,
          category_name: cat.category_name,
          domain_id: cat.domain_id,
          domain_name: cat.domain_name,
          path: cat.path,
          attributes // ✅ Atributos sin modificar
        };

        saveToCache(marketplace_id, `category_attributes_${site_id}`, cat.category_id, categoryData);
        categoriesWithAttrs.push(categoryData);
      }

      // === PASO 9: Guardar Resultado del Producto en Caché GLOBAL ===
      saveToCache(marketplace_id, `product_suggestion_${site_id}`, nameFixed, categoriesWithAttrs);

      suggestions.push({
        product_id: product.id,
        categories: categoriesWithAttrs
      });
    }

    // === PASO 10: Retornar Resultado con Estadísticas ===
    return res.status(200).json({
      success: true,
      suggestions,
      count: suggestions.length,
      stats: {
        total_products: products.length,
        cache_hits: cacheHits,
        api_calls: apiCalls,
        cache_hit_rate: products.length > 0 
          ? ((cacheHits / products.length) * 100).toFixed(2) + '%'
          : '0%'
      }
    });

  } catch (error) {
    logger.error(`❌ Error general en mercadoLibreSuggestedCategoriesWithAttributes: ${error.message}`, {
      stack: error.stack,
      body: req.body
    });
    return res.status(500).json({
      success: false,
      error: "Error interno al procesar categorías con atributos de MercadoLibre."
    });
  }
},*/
/*async mercadoLibreSuggestedCategoriesWithAttributes(req, res) {
  logger.info(`Datos recibidos para categorías sugeridas con atributos en MercadoLibre:\n ${JSON.stringify(req.body)}`);

  // ← CAMBIO: Recibir credential_id en lugar de marketplace_id
  const { credential_id, products } = req.body;
  const user_id = req.user?.id || req.body.user_id;

  if (!credential_id) {
    return res.status(400).json({
      success: false,
      error: "credential_id es requerido"
    });
  }

  if (!Array.isArray(products) || products.length === 0) {
    return res.status(400).json({
      success: false,
      error: "Se requiere un array no vacío de productos con 'id' y 'name'."
    });
  }

  try {
    // === PASO 1: Aplicar Rate Limit por usuario ===
    try {
      await marketplaceRateLimiter.consume(user_id);
    } catch (rateLimitError) {
      logger.warn(`Rate limit excedido para usuario ${user_id}`);
      return res.status(429).json({
        success: false,
        error: "Demasiadas solicitudes. Por favor, espera un momento."
      });
    }

    // === PASO 2: Obtener Credencial ESPECÍFICA por ID ← CAMBIO
    const credential = await MarketplaceCredentialRepository.findById(credential_id);

    if (!credential) {
      return res.status(404).json({
        success: false,
        error: "Credencial no encontrada"
      });
    }

    // Verificar propiedad
    if (credential.user_id !== user_id) {
      return res.status(403).json({
        success: false,
        error: "No autorizado"
      });
    }

    const marketplace_id = credential.marketplace_id;
    const site_id = getMercadoLibreSiteId(credential.marketplace?.domain);

    const suggestions = [];
    let cacheHits = 0;
    let apiCalls = 0;

    for (const product of products) {
      if (!product.id || !product.name) {
        logger.warn(`Producto inválido omitido: ${JSON.stringify(product)}`);
        continue;
      }

      const nameFixed = product.name.trim();

      // ← CAMBIO: Usar credential_id en la clave de caché
      const cachedProductResult = getFromCache(`credential_${credential_id}`, `product_suggestion_${site_id}`, nameFixed);

      if (cachedProductResult) {
        logger.info(`[CACHE HIT] Producto "${nameFixed}" en credential ${credential_id}`);
        cacheHits++;
        
        suggestions.push({
          product_id: product.id,
          credential_id: credential_id,
          marketplace_id: marketplace_id,
          categories: cachedProductResult
        });
        continue;
      }

      logger.info(`[CACHE MISS] Producto "${nameFixed}" en credential ${credential_id}`);
      apiCalls++;

      let categories = [];

      try {
        const domainDiscoveryUrl = `https://api.mercadolibre.com/sites/${site_id}/domain_discovery/search`;
        const catResponse = await axios.get(domainDiscoveryUrl, {
          params: { q: nameFixed, limit: 3 },
          timeout: 20000
        });

        const rawCategories = catResponse.data || [];
        logger.info(`Categorías obtenidas:\n ${JSON.stringify(rawCategories)}`);
        
        categories = rawCategories.map(cat => ({
          category_id: cat.category_id,
          category_name: cat.category_name,
          domain_id: cat.domain_id,
          domain_name: cat.domain_name,
          path: cat.domain_name || ''
        }));
      } catch (catErr) {
        logger.error(`Error al obtener categorías para "${nameFixed}": ${catErr.message}`);
        continue;
      }

      const categoriesWithAttrs = [];
      
      for (const cat of categories) {
        if (!cat.category_id) {
          logger.warn(`Categoría sin ID omitida: ${JSON.stringify(cat)}`);
          continue;
        }

        const cachedCategory = getFromCache(`credential_${credential_id}`, `category_attributes_${site_id}`, cat.category_id);

        if (cachedCategory) {
          logger.info(`[CACHE HIT] Categoría ${cat.category_id} en credential ${credential_id}`);
          categoriesWithAttrs.push(cachedCategory);
          continue;
        }

        logger.info(`[CACHE MISS] Categoría ${cat.category_id} en credential ${credential_id}`);

        let attributes = [];
        try {
          const attrUrl = `https://api.mercadolibre.com/categories/${cat.category_id}/attributes`;
          const attrResponse = await axios.get(attrUrl, {
            headers: { Authorization: `Bearer ${credential.access_token}` },
            timeout: 20000
          });

          const rawAttrs = attrResponse.data || [];
          logger.info(`Atributos obtenidos para categoría ${cat.category_id}: ${rawAttrs.length} atributos`);
          
          attributes = rawAttrs;
        } catch (attrErr) {
          logger.error(`Error al cargar atributos para categoría ${cat.category_id}: ${attrErr.message}`);
        }

        const categoryData = {
          category_id: cat.category_id,
          category_name: cat.category_name,
          domain_id: cat.domain_id,
          domain_name: cat.domain_name,
          path: cat.path,
          attributes
        };

        categoriesWithAttrs.push(categoryData);
      }

      saveToCache(`credential_${credential_id}`, `product_suggestion_${site_id}`, productCacheKey, categoriesWithAttrs);

      suggestions.push({
        product_id: product.id,
        credential_id: credential_id,
        marketplace_id: marketplace_id,
        categories: categoriesWithAttrs
      });
    }

    return res.status(200).json({
      success: true,
      suggestions,
      count: suggestions.length,
      stats: {
        total_products: products.length,
        cache_hits: cacheHits,
        api_calls: apiCalls,
        cache_hit_rate: products.length > 0 
          ? ((cacheHits / products.length) * 100).toFixed(2) + '%'
          : '0%'
      }
    });

  } catch (error) {
    logger.error(`❌ Error general en mercadoLibreSuggestedCategoriesWithAttributes: ${error.message}`, {
      stack: error.stack,
      body: req.body
    });
    return res.status(500).json({
      success: false,
      error: "Error interno al procesar categorías con atributos de MercadoLibre."
    });
  }
},*/
/*
async mercadoLibreSuggestedCategoriesWithAttributes(req, res) {
  logger.info(`Datos recibidos para categorías sugeridas con atributos y pricing en MercadoLibre:\n ${JSON.stringify(req.body)}`);

  // ✅ CORRECCIÓN: NO extraer 'price' global, viene dentro de cada producto
  const { credential_id, products, listing_type_id } = req.body;
  const user_id = req.user?.id || req.body.user_id;

  if (!credential_id) {
    return res.status(400).json({ success: false, error: "credential_id es requerido" });
  }

  if (!Array.isArray(products) || products.length === 0) {
    return res.status(400).json({
      success: false,
      error: "Se requiere un array no vacío de productos con 'id' y 'name'."
    });
  }

  const listingType = listing_type_id || 'gold_special'; // Default a gold_special

  try {
    // === PASO 1: Rate Limit ===
    try {
      await marketplaceRateLimiter.consume(user_id);
    } catch (rateLimitError) {
      logger.warn(`Rate limit excedido para usuario ${user_id}`);
      return res.status(429).json({
        success: false,
        error: "Demasiadas solicitudes. Por favor, espera un momento."
      });
    }

    // === PASO 2: Obtener Credencial ===
    const credential = await MarketplaceCredentialRepository.findById(credential_id);
    if (!credential) {
      return res.status(404).json({ success: false, error: "Credencial no encontrada" });
    }

    if (credential.user_id !== user_id) {
      return res.status(403).json({ success: false, error: "No autorizado" });
    }

    const marketplace_id = credential.marketplace_id;
    const site_id = getMercadoLibreSiteId(credential.marketplace?.domain);

    const suggestions = [];
    let cacheHits = 0;
    let apiCalls = 0;
    let pricingCalls = 0;

    // === PROCESAR CADA PRODUCTO ===
    for (const product of products) {
      if (!product.id || !product.name) {
        logger.warn(`Producto inválido omitido: ${JSON.stringify(product)}`);
        continue;
      }

      const nameFixed = product.name.trim();
      
      // ✅ CORRECCIÓN CLAVE: Obtener price DE CADA PRODUCTO, no global
      const productPrice = (product.price !== undefined && product.price !== null && !isNaN(product.price))
        ? parseFloat(product.price)
        : null;

      // Cache de producto debe variar por listing_type_id (y por price/dimensions cuando se pide pricing/shipping)
      const productCacheKey = [
        nameFixed,
        `listing:${listingType}`,
        `price:${productPrice !== null ? productPrice : 'null'}`,
        `dim:${dimensionsFormatted || 'null'}`,
      ].join('__');

      const cachedProductResult = getFromCache(
        `credential_${credential_id}`,
        `product_suggestion_${site_id}`,
        productCacheKey
      );

      if (cachedProductResult) {
        logger.info(`[CACHE HIT] Producto "${nameFixed}" (listing: ${listingType}) en credential ${credential_id}`);
        cacheHits++;
        
        suggestions.push({
          product_id: product.id,
          credential_id: credential_id,
          marketplace_id: marketplace_id,
          categories: cachedProductResult
        });
        continue;
      }

      logger.info(`[CACHE MISS] Producto "${nameFixed}" en credential ${credential_id}`);
      apiCalls++;

      let categories = [];

      // === Obtener categorías sugeridas ===
      try {
        const domainDiscoveryUrl = `https://api.mercadolibre.com/sites/${site_id}/domain_discovery/search`;
        const catResponse = await axios.get(domainDiscoveryUrl, {
          params: { q: nameFixed, limit: 3 },
          timeout: 20000
        });

        const rawCategories = catResponse.data || [];
        categories = rawCategories.map(cat => ({
          category_id: cat.category_id,
          category_name: cat.category_name,
          domain_id: cat.domain_id,
          domain_name: cat.domain_name,
          path: cat.domain_name || ''
        }));
      } catch (catErr) {
        logger.error(`Error al obtener categorías para "${nameFixed}": ${catErr.message}`);
        continue;
      }

      const categoriesWithAttrs = [];
      
      for (const cat of categories) {
        if (!cat.category_id) continue;

        // === Cache de categoría (solo atributos/base; NO incluir pricing/shipping) ===
        const cachedCategoryBase = getFromCache(`credential_${credential_id}`, `category_attributes_${site_id}`, cat.category_id);

        let attributes = cachedCategoryBase?.attributes || [];

        if (cachedCategoryBase) {
          logger.info(`[CACHE HIT] Categoría ${cat.category_id} en credential ${credential_id}`);
        } else {
          logger.info(`[CACHE MISS] Categoría ${cat.category_id} en credential ${credential_id}`);

          // === Obtener atributos de la categoría ===
          try {
            const attrUrl = `https://api.mercadolibre.com/categories/${cat.category_id}/attributes`;
            const attrResponse = await axios.get(attrUrl, {
              headers: { Authorization: `Bearer ${credential.access_token}` },
              timeout: 20000
            });
            attributes = attrResponse.data || [];
          } catch (attrErr) {
            logger.error(`Error al cargar atributos para categoría ${cat.category_id}: ${attrErr.message}`);
          }

          // Guardar SOLO base/atributos en cache (no depende de listing/price/dimensions)
          saveToCache(`credential_${credential_id}`, `category_attributes_${site_id}`, cat.category_id, {
            category_id: cat.category_id,
            category_name: cat.category_name,
            domain_id: cat.domain_id,
            domain_name: cat.domain_name,
            path: cat.path,
            attributes
          });
        }

        // === 💰 NUEVO: Obtener pricing/comisiones usando productPrice ===
        let pricing = null;
        
        // ✅ Calcular pricing SOLO si este producto tiene precio válido
        if (productPrice !== null) {
          const pricingCacheKey = `pricing_${cat.category_id}_${productPrice}_${listingType}`;
          const cachedPricing = getFromCache(`credential_${credential_id}`, 'category_pricing', pricingCacheKey);

          if (cachedPricing) {
            logger.info(`[CACHE HIT PRICING] Categoría ${cat.category_id}`);
            pricing = cachedPricing;
          } else {
            try {
              pricingCalls++;
              const pricingUrl = `https://api.mercadolibre.com/sites/${site_id}/listing_prices`;
              const pricingResponse = await axios.get(pricingUrl, {
                params: {
                  price: productPrice,  // ✅ Usar price del producto
                  category_id: cat.category_id,
                  listing_type_id: listingType
                },
                headers: { Authorization: `Bearer ${credential.access_token}` },
                timeout: 15000
              });

              const fees = pricingResponse.data || {};
              
              // ✅ Calcular monto neto y porcentaje correctamente
              pricing = {
                sale_fee_amount: fees.sale_fee_amount || 0,
                listing_fee_amount: fees.listing_fee_amount || 0,
                total_fee_amount: fees.total_fee_amount || 0,
                listing_type_id: listingType,
                input_price: productPrice,  // ✅ Precio del producto
                net_amount: parseFloat((productPrice - (fees.sale_fee_amount || 0)).toFixed(2)),
                // ✅ CORRECCIÓN: fee_percentage calculado con productPrice como denominador
                fee_percentage: productPrice > 0 
                  ? parseFloat((((fees.sale_fee_amount || 0) / productPrice) * 100).toFixed(2))
                  : 0
              };

              // Guardar en cache (30 minutos)
              saveToCache(`credential_${credential_id}`, 'category_pricing', pricingCacheKey, pricing, 1800);
              
            } catch (pricingErr) {
              logger.warn(`No se pudo obtener pricing para categoría ${cat.category_id}: ${pricingErr.message}`);
              pricing = {
                error: 'No se pudo calcular',
                message: pricingErr.message
              };
            }
          }
        }

        // === Construir objeto de categoría completo ===
        const categoryData = {
          category_id: cat.category_id,
          category_name: cat.category_name,
          domain_id: cat.domain_id,
          domain_name: cat.domain_name,
          path: cat.path,
          attributes,
          // 💰 Incluir pricing SOLO si se calculó para este producto
          ...(productPrice !== null && { pricing })
        };

        saveToCache(`credential_${credential_id}`, `category_attributes_${site_id}`, cat.category_id, categoryData);
        categoriesWithAttrs.push(categoryData);
      }

      saveToCache(`credential_${credential_id}`, `product_suggestion_${site_id}`, nameFixed, categoriesWithAttrs);

      suggestions.push({
        product_id: product.id,
        credential_id: credential_id,
        marketplace_id: marketplace_id,
        categories: categoriesWithAttrs
      });
    }

    return res.status(200).json({
      success: true,
      suggestions,
      count: suggestions.length,
      stats: {
        total_products: products.length,
        cache_hits: cacheHits,
        api_calls: apiCalls,
        pricing_calls: pricingCalls,
        cache_hit_rate: products.length > 0 
          ? ((cacheHits / products.length) * 100).toFixed(2) + '%'
          : '0%',
        // ✅ Indicar si al menos un producto tenía precio para pricing
        pricing_requested: products.some(p => p.price !== undefined && p.price !== null)
      }
    });

  } catch (error) {
    logger.error(`❌ Error general en mercadoLibreSuggestedCategoriesWithAttributes: ${error.message}`, {
      stack: error.stack,
      body: req.body
    });
    return res.status(500).json({
      success: false,
      error: "Error interno al procesar categorías con atributos y pricing de MercadoLibre."
    });
  }
},*/

/**
 * Convertir dimensiones del formato del frontend al formato de la API de MercadoLibre
 * API ML espera: "HeightxWidthxLength,Weight" - TODOS ENTEROS, en cm y gramos
 * 
 * @param {Object} packageData - Datos del paquete desde el frontend
 * @returns {String} Dimensiones en formato "15x8x22,320"
 */
formatDimensionsForAPI(packageData) {
  // Helper para extraer número de cualquier formato
  const extractNumber = (value) => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') {
      const num = Number(value.trim().replace(',', '.'));
      return Number.isFinite(num) ? num : null;
    }
    if (typeof value === 'object' && value !== null && 'value' in value) {
      return extractNumber(value.value);
    }
    return null;
  };

  // Helper para convertir a cm (siempre retorna número)
  const toCm = (dimension) => {
    if (!dimension) return null;
    const value = extractNumber(dimension);
    if (value === null) return null;
    const unit = (dimension.unit || dimension.unit || 'cm')?.toLowerCase();
    
    switch(unit) {
      case 'm': return value * 100;
      case 'mm': return value / 10;
      case 'in': return value * 2.54;
      case 'ft': return value * 30.48;
      case 'cm':
      default: return value;
    }
  };

  // Helper para convertir a gramos (siempre retorna número)
  const toGrams = (weightData) => {
    if (!weightData) return null;
    const value = extractNumber(weightData);
    if (value === null) return null;
    const unit = (weightData.unit || weightData.unit || 'g')?.toLowerCase();
    
    switch(unit) {
      case 'kg': return value * 1000;
      case 'lb': return value * 453.592;
      case 'oz': return value * 28.3495;
      case 'g':
      default: return value;
    }
  };

  if (!packageData) {
    throw new Error('Package data is required');
  }

  // Aceptar shape { package: {...} } por si llega envuelto
  if (packageData.package && typeof packageData.package === 'object') {
    packageData = packageData.package;
  }

  // Aceptar string preformateado "HxWxL,Weight"
  const dimensionsString =
    (typeof packageData.dimensions === 'string' && packageData.dimensions) ||
    (typeof packageData.dimensions_string === 'string' && packageData.dimensions_string) ||
    (typeof packageData.ml_dimensions === 'string' && packageData.ml_dimensions);

  if (dimensionsString) {
    const cleaned = dimensionsString.trim();
    const [dimPart, weightPart] = cleaned.split(',').map((s) => s.trim());
    if (dimPart && weightPart) {
      const parts = dimPart.split(/x/i).map((s) => extractNumber(s.trim())).filter((n) => n !== null);
      const weightParsed = extractNumber(weightPart);
      if (parts.length === 3 && weightParsed !== null) {
        const [hRaw, wRaw, lRaw] = parts;
        const h = Math.max(1, Math.ceil(hRaw));
        const w = Math.max(1, Math.ceil(wRaw));
        const l = Math.max(1, Math.ceil(lRaw));
        const wt = Math.max(1, Math.ceil(weightParsed));
        return `${h}x${w}x${l},${wt}`;
      }
    }
  }

  const dims = (packageData.dimensions && typeof packageData.dimensions === 'object') ? packageData.dimensions : {};
  const weightData =
    packageData.weight ??
    packageData.weight_grams ??
    packageData.weight_gram ??
    packageData.weight_g ??
    packageData.peso_grams ??
    packageData.peso_g ??
    (packageData.weight_kg !== undefined && packageData.weight_kg !== null ? { unit: 'kg', value: packageData.weight_kg } : null) ??
    (packageData.peso_kg !== undefined && packageData.peso_kg !== null ? { unit: 'kg', value: packageData.peso_kg } : null);

  // Extraer dimensiones en cm
  const heightCm = toCm(
    dims.height || dims.alto || dims.altura ||
    packageData.height_cm || packageData.alto_cm || packageData.altura_cm ||
    packageData.height || packageData.alto || packageData.altura
  );
  const widthCm = toCm(
    dims.width || dims.ancho ||
    packageData.width_cm || packageData.ancho_cm ||
    packageData.width || packageData.ancho
  );
  const lengthCm = toCm(
    dims.length || dims.largo || dims.longitud || dims.depth || dims.profundidad ||
    packageData.length_cm || packageData.largo_cm || packageData.longitud_cm || packageData.depth_cm || packageData.profundidad_cm ||
    packageData.length || packageData.largo || packageData.longitud || packageData.depth || packageData.profundidad
  );
  
  // Extraer peso en gramos
  const weightGrams = toGrams(weightData);

  // Validar que todos los valores existan
  const missing = [];
  if (heightCm === null) missing.push('height');
  if (widthCm === null) missing.push('width');
  if (lengthCm === null) missing.push('length');
  if (weightGrams === null) missing.push('weight');

  if (missing.length) {
    throw new Error(
      `Missing required dimensions: ${missing.join(', ')}. ` +
      `Accepted shapes: {package:{height_cm,width_cm,length_cm,weight_grams}} or {package:{dimensions:{height,width,length},weight}}`
    );
  }

  // ✅ IMPORTANTE: Redondear TODOS los valores a enteros (ML API lo requiere)
  const h = Math.max(1, Math.ceil(heightCm));
  const w = Math.max(1, Math.ceil(widthCm));
  const l = Math.max(1, Math.ceil(lengthCm));
  const wt = Math.max(1, Math.ceil(weightGrams));

  // Formato exacto que espera ML: "HeightxWidthxLength,Weight" (sin espacios)
  return `${h}x${w}x${l},${wt}`;
},
/**
 * Convertir unidad a centímetros
 */
convertToCm(dimension) {
  const coerceNumber = (value) => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return null;
      const num = Number(trimmed.replace(',', '.'));
      return Number.isFinite(num) ? num : null;
    }
    if (typeof value === 'object' && value !== null && 'value' in value) {
      return coerceNumber(value.value);
    }
    return null;
  };

  if (dimension === null || dimension === undefined) return null;

  if (typeof dimension === 'number' || typeof dimension === 'string') {
    const value = coerceNumber(dimension);
    return value === null ? null : value;
  }

  const value = coerceNumber(dimension.value);
  const unit = (dimension.unit || 'cm')?.toLowerCase();

  if (value === null) return null;
  
  switch(unit) {
    case 'm': return value * 100;
    case 'mm': return value / 10;
    case 'in': return value * 2.54;
    case 'ft': return value * 30.48;
    case 'cm':
    default: return value;
  }
},

/**
 * Convertir unidad a gramos
 */
convertToGrams(weightData) {
  const coerceNumber = (value) => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return null;
      const num = Number(trimmed.replace(',', '.'));
      return Number.isFinite(num) ? num : null;
    }
    if (typeof value === 'object' && value !== null && 'value' in value) {
      return coerceNumber(value.value);
    }
    return null;
  };

  if (weightData === null || weightData === undefined) return null;

  if (typeof weightData === 'number' || typeof weightData === 'string') {
    const value = coerceNumber(weightData);
    return value === null ? null : value;
  }

  const value = coerceNumber(weightData.value);
  const unit = (weightData.unit || 'g')?.toLowerCase();

  if (value === null) return null;
  
  switch(unit) {
    case 'kg': return value * 1000;
    case 'lb': return value * 453.592;
    case 'oz': return value * 28.3495;
    case 'g':
    default: return value;
  }
},

/**
 * Calcular costos de envío para un producto en MercadoLibre
 * @param {Object} credential - Credencial de MercadoLibre
 * @param {Object} product - Producto con price, package, etc.
 * @param {String} categoryId - ID de la categoría
 * @param {String} siteId - Site ID (MLA, MLC, etc.)
 * @param {String} listingType - Tipo de publicación (gold_special, etc.)
 * @returns {Object} Costos de envío (quién paga y cuánto)
 */
async calculateMercadoLibreShippingCosts(credential, product, categoryId, siteId, listingType = 'gold_special', logistic_type, shipping_mode) {
  const getMercadoLibreUserIdFromCredential = (cred) => {
    if (!cred) return null;

    if (cred.ml_user_id) return cred.ml_user_id;

    const additional = cred.additional_data;
    if (!additional) return null;

    if (typeof additional === 'object') return additional.ml_user_id || null;

    if (typeof additional === 'string') {
      try {
        const parsed = JSON.parse(additional);
        return parsed?.ml_user_id || null;
      } catch (e) {
        return null;
      }
    }

    return null;
  };

  const fetchMercadoLibreUserId = async (accessToken) => {
    if (!accessToken) return null;
    try {
      const res = await axios.get('https://api.mercadolibre.com/users/me', {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 8000,
      });
      return res.data?.id || null;
    } catch (e) {
      return null;
    }
  };

  const getCurrencyIdFromSite = (site) => {
    switch (String(site || '').toUpperCase()) {
      case 'MLC': return 'CLP';
      case 'MLA': return 'ARS';
      case 'MLB': return 'BRL';
      case 'MCO': return 'COP';
      case 'MLM': return 'MXN';
      case 'MLU': return 'UYU';
      case 'MLV': return 'VES';
      case 'MPE': return 'PEN';
      case 'MEC': return 'USD';
      case 'MGT': return 'GTQ';
      case 'MHN': return 'HNL';
      case 'MNI': return 'NIO';
      case 'MSV': return 'USD';
      case 'MCU': return 'CUP';
      case 'MPY': return 'PYG';
      case 'MBO': return 'BOB';
      case 'MCR': return 'CRC';
      case 'MPA': return 'PAB';
      case 'MRD': return 'DOP';
      default: return 'ARS';
    }
  };

  const dimensions = OAuthController.formatDimensionsForAPI(product.package);
  const mlUserIdFromCredential = getMercadoLibreUserIdFromCredential(credential);
  const mlUserId = mlUserIdFromCredential || (await fetchMercadoLibreUserId(credential?.access_token));

  // Si se tuvo que consultar a ML, persistir para próximas llamadas (best-effort)
  if (!mlUserIdFromCredential && mlUserId && credential?.id) {
    try {
      let additional = credential.additional_data;
      if (typeof additional === 'string') {
        try {
          additional = JSON.parse(additional);
        } catch (e) {
          additional = {};
        }
      }

      if (typeof additional !== 'object' || additional === null) additional = {};

      await MarketplaceCredentialRepository.updatePartial(credential.id, {
        additional_data: { ...additional, ml_user_id: mlUserId }
      });
    } catch (e) {
      logger.warn(`[ML] No se pudo persistir ml_user_id en additional_data para credencial ${credential.id}: ${e.message}`);
    }
  }

  if (!mlUserId) {
    const currencyId = getCurrencyIdFromSite(siteId);
    const errMsg = 'No se pudo determinar el ml_user_id para calcular shipping (falta additional_data.ml_user_id).';
    logger.error(errMsg, { site_id: siteId, category_id: categoryId, credential_id: credential?.id });
    return {
      buyer_pays: { cost: 0, currency_id: currencyId, paid_by: 'buyer', error: errMsg },
      seller_pays: { cost: 0, currency_id: currencyId, paid_by: 'seller', error: errMsg }
    };
  }
  
  const baseParams = {
    dimensions: dimensions,
    item_price: product.price,
    category_id: categoryId,
    listing_type_id: listingType,
    mode: shipping_mode || 'me2',
    condition: product.condition || 'new',
    logistic_type: logistic_type || 'drop_off',
    verbose: true
  };

  try {
    // Consulta 1: Comprador paga el envío
    const buyerPaysResponse = await axios.get(
      `https://api.mercadolibre.com/users/${mlUserId}/shipping_options/free`,
      {
        params: { ...baseParams, free_shipping: false },
        headers: { Authorization: `Bearer ${credential.access_token}` },
        timeout: 15000
      }
    );

    // Consulta 2: Vendedor ofrece envío gratis (vende paga)
    const sellerPaysResponse = await axios.get(
      `https://api.mercadolibre.com/users/${mlUserId}/shipping_options/free`,
      {
        params: { ...baseParams, free_shipping: true },
        headers: { Authorization: `Bearer ${credential.access_token}` },
        timeout: 15000
      }
    );

    const buyerCoverage = buyerPaysResponse.data?.coverage?.all_country || {};
    const sellerCoverage = sellerPaysResponse.data?.coverage?.all_country || {};

    return {
      buyer_pays: {
        // Mantener compatibilidad: "cost" = list_cost
        cost: buyerCoverage.list_cost || 0,
        list_cost: buyerCoverage.list_cost || 0,
        currency_id: buyerCoverage.currency_id || getCurrencyIdFromSite(siteId),
        billable_weight: buyerCoverage.billable_weight,
        discount: buyerCoverage.discount,
        shipping_method_id: buyerCoverage.shipping_method_id,
        paid_by: 'buyer',
        free_shipping: false
      },
      seller_pays: {
        cost: sellerCoverage.list_cost || 0,
        list_cost: sellerCoverage.list_cost || 0,
        currency_id: sellerCoverage.currency_id || getCurrencyIdFromSite(siteId),
        billable_weight: sellerCoverage.billable_weight,
        discount: sellerCoverage.discount,
        shipping_method_id: sellerCoverage.shipping_method_id,
        paid_by: 'seller',
        free_shipping: true
      }
    };
  } catch (error) {
    logger.error(`Error calculando envío para categoría ${categoryId}: ${error.message}`, {
      status: error.response?.status,
      data: error.response?.data,
      params: baseParams,
      ml_user_id: mlUserId
    });

    const currencyId = getCurrencyIdFromSite(siteId);
    const errMsg = error.response?.data?.message
      ? `${error.message}: ${error.response.data.message}`
      : error.message;
    return {
      buyer_pays: { cost: 0, currency_id: currencyId, paid_by: 'buyer', error: errMsg },
      seller_pays: { cost: 0, currency_id: currencyId, paid_by: 'seller', error: errMsg }
    };
  }
},

/**
 * Endpoint independiente para calcular costos de envío
 * Útil cuando ya se tiene la categoría seleccionada
 */
async mercadoLibreShippingCosts(req, res) {
  logger.info(`Datos recibidos para calcular costos de envío en MercadoLibre:\n ${JSON.stringify(req.body)}`);

  const { credential_id, product, category_id, listing_type_id } = req.body;
  const user_id = req.user?.id || req.body.user_id;

  // Validaciones
  if (!credential_id) {
    return res.status(400).json({ success: false, error: "credential_id es requerido" });
  }

  if (!product || !product.id) {
    return res.status(400).json({ success: false, error: "Se requiere información del producto con 'id'" });
  }

  if (!product.package) {
    return res.status(400).json({ 
      success: false, 
      error: "El producto debe incluir 'package' con dimensions y weight",
      example: {
        package: {
          weight: { unit: "g", value: 320 },
          dimensions: {
            height: { unit: "cm", value: 15 },
            width: { unit: "cm", value: 8 },
            length: { unit: "cm", value: 22 }
          }
        }
      }
    });
  }

  if (!product.price || isNaN(product.price)) {
    return res.status(400).json({ success: false, error: "El producto debe tener un 'price' válido" });
  }

  if (!category_id) {
    return res.status(400).json({ success: false, error: "category_id es requerido" });
  }

  try {
    // Rate Limit
    try {
      await marketplaceRateLimiter.consume(user_id);
    } catch (rateLimitError) {
      return res.status(429).json({
        success: false,
        error: "Demasiadas solicitudes. Por favor, espera un momento."
      });
    }

    // Obtener Credencial
    const credential = await MarketplaceCredentialRepository.findById(credential_id);
    if (!credential) {
      return res.status(404).json({ success: false, error: "Credencial no encontrada" });
    }

    if (credential.user_id !== user_id) {
      return res.status(403).json({ success: false, error: "No autorizado" });
    }

    const site_id = getMercadoLibreSiteId(credential.marketplace?.domain);
    const listingType = listing_type_id || 'gold_special';

    // Cache key
    const dimensions = OAuthController.formatDimensionsForAPI(product.package);
    const cacheKey = `shipping_${category_id}_${product.price}_${dimensions}_${listingType}`;
    const cachedShipping = getFromCache(`credential_${credential_id}`, 'shipping_costs', cacheKey);

    if (cachedShipping) {
      logger.info(`[CACHE HIT] Shipping para ${category_id}`);
      return res.status(200).json({
        success: true,
        shipping: cachedShipping,
        cached: true
      });
    }

    // Calcular costos
    logger.info(`[CACHE MISS] Calculando shipping para ${category_id}`);
    const shipping = await OAuthController.calculateMercadoLibreShippingCosts(
      credential,
      product,
      category_id,
      site_id,
      listingType
    );

    // Guardar en cache (15 minutos)
    saveToCache(`credential_${credential_id}`, 'shipping_costs', cacheKey, shipping, 900);

    return res.status(200).json({
      success: true,
      shipping,
      cached: false,
      product_id: product.id,
      category_id,
      dimensions,
      stats: {
        pricing_requested: true
      }
    });

  } catch (error) {
    logger.error(`❌ Error en mercadoLibreShippingCosts: ${error.message}`, {
      stack: error.stack,
      body: req.body
    });
    return res.status(500).json({
      success: false,
      error: "Error interno al calcular costos de envío de MercadoLibre."
    });
  }
},

// ✅ MÉTODO ACTUALIZADO - Ahora incluye shipping costs
async mercadoLibreSuggestedCategoriesWithAttributes(req, res) {
  logger.info(`Datos recibidos para categorías sugeridas con atributos, pricing y shipping en MercadoLibre:\n ${JSON.stringify(req.body)}`);

  const { credential_id, products, listing_type_id, logistic_type, shipping_mode } = req.body;
  const user_id = req.user?.id || req.body.user_id;

  if (!credential_id) {
    return res.status(400).json({ success: false, error: "credential_id es requerido" });
  }

  if (!Array.isArray(products) || products.length === 0) {
    return res.status(400).json({
      success: false,
      error: "Se requiere un array no vacío de productos con 'id' y 'name'."
    });
  }

  // ✅ NUEVO: Validar que los productos tengan package/dimensions si quieren shipping
  const productsWithoutPackage = products.filter(p => !p.package && p.price !== undefined);
  if (productsWithoutPackage.length > 0) {
    logger.warn(`Productos sin package (no se calculará shipping): ${productsWithoutPackage.map(p => p.id).join(', ')}`);
  }

  const listingType = listing_type_id || 'gold_special';

  try {
    // === PASO 1: Rate Limit ===
    try {
      await marketplaceRateLimiter.consume(user_id);
    } catch (rateLimitError) {
      logger.warn(`Rate limit excedido para usuario ${user_id}`);
      return res.status(429).json({
        success: false,
        error: "Demasiadas solicitudes. Por favor, espera un momento."
      });
    }

    // === PASO 2: Obtener Credencial ===
    const credential = await MarketplaceCredentialRepository.findById(credential_id);
    if (!credential) {
      return res.status(404).json({ success: false, error: "Credencial no encontrada" });
    }

    if (credential.user_id !== user_id) {
      return res.status(403).json({ success: false, error: "No autorizado" });
    }

    const marketplace_id = credential.marketplace_id;
    const site_id = getMercadoLibreSiteId(credential.marketplace?.domain);

    const suggestions = [];
    let cacheHits = 0;
    let apiCalls = 0;
    let pricingCalls = 0;
    let shippingCalls = 0;

    // === PROCESAR CADA PRODUCTO ===
    for (const product of products) {
      if (!product.id || !product.name) {
        logger.warn(`Producto inválido omitido: ${JSON.stringify(product)}`);
        continue;
      }

      const nameFixed = product.name.trim();
      
      // Obtener price de cada producto
      const productPrice = (product.price !== undefined && product.price !== null && !isNaN(product.price))
        ? parseFloat(product.price)
        : null;
      
      // Validar y formatear dimensiones si existen
      let dimensionsFormatted = null;
      if (product.package) {
        try {
          dimensionsFormatted = OAuthController.formatDimensionsForAPI(product.package);
          logger.info(`[Producto ${product.id}] Dimensiones formateadas: ${dimensionsFormatted}`);
        } catch (dimError) {
          logger.error(`[Producto ${product.id}] Error formateando dimensiones: ${dimError.message}`);
          // Continuar sin shipping
        }
      }
      
      const cachedProductResult = getFromCache(`credential_${credential_id}`, `product_suggestion_${site_id}`, nameFixed);

      if (cachedProductResult) {
        logger.info(`[CACHE HIT] Producto "${nameFixed}" en credential ${credential_id}`);
        cacheHits++;
        
        suggestions.push({
          product_id: product.id,
          credential_id: credential_id,
          marketplace_id: marketplace_id,
          categories: cachedProductResult
        });
        continue;
      }

      logger.info(`[CACHE MISS] Producto "${nameFixed}" en credential ${credential_id}`);
      apiCalls++;

      let categories = [];

      // === Obtener categorías sugeridas ===
      try {
        const domainDiscoveryUrl = `https://api.mercadolibre.com/sites/${site_id}/domain_discovery/search`;
        const catResponse = await axios.get(domainDiscoveryUrl, {
          params: { q: nameFixed, limit: 3 },
          timeout: 20000
        });

        const rawCategories = catResponse.data || [];
        categories = rawCategories.map(cat => ({
          category_id: cat.category_id,
          category_name: cat.category_name,
          domain_id: cat.domain_id,
          domain_name: cat.domain_name,
          path: cat.domain_name || ''
        }));
      } catch (catErr) {
        logger.error(`Error al obtener categorías para "${nameFixed}": ${catErr.message}`);
        continue;
      }

      const categoriesWithAttrs = [];
      
      for (const cat of categories) {
        if (!cat.category_id) continue;

        // === Cache de categoría con atributos ===
        const cachedCategory = getFromCache(`credential_${credential_id}`, `category_attributes_${site_id}`, cat.category_id);

        if (cachedCategory) {
          logger.info(`[CACHE HIT] Categoría ${cat.category_id} en credential ${credential_id}`);
          categoriesWithAttrs.push(cachedCategory);
          continue;
        }

        logger.info(`[CACHE MISS] Categoría ${cat.category_id} en credential ${credential_id}`);

        // === Obtener atributos de la categoría ===
        let attributes = [];
        try {
          const attrUrl = `https://api.mercadolibre.com/categories/${cat.category_id}/attributes`;
          const attrResponse = await axios.get(attrUrl, {
            headers: { Authorization: `Bearer ${credential.access_token}` },
            timeout: 20000
          });
          attributes = attrResponse.data || [];
        } catch (attrErr) {
          logger.error(`Error al cargar atributos para categoría ${cat.category_id}: ${attrErr.message}`);
        }

        // === 💰 Obtener pricing/comisiones ===
          let pricing = null;

          if (productPrice !== null) {
            // ✅ CORRECCIÓN 1: Incluir site_id en la clave para evitar colisiones entre países
            const pricingCacheKey = `pricing_${site_id}_${cat.category_id}_${productPrice}_${listing_type_id}`;
            
            logger.info(`[PRICING] Cache key: ${pricingCacheKey} | listing_type_id recibido: ${listing_type_id}`);
            
            const cachedPricing = getFromCache(`credential_${credential_id}`, 'category_pricing', pricingCacheKey);

            if (cachedPricing) {
              logger.info(`[CACHE HIT PRICING] Categoría ${cat.category_id} con listing ${listing_type_id}`);
              pricing = cachedPricing;
            } else {
              try {
                pricingCalls++;
                const pricingUrl = `https://api.mercadolibre.com/sites/${site_id}/listing_prices`;
                
                // ✅ CORRECCIÓN 2: Logging para verificar qué se envía a la API
                logger.info(`[PRICING API] URL: ${pricingUrl}`);
                logger.info(`[PRICING API] Params:`, {
                  price: productPrice,
                  category_id: cat.category_id,
                  listing_type_id: listing_type_id,
                  site_id: site_id
                });
                
                const pricingResponse = await axios.get(pricingUrl, {
                  params: {
                    price: productPrice,
                    category_id: cat.category_id,
                    listing_type_id: listing_type_id  // ← Verificar que este valor es el correcto
                  },
                  headers: { Authorization: `Bearer ${credential.access_token}` },
                  timeout: 15000
                });

                const fees = pricingResponse.data || {};
                
                // ✅ CORRECCIÓN 3: Logging de respuesta de la API
                logger.debug(`[PRICING API Response] listing_type_id devuelto: ${fees.listing_type_id || 'no definido'}`);
                
                pricing = {
                  sale_fee_amount: fees.sale_fee_amount || 0,
                  listing_fee_amount: fees.listing_fee_amount || 0,
                  total_fee_amount: fees.total_fee_amount || 0,
                  listing_type_id: listing_type_id,  // ← Forzar el valor que se solicitó, no el que devuelve la API
                  input_price: productPrice,
                  net_amount: parseFloat((productPrice - (fees.sale_fee_amount || 0)).toFixed(2)),
                  fee_percentage: productPrice > 0 
                    ? parseFloat((((fees.sale_fee_amount || 0) / productPrice) * 100).toFixed(2))
                    : 0
                };

                saveToCache(`credential_${credential_id}`, 'category_pricing', pricingCacheKey, pricing, 1800);
                
              } catch (pricingErr) {
                logger.warn(`No se pudo obtener pricing para categoría ${cat.category_id}: ${pricingErr.message}`);
                pricing = {
                  error: 'No se pudo calcular',
                  message: pricingErr.message
                };
              }
            }
          }

        // === 📦 NUEVO: Calcular costos de envío ===
        let shipping = null;

        if (productPrice !== null && dimensionsFormatted) {
          // ✅ CORRECCIÓN: Incluir listing_type_id, logistic_type y shipping_mode en la clave
          const shippingCacheKey = `shipping_${site_id}_${cat.category_id}_${productPrice}_${dimensionsFormatted}_${listing_type_id}_${logistic_type || 'drop_off'}_${shipping_mode || 'me2'}`;
          
          logger.info(`[SHIPPING] Cache key: ${shippingCacheKey}`);
          
          const cachedShipping = getFromCache(`credential_${credential_id}`, 'shipping_costs', shippingCacheKey);

          if (cachedShipping) {
            logger.info(`[CACHE HIT SHIPPING] Categoría ${cat.category_id} con config: ${listing_type_id}/${logistic_type}/${shipping_mode}`);
            shipping = cachedShipping;
          } else {
            try {
              shippingCalls += 2; // 2 llamadas API
              
              shipping = await OAuthController.calculateMercadoLibreShippingCosts(
                credential,
                { ...product, price: productPrice },
                cat.category_id,
                site_id,
                listing_type_id,
                logistic_type,  // ← Pasar explícitamente
                shipping_mode   // ← Pasar explícitamente
              );

              saveToCache(`credential_${credential_id}`, 'shipping_costs', shippingCacheKey, shipping, 900);
              
            } catch (shippingErr) {
              logger.warn(`Error calculando shipping para ${cat.category_id}: ${shippingErr.message}`);
              shipping = { 
                error: 'No se pudo calcular', 
                message: shippingErr.message 
              };
            }
          }
        }

        // === Construir objeto de categoría completo ===
        const categoryData = {
          category_id: cat.category_id,
          category_name: cat.category_name,
          domain_id: cat.domain_id,
          domain_name: cat.domain_name,
          path: cat.path,
          attributes,
          ...(productPrice !== null && { pricing }),
          ...(productPrice !== null && dimensionsFormatted && { shipping })
        };

        saveToCache(`credential_${credential_id}`, `category_attributes_${site_id}`, cat.category_id, categoryData);
        categoriesWithAttrs.push(categoryData);
      }

      saveToCache(`credential_${credential_id}`, `product_suggestion_${site_id}`, nameFixed, categoriesWithAttrs);

      suggestions.push({
        product_id: product.id,
        credential_id: credential_id,
        marketplace_id: marketplace_id,
        categories: categoriesWithAttrs
      });
    }

    return res.status(200).json({
      success: true,
      suggestions,
      count: suggestions.length,
      stats: {
        total_products: products.length,
        cache_hits: cacheHits,
        api_calls: apiCalls,
        pricing_calls: pricingCalls,
        shipping_calls: shippingCalls,
        cache_hit_rate: products.length > 0 
          ? ((cacheHits / products.length) * 100).toFixed(2) + '%'
          : '0%',
        pricing_requested: products.some(p => p.price !== undefined && p.price !== null),
        shipping_requested: products.some(p => p.package !== undefined && p.price !== undefined)
      }
    });

  } catch (error) {
    logger.error(`❌ Error general en mercadoLibreSuggestedCategoriesWithAttributes: ${error.message}`, {
      stack: error.stack,
      body: req.body
    });
    return res.status(500).json({
      success: false,
      error: "Error interno al procesar categorías con atributos, pricing y shipping de MercadoLibre."
    });
  }
},
async clearMercadoLibreCache(req, res) {
  const { marketplace_id } = req.params;
  
  try {
    const count = clearMarketplaceCache(marketplace_id);
    logger.info(`Caché limpiado para marketplace ${marketplace_id} (${count} entradas)`);
    
    return res.status(200).json({
      success: true,
      message: `Caché de marketplace ${marketplace_id} limpiado correctamente`,
      entries_cleared: count
    });
  } catch (error) {
    logger.error(`Error al limpiar caché del marketplace: ${error.message}`);
    return res.status(500).json({
      success: false,
      error: "Error al limpiar el caché del marketplace"
    });
  }
},

/**
 * Limpiar caché de un site específico de MercadoLibre
 */
async clearMercadoLibreSiteCache(req, res) {
  const { marketplace_id, site_id } = req.params;
  
  try {
    const count = clearMarketplaceCache(marketplace_id, site_id);
    logger.info(`Caché limpiado para marketplace ${marketplace_id} site ${site_id} (${count} entradas)`);
    
    return res.status(200).json({
      success: true,
      message: `Caché de marketplace ${marketplace_id} site ${site_id} limpiado correctamente`,
      entries_cleared: count
    });
  } catch (error) {
    logger.error(`Error al limpiar caché del site: ${error.message}`);
    return res.status(500).json({
      success: false,
      error: "Error al limpiar el caché del site"
    });
  }
},

/**
 * Obtener estadísticas del caché
 */
async getMercadoLibreCacheStats(req, res) {
  try {
    const stats = getCacheStats();
    
    return res.status(200).json({
      success: true,
      stats: {
        total_keys: stats.keys,
        hits: stats.hits,
        misses: stats.misses,
        hit_rate: stats.keys > 0 ? ((stats.hits / (stats.hits + stats.misses)) * 100).toFixed(2) + '%' : '0%'
      }
    });
  } catch (error) {
    logger.error(`Error al obtener estadísticas del caché: ${error.message}`);
    return res.status(500).json({
      success: false,
      error: "Error al obtener estadísticas del caché"
    });
  }
},
  /*async falabellaSuggestedCategoriesWithAttributes(req, res) {
    logger.info(`Datos recibidos para categorías sugeridas con atributos en Falabella:\n ${JSON.stringify(req.body)}`);

    const { marketplace_id, products } = req.body;
    const user_id = req.user?.id;

    if (!Array.isArray(products) || products.length === 0) {
      return res.status(400).json({
        success: false,
        error: "Se requiere un array no vacío de productos con 'id' y 'name'."
      });
    }

    try {
      // === PASO 1: Aplicar Rate Limit por usuario ===
      try {
        await marketplaceRateLimiter.consume(user_id);
      } catch (rateLimitError) {
        logger.warn(`Rate limit excedido para usuario ${user_id}`);
        return res.status(429).json({
          success: false,
          error: "Demasiadas solicitudes. Por favor, espera un momento."
        });
      }

      // === PASO 2: Obtener Credenciales ===
      const credential = await MarketplaceCredentialRepository.findByMarketplaceAndUser(
        marketplace_id,
        user_id
      );

      if (!credential) {
        return res.status(400).json({
          success: false,
          error: "Credenciales no encontradas"
        });
      }

      const baseUrl = "https://sellercenter-api.falabella.com";
      const userId = credential.seller_email;
      const apiKey = credential.api_key;

      if (!userId || !apiKey) {
        return res.status(500).json({
          success: false,
          error: "Faltan credenciales de Falabella (seller_email o api_key)"
        });
      }

      const suggestions = [];
      let cacheHits = 0;
      let apiCalls = 0;

      // === PASO 3: Procesar Cada Producto ===
      for (const product of products) {
        if (!product.id || !product.name) {
          logger.warn(`Producto inválido omitido: ${JSON.stringify(product)}`);
          continue;
        }

        const nameFixed = product.name.trim();

        // === PASO 4: Verificar Caché GLOBAL para este Producto ===
        // Clave: {marketplace_id}_product_suggestion_{nombre_producto}
        const cachedProductResult = getFromCache(marketplace_id, 'product_suggestion', nameFixed);

        if (cachedProductResult) {
          // ✅ CACHE HIT - Usar datos del caché (cualquier usuario puede usarlo)
          logger.info(`[CACHE HIT] Producto "${nameFixed}" en marketplace ${marketplace_id} (compartido)`);
          cacheHits++;
          
          suggestions.push({
            product_id: product.id,
            categories: cachedProductResult
          });
          continue; // Saltar a siguiente producto
        }

        // ❌ CACHE MISS - Hacer llamada a API
        logger.info(`[CACHE MISS] Producto "${nameFixed}" en marketplace ${marketplace_id}`);
        apiCalls++;

        const categories = [];

        // === PASO 5: Obtener Categorías Sugeridas ===
        const paramsSuggest = {
          UserID: userId,
          Version: "1.0",
          Action: "GetCategorySuggestion",
          Format: "JSON",
          Name: nameFixed,
          Timestamp: timestampMinus03(),
        };

        const keysSuggest = Object.keys(paramsSuggest).sort();
        const canonicalQuerySuggest = keysSuggest
          .map(k => `${rfc3986Encode(k)}=${rfc3986Encode(String(paramsSuggest[k]))}`)
          .join("&");
        const signatureSuggest = rfc3986Encode(
          crypto.createHmac("sha256", apiKey).update(canonicalQuerySuggest).digest("hex")
        );
        const urlSuggest = `${baseUrl}?${canonicalQuerySuggest}&Signature=${signatureSuggest}`;

        let suggestionResponse;
        try {
          suggestionResponse = await axios.get(urlSuggest, { timeout: 20000 });
        } catch (err) {
          logger.error(`Error al obtener sugerencias para "${nameFixed}":`, err.message);
          continue;
        }

        const dataSuggest = suggestionResponse.data;
        let suggestedItems = [];

        if (dataSuggest.SuccessResponse?.Body?.SuggestedCategory) {
          const raw = dataSuggest.SuccessResponse.Body.SuggestedCategory;
          suggestedItems = Array.isArray(raw) ? raw : [raw];
        }

        // === PASO 6: Obtener Atributos para Cada Categoría ===
        for (const item of suggestedItems) {
          if (!item.CategoryId || !item.CategoryName) continue;

          const categoryId = item.CategoryId.toString();

          // === PASO 7: Verificar Caché GLOBAL para esta Categoría ===
          // Clave: {marketplace_id}_category_attributes_{category_id}
          const cachedCategory = getFromCache(marketplace_id, 'category_attributes', categoryId);

          if (cachedCategory) {
            // ✅ CACHE HIT - Usar atributos del caché (compartido entre usuarios)
            logger.info(`[CACHE HIT] Categoría ${categoryId} en marketplace ${marketplace_id} (compartido)`);
            categories.push(cachedCategory);
            continue;
          }

          // ❌ CACHE MISS - Hacer llamada a API
          logger.info(`[CACHE MISS] Categoría ${categoryId} en marketplace ${marketplace_id}`);

          // Obtener atributos
          const paramsAttrs = {
            UserID: userId,
            Version: "1.0",
            Action: "GetCategoryAttributes",
            Format: "JSON",
            PrimaryCategory: categoryId,
            Timestamp: timestampMinus03(),
          };

          const keysAttrs = Object.keys(paramsAttrs).sort();
          const canonicalQueryAttrs = keysAttrs
            .map(k => `${rfc3986Encode(k)}=${rfc3986Encode(String(paramsAttrs[k]))}`)
            .join("&");
          const signatureAttrs = rfc3986Encode(
            crypto.createHmac("sha256", apiKey).update(canonicalQueryAttrs).digest("hex")
          );
          const urlAttrs = `${baseUrl}?${canonicalQueryAttrs}&Signature=${signatureAttrs}`;

          let attributes = [];
          try {
            const attrResponse = await axios.get(urlAttrs, { timeout: 20000 });
            const attrData = attrResponse.data;

            if (attrData.SuccessResponse?.Body?.Attribute) {
              const rawAttrs = attrData.SuccessResponse.Body.Attribute;
              const attrList = Array.isArray(rawAttrs) ? rawAttrs : [rawAttrs];

              attributes = attrList
                .filter(attr => attr.Name && attr.Label)
                .map(attr => ({
                  id: attr.FeedName || attr.Name,
                  name: attr.Label,
                  label: attr.Label,
                  is_mandatory: attr.isMandatory === "1" || attr.isMandatory === true,
                  description: attr.Description || '',
                  attribute_type: attr.AttributeType || 'string',
                  example_value: attr.ExampleValue || '',
                  value_type:
                    attr.AttributeType === 'option' || attr.AttributeType === 'multi_option'
                      ? 'list'
                      : attr.AttributeType === 'numberfield'
                        ? 'number'
                        : 'string',
                  values: attr.Options?.Option
                    ? (Array.isArray(attr.Options.Option)
                        ? attr.Options.Option.map(opt => ({ id: opt.id, name: opt.Name }))
                        : [{ id: attr.Options.Option.id, name: attr.Options.Option.Name }])
                    : [],
                  tags: {
                    required: attr.isMandatory === "1" || attr.isMandatory === true,
                    catalog_required: attr.isMandatory === "1" || attr.isMandatory === true,
                    hidden: false
                  }
                }))
                .sort((a, b) => (a.is_mandatory ? 0 : 1) - (b.is_mandatory ? 0 : 1));
            }
          } catch (attrErr) {
            logger.warn(`Error al cargar atributos para categoría ${categoryId}:`, attrErr.message);
          }

          // === PASO 8: Guardar Categoría en Caché GLOBAL ===
          const categoryData = {
            id: categoryId,
            name: item.CategoryName,
            path: item.SuggestedCategory || "",
            search_term: item.Name || "",
            attributes
          };

          saveToCache(marketplace_id, 'category_attributes', categoryId, categoryData);
          categories.push(categoryData);
        }

        // === PASO 9: Guardar Resultado del Producto en Caché GLOBAL ===
        saveToCache(marketplace_id, 'product_suggestion', nameFixed, categories);

        suggestions.push({
          product_id: product.id,
          categories
        });
      }

      // === PASO 10: Retornar Resultado con Estadísticas ===
      return res.status(200).json({
        success: true,
        suggestions,
        count: suggestions.length,
        stats: {
          total_products: products.length,
          cache_hits: cacheHits,
          api_calls: apiCalls,
          cache_hit_rate: products.length > 0 
            ? ((cacheHits / products.length) * 100).toFixed(2) + '%'
            : '0%'
        }
      });

    } catch (error) {
      logger.error(`❌ Error general en falabellaSuggestedCategoriesWithAttributes: ${error.message}`);
      
      if (error.response?.data?.ErrorResponse?.Head) {
        const head = error.response.data.ErrorResponse.Head;
        const errorCode = head.ErrorCode;
        let errorMessage = head.ErrorMessage;
        let statusCode = 500;

        if (errorCode === "7") {
          errorMessage = "Firma inválida (E007). Verifica API Key y seller_email.";
          statusCode = 401;
        } else if (errorCode === "9") {
          errorMessage = 'Acceso denegado (E009). Verifica rol "Seller API Product Access".';
          statusCode = 403;
        } else if ([3, 4].includes(Number(errorCode))) {
          errorMessage = "Error de timestamp (E003/E004).";
          statusCode = 400;
        }

        return res.status(statusCode).json({ success: false, error: errorMessage });
      }

      return res.status(500).json({
        success: false,
        error: "Error interno al procesar categorías con atributos."
      });
    }
  },*/
  /*async falabellaSuggestedCategoriesWithAttributes(req, res) {
  logger.info(`Datos recibidos para categorías sugeridas con atributos en Falabella:\n ${JSON.stringify(req.body)}`);

  // ← CAMBIO: Recibir credential_id en lugar de marketplace_id
  const { credential_id, products } = req.body;
  const user_id = req.user?.id;

  if (!credential_id) {
    return res.status(400).json({
      success: false,
      error: "credential_id es requerido"
    });
  }

  if (!Array.isArray(products) || products.length === 0) {
    return res.status(400).json({
      success: false,
      error: "Se requiere un array no vacío de productos con 'id' y 'name'."
    });
  }

  try {
    // === PASO 1: Aplicar Rate Limit por usuario ===
    try {
      await marketplaceRateLimiter.consume(user_id);
    } catch (rateLimitError) {
      logger.warn(`Rate limit excedido para usuario ${user_id}`);
      return res.status(429).json({
        success: false,
        error: "Demasiadas solicitudes. Por favor, espera un momento."
      });
    }

    // === PASO 2: Obtener Credencial ESPECÍFICA por ID ← CAMBIO
    const credential = await MarketplaceCredentialRepository.findById(credential_id);

    if (!credential) {
      return res.status(404).json({
        success: false,
        error: "Credencial no encontrada"
      });
    }

    // Verificar propiedad
    if (credential.user_id !== user_id) {
      return res.status(403).json({
        success: false,
        error: "No autorizado"
      });
    }

    const marketplace_id = credential.marketplace_id; // ← Obtener marketplace_id de la credencial

    const baseUrl = "https://sellercenter-api.falabella.com";
    const userId = credential.seller_email;
    const apiKey = credential.api_key;

    if (!userId || !apiKey) {
      return res.status(500).json({
        success: false,
        error: "Faltan credenciales de Falabella (seller_email o api_key)"
      });
    }

    // ... RESTO DEL CÓDIGO IGUAL ...
    const suggestions = [];
    let cacheHits = 0;
    let apiCalls = 0;

    for (const product of products) {
      if (!product.id || !product.name) {
        logger.warn(`Producto inválido omitido: ${JSON.stringify(product)}`);
        continue;
      }

      const nameFixed = product.name.trim();

      // Usar credential_id en la clave de caché para diferenciar
      const cachedProductResult = getFromCache(`credential_${credential_id}`, 'product_suggestion', nameFixed);

      if (cachedProductResult) {
        logger.info(`[CACHE HIT] Producto "${nameFixed}" en credential ${credential_id}`);
        cacheHits++;
        
        suggestions.push({
          product_id: product.id,
          credential_id: credential_id,
          marketplace_id: marketplace_id,
          categories: cachedProductResult
        });
        continue;
      }

      logger.info(`[CACHE MISS] Producto "${nameFixed}" en credential ${credential_id}`);
      apiCalls++;

      const categories = [];

      const paramsSuggest = {
        UserID: userId,
        Version: "1.0",
        Action: "GetCategorySuggestion",
        Format: "JSON",
        Name: nameFixed,
        Timestamp: timestampMinus03(),
      };

      const keysSuggest = Object.keys(paramsSuggest).sort();
      const canonicalQuerySuggest = keysSuggest
        .map(k => `${rfc3986Encode(k)}=${rfc3986Encode(String(paramsSuggest[k]))}`)
        .join("&");
      const signatureSuggest = rfc3986Encode(
        crypto.createHmac("sha256", apiKey).update(canonicalQuerySuggest).digest("hex")
      );
      const urlSuggest = `${baseUrl}?${canonicalQuerySuggest}&Signature=${signatureSuggest}`;
      
      let suggestionResponse;
      try {
        suggestionResponse = await axios.get(urlSuggest);
        logger.info(`Categorías sugeridas:\n ${JSON.stringify(suggestionResponse.data)}`);
      } catch (err) {
        logger.error(`Error al obtener sugerencias para "${nameFixed}": ${JSON.stringify(err.message)}`);
        continue;
      }

      const dataSuggest = suggestionResponse.data;
      let suggestedItems = [];

      if (dataSuggest.SuccessResponse?.Body?.SuggestedCategory) {
        const raw = dataSuggest.SuccessResponse.Body.SuggestedCategory;
        suggestedItems = Array.isArray(raw) ? raw : [raw];
      }

      for (const item of suggestedItems) {
        if (!item.CategoryId || !item.CategoryName) continue;

        const categoryId = item.CategoryId.toString();

        const cachedCategory = getFromCache(`credential_${credential_id}`, 'category_attributes', categoryId);

        if (cachedCategory) {
          logger.info(`[CACHE HIT] Categoría ${categoryId} en credential ${credential_id}`);
          categories.push(cachedCategory);
          continue;
        }

        logger.info(`[CACHE MISS] Categoría ${categoryId} en credential ${credential_id}`);

        const paramsAttrs = {
          UserID: userId,
          Version: "1.0",
          Action: "GetCategoryAttributes",
          Format: "JSON",
          PrimaryCategory: categoryId,
          Timestamp: timestampMinus03(),
        };

        const keysAttrs = Object.keys(paramsAttrs).sort();
        const canonicalQueryAttrs = keysAttrs
          .map(k => `${rfc3986Encode(k)}=${rfc3986Encode(String(paramsAttrs[k]))}`)
          .join("&");
        const signatureAttrs = rfc3986Encode(
          crypto.createHmac("sha256", apiKey).update(canonicalQueryAttrs).digest("hex")
        );
        const urlAttrs = `${baseUrl}?${canonicalQueryAttrs}&Signature=${signatureAttrs}`;

        let attributes = [];
        try {
          const attrResponse = await axios.get(urlAttrs);
          const attrData = attrResponse.data;
          //logger.info(`Categoría obtenida: \n ${JSON.stringify(attrData)}`);
          if (attrData.SuccessResponse?.Body?.Attribute) {
            const rawAttrs = attrData.SuccessResponse.Body.Attribute;
            const attrList = Array.isArray(rawAttrs) ? rawAttrs : [rawAttrs];

            attributes = attrList
              .filter(attr => attr.Name && attr.Label)
              .map(attr => ({
                id: attr.FeedName || attr.Name,
                name: attr.Label,
                label: attr.Label,
                is_mandatory: attr.isMandatory === "1" || attr.isMandatory === true,
                description: attr.Description || '',
                attribute_type: attr.AttributeType || 'string',
                example_value: attr.ExampleValue || '',
                value_type:
                  attr.AttributeType === 'option' || attr.AttributeType === 'multi_option'
                    ? 'list'
                    : attr.AttributeType === 'numberfield'
                      ? 'number'
                      : 'string',
                values: attr.Options?.Option
                  ? (Array.isArray(attr.Options.Option)
                      ? attr.Options.Option.map(opt => ({ id: opt.id, name: opt.Name }))
                      : [{ id: attr.Options.Option.id, name: attr.Options.Option.Name }])
                  : [],
                tags: {
                  required: attr.isMandatory === "1" || attr.isMandatory === true,
                  catalog_required: attr.isMandatory === "1" || attr.isMandatory === true,
                  hidden: false
                }
              }))
              .sort((a, b) => (a.is_mandatory ? 0 : 1) - (b.is_mandatory ? 0 : 1));
          }
        } catch (attrErr) {
          logger.warn(`Error al cargar atributos para categoría ${categoryId}:`, attrErr.message);
        }

        const categoryData = {
          id: categoryId,
          name: item.CategoryName,
          path: item.SuggestedCategory || "",
          search_term: item.Name || "",
          attributes
        };

        saveToCache(`credential_${credential_id}`, 'category_attributes', categoryId, categoryData);
        categories.push(categoryData);
      }

      saveToCache(`credential_${credential_id}`, 'product_suggestion', nameFixed, categories);

      suggestions.push({
        product_id: product.id,
        credential_id: credential_id,
        marketplace_id: marketplace_id,
        categories
      });
    }

    return res.status(200).json({
      success: true,
      suggestions,
      count: suggestions.length,
      stats: {
        total_products: products.length,
        cache_hits: cacheHits,
        api_calls: apiCalls,
        cache_hit_rate: products.length > 0 
          ? ((cacheHits / products.length) * 100).toFixed(2) + '%'
          : '0%'
      }
    });

  } catch (error) {
    logger.error(`❌ Error general en falabellaSuggestedCategoriesWithAttributes: ${error.message}`);
    
    if (error.response?.data?.ErrorResponse?.Head) {
      const head = error.response.data.ErrorResponse.Head;
      const errorCode = head.ErrorCode;
      let errorMessage = head.ErrorMessage;
      let statusCode = 500;

      if (errorCode === "7") {
        errorMessage = "Firma inválida (E007). Verifica API Key y seller_email.";
        statusCode = 401;
      } else if (errorCode === "9") {
        errorMessage = 'Acceso denegado (E009). Verifica rol "Seller API Product Access".';
        statusCode = 403;
      } else if ([3, 4].includes(Number(errorCode))) {
        errorMessage = "Error de timestamp (E003/E004).";
        statusCode = 400;
      }

      return res.status(statusCode).json({ success: false, error: errorMessage });
    }

    return res.status(500).json({
      success: false,
      error: "Error interno al procesar categorías con atributos."
    });
  }
},*/
async falabellaSuggestedCategoriesWithAttributes(req, res) {
  logger.info(`Datos recibidos para categorías sugeridas con atributos y pricing en Falabella:\n ${JSON.stringify(req.body)}`);

  const { credential_id, products } = req.body;
  const user_id = req.user?.id;

  // === VALIDACIONES ===
  if (!credential_id) {
    return res.status(400).json({ success: false, error: "credential_id es requerido" });
  }
  if (!Array.isArray(products) || products.length === 0) {
    return res.status(400).json({
      success: false,
      error: "Se requiere un array no vacío de productos con 'id' y 'name'."
    });
  }

  try {
    // === Rate Limit ===
    try {
      await marketplaceRateLimiter.consume(user_id);
    } catch (rateLimitError) {
      logger.warn(`Rate limit excedido para usuario ${user_id}`);
      return res.status(429).json({ success: false, error: "Demasiadas solicitudes" });
    }

    // === Obtener Credencial ===
    const credential = await MarketplaceCredentialRepository.findById(credential_id);
    if (!credential) {
      return res.status(404).json({ success: false, error: "Credencial no encontrada" });
    }
    if (credential.user_id !== user_id) {
      return res.status(403).json({ success: false, error: "No autorizado" });
    }

    const marketplace_id = credential.marketplace_id;
    const baseUrl = "https://sellercenter-api.falabella.com";
    const userId = credential.seller_email;
    const apiKey = credential.api_key;

    if (!userId || !apiKey) {
      return res.status(500).json({ success: false, error: "Faltan credenciales de Falabella" });
    }

    const suggestions = [];
    let cacheHits = 0, apiCalls = 0, pricingCalls = 0, treeCalls = 0;

    // === PROCESAR CADA PRODUCTO ===
    for (const product of products) {
      if (!product.id || !product.name) continue;

      const nameFixed = product.name.trim();
      const productPrice = (product.price !== undefined && product.price !== null && !isNaN(product.price))
        ? parseFloat(product.price) : null;

      // === Cache de producto ===
      const cachedProductResult = getFromCache(`credential_${credential_id}`, 'product_suggestion', nameFixed);
      if (cachedProductResult) {
        cacheHits++;
        suggestions.push({ product_id: product.id, credential_id, marketplace_id, categories: cachedProductResult });
        continue;
      }

      apiCalls++;
      const categories = [];

      // === GetCategorySuggestion ===
      const paramsSuggest = {
        UserID: userId, Version: "1.0", Action: "GetCategorySuggestion", Format: "JSON",
        Name: nameFixed, Timestamp: timestampMinus03(),
      };
      const keysSuggest = Object.keys(paramsSuggest).sort();
      const canonicalQuerySuggest = keysSuggest
        .map(k => `${rfc3986Encode(k)}=${rfc3986Encode(String(paramsSuggest[k]))}`)
        .join("&");
      const signatureSuggest = rfc3986Encode(
        crypto.createHmac("sha256", apiKey).update(canonicalQuerySuggest).digest("hex")
      );
      const urlSuggest = `${baseUrl}?${canonicalQuerySuggest}&Signature=${signatureSuggest}`;

      let suggestionResponse;
      try {
        suggestionResponse = await axios.get(urlSuggest);
        logger.info(`categoría sugerida: \n ${JSON.stringify(suggestionResponse.data)}`);
      } catch (err) {
        logger.error(`Error GetCategorySuggestion para "${nameFixed}": ${err.message}`);
        continue;
      }

      const dataSuggest = suggestionResponse.data;
      let suggestedItems = [];
      if (dataSuggest.SuccessResponse?.Body?.SuggestedCategory) {
        const raw = dataSuggest.SuccessResponse.Body.SuggestedCategory;
        suggestedItems = Array.isArray(raw) ? raw : [raw];
      }

      for (const item of suggestedItems) {
        if (!item.CategoryId || !item.CategoryName) continue;
        const categoryId = item.CategoryId.toString();

        // === Cache de categoría ===
        const cachedCategory = getFromCache(`credential_${credential_id}`, 'category_attributes', categoryId);
        if (cachedCategory) {
          categories.push(cachedCategory);
          continue;
        }

        // === GetCategoryAttributes ===
        const paramsAttrs = {
          UserID: userId, Version: "1.0", Action: "GetCategoryAttributes", Format: "JSON",
          PrimaryCategory: categoryId, Timestamp: timestampMinus03(),
        };
        const keysAttrs = Object.keys(paramsAttrs).sort();
        const canonicalQueryAttrs = keysAttrs
          .map(k => `${rfc3986Encode(k)}=${rfc3986Encode(String(paramsAttrs[k]))}`)
          .join("&");
        const signatureAttrs = rfc3986Encode(
          crypto.createHmac("sha256", apiKey).update(canonicalQueryAttrs).digest("hex")
        );
        const urlAttrs = `${baseUrl}?${canonicalQueryAttrs}&Signature=${signatureAttrs}`;
        let attributes = [];

        try {
          const attrResponse = await axios.get(urlAttrs);
          const attrData = attrResponse.data;
          if (attrData.SuccessResponse?.Body?.Attribute) {
            const rawAttrs = attrData.SuccessResponse.Body.Attribute;
            const attrList = Array.isArray(rawAttrs) ? rawAttrs : [rawAttrs];
            attributes = attrList.filter(attr => attr.Name && attr.Label).map(attr => ({
              id: attr.FeedName || attr.Name, name: attr.Label, label: attr.Label,
              is_mandatory: attr.isMandatory === "1" || attr.isMandatory === true,
              description: attr.Description || '', attribute_type: attr.AttributeType || 'string',
              example_value: attr.ExampleValue || '',
              value_type: ['option', 'multi_option'].includes(attr.AttributeType) ? 'list' :
                         attr.AttributeType === 'numberfield' ? 'number' : 'string',
              values: attr.Options?.Option
                ? (Array.isArray(attr.Options.Option)
                    ? attr.Options.Option.map(opt => ({ id: opt.id, name: opt.Name }))
                    : [{ id: attr.Options.Option.id, name: attr.Options.Option.Name }])
                : [],
              tags: { required: attr.isMandatory === "1", catalog_required: attr.isMandatory === "1", hidden: false }
            })).sort((a, b) => (a.is_mandatory ? 0 : 1) - (b.is_mandatory ? 0 : 1));
          }
        } catch (attrErr) {
          logger.warn(`Error GetCategoryAttributes para ${categoryId}: ${attrErr.message}`);
        }

        // === 💰 NUEVO: Obtener pricing/comisión con auto-mapeo ===
        let pricing = null;
        if (productPrice !== null) {
          const pricingCacheKey = `pricing_${categoryId}_${item.CategoryName}_${productPrice}`;
          const cachedPricing = getFromCache(`credential_${credential_id}`, 'category_pricing', pricingCacheKey);

          if (cachedPricing) {
            pricing = cachedPricing;
          } else {
            try {
              pricingCalls++;

              // 🔹 Paso 1: Buscar comisión en BD por category_id o global_identifier
              let commission = await CategoryCommissionRepository.findByCategory(
                marketplace_id,
                {
                  categoryId: categoryId,
                  globalIdentifier: item.SuggestedCategory
                }
              );

              // 🔹 Paso 2: Si NO existe, consultar GetCategoryTree para auto-mapear
              if (!commission) {
                logger.info(`[AUTO-MAP] Categoría ${categoryId} no encontrada, consultando GetCategoryTree...`);
                treeCalls++;

                // Obtener árbol completo (se cachea en memoria si es necesario)
                const treeData = await OAuthController.fetchFalabellaCategoryTree(baseUrl, userId, apiKey);

                // 🔹 Paso 3: Normalizar nombres para coincidir con el formato de la BD
                const treeMatch = await OAuthController.findCategoryInTree(treeData, categoryId);
logger.info(`categoría encontrada desde el arbol: \n ${JSON.stringify(treeMatch)}`);

// 🔹 Verificar que treeMatch exista y tenga propiedades válidas
if (treeMatch && Object.keys(treeMatch).length > 0) {
  logger.debug(`[AUTO-MAP] ✅ Encontrado en árbol: ${JSON.stringify(treeMatch)}`);
  
  // 🔹 Paso 3: Buscar en BD por ruta de niveles (level1-4)
  const commissionByPath = await CategoryCommissionRepository.findByCategoryPathWithLevels(
    marketplace_id,
    {
      level1: treeMatch.level1,
      level2: treeMatch.level2,
      level3: treeMatch.level3,
      level4: treeMatch.level4
    }
  );
logger.info(`comisión encontrada en la bd: \n ${JSON.stringify(commissionByPath)}`);
  if (commissionByPath) {
    // 🔹 Paso 4: Actualizar el registro con los identificadores de API
    await CategoryCommissionRepository.updateCommissionIdentifiers(
      commissionByPath.id,
      {
        category_id: categoryId,
        global_identifier: item.SuggestedCategory,
        category_name_api: item.CategoryName
      }
    );
    
    commission = commissionByPath;
    logger.info(`[AUTO-MAP] ✅ Registro actualizado: ID=${commissionByPath.id}`);
  } else {
    logger.warn(`[AUTO-MAP] ⚠️ No se encontró comisión en BD para esta categoría`);
  }
} else {
  logger.error(`[AUTO-MAP] ❌ treeMatch es null o undefined: ${treeMatch}`);
}
              }

              // 🔹 Paso 5: Calcular pricing si hay comisión
              if (commission) {
                pricing = CategoryCommissionRepository.calculatePricing(commission, productPrice);
                logger.debug(`[PRICING] Calculado para ${categoryId}: ${pricing.fee_percentage}%`);
              } else {
                // Fallback: sin comisión
                pricing = {
                  sale_fee_amount: null,
                  listing_fee_amount: 0,
                  total_fee_amount: null,
                  fee_percentage: null,
                  net_amount: null,
                  currency: 'CLP',
                  warning: `Comisión no configurada para "${item.CategoryName}"`,
                  source: 'tabla_local'
                };
                logger.warn(`[PRICING] Sin comisión para ${categoryId}: ${item.CategoryName}`);
              }

              // 💾 Cache de pricing (24h)
              saveToCache(`credential_${credential_id}`, 'category_pricing', pricingCacheKey, pricing, 86400);

            } catch (pricingErr) {
              logger.warn(`Error calculando pricing para ${categoryId}: ${pricingErr.message}`);
              pricing = { error: 'Cálculo no disponible', sale_fee_amount: null, fee_percentage: null, currency: 'CLP' };
            }
          }
        }

        // === Construir categoryData ===
        const categoryData = {
          id: categoryId,
          name: item.CategoryName,
          path: item.SuggestedCategory || "",
          search_term: item.Name || "",
          attributes,
          ...(productPrice !== null && { pricing })
        };

        saveToCache(`credential_${credential_id}`, 'category_attributes', categoryId, categoryData);
        categories.push(categoryData);
      }

      saveToCache(`credential_${credential_id}`, 'product_suggestion', nameFixed, categories);
      suggestions.push({ product_id: product.id, credential_id, marketplace_id, categories });
    }

    return res.status(200).json({
      success: true,
      suggestions,
      count: suggestions.length,
      stats: {
        total_products: products.length,
        cache_hits: cacheHits,
        api_calls: apiCalls,
        pricing_calls: pricingCalls,
        tree_calls: treeCalls,
        cache_hit_rate: products.length > 0 ? ((cacheHits / products.length) * 100).toFixed(2) + '%' : '0%',
        pricing_requested: products.some(p => p.price !== undefined && p.price !== null)
      }
    });

  } catch (error) {
    logger.error(`❌ Error en falabellaSuggestedCategoriesWithAttributes: ${error.message}`);
    if (error.response?.data?.ErrorResponse?.Head) {
      const head = error.response.data.ErrorResponse.Head;
      const errorCode = head.ErrorCode;
      let errorMessage = head.ErrorMessage, statusCode = 500;
      if (errorCode === "7") { errorMessage = "Firma inválida (E007)"; statusCode = 401; }
      else if (errorCode === "9") { errorMessage = "Acceso denegado (E009)"; statusCode = 403; }
      else if ([3, 4].includes(Number(errorCode))) { errorMessage = "Error de timestamp (E003/E004)"; statusCode = 400; }
      return res.status(statusCode).json({ success: false, error: errorMessage });
    }
    return res.status(500).json({ success: false, error: "Error interno al procesar categorías con pricing de Falabella." });
  }
},
/**
 * Obtiene el árbol completo de categorías de Falabella
 * @returns {Object} Respuesta de GetCategoryTree
 */
async fetchFalabellaCategoryTree(baseUrl, userId, apiKey) {
  const params = {
    UserID: userId,
    Version: "1.0",
    Action: "GetCategoryTree",
    Format: "JSON",
    Timestamp: timestampMinus03(),
  };
  
  const keys = Object.keys(params).sort();
  const canonicalQuery = keys
    .map(k => `${rfc3986Encode(k)}=${rfc3986Encode(String(params[k]))}`)
    .join("&");
  const signature = rfc3986Encode(
    crypto.createHmac("sha256", apiKey).update(canonicalQuery).digest("hex")
  );
  const url = `${baseUrl}?${canonicalQuery}&Signature=${signature}`;
  
  const response = await axios.get(url);  
  //logger.info(`Arbol de categorías: \n ${JSON.stringify(response.data)}`);
  return response.data?.SuccessResponse?.Body?.Categories?.Category || [];
},

/**
 * Busca recursivamente un CategoryId en el árbol de categorías
 * @returns {Object|null} { level1, level2, level3, level4, api_name } o null
 */
async findCategoryInTree(nodes, targetCategoryId, path = []) {
  const nodeList = Array.isArray(nodes) ? nodes : [nodes];
  
  for (const node of nodeList) {
    const currentPath = [...path, node.Name];
    
    // Si coincide el CategoryId, retornar la ruta
    if (node.CategoryId?.toString() === targetCategoryId) {
      return {
        level1: currentPath[0] || null,
        level2: currentPath[1] || null,
        level3: currentPath[2] || null,
        level4: currentPath[3] || node.Name, // Último nivel disponible
        api_name: node.Name
      };
    }
    
    // Recursividad para hijos
    if (node.Children?.Category) {
      const result = await OAuthController.findCategoryInTree(node.Children.Category, targetCategoryId, currentPath);
      if (result) return result;
    }
  }
  
  return null;
},
async falabellaCategories(req, res) {
    logger.info(
      "Datos recibidos al obtener las categorías de un producto en falabella:",
    );
    logger.info(JSON.stringify(req.body));

    const { productName, marketplace_id } = req.body;
    const user_id = req.user?.id;

    try {
      const credential =
        await MarketplaceCredentialRepository.findByMarketplaceAndUser(
          marketplace_id,
          user_id,
        );

      if (!credential) {
        return res.status(400).json({
          success: false,
          error: "Credenciales no encontradas",
        });
      }
      const baseUrl = "https://sellercenter-api.falabella.com";
      const userId = credential.seller_email; /*'evelyn@klint.cl'*/
      const apiKey = credential.api_key; /*'79c1b4e70aedbccd614cb3815f524aca2ea0c220'*/
      const nameFixed = productName.trim();

      if (!userId || !apiKey) {
        return res
          .status(500)
          .json({ success: false, error: "Faltan env vars Falabella" });
      }

      const params = {
        UserID: userId,
        Version: "1.0",
        Action: "GetCategorySuggestion",
        Format: "JSON",
        Name: nameFixed,
        Timestamp: timestampMinus03(), // o usa -03:00 si tu cuenta lo exige
      };

      // 1) ordenar
      const keys = Object.keys(params).sort();

      // 2) construir query ENCODEADA (esto se firma)
      const canonicalQuery = keys
        .map((k) => `${rfc3986Encode(k)}=${rfc3986Encode(String(params[k]))}`)
        .join("&");

      // 3) firma HMAC SHA256 HEX (igual PHP hash_hmac(..., false))
      const signatureHex = crypto
        .createHmac("sha256", apiKey)
        .update(canonicalQuery)
        .digest("hex");

      // 4) Falabella/PHP hace rawurlencode(signature)
      const signature = rfc3986Encode(signatureHex);

      const url = `${baseUrl}?${canonicalQuery}&Signature=${signature}`;
      const response = await axios.get(url, { timeout: 20000 });

      const data = response.data;
      const categories = [];

      logger.info(`Categorias obtenidas:, ${JSON.stringify(data)}`);

      // ✅ Procesar respuesta de Falabella para GetCategorySuggestion
      if (data.SuccessResponse?.Body?.SuggestedCategory) {
        const suggested = data.SuccessResponse.Body.SuggestedCategory;

        // Manejar tanto objeto único como array (aunque normalmente es objeto único)
        const items = Array.isArray(suggested) ? suggested : [suggested];

        items.forEach((item) => {
          if (item.CategoryId && item.CategoryName) {
            categories.push({
              id: item.CategoryId.toString(), // ID numérico
              name: item.CategoryName, // Nombre amigable
              path: item.SuggestedCategory || "", // Path/código jerárquico (ej: G12020103)
              search_term: item.Name || "", // Término de búsqueda que generó la sugerencia
            });
          }
        });
      }

      return res.status(200).json({
        success: true,
        categories: categories,
        count: categories.length,
      });
    } catch (error) {
      logger.error(`❌ Falabella Categories error:, ${error.message}`);

      if (error.response) {
        logger.error("❌ Respuesta de error:");
        logger.error(JSON.stringify(error.response.data, null, 2));
      }

      // ✅ Mensajes de error específicos según código
      let errorMessage = error.message || "Error interno";
      let statusCode = 500;

      if (error.response?.data?.ErrorResponse?.Head) {
        const errorCode = error.response.data.ErrorResponse.Head.ErrorCode;
        const errorMsg = error.response.data.ErrorResponse.Head.ErrorMessage;

        if (errorCode === "7") {
          errorMessage =
            "Firma inválida (E007). Verifica que la API Key sea correcta y que el correo electrónico (UserID) sea el de tu cuenta de Seller Center.";
          statusCode = 401;
        } else if (errorCode === "9") {
          errorMessage =
            'Acceso denegado (E009). Verifica que tu usuario tenga el rol "Seller API Product Access" en Seller Center.';
          statusCode = 403;
        } else if (errorCode === "3") {
          errorMessage =
            "Timestamp expirado (E003). Por favor intenta nuevamente.";
          statusCode = 400;
        } else if (errorCode === "4") {
          errorMessage = "Formato de timestamp inválido (E004).";
          statusCode = 400;
        } else {
          errorMessage = `${errorMsg} (Código: ${errorCode})`;
        }
      }

      return res.status(statusCode).json({
        success: false,
        error: errorMessage,
        error_code: error.response?.data?.ErrorResponse?.Head?.ErrorCode,
      });
    }
  },

  // controllers/marketplace/falabellaController.js
  async falabellaAttributes(req, res) {
    logger.info(
      "Datos recibidos al obtener los atributos de una categoría en falabella:",
    );
    logger.info(JSON.stringify(req.body));

    const { category_id, marketplace_id } = req.body;
    const user_id = req.user?.id;

    try {
      const credential =
        await MarketplaceCredentialRepository.findByMarketplaceAndUser(
          marketplace_id,
          user_id,
        );

      if (!credential) {
        return res.status(400).json({
          success: false,
          error: "Credenciales no encontradas",
        });
      }

      const baseUrl = "https://sellercenter-api.falabella.com";
      const userId = credential.seller_email;
      const apiKey = credential.api_key;

      if (!userId || !apiKey || !category_id) {
        return res.status(400).json({
          success: false,
          error: "Faltan datos requeridos: category_id, seller_email o api_key",
        });
      }

      // ✅ Parámetros para GetCategoryAttributes
      const params = {
        UserID: userId,
        Version: "1.0",
        Action: "GetCategoryAttributes",
        Format: "JSON",
        PrimaryCategory: category_id.toString(), // ✅ ID de la categoría
        Timestamp: timestampMinus03(),
      };

      // 1) ordenar alfabéticamente
      const keys = Object.keys(params).sort();

      // 2) construir query ENCODEADA (esto se firma)
      const canonicalQuery = keys
        .map((k) => `${rfc3986Encode(k)}=${rfc3986Encode(String(params[k]))}`)
        .join("&");

      // 3) firma HMAC SHA256 HEX
      const signatureHex = crypto
        .createHmac("sha256", apiKey)
        .update(canonicalQuery)
        .digest("hex");

      // 4) encodear la firma
      const signature = rfc3986Encode(signatureHex);

      const url = `${baseUrl}?${canonicalQuery}&Signature=${signature}`;
      
      logger.info(`🔍 URL para atributos: ${url}`);

      const response = await axios.get(url, { timeout: 20000 });

    const data = response.data;
    const attributes = [];

    logger.info(`Atributos obtenidos: ${JSON.stringify(data)}`);

    // ✅ Procesar respuesta REAL de Falabella para GetCategoryAttributes
    if (data.SuccessResponse?.Body?.Attribute) {
      const attrs = data.SuccessResponse.Body.Attribute;
      
      // Manejar array o objeto único
      const items = Array.isArray(attrs) ? attrs : [attrs];

      items.forEach((attr) => {
        if (attr.Name && attr.Label) {
          attributes.push({
            id: attr.FeedName || attr.Name, // FeedName es el verdadero identificador para XMLs
            name: attr.Label, // Nombre legibles
            label: attr.Label,
            is_mandatory: attr.isMandatory === "1" || attr.isMandatory === true,
            description: attr.Description || '',
            attribute_type: attr.AttributeType || 'string',
            example_value: attr.ExampleValue || '',
            value_type: 
              attr.AttributeType === 'option' || attr.AttributeType === 'multi_option'
                ? 'list'
                : attr.AttributeType === 'numberfield'
                  ? 'number'
                  : 'string',
            values: attr.Options?.Option 
              ? (Array.isArray(attr.Options.Option) 
                  ? attr.Options.Option.map(opt => ({ 
                      id: opt.id,       // ✅ Campo real: id
                      name: opt.Name    // ✅ Campo real: Name
                    }))
                  : [{ id: attr.Options.Option.id, name: attr.Options.Option.Name }])
              : [],
            tags: {
              required: attr.isMandatory === "1" || attr.isMandatory === true,
              catalog_required: attr.isMandatory === "1" || attr.isMandatory === true
            }
          });
        }
      });
    }

        // ✅ Ordenar: requeridos primero
        const sortedAttributes = attributes.sort((a, b) => {
          const aReq = a.is_mandatory ? 0 : 1;
          const bReq = b.is_mandatory ? 0 : 1;
          return aReq - bReq;
        });

      return res.status(200).json({
        success: true,
        attributes: sortedAttributes,
        count: sortedAttributes.length,
      });
    } catch (error) {
      logger.error(`❌ Falabella Attributes error: ${error.message}`);

      if (error.response) {
        logger.error("❌ Respuesta de error:");
        logger.error(JSON.stringify(error.response.data, null, 2));
      }

      let errorMessage = error.message || "Error interno";
      let statusCode = 500;

      if (error.response?.data?.ErrorResponse?.Head) {
        const errorCode = error.response.data.ErrorResponse.Head.ErrorCode;
        const errorMsg = error.response.data.ErrorResponse.Head.ErrorMessage;

        if (errorCode === "57") {
          errorMessage = "No hay atributos para esta categoría (E057)";
          statusCode = 404;
        } else if (errorCode === "7") {
          errorMessage =
            "Firma inválida (E007). Verifica que la API Key sea correcta.";
          statusCode = 401;
        } else if (errorCode === "9") {
          errorMessage =
            'Acceso denegado (E009). Verifica que tu usuario tenga el rol "Seller API Product Access".';
          statusCode = 403;
        } else if (errorCode === "3") {
          errorMessage = "Timestamp expirado (E003).";
          statusCode = 400;
        } else if (errorCode === "4") {
          errorMessage = "Formato de timestamp inválido (E004).";
          statusCode = 400;
        } else {
          errorMessage = `${errorMsg} (Código: ${errorCode})`;
        }
      }

      return res.status(statusCode).json({
        success: false,
        error: errorMessage,
        error_code: error.response?.data?.ErrorResponse?.Head?.ErrorCode,
      });
    }
  },

async falabellaProductStatus(req, res) {
  logger.info(`${req.user?.name || "Unknown"} - Consulta status del producto publicado en Falabella`);
  logger.info("Datos recibidos:");
  logger.info(JSON.stringify(req.body));

  const { sku, marketplace_id } = req.body;
  const user_id = req.user?.id;

  // ✅ VALIDACIÓN temprana de parámetros requeridos
  if (!sku || !marketplace_id) {
    const hasTypo = req.body.marketplsce_id !== undefined;
    return res.status(400).json({
      success: false,
      error: hasTypo 
        ? 'Parámetro incorrecto: "marketplsce_id" (typo). Debe ser "marketplace_id"'
        : 'Faltan parámetros requeridos: sku y marketplace_id'
    });
  }

  try {
    const credential = await MarketplaceCredentialRepository.findByMarketplaceAndUser(
      marketplace_id,
      user_id,
    );

    if (!credential) {
      return res.status(400).json({
        success: false,
        error: "Credenciales no encontradas para este marketplace y usuario",
      });
    }

    const baseUrl = "https://sellercenter-api.falabella.com";
    const userId = credential.seller_email;
    const apiKey = credential.api_key;

    if (!userId || !apiKey) {
      return res.status(400).json({
        success: false,
        error: "Faltan credenciales: seller_email o api_key",
      });
    }

    // ✅ PARÁMETROS CORRECTOS para búsqueda EXACTA por SKU
    const params = {
      UserID: userId,
      Version: "1.0",
      Action: "GetProducts",
      Format: "JSON",
      Timestamp: timestampMinus03(),
      SellerSku: sku // ✅ ARRAY JSON para búsqueda EXACTA
    };

    // 1) Ordenar alfabéticamente
    const keys = Object.keys(params).sort();

    // 2) Construir query ENCODEADA (esto se firma)
    const canonicalQuery = keys
      .map((k) => `${rfc3986Encode(k)}=${rfc3986Encode(String(params[k]))}`)
      .join("&");

    // 3) Firma HMAC SHA256 HEX
    const signatureHex = crypto
      .createHmac("sha256", apiKey)
      .update(canonicalQuery)
      .digest("hex");

    // 4) Encodear la firma
    const signature = rfc3986Encode(signatureHex);

    const url = `${baseUrl}?${canonicalQuery}&Signature=${signature}`;
    
    logger.info(`🔍 URL para estado del producto: ${url}`);

    const response = await axios.get(url, { timeout: 20000 });

    const data = response.data;
    logger.info(`Estado obtenido: ${JSON.stringify(data)}`);

    // ✅ PROCESAR RESPUESTA CORRECTAMENTE (estructura real de Falabella)
    let productStatus = null;
    
    if (data.SuccessResponse?.Body?.Products?.Product) {
      // Normalizar a array (puede ser objeto único o array)
      const products = Array.isArray(data.SuccessResponse.Body.Products.Product)
        ? data.SuccessResponse.Body.Products.Product
        : [data.SuccessResponse.Body.Products.Product];
      
      // Buscar producto EXACTO por SKU
      const product = products.find(p => p.SellerSku === sku);
      
      if (product) {
        // ✅ EXTRAER BusinessUnit (puede ser objeto o array)
        let businessUnit = product.BusinessUnits?.BusinessUnit;
        if (Array.isArray(businessUnit)) {
          businessUnit = businessUnit[0]; // Tomar primera unidad de negocio
        }
        
        // ✅ Estructura limpia para el frontend
        productStatus = {
          sku: product.SellerSku,
          name: product.Name || 'Sin nombre',
          brand: product.Brand || 'Genérica',
          status: businessUnit?.Status || 'unknown', // 'active', 'inactive', 'deleted'
          stock: parseInt(businessUnit?.Stock || '0', 10),
          price: parseFloat(businessUnit?.Price || '0'),
          published: businessUnit?.IsPublished === '1' || businessUnit?.IsPublished === 1,
          qc_status: product.QCStatus || 'pending', // 'approved', 'pending', 'rejected'
          category: product.PrimaryCategory || '',
          last_updated: product.LastUpdateDate || null,
          url: product.Url || null,
          main_image: product.MainImage || null,
          content_score: parseInt(product.ContentScore || '0', 10)
        };
      }
    }

    // ✅ RESPUESTA OPTIMIZADA PARA FRONTEND
    return res.status(200).json({
      success: true,
      found: !!productStatus,
      product: productStatus, // ✅ Nombre consistente con otros endpoints
      message: productStatus 
        ? `Producto encontrado en Falabella (estado: ${productStatus.status})`
        : `Producto con SKU "${sku}" no encontrado en Falabella`
    });
  } catch (error) {
    logger.error(`❌ Falabella status error: ${error.message}`);

    if (error.response) {
      logger.error("❌ Respuesta de error:");
      logger.error(JSON.stringify(error.response.data, null, 2));
    }

    let errorMessage = error.message || "Error interno";
    let statusCode = 500;

    if (error.response?.data?.ErrorResponse?.Head) {
      const errorCode = error.response.data.ErrorResponse.Head.ErrorCode;
      const errorMsg = error.response.data.ErrorResponse.Head.ErrorMessage;

      if (errorCode === "7") {
        errorMessage = "Firma inválida (E007). Verifica API Key y formato de timestamp";
        statusCode = 401;
      } else if (errorCode === "9") {
        errorMessage = 'Acceso denegado (E009). Verifica rol "Seller API Product Access"';
        statusCode = 403;
      } else if (errorCode === "3") {
        errorMessage = "Timestamp expirado (E003).";
        statusCode = 400;
      } else if (errorCode === "70") {
        errorMessage = "SKU no válido o datos corruptos en la lista (E070).";
        statusCode = 400;
      } else {
        errorMessage = `${errorMsg} (Código: ${errorCode})`;
      }
    }

    return res.status(statusCode).json({
      success: false,
      error: errorMessage,
      error_code: error.response?.data?.ErrorResponse?.Head?.ErrorCode,
    });
  }
},
async falabellaFeedStatus(req, res) {
  logger.info(`${req.user?.name || "Unknown"} - Consulta estado de feed en Falabella`);
  logger.info("Datos recibidos:");
  logger.info(JSON.stringify(req.body));

  const { feed_id, marketplace_id } = req.body;
  const user_id = req.user?.id;

  // ✅ VALIDACIÓN temprana de parámetros requeridos
  if (!feed_id || !marketplace_id) {
    return res.status(400).json({
      success: false,
      error: 'Faltan parámetros requeridos: feed_id y marketplace_id'
    });
  }

  try {
    const credential = await MarketplaceCredentialRepository.findByMarketplaceAndUser(
      marketplace_id,
      user_id,
    );

    if (!credential) {
      return res.status(400).json({
        success: false,
        error: "Credenciales no encontradas para este marketplace y usuario",
      });
    }

    const baseUrl = "https://sellercenter-api.falabella.com";
    const userId = credential.seller_email;
    const apiKey = credential.api_key;

    if (!userId || !apiKey) {
      return res.status(400).json({
        success: false,
        error: "Faltan credenciales: seller_email o api_key",
      });
    }

    // ✅ PARÁMETROS para FeedStatus (igual que falabellaCategories que funciona)
    const params = {
      UserID: userId,
      Version: "1.0",
      Action: "FeedStatus",
      Format: "JSON",
      Timestamp: timestampMinus03(),
      FeedID: feed_id // ✅ UUID del feed a consultar
    };

    // 1) Ordenar alfabéticamente
    const keys = Object.keys(params).sort();

    // 2) Construir query ENCODEADA (esto se firma)
    const canonicalQuery = keys
      .map((k) => `${rfc3986Encode(k)}=${rfc3986Encode(String(params[k]))}`)
      .join("&");

    logger.info(`[FalabellaFeedStatus] 🔍 String to sign (ENCODEADO):`);
    logger.info(canonicalQuery);

    // 3) Firma HMAC SHA256 HEX
    const signatureHex = crypto
      .createHmac("sha256", apiKey)
      .update(canonicalQuery)
      .digest("hex");

    logger.info(`[FalabellaFeedStatus] ✅ Firma generada (HEX): ${signatureHex.substring(0, 16)}...`);

    // 4) Encodear la firma
    const signature = rfc3986Encode(signatureHex);

    // 5) Construir URL final
    const url = `${baseUrl}?${canonicalQuery}&Signature=${signature}`;
    
    logger.info(`[FalabellaFeedStatus] 🌐 URL para consulta de feed:`);
    logger.info(url);

    // ✅ Realizar solicitud a Falabella
    const response = await axios.get(url, { timeout: 10000 });

    const data = response.data;
    logger.info(`[FalabellaFeedStatus] 📊 Respuesta de Falabella:`);
    logger.info(JSON.stringify(data, null, 2));

    // ✅ Procesar respuesta exitosa
    if (data.SuccessResponse?.Body?.Feed) {
      const feed = data.SuccessResponse.Body.Feed;
      
      // Estructura limpia para el frontend
      const feedStatus = {
        feed_id: feed.FeedID || feed_id,
        status: feed.Status || 'unknown', // Queued, Processing, Canceled, Finished, Error
        action: feed.Action || 'unknown',
        source: feed.Source || 'unknown',
        total_records: parseInt(feed.TotalRecords || '0', 10),
        processed_records: parseInt(feed.ProcessedRecords || '0', 10),
        failed_records: parseInt(feed.FailedRecords || '0', 10),
        created_at: feed.CreatedAt || null,
        updated_at: feed.UpdatedAt || null,
        errors: feed.FeedErrors?.Error || [],
        warnings: feed.FeedWarnings?.Warning || []
      };

      return res.status(200).json({
        success: true,
        feed: feedStatus,
        message: `Feed ${feedStatus.status.toLowerCase()}`
      });
    }

    // ✅ Manejar respuesta sin datos (feed no encontrado)
    return res.status(404).json({
      success: false,
      error: `Feed con ID "${feed_id}" no encontrado`,
      error_code: "FEED_NOT_FOUND"
    });

  } catch (error) {
    logger.error(`[FalabellaFeedStatus] ❌ Error consultando estado de feed:`, error.message);

    if (error.response) {
      logger.error("❌ Respuesta de error de Falabella:");
      logger.error(JSON.stringify(error.response.data, null, 2));
    }

    let errorMessage = error.message || "Error interno";
    let statusCode = 500;
    let errorCode = null;

    if (error.response?.data?.ErrorResponse?.Head) {
      const head = error.response.data.ErrorResponse.Head;
      errorCode = head.ErrorCode;
      errorMessage = head.ErrorMessage || `Error ${errorCode}`;

      // Mapeo de códigos de error específicos
      if (errorCode === "12") {
        errorMessage = "ID de feed no válido (E012). Verifica que el FeedID sea un UUID correcto";
        statusCode = 400;
      } else if (errorCode === "7") {
        errorMessage = "Firma inválida (E007). Verifica API Key y formato de timestamp";
        statusCode = 401;
      } else if (errorCode === "9") {
        errorMessage = 'Acceso denegado (E009). Verifica rol "Seller API Product Access"';
        statusCode = 403;
      } else if (errorCode === "3") {
        errorMessage = "Timestamp expirado (E003).";
        statusCode = 400;
      } else if (errorCode === "1") {
        errorMessage = "Parámetro FeedID es obligatorio (E001)";
        statusCode = 400;
      }
    }

    return res.status(statusCode).json({
      success: false,
      error: errorMessage,
      error_code: errorCode || 'UNKNOWN_ERROR',
      feed_id: feed_id
    });
  }
},
async clearFalabellaMarketplaceCache(req, res) {
  const { marketplace_id } = req.params;
  
  try {
    clearMarketplaceCache(marketplace_id);
    logger.info(`Caché limpiado para marketplace ${marketplace_id}`);
    
    return res.status(200).json({
      success: true,
      message: `Caché de marketplace ${marketplace_id} limpiado correctamente`
    });
  } catch (error) {
    logger.error(`Error al limpiar caché del marketplace: ${error.message}`);
    return res.status(500).json({
      success: false,
      error: "Error al limpiar el caché del marketplace"
    });
  }
},

/**
 * Limpiar caché global (todas las plataformas)
 */
async clearAllMarketplacesCache(req, res) {
  try {
    clearAllCache();
    logger.info(`Caché global limpiado`);
    
    return res.status(200).json({
      success: true,
      message: "Caché global limpiado correctamente"
    });
  } catch (error) {
    logger.error(`Error al limpiar caché global: ${error.message}`);
    return res.status(500).json({
      success: false,
      error: "Error al limpiar el caché global"
    });
  }
}
};

module.exports = OAuthController;
