const logger = require("../../config/logger");
const { FeatureFlagRepository } = require("../repositories");

const FeatureFlagController = {
  async index(req, res) {
    try {
      const { company_id } = req.body;
      const flags = await FeatureFlagRepository.findByCompanyId(company_id);
      return res.status(200).json({
        success: true,
        featureFlags: flags.map(f => ({
          flag_key: f.flag_key,
          is_enabled: f.is_enabled,
          source: f.source
        })),
        message: "Algunas funcionalidades dependen de tu plan contratado."
      });
    } catch (err) {
      logger.error("FeatureFlagController->index: " + err.message);
      return res.status(500).json({ success: false, message: "Error al cargar feature flags.", details: err.message });
    }
  }
};

module.exports = FeatureFlagController;