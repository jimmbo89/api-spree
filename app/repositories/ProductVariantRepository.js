// repositories/ProductVariantRepository.js
const { error } = require("winston");
const logger = require("../../config/logger");
const { ProductVariant } = require("../models");

const ProductVariantRepository = {
  async findByProductId(productId) {
    return await ProductVariant.findAll({
      where: { product_id: productId },
      attributes: ['id', 'product_id', 'sku', 'internal_code', 'attributes', 'image']
    });
  },

  /**
   * NUEVO: Obtiene la primera variante de un producto (para usar como default)
   */
  async findOneByProductId(productId) {
    return await ProductVariant.findOne({
      where: { product_id: productId },
      order: [['id', 'ASC']], // Retorna la más antigua
      attributes: ['id', 'product_id', 'sku', 'internal_code', 'attributes', 'image']
    });
  },

  async findById(id) {
    return await ProductVariant.findByPk(id);
  },

  async findBySku(sku) {
    if (!sku) return null;
    return await ProductVariant.findOne({
      where: { sku }
    });
  },

  async create(variantData, options = {}) {
    logger.info('Creando variante:', JSON.stringify(variantData));
    
    try {
        // Asegurar que attributes sea un objeto (no array)
        const processedData = { ...variantData };
        
        if (processedData.attributes) {
            // Si es array, convertirlo a objeto
            if (Array.isArray(processedData.attributes)) {
                const obj = {};
                processedData.attributes.forEach(item => {
                    if (item.key && item.value !== undefined) {
                        obj[item.key] = item.value;
                    }
                });
                processedData.attributes = obj;
            }
            // Si ya es objeto, dejarlo como está
        } else {
            processedData.attributes = {};
        }
        
        return await ProductVariant.create(processedData, options);
    } catch (err) {
        logger.error(err);
        throw err;
    }
},

  /*async update(variant, data, options = {}) {
    return await variant.update(data, options);
  },*/

  async update(variant, data, options = {}) {
    logger.info('Actualizando variante ID:', variant.id, 'con datos:', JSON.stringify(data));

    try {
      const processedData = { ...data };

      // Procesar attributes igual que en create
      if (processedData.attributes !== undefined) {
        if (Array.isArray(processedData.attributes)) {
          const obj = {};
          processedData.attributes.forEach(item => {
            if (item.key && item.value !== undefined) {
              obj[item.key] = item.value;
            }
          });
          processedData.attributes = obj;
        }
        // Si ya es objeto, se mantiene
      }

      return await variant.update(processedData, options);
    } catch (err) {
      logger.error('Error al actualizar variante:', err);
      throw err;
    }
  },

  async delete(variant, options = {}) {
    return await variant.destroy(options);
  }
};

module.exports = ProductVariantRepository;
