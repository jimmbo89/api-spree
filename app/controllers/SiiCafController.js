// controllers/sii/SiiCafController.js
const logger = require("../../config/logger");
const { SiiCafRepository, SiiCertificateRepository, CompanyRepository, TenantLogRepository } = require("../repositories");
const { CAFManager } = require("../services/SII/CAFManager");
const { sequelize } = require('../models');

class SiiCafController {
  async upload(req, res) {
    try {
      if (!req.file) {
        return res.status(400).json({ 
          success: false, 
          message: "Archivo CAF XML requerido" 
        });
      }

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
        const cafManager = new CAFManager();
        const cafData = await cafManager.parseCAFXml(req.file.buffer.toString());

        const validation = await cafManager.validateCAF(cafData, company_id, { transaction: t });
        if (!validation.isValid) {
          throw new Error(validation.message);
        }

        const certificate = await SiiCertificateRepository.findActiveByCompanyId(company_id, { transaction: t });
        if (!certificate) {
          throw new Error('Debe subir un certificado válido antes de cargar CAF');
        }

        const caf = await SiiCafRepository.create({
          company_id: company_id,
          certificate_id: certificate.id,
          document_type: cafData.documentType,
          folio_start: cafData.rangoD,
          folio_end: cafData.rangoH,
          folio_next: cafData.rangoD,
          issue_date: cafData.fa,
          expiration_date: cafData.fe,
          caf_xml: req.file.buffer.toString(),
          private_key: cafData.privateKey || '',
          is_active: true,
          is_exhausted: false,
          used_count: 0,
          remaining_count: cafData.rangoH - cafData.rangoD + 1
        }, { transaction: t });

        await TenantLogRepository.create({
          company_id: company_id,
          user_id: req.user?.id,
          module: 'sii',
          event_type: 'create',
          action: 'CAF cargado',
          description: `Tipo: ${cafData.documentType}, Folios: ${cafData.rangoD}-${cafData.rangoH}`,
          meta: { caf_id: caf.id, folios: cafData.rangoH - cafData.rangoD + 1 },
          result: 'success'
        }, { transaction: t });

        await t.commit();

        return res.status(201).json({
          success: true,
          message: 'CAF cargado correctamente',
           data: {
            id: caf.id,
            document_type: caf.document_type,
            folios_disponibles: caf.remaining_count,
            vigencia: `${caf.issue_date} - ${caf.expiration_date}`
          }
        });
      } catch (err) {
        if (t && !t.finished) await t.rollback();
        throw err;
      }
    } catch (err) {
      logger.error("SiiCafController->upload: " + err.message);
      return res.status(500).json({ 
        success: false, 
        message: "Error al cargar CAF.",
        details: err.message 
      });
    }
  }

  async index(req, res) {
    try {
      const { company_id } = req.body;
      
      const company = await CompanyRepository.findById(company_id);
      if (!company) {
        return res.status(404).json({ 
          success: false, 
          message: "Compañía no encontrada" 
        });
      }

      const cafs = await SiiCafRepository.findByCompanyId(company_id);
      
      return res.status(200).json({
        success: true,
         cafs: cafs
      });
    } catch (err) {
      logger.error("SiiCafController->index: " + err.message);
      return res.status(500).json({ 
        success: false, 
        message: "Error al listar CAFs.",
        details: err.message 
      });
    }
  }

  async toggleActive(req, res) {
    try {
      const { company_id, caf_id, is_active } = req.body;
      
      const company = await CompanyRepository.findById(company_id);
      if (!company) {
        return res.status(404).json({ 
          success: false, 
          message: "Compañía no encontrada" 
        });
      }

      const caf = await SiiCafRepository.findById(caf_id);
      if (!caf || caf.company_id !== company_id) {
        return res.status(404).json({ 
          success: false, 
          message: "CAF no encontrado" 
        });
      }

      await SIICafRepository.update(caf_id, { is_active: is_active });

      await TenantLogRepository.create({
        company_id: company_id,
        user_id: req.user?.id,
        module: 'sii',
        event_type: 'update',
        action: is_active ? 'CAF activado' : 'CAF desactivado',
        description: `CAF ${caf_id} ${is_active ? 'activado' : 'desactivado'}`,
        result: 'success'
      });

      return res.status(200).json({
        success: true,
        message: `CAF ${is_active ? 'activado' : 'desactivado'} correctamente`
      });
    } catch (err) {
      logger.error("SiiCafController->toggleActive: " + err.message);
      return res.status(500).json({ 
        success: false, 
        message: "Error al actualizar CAF.",
        details: err.message 
      });
    }
  }
}

module.exports = new SiiCafController();