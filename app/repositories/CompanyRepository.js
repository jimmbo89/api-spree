const { Op } = require('sequelize');
const { Company, BusinessType } = require('../models');
const ImageService = require('../services/ImageService');
const logger = require('../../config/logger');

const CompanyRepository = {
  async findAll() {
    return await Company.findAll({
      attributes: ['id', 'name', 'address', 'city', 'country', 'image', 'rut', 'phone', 'business_type_id'],
      include: [{
        model: BusinessType,
        as: 'businessType',
        attributes: ['id', 'name'], // No queremos los atributos del modelo, solo el name como alias
        required: false // LEFT JOIN (puede ser null)
      }]
    });
  },

  async findById(id) {
    return await Company.findByPk(id, {
      attributes: ['id', 'name', 'description', 'address', 'city', 'country', 'image', 'rut', 'phone', 'business_type_id'],
      include: [{
        model: BusinessType,
        as: 'businessType',
        attributes: ['id', 'name'], // No queremos los atributos del modelo, solo el name como alias
        required: false // LEFT JOIN (puede ser null)
      }]
    });
  },

 async getMappedCompaniesByUserId(userId) {
    const companies = await Company.findAll({
      where: { user_id: userId },
      attributes: ['id', 'name', 'description', 'address', 'city', 'country', 'image', 'rut', 'phone', 'business_type_id'],
      include: [{
        model: BusinessType,
        as: 'businessType',
        attributes: ['id', 'name'], // No queremos los atributos del modelo, solo el name como alias
        required: false // LEFT JOIN (puede ser null)
      }]
    });

    return companies.map(company => ({
      id: company.id,
      business_type_id: company.business_type_id,
      businessbusinessTypeName: company.businessType.name,
      name: company.name,
      description: company.description,
      address: company.address,
      city: company.city,
      country: company.country,
      rut: company.rut,
      phone: company.phone,
      image: company.image,
    }));
  },

  async existsByRut(rut, excludeId = null) {
    const whereCondition = excludeId
      ? { rut, id: { [Op.ne]: excludeId } }
      : { rut };
    return await Company.findOne({ where: whereCondition });
  },

  async create(body, file, transaction = null) {
    const { name, description, rut, address, city, country, phone, user_id, business_type_id } = body;

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
      image: 'companies/default.jpg',
    }, { transaction });

    if (file) {
      const newFilename = ImageService.generateFilename('companies', company.id, file.originalname);
      company.image = await ImageService.moveFile(file, newFilename);
      await company.update({ image: company.image }, { transaction });
    }

    return company;
  },

  async update(company, body, file) {
    const fieldsToUpdate = ['name', 'description', 'rut', 'address', 'city', 'country', 'phone', 'business_type_id'];

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