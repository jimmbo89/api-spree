const { CompanyPreference, Company, sequelize } = require("../models");
const logger = require("../../config/logger");

const CompanyPreferenceRepository = {
  async findByCompanyId(company_id) {
    const pref = await CompanyPreference.findOne({
      where: { company_id },
      include: [{ model: Company, as: 'company' }]
    });
    return pref;
  },

  async createOrUpdate(data, options = {}) {
    try {
      const existing = await CompanyPreference.findOne({ where: { company_id: data.company_id } });
      let preference;
      if (existing) {
        await existing.update(data, options);
        preference = existing;
      } else {
        preference = await CompanyPreference.create(data, options);
      }
      logger.info(`Preferencias actualizadas para tenant ID ${data.company_id}`);
      return preference;
    } catch (error) {
      logger.error("Error en CompanyPreferenceRepository->createOrUpdate:", error);
      throw new Error(`Error al guardar preferencias: ${error.message}`);
    }
  }
};

module.exports = CompanyPreferenceRepository;