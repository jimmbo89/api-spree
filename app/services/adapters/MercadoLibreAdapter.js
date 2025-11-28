// src/services/adapters/MercadoLibreAdapter.js
const BaseAdapter = require('./BaseAdapter');
const axios = require('axios');
const logger = require('../../../config/logger');
const {
  MarketplaceCredentialRepository
} = require('../../repositories');

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

    if (this.credential.expires_at && new Date(this.credential.expires_at) < new Date()) {
      await this.refreshAccessToken();
    }

    if (!this.credential.access_token) {
      throw new Error('access_token_required');
    }
  }

  async refreshAccessToken() {
    if (!this.credential.refresh_token) {
      throw new Error('refresh_token_not_available');
    }

     const oauthTokenUrl = `${this.credential.marketplace_domain}/oauth/token`.replace(/\s+$/g, '');
    const response = await axios.post(oauthTokenUrl, {
      grant_type: 'refresh_token',
      client_id: this.credential.client_id,
      client_secret: this.credential.client_secret,
      refresh_token: this.credential.refresh_token
    });

    const newTokenData = {
      access_token: response.data.access_token,
      refresh_token: response.data.refresh_token,
      expires_at: new Date(Date.now() + response.data.expires_in * 1000),
      marketplace_id: this.marketplaceId,
      company_id: this.companyId,
      branch_id: this.branchId
    };

    await MarketplaceCredentialRepository.createOrUpdate(newTokenData);
    this.credential = { ...this.credential, ...newTokenData };
  }

  async publish(transformedProduct) {
    try {
      await this.ensureValidCredentials();

      const oauthTokenUrl = `${this.credential.marketplace_domain}/items`.replace(/\s+$/g, '');
      const response = await axios.post(oauthTokenUrl, transformedProduct, {
        headers: {
          'Authorization': `Bearer ${this.credential.access_token}`,
          'Content-Type': 'application/json'
        }
      });

      return { success: true, data: response.data };

    } catch (err) {
      if (err.message === 'marketplace_credentials_not_found' || err.message === 'access_token_required') {
        const basicCred = await MarketplaceCredentialRepository.findByMarketplaceAndContext(
          this.marketplaceId,
          this.companyId,
          this.branchId
        );

        if (basicCred && basicCred.client_id && basicCred.redirect_uri) {
          const state = `${this.marketplaceId}_${this.companyId}_${this.branchId || 'null'}`;
          const oauthTokenUrl = `${this.credential.marketplace_domain}/items`.replace(/\s+$/g, '');
          const auth_url = `https://auth.mercadolibre.cl/authorization?client_id=${basicCred.client_id}&redirect_uri=${basicCred.redirect_uri}&response_type=code&state=${state}`;
          return { auth_required: true, auth_url };
        } else {
          throw new Error('marketplace_credentials_incomplete');
        }
      }

      const errorMsg = err.response?.data?.message || err.message || 'Error desconocido';
      return { success: false, error: errorMsg };
    }
  }

  static supports(marketplace) {
    return marketplace.domain?.includes('mercadolibre');
  }
}

module.exports = MercadoLibreAdapter;