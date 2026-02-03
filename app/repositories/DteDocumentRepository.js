// repositories/dteDocumentRepository.js
const { DteDocument } = require("../models");
const logger = require("../../config/logger");

const DteDocumentRepository = {
  async findByCompanyIdAndType(company_id, document_type, options = {}) {
    return await DteDocument.findAll({
      where: { company_id, document_type },
      ...options
    });
  },

  async findByFolio(company_id, document_type, folio, options = {}) {
    return await DteDocument.findOne({
      where: { company_id, document_type, folio },
      ...options
    });
  },

  async findById(document_id, options = {}) {
    return await DteDocument.findByPk(document_id, options);
  },

  async create(data, options = {}) {
    const document = await DteDocument.create(data, options);
    logger.info(`DTE documento creado ID ${document.id} para tenant ${data.company_id}`);
    return document;
  },

  async update(document_id, data, options = {}) {
    const document = await DteDocument.findByPk(document_id);
    if (!document) throw new Error("Documento DTE no encontrado");
    await document.update(data, options);
    logger.info(`DTE documento actualizado ID ${document_id}`);
    return document;
  },

  async getNextFolio(company_id, document_type, options = {}) {
    const lastDoc = await DteDocument.findOne({
      where: { company_id, document_type },
      order: [['folio', 'DESC']],
      attributes: ['folio'],
      ...options
    });
    return lastDoc ? lastDoc.folio + 1 : 1;
  },

  async getDocumentsByStatus(company_id, sii_status, options = {}) {
    return await DteDocument.findAll({
      where: { company_id, sii_status },
      order: [['createdAt', 'DESC']],
      ...options
    });
  },

  async countByCompany(company_id, options = {}) {
    return await DteDocument.count({
      where: { company_id },
      ...options
    });
  }
};

module.exports = DteDocumentRepository;