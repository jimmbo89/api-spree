const logger = require("../../config/logger");
const { CompanyPreferenceRepository, CompanyRepository } = require("../repositories");
const { sequelize } = require('../models');

const CompanyPreferenceController = {
  async store(req, res) {
    const { company_id, timezone, language, date_format } = req.body;

    const company = await CompanyRepository.findById(company_id);
    if (!company) {
      return res.status(404).json({ success: false, message: "Compañía no encontrada" });
    }

    const t = await sequelize.transaction();
    try {
      const preference = await CompanyPreferenceRepository.createOrUpdate(
        { company_id, timezone, language, date_format },
        { transaction: t }
      );
      await t.commit();

      return res.status(200).json({
        success: true,
        preference,
        message: "Preferencias guardadas correctamente."
      });
    } catch (err) {
      if (t && !t.finished) await t.rollback();
      logger.error("CompanyPreferenceController->store: " + err.message);
      return res.status(500).json({ success: false, message: "No se pudieron guardar las preferencias.", details: err.message });
    }
  },

  async show(req, res) {
    try {
      const { company_id } = req.body;
      
      const company = await CompanyRepository.findById(company_id);
      if (!company) {
        return res.status(404).json({ success: false, message: "Compañía no encontrada" });
      }

      const preference = await CompanyPreferenceRepository.findByCompanyId(company_id);
      
      // Si no existe, devolver valores por defecto
      const defaultPref = {
        timezone: 'America/Santiago',
        language: 'es-CL',
        date_format: 'DD/MM/YYYY'
      };

      return res.status(200).json({
        success: true,
        preference: preference || defaultPref
      });
    } catch (err) {
      logger.error("CompanyPreferenceController->show: " + err.message);
      return res.status(500).json({ success: false, message: "Error al cargar preferencias.", details: err.message });
    }
  }
};

module.exports = CompanyPreferenceController;