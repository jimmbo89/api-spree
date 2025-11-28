// src/repositories/MarketplaceRepository.js
const { Marketplace, ProductFieldMapping } = require('../models');
const logger = require('../../config/logger');

const formatMarketplace = (record) => ({
  id: record.id,
  name: record.name,
  description: record.description,
  type: record.type,
  domain: record.domain,
  config: record.config,
  active: record.active
});

const formatMapping = (record) => ({
  id: record.id,
  internal_field: record.internal_field,
  external_field: record.external_field,
  required: record.required,
  data_type: record.data_type,
  direction: record.direction,
  default_value: record.default_value,
  validation_rules: record.validation_rules
});

const MarketplaceRepository = {
  async findById(id) {
    return await Marketplace.findByPk(id);
  },

  async findByContextAndName(name) {
    const where = { name };
    const record = await Marketplace.findOne({ where });
    return record ? formatMarketplace(record) : null;
  },

  async findAllByContext() {
    const records = await Marketplace.findAll();
    return records.map(record => {
      // Parsear `config` solo si es string; si ya es objeto, dejarlo como está
      const config = typeof record.config === 'string' && record.config.trim()
        ? JSON.parse(record.config)
        : record.config || {};

      return {
        ...record.get ? record.get({ plain: true }) : record, // soporta instancias Sequelize y objetos planos
        config // sobrescribe el campo con la versión parseada
      };
    });
  },

  async create(marketplaceData, options = {}) {
    try {
      return await Marketplace.create(marketplaceData, options);
    } catch (error) {
      logger.error(`[REPO] ERROR al crear marketplace:`, error.message);
      throw error;
    }
  },

  async update(record, updateData) {
    const allowed = ['name', 'description', 'type', 'domain', 'config', 'active'];
    const clean = Object.keys(updateData)
      .filter(k => allowed.includes(k) && updateData[k] !== undefined)
      .reduce((a, k) => ({ ...a, [k]: updateData[k] }), {});
    await record.update(clean);
    return record;
  },

  async delete(record) {
    return await record.destroy();
  },

  async findMappingsByMarketplace(marketplaceId) {
    const records = await ProductFieldMapping.findAll({ where: { marketplace_id: marketplaceId } });
    return records.map(formatMapping);
  },

  async createMapping(mappingData, options = {}) {
    try {
      return await ProductFieldMapping.create(mappingData, options);
    } catch (error) {
      logger.error(`[REPO] ERROR al crear mapeo:`, error.message);
      throw error;
    }
  },

  async deleteMappingsByMarketplace(marketplaceId, options = {}) {
    await ProductFieldMapping.destroy({ where: { marketplace_id: marketplaceId }, ...options });
  }
};

module.exports = MarketplaceRepository;