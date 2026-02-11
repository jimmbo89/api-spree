const logger = require("../../config/logger");
const fs = require('fs');
const path = require('path');
const { SiiCafRepository, SiiCertificateRepository, CompanyRepository, TenantLogRepository } = require("../repositories");

const { sequelize } = require('../models');
const CAFManager = require("../services/SII/CAFManager");

const SiiCafController = {
  async list(req, res) {
    try {
      const { certificate_id } = req.body;

      const certificate = await SiiCertificateRepository.findById(certificate_id);
      if (!certificate) {
        return res.status(404).json({ success: false, message: "Certificado no encontrado" });
      }

      const cafs = await SiiCafRepository.findByCertificateId(certificate_id);

      return res.status(200).json({
        success: true,
         cafs
      });
    } catch (err) {
      logger.error("SiiCafController->list: " + err.message);
      return res.status(500).json({ success: false, message: "Error al listar CAFs." });
    }
  },

  async create(req, res) {
  logger.info(`${req.user?.name || "Unknown"} - Crea CAF`);
  logger.info(`Datos recibidos del CAF:\n ${JSON.stringify(req.body)}`);

  const t = await sequelize.transaction();
  try {
    const { certificate_id, expiration_date, private_key } = req.body;
    const xmlFile = req.file; // 👈 multer.single() → req.file

    if (!xmlFile) {
      await t.rollback();
      return res.status(400).json({ success: false, message: "Archivo XML del CAF requerido" });
    }

    const certificate = await SiiCertificateRepository.findById(certificate_id, { transaction: t });
    if (!certificate) {
      await t.rollback();
      return res.status(404).json({ success: false, message: "Certificado no válido" });
    }

    // ✅ Leer desde buffer (no desde disco)
    const xmlContent = xmlFile.buffer.toString('utf8'); // 👈 clave!
    const cafData = await CAFManager.parseCAFXml(xmlContent);

    // ✅ Validar estructura básica
    if (!cafData.documentType || !cafData.rangoD || !cafData.rangoH) {
      await t.rollback();
      return res.status(400).json({ success: false, message: "CAF con datos incompletos" });
    }

    // ✅ Validar integridad del CAF (fechas, rango, duplicados, etc.)
    const validation = await CAFManager.validateCAF(cafData, certificate.company_id, { transaction: t });
    if (!validation.isValid) {
      await t.rollback();
      return res.status(400).json({ success: false, message: validation.message });
    }

    // ✅ Crear registro usando SOLO datos del XML
    const caf = await SiiCafRepository.create({
      certificate_id,
      company_id: certificate.company_id,
      document_type: cafData.documentType,
      folio_start: cafData.rangoD,
      folio_end: cafData.rangoH,
      folio_next: cafData.rangoD,
      issue_date: cafData.fa,
      expiration_date: expiration_date || cafData.fe, // permite sobrescribir
      caf_xml: xmlContent,
      private_key: private_key || cafData.privateKey || '',
      is_active: true,
      is_exhausted: false,
      used_count: 0,
      remaining_count: cafData.rangoH - cafData.rangoD + 1
    }, { transaction: t });

    await TenantLogRepository.create({
      company_id: certificate.company_id,
      user_id: req.user?.id,
      module: 'sii',
      event_type: 'create',
      action: 'CAF creado',
      description: `Tipo ${cafData.documentType}, Folios ${cafData.rangoD}-${cafData.rangoH}`,
      meta: { caf_id: caf.id },
      result: 'success'
    }, { transaction: t });

    await t.commit();

    // ✅ Opcional: eliminar archivo temporal
    fs.unlinkSync(xmlFile.path);

    return res.status(201).json({
      success: true,
      message: "CAF creado correctamente",
      data: caf
    });
  } catch (err) {
    await t.rollback();
    logger.error("SiiCafController->create: " + err.message);
    return res.status(500).json({ success: false, message: err.message || "Error al crear CAF" });
  }
},

async update(req, res) {
  logger.info(`${req.user?.name || "Unknown"} - Edida CAF`);
  logger.info(`Datos recibidos del CAF:\n ${JSON.stringify(req.body)}`);
  const t = await sequelize.transaction();
  try {
    const { id, certificate_id, expiration_date, private_key } = req.body;
    const xmlFile = req.file;

    const existing = await SiiCafRepository.findById(id, { transaction: t });
    if (!existing) {
      await t.rollback();
      return res.status(404).json({ success: false, message: "CAF no encontrado" });
    }

    let certificate;
    if (certificate_id !== undefined) {
      certificate = await SiiCertificateRepository.findById(certificate_id, { transaction: t });
      if (!certificate) {
        await t.rollback();
        return res.status(404).json({ success: false, message: "Certificado no válido" });
      }
    }

    // ✅ Preparar datos para actualización
    const updateData = {};

    // ✅ Si se envió nuevo certificado, actualizarlo
    if (certificate_id !== undefined) {
      updateData.certificate_id = certificate_id;
      updateData.company_id = certificate.company_id;
    }

    // ✅ Manejo de XML
    if (xmlFile) {
      const cafXml = xmlFile.buffer.toString('utf8');
      const cafData = await CAFManager.parseCAFXml(cafXml);

      if (!cafData.documentType || !cafData.rangoD || !cafData.rangoH) {
        await t.rollback();
        return res.status(400).json({ success: false, message: "CAF con datos incompletos" });
      }

      const validation = await CAFManager.validateCAF(cafData, 
        certificate?.company_id || existing.company_id, 
        { transaction: t, excludeId: id }
      );
      if (!validation.isValid) {
        await t.rollback();
        return res.status(400).json({ success: false, message: validation.message });
      }

      // ✅ Actualizar campos del XML
      updateData.document_type = cafData.documentType;
      updateData.folio_start = cafData.rangoD;
      updateData.folio_end = cafData.rangoH;
      updateData.caf_xml = cafXml;
      updateData.remaining_count = cafData.rangoH - cafData.rangoD + 1;
      updateData.issue_date = cafData.fa;
    }

    // ✅ Fecha de vencimiento (solo si se envía)
    if (expiration_date !== undefined) {
      updateData.expiration_date = expiration_date;
    }

    // ✅ Clave privada (solo si se envía)
    if (private_key !== undefined) {
      updateData.private_key = private_key;
    }

    // ✅ Ejecutar actualización
    const updated = await SiiCafRepository.update(existing, updateData, { transaction: t });

    await TenantLogRepository.create({
      company_id: certificate?.company_id || existing.company_id,
      user_id: req.user?.id,
      module: 'sii',
      event_type: 'update',
      action: 'CAF actualizado',
      meta: { caf_id: id },
      result: 'success'
    }, { transaction: t });

    await t.commit();

    return res.status(200).json({
      success: true,
      message: "CAF actualizado",
      data: updated
    });
  } catch (err) {
    await t.rollback();
    logger.error("SiiCafController->update: " + err.message);
    return res.status(500).json({ success: false, message: err.message || "Error al actualizar CAF" });
  }
},

  async destroy(req, res) {
    try {
      const { id } = req.body;
      const caf = await SiiCafRepository.findById(id);
      if (!caf) {
        return res.status(404).json({ success: false, message: "CAF no encontrado" });
      }

      await SiiCafRepository.delete(caf);

      await TenantLogRepository.create({
        company_id: caf.company_id,
        user_id: req.user?.id,
        module: 'sii',
        event_type: 'delete',
        action: 'CAF eliminado',
        meta: { caf_id: id },
        result: 'success'
      });

      return res.status(200).json({
        success: true,
        message: "CAF eliminado correctamente"
      });
    } catch (err) {
      logger.error("SiiCafController->destroy: " + err.message);
      return res.status(500).json({ success: false, message: "Error al eliminar CAF" });
    }
  }
}

module.exports = SiiCafController;