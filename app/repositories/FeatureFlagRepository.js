// repositories/featureFlagRepository.js
const { FeatureFlag } = require("../models");
const logger = require("../../config/logger");

const FeatureFlagRepository = {
  async findByCompanyId(company_id) {
    return await FeatureFlag.findAll({ 
      where: { company_id },
      order: [['flag_key', 'ASC']]
    });
  },

  async findByKey(company_id, flag_key) {
    return await FeatureFlag.findOne({ 
      where: { company_id, flag_key } 
    });
  },

  async upsert(company_id, flag_key, data, options = {}) {
    const existing = await FeatureFlag.findOne({ 
      where: { company_id, flag_key } 
    });
    
    if (existing) {
      await existing.update(data, options);
      logger.info(`Feature flag actualizado: ${flag_key}`);
      return existing;
    }
    
    const flag = await FeatureFlag.create({
      company_id,
      flag_key,
      ...data
    }, options);
    
    logger.info(`Feature flag creado: ${flag_key}`);
    return flag;
  },

  async isEnabled(company_id, flag_key) {
    const flag = await this.findByKey(company_id, flag_key);
    return flag ? flag.is_enabled : false;
  },

  async enable(company_id, flag_key, options = {}) {
    return await this.upsert(company_id, flag_key, { is_enabled: true }, options);
  },

  async disable(company_id, flag_key, options = {}) {
    return await this.upsert(company_id, flag_key, { is_enabled: false }, options);
  }
};

module.exports = FeatureFlagRepository;