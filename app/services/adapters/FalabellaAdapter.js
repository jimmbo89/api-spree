// src/services/adapters/FalabellaAdapter.js
const BaseAdapter = require('./BaseAdapter');
const axios = require('axios');
const logger = require('../../../config/logger');
const {
  MarketplaceCredentialRepository
} = require('../../repositories');

class FalabellaAdapter extends BaseAdapter {
  async ensureValidCredentials() {
    this.credential = await MarketplaceCredentialRepository.findByMarketplaceAndContext(
      this.marketplaceId,
      this.companyId,
      this.branchId
    );

    if (!this.credential || !this.credential.client_id || !this.credential.access_token) {
      throw new Error('falabella_credentials_missing');
    }
  }

  async publish(transformedProduct) {
    try {
      await this.ensureValidCredentials();

      // Publicar directamente con API Key
      const response = await axios.post('https://sellercenter-api.falabella.com', transformedProduct, {
        headers: {
          'X-Seller-ID': this.credential.client_id,   // Seller ID
          'X-API-Key': this.credential.access_token,  // API Key
          'Content-Type': 'application/json'
        }
      });

      return { success: true,  data: response.data };

    } catch (err) {
      const errorMsg = err.response?.data?.message || err.message || 'Error en Falabella';
      logger.error(`[FalabellaAdapter] Error al publicar:`, errorMsg);
      return { success: false, error: errorMsg };
    }
  }

  static supports(marketplace) {
    return marketplace.domain?.includes('falabella.cl');
  }
}

module.exports = FalabellaAdapter;