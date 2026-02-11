// controllers/sii/DTEDocumentController.js
const logger = require("../../config/logger");
const { DteDocumentRepository, CompanyRepository, TenantLogRepository } = require("../repositories");
const { sequelize } = require('../models');
const SiiIntegrationService = require("../services/SII/SiiIntegrationService");

class DteDocumentController {
  async issue(req, res) {
    try {
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
        const result = await SiiIntegrationService.issueDTE(
          company_id,
          value,
          req.user?.id,
          { transaction: t }
        );
        await t.commit();
        return res.status(201).json(result);
      } catch (err) {
        if (t && !t.finished) await t.rollback();
        throw err;
      }
    } catch (err) {
      logger.error("DTEDocumentController->issue: " + err.message);
      return res.status(500).json({ 
        success: false, 
        message: "Error al emitir documento DTE.",
        details: err.message 
      });
    }
  }

  async index(req, res) {
    try {
      const { company_id } = req.body;
      const { document_type, sii_status, page = 1, limit = 10 } = req.query;

      const company = await CompanyRepository.findById(company_id);
      if (!company) {
        return res.status(404).json({ 
          success: false, 
          message: "Compañía no encontrada" 
        });
      }

      const where = { company_id };
      if (document_type) where.document_type = document_type;
      if (sii_status) where.sii_status = sii_status;

      const { count, rows } = await DteDocumentRepository.findByCompanyIdAndType(
        company_id,
        document_type,
        {
          limit: parseInt(limit),
          offset: (page - 1) * limit,
          order: [['createdAt', 'DESC']]
        }
      );

      return res.status(200).json({
        success: true,
         dteDocuments: rows.map(doc => ({
          id: doc.id,
          document_type: doc.document_type,
          folio: doc.folio,
          rut_receptor: doc.rut_receptor,
          razon_social_receptor: doc.razon_social_receptor,
          monto_total: doc.monto_total,
          fecha_emision: doc.fecha_emision,
          sii_status: doc.sii_status,
          track_id: doc.track_id,
          created_at: doc.createdAt
        })),
        pagination: {
          total: count,
          page: parseInt(page),
          limit: parseInt(limit),
          pages: Math.ceil(count / limit)
        }
      });
    } catch (err) {
      logger.error("DTEDocumentController->index: " + err.message);
      return res.status(500).json({ 
        success: false, 
        message: "Error al listar documentos.",
        details: err.message 
      });
    }
  }

  async show(req, res) {
    try {
      const { company_id, document_id } = req.body;

      const company = await CompanyRepository.findById(company_id);
      if (!company) {
        return res.status(404).json({ 
          success: false, 
          message: "Compañía no encontrada" 
        });
      }

      const document = await DteDocumentRepository.findById(document_id);
      if (!document || document.company_id !== company_id) {
        return res.status(404).json({ 
          success: false, 
          message: "Documento no encontrado" 
        });
      }

      return res.status(200).json({
        success: true,
         dtDocuments: {
          id: document.id,
          document_type: document.document_type,
          folio: document.folio,
          rut_emisor: document.rut_emisor,
          rut_receptor: document.rut_receptor,
          razon_social_receptor: document.razon_social_receptor,
          monto_neto: document.monto_neto,
          monto_iva: document.monto_iva,
          monto_total: document.monto_total,
          fecha_emision: document.fecha_emision,
          sii_status: document.sii_status,
          track_id: document.track_id,
          sii_error_code: document.sii_error_code,
          sii_error_message: document.sii_error_message,
          detalles: document.detalles,
          created_at: document.createdAt,
          updated_at: document.updatedAt
        }
      });
    } catch (err) {
      logger.error("DTEDocumentController->show: " + err.message);
      return res.status(500).json({ 
        success: false, 
        message: "Error al obtener documento.",
        details: err.message 
      });
    }
  }

  async checkStatus(req, res) {
    try {
      const { company_id, document_id } = req.body;

      const company = await CompanyRepository.findById(company_id);
      if (!company) {
        return res.status(404).json({ 
          success: false, 
          message: "Compañía no encontrada" 
        });
      }

      const result = await SiiIntegrationService.checkDocumentStatus(
        company_id,
        document_id,
        req.user?.id
      );

      return res.status(200).json(result);
    } catch (err) {
      logger.error("DTEDocumentController->checkStatus: " + err.message);
      return res.status(500).json({ 
        success: false, 
        message: "Error al consultar estado.",
        details: err.message 
      });
    }
  }
}

module.exports = new DteDocumentController();