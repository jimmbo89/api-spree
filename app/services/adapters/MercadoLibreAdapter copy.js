const BaseAdapter = require('./BaseAdapter');
const axios = require('axios');
const logger = require('../../../config/logger');
const { MarketplaceCredentialRepository } = require('../../repositories');
const qs = require('qs');

class MercadoLibreAdapter extends BaseAdapter {
  async ensureValidCredentials() {
    this.credential = await MarketplaceCredentialRepository.findByMarketplaceAndContext(
      this.marketplaceId,
      this.companyId,
      this.branchId
    );

    if (!this.credential) {
      throw new Error('marketplace_credentials_not_found');
    }

    // Si el token está expirado y hay refresh_token, renovar
    // 👇 Comparación robusta en milisegundos (UTC)
   if (this.credential.expires_at) {
        const nowMs = Date.now();
        const expiresAtMs = new Date(this.credential.expires_at).getTime();

      logger.info(`[Token Check] Ahora: ${nowMs}`);
      logger.info(`[Token Check] Expira: ${expiresAtMs}`);

      if (expiresAtMs <= nowMs) {
        if (this.credential.refresh_token) {
          logger.info(`[MercadoLibreAdapter] Token expirado. Renovando...`);
          await this.refreshAccessToken();
        } else {
          logger.warn(`[MercadoLibreAdapter] Token expirado y no hay refresh_token`);
          this.credential.access_token = null;
        }
      }
    }

    // Nota: si no hay access_token (ni antes ni después de refresh),
    // el método publish() lo detectará y redirigirá a auth
  }

  async refreshAccessToken() {
    if (!this.credential.refresh_token) {
      logger.warn(`[MercadoLibreAdapter] refresh_token no disponible para renovar token`);
      return; // No lanzar error; se maneja en publish()
    }

    logger.info('Credenciales para refrescar el token:');
    logger.info(JSON.stringify(this.credential));

    // ✅ Siempre usar api.mercadolibre.com, sin importar el país
    const oauthTokenUrl = 'https://api.mercadolibre.com/oauth/token';
   const params = new URLSearchParams();
    params.append('grant_type', 'refresh_token');
    params.append('client_id', this.credential.client_id);
    params.append('client_secret', this.credential.client_secret);
    params.append('refresh_token', this.credential.refresh_token);

    const response = await axios.post(oauthTokenUrl, params, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    logger.info('Respuesta de refrescar el tokens');
    logger.info(JSON.stringify(response));

    const newTokenData = {
      access_token: response.data.access_token,
      refresh_token: response.data.refresh_token,
      expires_at: new Date(Date.now() + response.data.expires_in * 1000),
      marketplace_id: this.marketplaceId,
      company_id: this.companyId,
      branch_id: this.branchId,
      scopes: response.data.scope
    };

    await MarketplaceCredentialRepository.createOrUpdate(newTokenData);
    this.credential = { ...this.credential, ...newTokenData };
  }

  async publish(transformedProduct) {
    try {
      await this.ensureValidCredentials();

      // Si después de ensureValidCredentials aún no hay access_token,
      // significa que no se puede renovar → hay que autorizar
      if (!this.credential.access_token) {
        const basicCred = await MarketplaceCredentialRepository.findByMarketplaceAndContext(
          this.marketplaceId,
          this.companyId,
          this.branchId
        );
        if (basicCred && basicCred.client_id && basicCred.redirect_uri) {
          const state = `${this.marketplaceId}_${this.companyId}_${this.branchId || 'null'}`;
          const auth_url = `https://auth.mercadolibre.com/authorization?client_id=${encodeURIComponent(basicCred.client_id)}&redirect_uri=${encodeURIComponent(basicCred.redirect_uri)}&response_type=code&state=${encodeURIComponent(state)}`;
          return { auth_required: true, auth_url };
        } else {
          logger.error(`[MercadoLibreAdapter] Credenciales incompletas: faltan client_id o redirect_uri`);
          throw new Error('marketplace_credentials_incomplete');
        }
      }
      logger.info(`[MercadoLibreAdapter] Publicando producto en Mercado Libre con access_token válido`);
      logger.info(JSON.stringify(this.credential.access_token));
      // ✅ URL fija según documentación oficial
      const itemsUrl = 'https://api.mercadolibre.com/items';

      const response = await axios.post(itemsUrl, transformedProduct, {
        headers: {
          'Authorization': `Bearer ${this.credential.access_token}`,
          'Content-Type': 'application/json'
        }
      });

      return { success: true, data: response.data };

    } catch (err) {
       // Otros errores de la API
      const errorResponse = err.response?.data;
      const errorMsg = errorResponse
        ? JSON.stringify(errorResponse, null, 2)
        : err.message || 'Error desconocido';

      logger.error(`[MercadoLibreAdapter] Error al publicar en Mercado Libre:`);
      //logger.error(errorMsg);
      return { success: false, error: errorMsg };
    }
  }

  static supports(marketplace) {
    return marketplace.domain?.includes('mercadolibre');
  }
}

module.exports = MercadoLibreAdapter;