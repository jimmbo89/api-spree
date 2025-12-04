// src/services/adapters/PublishingAdapterFactory.js
const FalabellaAdapter = require('./FalabellaAdapter');
const MercadoLibreAdapter = require('./MercadoLibreAdapter');
// Importa otros adapters aquí cuando los crees

class PublishingAdapterFactory {
  static getAdapter(marketplace, companyId, branchId = null) {
    // Detectar por dominio o tipo
    if (MercadoLibreAdapter.supports(marketplace)) {
      return new MercadoLibreAdapter(marketplace.id, companyId, branchId);
    }

    if (FalabellaAdapter.supports(marketplace)) {
      return new FalabellaAdapter(marketplace.id, companyId, branchId);
    }

    // Ejemplo futuro:
    // if (marketplace.domain?.includes('shopify')) {
    //   return new ShopifyAdapter(marketplace.id, companyId, branchId);
    // }

    throw new Error(`Adapter no encontrado para el marketplace: ${marketplace.name} (${marketplace.domain})`);
  }
}

module.exports = PublishingAdapterFactory;