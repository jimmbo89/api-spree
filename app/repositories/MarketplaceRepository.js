// repositories/MarketplaceRepository.js
const { Marketplace, ProductFieldMapping } = require('../models');
const EncryptionService = require('../services/EncryptionService');
const logger = require('../../config/logger');

const formatMarketplace = (record) => {
  const plain = record.get ? record.get({ plain: true }) : record;

  // Descifrar client_secret solo si se va a exponer (¡cuidado en producción!)
  let client_secret = plain.client_secret;
  if (client_secret) {
    try {
      client_secret = EncryptionService.decrypt(client_secret);
    } catch (e) {
      logger.warn(`[REPO] No se pudo descifrar client_secret para marketplace ${plain.id}`);
    }
  }

  return {
    id: plain.id,
    name: plain.name,
    description: plain.description,
    type: plain.type,
    domain: plain.domain,
    // Campos OAuth explícitos
    client_id: plain.client_id,
    client_secret: client_secret, // ¡solo en contextos seguros!
    redirect_uri: plain.redirect_uri,
    scopes: plain.scopes,
    active: plain.active
  };
};

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
    const record = await Marketplace.findByPk(id);
    return record;
  },

  async findByIds(marketplaceIds) {
    if (!Array.isArray(marketplaceIds) || marketplaceIds.length === 0) {
      return { valid: true, marketplaces: [], missingIds: [] };
    }

    const marketplaces = await Marketplace.findAll({
      where: { id: marketplaceIds }
    });

    const foundIds = new Set(marketplaces.map(m => m.id));
    const missingIds = marketplaceIds.filter(id => !foundIds.has(id));

    return {
      valid: missingIds.length === 0,
      marketplaces: marketplaces.map(formatMarketplace),
      missingIds
    };
  },

  async findAll() {
    const records = await Marketplace.findAll();
    return records.map(formatMarketplace);
  },

  async create(marketplaceData, options = {}) {
    // Cifrar client_secret antes de guardar
    const data = { ...marketplaceData };
    if (data.client_secret) {
      data.client_secret = EncryptionService.encrypt(data.client_secret);
    }
    try {
      const record = await Marketplace.create(data, options);
      return formatMarketplace(record);
    } catch (error) {
      logger.error(`[REPO] ERROR al crear marketplace:`, error.message);
      throw error;
    }
  },

  async update(record, updateData) {
    const allowed = [
      'name', 'description', 'type', 'domain',
      'client_id', 'client_secret', 'redirect_uri', 'scopes', 'active'
    ];

    const clean = {};
    for (const key of allowed) {
      if (updateData[key] !== undefined) {
        if (key === 'client_secret' && updateData[key]) {
          clean[key] = EncryptionService.encrypt(updateData[key]);
        } else {
          clean[key] = updateData[key];
        }
      }
    }

    await record.update(clean);
    return formatMarketplace(record);
  },

  async delete(record) {
    return await record.destroy();
  },

  // --- Mapeos (sin cambios) ---
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