// src/services/adapters/BaseAdapter.js
class BaseAdapter {
  constructor(marketplaceId, companyId, branchId = null) {
    this.marketplaceId = marketplaceId;
    this.companyId = companyId;
    this.branchId = branchId;
  }

  async publish(transformedProduct) {
    throw new Error('El método publish() debe ser implementado por el adapter');
  }

  static supports(marketplace) {
    throw new Error('El método supports() debe ser implementado por el adapter');
  }

   /**
   * Indica si el adapter soporta predicción de categoría
   */
  static supportsCategoryPrediction() {
    return false;
  }

  /**
   * Método para predecir categoría (solo implementado por adapters que soportan)
   */
  async predictCategory(title) {
    throw new Error('Este marketplace no soporta predicción de categoría');
  }
}

module.exports = BaseAdapter;