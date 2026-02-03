// src/services/adapters/BaseAdapter.js
class BaseAdapter {
  constructor(marketplaceId, companyId, branchId = null, userId) {
    this.marketplaceId = marketplaceId;
    this.companyId = companyId;
    this.branchId = branchId;
    this.userId = userId;
  }

  /**
   * Preparar producto antes de publicar (implementar por cada adapter)
   * @param {Object} productData - Datos originales del producto
   * @returns {Promise<Object>} - Producto preparado para publicar
   */
  async prepareProduct(productData) {
    // Cada adapter implementa su propia lógica
    return productData;
  }

  /**
   * Validar producto antes de publicar
   * @param {Object} product - Producto preparado
   * @returns {Object} - { valid: boolean, errors: [] }
   */
  validateProduct(product) {
    return { valid: true, errors: [] };
  }

  /**
   * Publicar producto (implementar por cada adapter)
   */
  async publish(transformedProduct) {
    throw new Error('El método publish() debe ser implementado por el adapter');
  }

  /**
   * Obtener transformer específico (si aplica)
   */
  static getTransformer() {
    return null; // Cada adapter puede tener su propio transformer
  }

  static supports(marketplace) {
    throw new Error('El método supports() debe ser implementado por el adapter');
  }

  static supportsCategoryPrediction() {
    return false;
  }

  async predictCategory(title) {
    throw new Error('Este marketplace no soporta predicción de categoría');
  }
}

module.exports = BaseAdapter;