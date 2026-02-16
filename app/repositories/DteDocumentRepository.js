// repositories/dteDocumentRepository.js
const { DTEDocument } = require("../models");
const logger = require("../../config/logger");

const DteDocumentRepository = {
  // ✅ CORREGIDO: findAndCountAll - manejar paginación correctamente
  async findAndCountAll(options = {}) {
    const { count, rows } = await DTEDocument.findAndCountAll(options);
    return { count, rows };
  },

  // ✅ AGREGADO: findByIdAndCompany - seguridad multi-tenant
  async findByIdAndCompany(document_id, company_id, options = {}) {
    return await DTEDocument.findOne({
      where: { id: document_id, company_id },
      ...options
    });
  },

  async findById(document_id, options = {}) {
    return await DTEDocument.findByPk(document_id, options);
  },

  async create(data, options = {}) {
    const document = await DTEDocument.create(data, options);
    logger.info(`DTE documento creado ID ${document.id} para tenant ${data.company_id}`);
    return document;
  },

  async update(document_id, data, options = {}) {
    const document = await DTEDocument.findByPk(document_id, options);
    if (!document) throw new Error("Documento DTE no encontrado");
    await document.update(data, options);
    logger.info(`DTE documento actualizado ID ${document_id}`);
    return document;
  },

  async destroy(document_id, options = {}) {
    const document = await DTEDocument.findByPk(document_id, options);
    if (!document) throw new Error("Documento DTE no encontrado");
    await document.destroy(options);
    logger.info(`DTE documento eliminado ID ${document_id}`);
    return document;
  },

  async getDocumentsByStatus(company_id, sii_status, options = {}) {
    return await DTEDocument.findAll({
      where: { company_id, sii_status },
      order: [['createdAt', 'DESC']],
      ...options
    });
  },

  async countByCompany(company_id, options = {}) {
    return await DTEDocument.count({
      where: { company_id },
      ...options
    });
  },

  // ✅ AGREGADO: findByFolioAndCompany - buscar por folio y compañía
  async findByFolioAndCompany(company_id, document_type, folio, options = {}) {
    return await DTEDocument.findOne({
      where: { company_id, document_type, folio },
      ...options
    });
  }
};

module.exports = DteDocumentRepository;