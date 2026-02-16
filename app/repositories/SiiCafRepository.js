// repositories/siiCafRepository.js
const { SiiCaf } = require("../models");
const { Op } = require('sequelize');
const logger = require("../../config/logger");

const SiiCafRepository = {
  async findByCompanyId(company_id, options = {}) {
    return await SiiCaf.findAll({
      where: { company_id },
      order: [['createdAt', 'DESC']],
      ...options
    });
  },

  async findById(caf_id, options = {}) {
    return await SiiCaf.findByPk(caf_id, options);
  },

  async create(data, options = {}) {
    const caf = await SiiCaf.create(data, options);
    logger.info(`CAF creado ID ${caf.id} para tenant ${data.company_id}`);
    return caf;
  },

  async update(cafInstance, data, options = {}) {
  if (!cafInstance || !cafInstance.id) {
    throw new Error("Instancia de CAF inválida");
  }

  const allowedFields = [
    'certificate_id',
    'company_id',
    'document_type',
    'folio_start',
    'folio_end',
    'expiration_date',
    'caf_xml',
    'private_key',
    'remaining_count',
    'is_active',
    'is_exhausted',
    'used_count',
    'folio_next'
  ];

  const fieldsToUpdate = {};
  for (const key of allowedFields) {
    if (data[key] !== undefined) {
      fieldsToUpdate[key] = data[key];
    }
  }

  if (Object.keys(fieldsToUpdate).length > 0) {
    await cafInstance.update(fieldsToUpdate, options);
    logger.info(`CAF actualizado ID ${cafInstance.id}`);
  } else {
    logger.info(`CAF (ID: ${cafInstance.id}) - No hay cambios para actualizar`);
  }

  return cafInstance;
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

    return await SiiCaf.findOne({
      where,
      order: [['folio_next', 'ASC']],
      ...options
    });
  },

  async markAsExhausted(caf_id, options = {}) {
    const caf = await SiiCaf.findByPk(caf_id);
    if (!caf) throw new Error("CAF no encontrado");
    await caf.update({
      is_exhausted: true,
      remaining_count: 0
    }, options);
    logger.info(`CAF marcado como agotado ID ${caf_id}`);
    return caf;
  },

  async incrementFolio(caf_id, options = {}) {
    const caf = await SiiCaf.findByPk(caf_id, options);
    if (!caf) throw new Error("CAF no encontrado");

    const nextFolio = caf.folio_next + 1;
    const isExhausted = nextFolio > caf.folio_end;

    const updatedCaf = await caf.update({
      folio_next: nextFolio,
      used_count: caf.used_count + 1,
      remaining_count: caf.remaining_count - 1,
      is_exhausted: isExhausted
    }, options);

    logger.info(`CAF ${caf_id} folio incrementado a ${nextFolio}`);

    return updatedCaf;
  },
  async toggleActive(caf_id, is_active, options = {}) {
    const caf = await SiiCaf.findByPk(caf_id);
    if (!caf) throw new Error("CAF no encontrado");
    await caf.update({ is_active }, options);
    logger.info(`CAF ${is_active ? 'activado' : 'desactivado'} ID ${caf_id}`);
    return caf;
  },

  async findByCertificateId(certificate_id, options = {}) {
  return await SiiCaf.findAll({
    where: { certificate_id },
    order: [['createdAt', 'DESC']],
    ...options
  });
},

async delete(caf, options = {}) {
  return await caf.destroy(options);
},

async findActiveByCompanyAndType(companyId, documentType, options = {}) {
  const { transaction, excludeId } = options;
  
  const where = {
    company_id: companyId,
    document_type: documentType,
    is_active: true
  };

  // ✅ Excluir ID si se proporciona
  if (excludeId) {
    where.id = { [Op.ne]: excludeId };
  }

  return await SiiCaf.findOne({ 
    where,
    transaction 
  });
}
};

module.exports = SiiCafRepository;