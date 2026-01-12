const logger = require("../../config/logger");
const { ProductAttribute } = require("../models");

const ProductAttributeRepository = {
  async findByProductId(productId) {
    return await ProductAttribute.findAll({
      where: { product_id: productId },
      attributes: ['id', 'product_id', 'attribute_id', 'value']
    });
  },

  async findById(id) {
    return await ProductAttribute.findByPk(id);
  },

  async create(attributeData, options = {}) {
    logger.info('Creando atributo de producto:', JSON.stringify(attributeData));
    
    try {
        // Validar que los campos obligatorios existan
        const processedData = { ...attributeData };
        
        if (!processedData.product_id || !processedData.attribute_id || processedData.value === undefined) {
            throw new Error('Faltan campos requeridos: product_id, attribute_id, value');
        }
        
        return await ProductAttribute.create(processedData, options);
    } catch (err) {
        logger.error(err);
        throw err;
    }
  },

  async update(attribute, data, options = {}) {
    logger.info('Actualizando atributo de producto ID:', attribute.id, 'con datos:', JSON.stringify(data));

    try {
      const processedData = { ...data };

      // Validar campos si vienen
      if (processedData.value === undefined && processedData.attribute_id === undefined && processedData.product_id === undefined) {
        throw new Error('No hay datos válidos para actualizar');
      }

      return await attribute.update(processedData, options);
    } catch (err) {
      logger.error('Error al actualizar atributo de producto:', err);
      throw err;
    }
  },

  async delete(attribute, options = {}) {
    return await attribute.destroy(options);
  }
};

module.exports = ProductAttributeRepository;