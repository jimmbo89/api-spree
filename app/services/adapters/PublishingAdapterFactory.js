// src/services/adapters/PublishingAdapterFactory.js
const FalabellaAdapter = require('./FalabellaAdapter');
const MercadoLibreAdapter = require('./MercadoLibreAdapter');

class PublishingAdapterFactory {
  /**
   * Crea un adapter para el marketplace especificado
   * @param {object} marketplace - Objeto del marketplace
   * @param {number} companyId - ID de la empresa
   * @param {number|null} branchId - ID de la sucursal
   * @param {number} userId - ID del usuario
   * @param {number|object} credential - ID de credencial (número) O objeto credential completo
   * @returns {BaseAdapter} Instancia del adapter correspondiente
   */
  static getAdapter(marketplace, companyId, branchId = null, userId, credential = null) {
    // ← credential puede ser: number (credential_id) | object (credential completo) | null
    
    if (MercadoLibreAdapter.supports(marketplace)) {
      return new MercadoLibreAdapter(
        marketplace.id, 
        companyId, 
        branchId, 
        userId, 
        credential  // ← Pasamos tal cual (ID u objeto)
      );
    }

    if (FalabellaAdapter.supports(marketplace)) {
      return new FalabellaAdapter(
        marketplace.id, 
        companyId, 
        branchId, 
        userId, 
        credential
      );
    }

    throw new Error(`Adapter no encontrado para el marketplace: ${marketplace.name} (${marketplace.domain})`);
  }
}

module.exports = PublishingAdapterFactory;