// src/controllers/OAuthController.js
const logger = require('../../config/logger');
const axios = require('axios');
const {
  MarketplaceCredentialRepository,
  LogRepository
} = require('../repositories');
const { getRequestMetadata } = require('../util/requestUtil');

const OAuthController = {
  async mercadoLibreCallback(req, res) {
    const { code, state } = req.query;
    const metadata = getRequestMetadata(req);

    if (!code || !state) {
      logger.warn('OAuth callback sin code o state');
      return res.status(400).json({ error: 'Datos incompletos' });
    }

    try {
      // Decodificar state: "marketplaceId_companyId_branchId"
      const [marketplaceId, companyId, branchId] = state.split('_');
      
      // Cargar credenciales básicas
      const credential = await MarketplaceCredentialRepository.findByMarketplaceAndContext(
        marketplaceId,
        companyId,
        branchId === 'null' ? null : branchId
      );

      if (!credential || !credential.client_id || !credential.client_secret) {
        throw new Error('Credenciales OAuth incompletas');
      }

      // Intercambiar code por tokens
      const oauthTokenUrl = `${credential.marketplace_domain}/oauth/token`.replace(/\s+$/g, ''); // elimina espacios al final
      const tokenRes = await axios.post(oauthTokenUrl, {
        grant_type: 'authorization_code',
        client_id: credential.client_id,
        client_secret: credential.client_secret,
        redirect_uri: credential.redirect_uri,
        code
      });

      // Guardar tokens
      await MarketplaceCredentialRepository.createOrUpdate({
        marketplace_id: marketplaceId,
        company_id: companyId,
        branch_id: branchId === 'null' ? null : branchId,
        access_token: tokenRes.data.access_token,
        refresh_token: tokenRes.data.refresh_token,
        expires_at: new Date(Date.now() + tokenRes.data.expires_in * 1000)
      });

      // Log
      await LogRepository.create({
        user_id: metadata.user_id,
        action: 'oauth.mercadolibre.success',
        description: 'Tokens de MercadoLibre guardados exitosamente',
        ip_address: metadata.ip_address,
        user_agent: metadata.user_agent,
        status: 'success',
        meta: { marketplace_id: marketplaceId }
      });

      // Redirigir al frontend (ajusta la URL según tu app)
      res.redirect('/admin/publicaciones?oauth_success=true');

    } catch (error) {
      logger.error('OAuth callback error:', error.message);
      
      await LogRepository.create({
        user_id: metadata.user_id,
        action: 'oauth.mercadolibre.error',
        description: `Error en OAuth: ${error.message}`,
        ip_address: metadata.ip_address,
        user_agent: metadata.user_agent,
        status: 'error',
        meta: null
      });

      res.redirect('/admin/publicaciones?oauth_error=true');
    }
  }
};

module.exports = OAuthController;