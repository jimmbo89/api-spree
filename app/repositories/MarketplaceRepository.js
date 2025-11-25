// src/repositories/MarketplaceRepository.js
const { Marketplace, ProductFieldMapping } = require('../models');
const logger = require('../../config/logger');

// Función auxiliar para formatear un marketplace
const formatMarketplace = (record) => ({
  id: record.id,
  company_id: record.company_id,
  user_id: record.user_id,
  name: record.name,
  description: record.description,
  type: record.type,
  domain: record.domain,
  config: record.config,
  active: record.active
});

// Función auxiliar para formatear un mapeo
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
  // --- Marketplaces ---
  async findById(id) {
    // Devuelve instancia cruda de Sequelize (para update/delete)
    return await Marketplace.findByPk(id);
  },

  async findByCompanyAndName(companyId, name) {
    const record = await Marketplace.findOne({ where: { company_id: companyId, name } });
    return record ? formatMarketplace(record) : null;
  },

  async findAllByCompany(companyId) {
    const records = await Marketplace.findAll({ where: { company_id: companyId } });
    return records.map(formatMarketplace);
  },

  async create(marketplaceData, options = {}) {
    logger.info(`[REPO] Creando marketplace: ${marketplaceData.name}`, { company_id: marketplaceData.company_id });
    try {
      return await Marketplace.create(marketplaceData, options);
    } catch (error) {
      logger.error(`[REPO] ERROR al crear marketplace:`, error.message);
      throw error;
    }
  },

  async update(record, updateData) {
    const allowed = ['name', 'description', 'type', 'domain', 'config', 'active', 'user_id', 'company_id'];
    const clean = Object.keys(updateData)
      .filter(k => allowed.includes(k) && updateData[k] !== undefined)
      .reduce((a, k) => ({ ...a, [k]: updateData[k] }), {});
    await record.update(clean);
    return record;
  },

  async delete(record) {
    return await record.destroy();
  },

  // --- Mapeos ---
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