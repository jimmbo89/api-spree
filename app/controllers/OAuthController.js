const logger = require('../../config/logger');
const axios = require('axios');
const qs = require('qs');
const {
  MarketplaceCredentialRepository,
  LogRepository
} = require('../repositories');
const { getRequestMetadata } = require('../util/requestUtil');
const { getUserId } = require('../../config/context');
const crypto = require('crypto');
function rawurlencode(str) {
  return encodeURIComponent(str)
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A')
    .replace(/~/g, '%7E');
}

const OAuthController = {
  async mercadoLibreCallback(req, res) {
    const { code, state } = req.body;
    logger.info('Datos recibidos actualizar las credenciales de mercado libre:');
    logger.info(JSON.stringify(req.body));
    const metadata = getRequestMetadata(req);

    if (!code || !state) {
      logger.warn('OAuth callback sin code o state');
      return res.status(400).json({ error: 'Datos incompletos: se requieren "code" y "state"' });
    }

    try {
      const [marketplaceId, userId] = state.split('_');
      logger.info('Marketplace');
      logger.info(marketplaceId);
      const credential = await MarketplaceCredentialRepository.findByMarketplaceAndUser(
        marketplaceId,
        userId
      );

      logger.info('Credenciales básicas obtenidas para OAuth Mercado Libre');
      logger.info(JSON.stringify(credential));

      if (!credential || !credential.client_id || !credential.client_secret) {
        throw new Error('Credenciales OAuth incompletas en la base de datos');
      }

      // ✅ URL oficial de tokens (sin espacios)
      const oauthTokenUrl = 'https://api.mercadolibre.com/oauth/token';

      logger.info('[OAuth] Enviando solicitud a Mercado Libre');

      logger.info(JSON.stringify({
        client_id: credential.client_id,
        client_secret: credential.client_secret,
        code: `"${code}"`, // comillas para detectar espacios
        redirect_uri: `"${credential.redirect_uri}"`, // comillas para detectar espacios
      }));

      logger.info(JSON.stringify(qs.stringify({
          grant_type: 'authorization_code',
          client_id: credential.client_id,
          client_secret: credential.client_secret,
          code: code,
          redirect_uri: credential.redirect_uri.trim() // ✅ elimina espacios
        })));
      // ✅ Petición exactamente como en tu ejemplo que funciona
      const tokenRes = await axios.post(
        oauthTokenUrl,
        qs.stringify({
          grant_type: 'authorization_code',
          client_id: credential.client_id,
          client_secret: credential.client_secret,
          code: code,
          redirect_uri: credential.redirect_uri.trim() // ✅ elimina espacios
        }),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
            // ❌ NO incluir 'Authorization' header
          }
        }
      );

      logger.info('[OAuth] Tokens recibidos correctamente');

      logger.info(JSON.stringify({
        has_access_token: !!tokenRes.data.access_token,
        has_refresh_token: !!tokenRes.data.refresh_token,
        expires_in: tokenRes.data.expires_in
      }));

      if (!tokenRes.data.access_token || !tokenRes.data.refresh_token) {
        throw new Error('Respuesta de Mercado Libre no contiene access_token o refresh_token');
      }

      // ✅ Guardar con redirect_uri limpio (sin espacios)
      await MarketplaceCredentialRepository.createOrUpdate({
        id: credential.id,
        marketplace_id: marketplaceId,
        user_id: userId,
        //client_secret: credential.client_secret,
        redirect_uri: credential.redirect_uri.trim(), // 🔑 ¡clave!
        access_token: tokenRes.data.access_token,
        refresh_token: tokenRes.data.refresh_token,
        expires_at: new Date(Date.now() + tokenRes.data.expires_in * 1000),
        //scopes: tokenRes.data.scope
      });

      await LogRepository.create({
        user_id: userId,
        action: 'oauth.mercadolibre.success',
        description: 'Tokens de Mercado Libre guardados exitosamente',
        ip_address: metadata.ip_address,
        user_agent: metadata.user_agent,
        status: 'success',
        meta: { marketplace_id: marketplaceId }
      });

      return res.status(200).json({
        success: true,
        message: 'Tokens de Mercado Libre guardados correctamente',
        data: {
          marketplace_id: marketplaceId,
          access_token: '[REDACTADO]',
          refresh_token: '[REDACTADO]',
          expires_in: tokenRes.data.expires_in
        }
      });

    } catch (error) {
      logger.error('OAuth callback error:', {
        message: error.message,
        stack: error.stack,
        code: req.query.code?.substring(0, 10),
        state: req.query.state
      });

      await LogRepository.create({
        user_id: userId,
        action: 'oauth.mercadolibre.error',
        description: `Error en OAuth: ${error.message}`,
        ip_address: metadata.ip_address,
        user_agent: metadata.user_agent,
        status: 'error',
        meta: { error: error.message }
      });

      return res.status(500).json({
        success: false,
        error: error.message || 'Error interno al procesar el callback de Mercado Libre'
      });
    }
  },

  async mercadoLibreCategory(req, res) {
    const { productName, site_id, marketplace_id, user_id: bodyUserId } = req.body;
    const user_id = bodyUserId || getUserId();
    logger.info('Datos recibidos al optener ls categorías de un producto en mercado libre:');
    logger.info(JSON.stringify(req.body));

    try {
      const credential = await MarketplaceCredentialRepository.findByMarketplaceAndUser(
        marketplace_id,
        user_id
      );
      logger.info('Credenciales básicas obtenidas para OAuth Mercado Libre');
      logger.info(JSON.stringify(credential));

      
       const domainDiscoveryUrl = `https://api.mercadolibre.com/sites/${site_id}/domain_discovery/search`;
            const response = await axios.get(domainDiscoveryUrl, {
              params: { q: productName, limit: 8 }//,
              //headers: { Authorization: `Bearer ${credential.access_token}` }
            });

      
      return res.status(200).json({
        success: true,
       categories: response.data
      });

    } catch (error) {
      logger.error('OAuth Category error:', {
        message: error.message,
        stack: error.stack
      });

      return res.status(500).json({
        success: false,
        error: error.message || 'Error interno al obtener las categorías de Mercado Libre'
      });
    }
  },

  async mercadoLibreAttributes(req, res) {
    const { category_id, marketplace_id, user_id: bodyUserId } = req.body;
    const user_id = bodyUserId || getUserId();
    logger.info('Datos recibidos al optener los atributos de una categoría en mercado libre:');
    logger.info(JSON.stringify(req.body));

    try {
      const credential = await MarketplaceCredentialRepository.findByMarketplaceAndUser(
        marketplace_id,
        user_id
      );
      logger.info('Credenciales básicas obtenidas para OAuth Mercado Libre');
      logger.info(JSON.stringify(credential));

      const domainCategoriesUrl = `https://api.mercadolibre.com/categories/${category_id}/attributes`;
      const response = await axios.get(domainCategoriesUrl, {
        headers: { Authorization: `Bearer ${credential.access_token}` }
      });

      
      return res.status(200).json({
        success: true,
       attributes: response.data
      });

    } catch (error) {
      logger.error('OAuth Category error:', {
        message: error.message,
        stack: error.stack
      });

      return res.status(500).json({
        success: false,
        error: error.message || 'Error interno al obtener los atributos de Mercado Libre'
      });
    }
  },

  // src/controllers/MarketplaceController.js
async falabellaCategories(req, res) {
    logger.info('Datos recibidos al obtener las categorías de un producto en falabella:');
    logger.info(JSON.stringify(req.body));
    
    const { productName, marketplace_id } = req.body;
    const user_id = req.user?.id;

    try {
        const credential = await MarketplaceCredentialRepository.findByMarketplaceAndUser(
            marketplace_id,
            user_id
        );

        if (!credential) {
            return res.status(400).json({
                success: false,
                error: 'Credenciales no encontradas'
            });
        }
       
        const sellerEmail = 'yasmany@klint.cl'; // ✅ UserID = Correo electrónico
        const apiKey = 'a67b6eb80cce44afec76c0bfc0918fc2d4e303de'; // ✅ API Key de Seller Center
        const sellerId = 'SC72B9D'; // ✅ Seller ID para User-Agent

        if (!sellerEmail || !apiKey || !sellerId) {
            return res.status(400).json({
                success: false,
                error: 'Credenciales de Falabella incompletas. Se requiere: correo (UserID), API Key y Seller ID'
            });
        }

        // ✅ Timestamp ISO 8601 completo con segundos
        //const timestamp = new Date().toISOString().replace(/\.\d+Z$/, '+0000');
        
      const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

        logger.info(`🕐 Timestamp generado: ${timestamp}`);
        const params = {
          Action: "GetCategorySuggestion",
          Format: "JSON",
          Name: "Mouse inalambrico Logitech",
          Timestamp: timestamp,
          UserID: sellerEmail,
          Version: "1.0"
        };
        const sortedKeys = Object.keys(params).sort();

        // :two: string a firmar (SIN encode)
        const stringToSign = sortedKeys
          .map(k => `${k}=${params[k]}`)
          .join("&");

        // :three: firma
        const signature = crypto
          .createHmac("sha256", apiKey)
          .update(stringToSign)
          .digest("hex");

        // :four: query encodeada
        const query = sortedKeys
          .map(
            k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`
          )
          .join("&");
        const url = `https://sellercenter-api.falabella.com?${query}&Signature=${signature}`;

        // debug vital
        logger.info("STRING TO SIGN:");
        logger.info( stringToSign);
        logger.info("STRING TO SIGN:");
        logger.info(signature);
        logger.info("URL:");
        logger.info(url);
        // ✅ Solicitud
        const response = await axios.get(url);

        logger.info('✅ Respuesta de Falabella:');
        logger.info(JSON.stringify(response.data, null, 2));
        
        const data = response.data;
        const categories = [];
        
        // ✅ Procesar respuesta según estructura real de Falabella
        if (data.SuccessResponse?.Body?.Categories?.Category) {
            const categoriesData = data.SuccessResponse.Body.Categories.Category;
            
            if (Array.isArray(categoriesData)) {
                categoriesData.forEach(cat => {
                    if (cat.CategoryId && cat.CategoryName) {
                        categories.push({
                            id: cat.CategoryId,
                            name: cat.CategoryName
                        });
                    }
                });
            } else if (categoriesData?.CategoryId && categoriesData?.CategoryName) {
                categories.push({
                    id: categoriesData.CategoryId,
                    name: categoriesData.CategoryName
                });
            }
        }

        return res.status(200).json({
            success: true,
            categories: categories,
            count: categories.length
        });

    } catch (error) {
        logger.error('❌ Falabella Categories error:', error.message);
        
        if (error.response) {
            logger.error('❌ Respuesta de error:');
            logger.error(JSON.stringify(error.response.data, null, 2));
        }

        // ✅ Mensajes de error específicos según código
        let errorMessage = error.message || 'Error interno';
        let statusCode = 500;

        if (error.response?.data?.ErrorResponse?.Head) {
            const errorCode = error.response.data.ErrorResponse.Head.ErrorCode;
            const errorMsg = error.response.data.ErrorResponse.Head.ErrorMessage;
            
            if (errorCode === '7') {
                errorMessage = 'Firma inválida (E007). Verifica que la API Key sea correcta y que el correo electrónico (UserID) sea el de tu cuenta de Seller Center.';
                statusCode = 401;
            } else if (errorCode === '9') {
                errorMessage = 'Acceso denegado (E009). Verifica que tu usuario tenga el rol "Seller API Product Access" en Seller Center.';
                statusCode = 403;
            } else if (errorCode === '3') {
                errorMessage = 'Timestamp expirado (E003). Por favor intenta nuevamente.';
                statusCode = 400;
            } else if (errorCode === '4') {
                errorMessage = 'Formato de timestamp inválido (E004).';
                statusCode = 400;
            } else {
                errorMessage = `${errorMsg} (Código: ${errorCode})`;
            }
        }

        return res.status(statusCode).json({
            success: false,
            error: errorMessage,
            error_code: error.response?.data?.ErrorResponse?.Head?.ErrorCode
        });
    }
}

};

module.exports = OAuthController;