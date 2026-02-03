const { SiiConfiguration, Company, sequelize } = require("../models");
const logger = require("../../config/logger");

const SiiConfigurationRepository = {
  async findByCompanyId(company_id) {
    return await SiiConfiguration.findOne({ where: { company_id } });
  },

  async createOrUpdate(data, options = {}) {
    const existing = await SiiConfiguration.findOne({ where: { company_id: data.company_id } });
    let config;
    if (existing) {
      await existing.update(data, options);
      config = existing;
    } else {
      config = await SiiConfiguration.create(data, options);
    }
    logger.info(`Configuración SII actualizada para tenant ID ${data.company_id}`);
    return config;
  },

  async connect(company_id, options = {}) {
    const config = await SiiConfiguration.findOne({ where: { company_id } });
    if (!config) throw new Error("Configuración SII no encontrada");
    await config.update({
      is_connected: true,
      connected_at: new Date()
    }, options);
    return config;
  },

  async disconnect(company_id, options = {}) {
    const config = await SiiConfiguration.findOne({ where: { company_id } });
    if (!config) throw new Error("Configuración SII no encontrada");
    await config.update({
      is_connected: false,
      disconnected_at: new Date()
    }, options);
    return config;
  }
};

module.exports = SiiConfigurationRepository;