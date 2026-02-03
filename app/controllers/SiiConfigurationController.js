// controllers/sii/SIIConfigurationController.js
const logger = require("../../config/logger");
const { SiiConfigurationRepository, CompanyRepository } = require("../repositories");
const { sequelize } = require('../models');
const SIIConnectionService = require("../services/SII/SIIConnectionService");

class SIIConfigurationController {
  async show(req, res) {
    try {
      const { company_id } = req.body;

      const company = await CompanyRepository.findById(company_id);
      if (!company) {
        return res.status(404).json({ 
          success: false, 
          message: "Compañía no encontrada" 
        });
      }

      const status = await SIIConnectionService.getIntegrationStatus(company_id);

      return res.status(200).json({
        success: true,
         status
      });
    } catch (err) {
      logger.error("SIIConfigurationController->show: " + err.message);
      return res.status(500).json({ 
        success: false, 
        message: "Error al cargar estado SII.",
        details: err.message 
      });
    }
  }

  async store(req, res) {
    const { company_id, rut, legal_name, sii_environment, contributor_type } = req.body;

    const company = await CompanyRepository.findById(company_id);
    if (!company) {
      return res.status(404).json({ 
        success: false, 
        message: "Compañía no encontrada" 
      });
    }

    const t = await sequelize.transaction();
    try {
      const result = await SIIConnectionService.configureSII(
        company_id,
        { rut, legal_name, sii_environment, contributor_type },
        req.user?.id,
        { transaction: t }
      );
      await t.commit();
      return res.status(200).json(result);
    } catch (err) {
      if (t && !t.finished) await t.rollback();
      logger.error("SIIConfigurationController->store: " + err.message);
      return res.status(500).json({ 
        success: false, 
        message: "No se pudo configurar SII.",
        details: err.message 
      });
    }
  }

  async connect(req, res) {
    const { company_id } = req.body;
    
    const company = await CompanyRepository.findById(company_id);
    if (!company) {
      return res.status(404).json({ 
        success: false, 
        message: "Compañía no encontrada" 
      });
    }

    const t = await sequelize.transaction();
    try {
      const config = await SiiConfigurationRepository.connect(company_id, { transaction: t });
      await t.commit();
      
      await TenantLogRepository.create({
        company_id: company_id,
        user_id: req.user?.id,
        module: 'sii',
        event_type: 'update',
        action: 'Conexión SII',
        description: 'SII conectado',
        result: 'success'
      });

      return res.status(200).json({ 
        success: true, 
        config, 
        message: "Conectado a SII." 
      });
    } catch (err) {
      if (t && !t.finished) await t.rollback();
      logger.error("SIIConfigurationController->connect: " + err.message);
      return res.status(500).json({ 
        success: false, 
        message: "Error al conectar con SII.",
        details: err.message 
      });
    }
  }

  async disconnect(req, res) {
    const { company_id } = req.body;
    
    const company = await CompanyRepository.findById(company_id);
    if (!company) {
      return res.status(404).json({ 
        success: false, 
        message: "Compañía no encontrada" 
      });
    }

    const t = await sequelize.transaction();
    try {
      const result = await SIIConnectionService.disconnectSII(
        company_id,
        req.user?.id,
        { transaction: t }
      );
      await t.commit();
      return res.status(200).json(result);
    } catch (err) {
      if (t && !t.finished) await t.rollback();
      logger.error("SIIConfigurationController->disconnect: " + err.message);
      return res.status(500).json({ 
        success: false, 
        message: "Error al desconectar de SII.",
        details: err.message 
      });
    }
  }
}

module.exports = new SIIConfigurationController();