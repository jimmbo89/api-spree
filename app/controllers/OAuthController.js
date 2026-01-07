const logger = require('../../config/logger');
const axios = require('axios');
const qs = require('qs');
const {
  MarketplaceCredentialRepository,
  LogRepository
} = require('../repositories');
const { getRequestMetadata } = require('../util/requestUtil');
const proxyHelper = require('../util/proxyHelper');

const OAuthController = {
  async mercadoLibreCallback(req, res) {
    const { code, state } = req.query;
    logger.info('Datos recibidos:', req.query);
    const metadata = getRequestMetadata(req);

    if (!code || !state) {
      logger.warn('OAuth callback sin code o state');
      return res.status(400).json({ error: 'Datos incompletos: se requieren "code" y "state"' });
    }

    try {
      const [marketplaceId, companyId, branchIdStr] = state.split('_');
      const branchId = branchIdStr === 'null' ? null : branchIdStr;

      const credential = await MarketplaceCredentialRepository.findByMarketplaceAndContext(
        marketplaceId,
        companyId,
        branchId
      );

      logger.info('Credenciales básicas obtenidas para OAuth Mercado Libre', { credential });

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
        company_id: companyId,
        branch_id: branchId,
        client_id: credential.client_id,
        client_secret: credential.client_secret,
        redirect_uri: credential.redirect_uri.trim(), // 🔑 ¡clave!
        access_token: tokenRes.data.access_token,
        refresh_token: tokenRes.data.refresh_token,
        expires_at: new Date(Date.now() + tokenRes.data.expires_in * 1000),
        scopes: tokenRes.data.scope
      });

      await LogRepository.create({
        user_id: metadata.user_id,
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
          company_id: companyId,
          branch_id: branchId,
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
        user_id: metadata.user_id,
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
  }
};

module.exports = OAuthController;