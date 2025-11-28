// src/services/adapters/FalabellaAdapter.js

const BaseAdapter = require('./BaseAdapter');
const axios = require('axios');
const logger = require('../../../config/logger');
const { MarketplaceCredentialRepository } = require('../../repositories');

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

      // ✅ Validación mínima obligatoria (evita errores 400 silenciosos)
      const required = ['sku', 'productName', 'brand', 'price', 'stock', 'categoryId'];
      for (const field of required) {
        if (transformedProduct[field] == null || transformedProduct[field] === '') {
          const error = `Campo requerido por Falabella ausente o vacío: ${field}`;
          logger.error(`[FalabellaAdapter] ${error}`);
          return { success: false, error };
        }
      }

      // ✅ Asegurar tipos correctos
      transformedProduct.price = Math.round(Number(transformedProduct.price));
      transformedProduct.stock = Math.max(0, Math.round(Number(transformedProduct.stock)));

      // ✅ Log en modo debug (solo en desarrollo o con log level = debug)
      logger.debug('[FalabellaAdapter] Enviando a Falabella:', JSON.stringify(transformedProduct, null, 2));

      // ✅ Llamada a la API
      const response = await axios.post(
        'https://sellercenter-api.falabella.com',
        transformedProduct,
        {
          headers: {
            'X-Seller-ID': this.credential.client_id,   // ← Tu User ID de Seller Center
            'X-API-Key': this.credential.access_token,  // ← Tu API Key
            'Content-Type': 'application/json'
          },
          timeout: 10000 // 10 segundos
        }
      );

      // ✅ Respuesta exitosa
      return {
        success: true,
        data: {
          id: response.data.id || transformedProduct.sku,
          permalink: response.data.permalink || `https://www.falabella.cl/product/${transformedProduct.sku}`
        }
      };

    } catch (err) {
      let errorMsg = 'Error desconocido al publicar en Falabella';
      if (err.response) {
        errorMsg = err.response.data?.message || err.response.statusText || 'Error en respuesta de Falabella';
        logger.error(`[FalabellaAdapter] Error HTTP ${err.response.status}:`, errorMsg);
        logger.debug('Cuerpo de error:', JSON.stringify(err.response.data, null, 2));
      } else if (err.request) {
        errorMsg = 'No se recibió respuesta de Falabella (timeout o red)';
      } else {
        errorMsg = err.message || 'Error interno';
      }

      return { success: false, error: errorMsg };
    }
  }

  static supports(marketplace) {
    return marketplace.domain?.includes('falabella.cl');
  }
}

module.exports = FalabellaAdapter;