// src/repositories/ProductFieldMappingRepository.js
const { ProductFieldMapping, Marketplace } = require('../models');
const logger = require('../../config/logger');

// Formateo de salida
const formatMapping = (record) => ({
  id: record.id,
  marketplace_id: record.marketplace_id,
  internal_field: record.internal_field,
  external_field: record.external_field,
  required: record.required,
  data_type: record.data_type,
  direction: record.direction,
  default_alue: record.default_value,
  validation_ules: record.validation_rules
});

const ProductFieldMappingRepository = {
  // Devuelve instancia cruda para update/delete
  async findById(id) {
    return await ProductFieldMapping.findByPk(id);
  },

  async findByMarketplace(marketplaceId) {
    const records = await ProductFieldMapping.findAll({ where: { marketplace_id: marketplaceId } });
    return records.map(formatMapping);
  },

  async create(mappingData, options = {}) {
    const { marketplace_id, internal_field, external_field } = mappingData;
    logger.info(`[REPO] Creando mapeo de campo: ${internal_field} → ${external_field} (marketplace ${marketplace_id})`);
    try {
      return await ProductFieldMapping.create(mappingData, options);
    } catch (error) {
      logger.error(`[REPO] ERROR al crear mapeo de campo:`, error.message);
      throw error;
    }
  },

  async update(record, updateData) {
    const allowed = ['external_field', 'required', 'data_type', 'direction', 'default_value', 'validation_rules'];
    const clean = Object.keys(updateData)
      .filter(k => allowed.includes(k) && updateData[k] !== undefined)
      .reduce((a, k) => ({ ...a, [k]: updateData[k] }), {});
    await record.update(clean);
    return record;
  },

  async delete(record) {
    return await record.destroy();
  }
};

module.exports = ProductFieldMappingRepository;