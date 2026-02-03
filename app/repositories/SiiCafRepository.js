// repositories/siiCafRepository.js
const { SIICaf } = require("../models");
const { Op } = require('sequelize');
const logger = require("../../config/logger");

const SiiCafRepository = {
  async findActiveByCompanyAndType(company_id, document_type, options = {}) {
    return await SIICaf.findOne({
      where: {
        company_id,
        document_type,
        is_active: true,
        is_exhausted: false
      },
      order: [['folio_next', 'ASC']],
      ...options
    });
  },

  async findByCompanyId(company_id, options = {}) {
    return await SIICaf.findAll({
      where: { company_id },
      order: [['createdAt', 'DESC']],
      ...options
    });
  },

  async findById(caf_id, options = {}) {
    return await SIICaf.findByPk(caf_id, options);
  },

  async create(data, options = {}) {
    const caf = await SIICaf.create(data, options);
    logger.info(`CAF creado ID ${caf.id} para tenant ${data.company_id}`);
    return caf;
  },

  async update(caf_id, data, options = {}) {
    const caf = await SIICaf.findByPk(caf_id);
    if (!caf) throw new Error("CAF no encontrado");
    await caf.update(data, options);
    logger.info(`CAF actualizado ID ${caf_id}`);
    return caf;
  },

  async getNextAvailableCAF(company_id, document_type = null, options = {}) {
    const where = {
      company_id,
      is_active: true,
      is_exhausted: false,
      expiration_date: {
        [Op.gte]: new Date()
      }
    };
    
    if (document_type) {
      where.document_type = document_type;
    }

    return await SIICaf.findOne({
      where,
      order: [['folio_next', 'ASC']],
      ...options
    });
  },

  async markAsExhausted(caf_id, options = {}) {
    const caf = await SIICaf.findByPk(caf_id);
    if (!caf) throw new Error("CAF no encontrado");
    await caf.update({
      is_exhausted: true,
      remaining_count: 0
    }, options);
    logger.info(`CAF marcado como agotado ID ${caf_id}`);
    return caf;
  },

  async toggleActive(caf_id, is_active, options = {}) {
    const caf = await SIICaf.findByPk(caf_id);
    if (!caf) throw new Error("CAF no encontrado");
    await caf.update({ is_active }, options);
    logger.info(`CAF ${is_active ? 'activado' : 'desactivado'} ID ${caf_id}`);
    return caf;
  }
};

module.exports = SiiCafRepository;