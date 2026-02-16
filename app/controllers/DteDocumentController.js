// controllers/sii/DTEDocumentController.js
const logger = require("../../config/logger");
const { DteDocumentRepository, CompanyRepository, SiiCafRepository } = require("../repositories");
const { sequelize } = require('../models');
const SiiIntegrationService = require("../services/SII/SiiIntegrationService");

const DteDocumentController = {
  // ✅ CORREGIDO: Crear documento DTE
  async create(req, res) {
    try {
      const { company_id, ...data } = req.body;

      // Validar compañía
      const company = await CompanyRepository.findById(company_id);
      if (!company) {
        return res.status(404).json({ 
          success: false, 
          message: "Compañía no encontrada" 
        });
      }

      const t = await sequelize.transaction();
      try {
        // Crear documento DTE
        const document = await DteDocumentRepository.create({
          ...data,
          company_id
        }, { transaction: t });
        
        await t.commit();
        
        return res.status(201).json({
          success: true,
          message: "Documento DTE creado exitosamente",
          dteDocument: {
            id: document.id,
            document_type: document.document_type,
            folio: document.folio,
            rut_receptor: document.rut_receptor,
            razon_social_receptor: document.razon_social_receptor,
            monto_total: document.monto_total,
            sii_status: document.sii_status,
            created_at: document.createdAt
          }
        });
      } catch (err) {
        if (t && !t.finished) await t.rollback();
        throw err;
      }
    } catch (err) {
      logger.error("DTEDocumentController->create: " + err.message);
      return res.status(500).json({ 
        success: false, 
        message: "Error al crear documento DTE",
        details: err.message 
      });
    }
  },

  // ✅ CORREGIDO: Método issue
  async issue(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Crea dte documents issus`);
    logger.info(`Datos recibidos:\n ${JSON.stringify(req.body)}`);
    try {
      const { company_id, ...data } = req.body;

      // Validar compañía
      const company = await CompanyRepository.findById(company_id);
      if (!company) {
        return res.status(404).json({ 
          success: false, 
          message: "Compañía no encontrada" 
        });
      }
       const user_id = req.user.id;
      // Verificar que exista CAF activo para el tipo de documento
      const caf = await SiiCafRepository.findActiveByCompanyAndType(
        company_id,
        data.document_type
      );

      if (!caf) {
        return res.status(400).json({ 
          success: false, 
          message: `No existe CAF activo para el tipo de documento ${data.document_type}` 
        });
      }

      // Verificar folio disponible en CAF
      if (caf.folio_next > caf.folio_end) {
        return res.status(400).json({ 
          success: false, 
          message: "CAF agotado, debe cargar un nuevo CAF" 
        });
      }

      const t = await sequelize.transaction();
      try {
        // Asignar folio desde CAF
        data.folio = caf.folio_next;
        data.rut_emisor = company.rut;
        data.legal_name_emisor = company.name;

        // Crear documento DTE
        const document = await DteDocumentRepository.create({
          ...data,
          company_id
        }, { transaction: t });

        // Actualizar folio_next del CAF
        await SiiCafRepository.incrementFolio(caf.id, { transaction: t });

        // Emitir documento al SII
        const result = await SiiIntegrationService.issueDTE(
          document.id,
          user_id,
          { transaction: t }
        );

        // Actualizar documento con resultado del SII
        await DteDocumentRepository.update(document.id, {
          sii_status: result.sii_status,
          track_id: result.track_id,
          sii_response: typeof result.sii_response === 'string' 
            ? result.sii_response 
            : JSON.stringify(result.sii_response),
          xml_dte: result.xml_dte,
          xml_envio: result.xml_envio
        }, { transaction: t });

        await t.commit();

        return res.status(201).json({
          success: true,
          message: "Documento DTE emitido exitosamente",
          dteDocument: {
            id: document.id,
            document_type: document.document_type,
            folio: document.folio,
            rut_receptor: document.rut_receptor,
            razon_social_receptor: document.razon_social_receptor,
            monto_total: document.monto_total,
            sii_status: result.sii_status,
            track_id: result.track_id,
            created_at: document.createdAt
          }
        });
      } catch (err) {
        if (t && !t.finished) await t.rollback();
        throw err;
      }
    } catch (err) {
      logger.error("DTEDocumentController->issue: " + err.message);
      return res.status(500).json({ 
        success: false, 
        message: "Error al emitir documento DTE",
        details: err.message 
      });
    }
  },

  // ✅ CORREGIDO: index - usar findAndCountAll en lugar de findByCompanyIdAndType
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

      // Construir where clause
      const where = { company_id };
      if (document_type) where.document_type = document_type;
      if (sii_status) where.sii_status = sii_status;

      // Usar findAndCountAll con opciones de paginación
      const { count, rows } = await DteDocumentRepository.findAndCountAll({
        where,
        order: [['createdAt', 'DESC']]
      });

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
        message: "Error al listar documentos",
        details: err.message 
      });
    }
  },

  // ✅ CORREGIDO: show
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

      const document = await DteDocumentRepository.findByIdAndCompany(document_id, company_id);
      if (!document) {
        return res.status(404).json({ 
          success: false, 
          message: "Documento no encontrado" 
        });
      }

      return res.status(200).json({
        success: true,
        dteDocument: {
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
        message: "Error al obtener documento",
        details: err.message 
      });
    }
  },

  // ✅ AGREGADO: update
  async update(req, res) {
    try {
      const { company_id, document_id } = req.body;
      const updateData = req.body;

      const company = await CompanyRepository.findById(company_id);
      if (!company) {
        return res.status(404).json({ 
          success: false, 
          message: "Compañía no encontrada" 
        });
      }

      const document = await DteDocumentRepository.findByIdAndCompany(document_id, company_id);
      if (!document) {
        return res.status(404).json({ 
          success: false, 
          message: "Documento no encontrado" 
        });
      }

      // No permitir actualizar si ya fue emitido al SII
      if (document.sii_status !== 'pendiente') {
        return res.status(400).json({ 
          success: false, 
          message: "No se puede modificar un documento ya emitido al SII" 
        });
      }

      const updated = await DteDocumentRepository.update(document_id, updateData);

      return res.status(200).json({
        success: true,
        message: "Documento actualizado exitosamente",
        dteDocument: {
          id: updated.id,
          document_type: updated.document_type,
          folio: updated.folio,
          rut_receptor: updated.rut_receptor,
          razon_social_receptor: updated.razon_social_receptor,
          monto_total: updated.monto_total,
          sii_status: updated.sii_status,
          updated_at: updated.updatedAt
        }
      });
    } catch (err) {
      logger.error("DTEDocumentController->update: " + err.message);
      return res.status(500).json({ 
        success: false, 
        message: "Error al actualizar documento",
        details: err.message 
      });
    }
  },

  // ✅ AGREGADO: destroy
  async destroy(req, res) {
    try {
      const { company_id, document_id } = req.body;

      const company = await CompanyRepository.findById(company_id);
      if (!company) {
        return res.status(404).json({ 
          success: false, 
          message: "Compañía no encontrada" 
        });
      }

      const document = await DteDocumentRepository.findByIdAndCompany(document_id, company_id);
      if (!document) {
        return res.status(404).json({ 
          success: false, 
          message: "Documento no encontrado" 
        });
      }

      // No permitir eliminar si ya fue emitido al SII
      if (document.sii_status !== 'pendiente') {
        return res.status(400).json({ 
          success: false, 
          message: "No se puede eliminar un documento ya emitido al SII" 
        });
      }

      await DteDocumentRepository.destroy(document_id);

      return res.status(200).json({
        success: true,
        message: "Documento eliminado exitosamente"
      });
    } catch (err) {
      logger.error("DTEDocumentController->destroy: " + err.message);
      return res.status(500).json({ 
        success: false, 
        message: "Error al eliminar documento",
        details: err.message 
      });
    }
  },

  // ✅ CORREGIDO: checkStatus
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

      const document = await DteDocumentRepository.findByIdAndCompany(document_id, company_id);
      if (!document) {
        return res.status(404).json({ 
          success: false, 
          message: "Documento no encontrado" 
        });
      }

      const result = await SiiIntegrationService.checkDocumentStatus(
        company_id,
        document_id
      );

      return res.status(200).json({
        success: true,
        message: "Estado consultado exitosamente",
        dteDocument: {
          id: document_id,
          sii_status: result.sii_status,
          track_id: result.track_id,
          sii_response: result.sii_response,
          checked_at: new Date()
        }
      });
    } catch (err) {
      logger.error("DTEDocumentController->checkStatus: " + err.message);
      return res.status(500).json({ 
        success: false, 
        message: "Error al consultar estado",
        details: err.message 
      });
    }
  },
}

module.exports = DteDocumentController;