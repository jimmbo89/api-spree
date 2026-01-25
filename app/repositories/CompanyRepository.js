const { Op } = require('sequelize');
const { Company, BusinessType, Plan } = require('../models');
const ImageService = require('../services/ImageService');
const logger = require('../../config/logger');

const CompanyRepository = {
  async findAll() {
    return await Company.findAll({
      attributes: ['id', 'name', 'address', 'city', 'country', 'image', 'rut', 'phone', 'business_type_id', 'email', 'currency'],
      include: [
      { model: BusinessType, as: 'businessType', attributes: ['id', 'name'], required: false },
      { model: Plan, as: 'plan', attributes: ['id', 'name'], required: false } // 👈 NUEVO
    ]
    });
  },

  async findById(id) {
    return await Company.findByPk(id, {
      attributes: ['id', 'name', 'description', 'address', 'city', 'country', 'image', 'rut', 'phone', 'business_type_id', 'plan_id', 'email', 'currency'],
      include: [
      { model: BusinessType, as: 'businessType', attributes: ['id', 'name'], required: false },
      { model: Plan, as: 'plan', required: false } // 👈 NUEVO
    ]
    });
  },

 async getMappedCompaniesByUserId(userId) {
    const companies = await Company.findAll({
      where: { user_id: userId },
      attributes: ['id', 'name', 'description', 'address', 'city', 'country', 'image', 'rut', 'phone', 'business_type_id', 'email', 'plan_id', 'currency'],
      include: [
      { model: BusinessType, as: 'businessType', attributes: ['id', 'name'], required: false },
      { model: Plan, as: 'plan', attributes: ['id', 'name'], required: false } // 👈 NUEVO
    ]
    });

    return companies.map(company => ({
      id: company.id,
      business_type_id: company.business_type_id,
      businessbusinessTypeName: company.businessType.name,
      plan_id: company.plan_id,
      planName: company.plan?.name || null, // 👈 NUEVO
      name: company.name,
      description: company.description,
      address: company.address,
      city: company.city,
      country: company.country,
      rut: company.rut,
      phone: company.phone,
      image: company.image,
      email: company.email,
      currency: company.currency
    }));
  },

  async existsByRut(rut, excludeId = null) {
    const whereCondition = excludeId
      ? { rut, id: { [Op.ne]: excludeId } }
      : { rut };
    return await Company.findOne({ where: whereCondition });
  },

  async checkUniqueFields(data, excludeId = null) {
  const { rut, email } = data;

  // Si ambos son null/undefined/vacíos, no hay nada que verificar
  if (
    (rut === null || rut === undefined || rut === '') &&
    (email === null || email === undefined || email === '')
  ) {
    return { exists: false, field: null };
  }

  let whereCondition = {};

  if (rut !== null && rut !== undefined && rut !== '') {
    whereCondition.rut = rut;
  }

  if (email !== null && email !== undefined && email !== '') {
    whereCondition.email = email;
  }

  if (Object.keys(whereCondition).length === 0) {
    return { exists: false, field: null };
  }

  if (excludeId !== null) {
    whereCondition.id = { [Op.ne]: excludeId };
  }

  const existing = await Company.findOne({
    where: whereCondition,
    attributes: ['id', 'rut', 'email']
  });

  if (existing) {
    if (rut && existing.rut === rut) {
      return { exists: true, field: 'rut', existing };
    }
    if (email && existing.email === email) {
      return { exists: true, field: 'email', existing };
    }
  }

  return { exists: false, field: null, existing: null };
},

  async create(body, file, transaction = null) {
    const { name, description, rut, address, city, country, phone, user_id, business_type_id, email, plan_id, currency } = body;

    const company = await Company.create({
      name,
      description,
      rut,
      address,
      city,
      country,
      phone,
      user_id,
      business_type_id, 
      plan_id,
      image: 'companies/default.jpg',
      email,
      currency
    }, { transaction });

    if (file) {
      const newFilename = ImageService.generateFilename('companies', company.id, file.originalname);
      company.image = await ImageService.moveFile(file, newFilename);
      await company.update({ image: company.image }, { transaction });
    }

    return company;
  },

  async update(company, body, file) {
    const fieldsToUpdate = ['name', 'description', 'rut', 'address', 'city', 'country', 'phone', 'business_type_id', 'email', 'plan_id', 'currency'];

    const updatedData = Object.keys(body)
      .filter(key => fieldsToUpdate.includes(key) && body[key] !== undefined)
      .reduce((obj, key) => {
        obj[key] = body[key];
        return obj;
      }, {});

    if (file) {
      if (company.image && company.image !== 'companies/default.jpg') {
        await ImageService.deleteFile(company.image);
      }
      const newFilename = ImageService.generateFilename('companies', company.id, file.originalname);
      updatedData.image = await ImageService.moveFile(file, newFilename);
    }

    if (Object.keys(updatedData).length > 0) {
      await company.update(updatedData);
      logger.info(`Compañía actualizada exitosamente (ID: ${company.id})`);
    }

    return company;
  },

  async delete(company) {
    if (company.image && company.image !== 'companies/default.jpg') {
      await ImageService.deleteFile(company.image);
    }
    return await company.destroy();
  },
};

module.exports = CompanyRepository;