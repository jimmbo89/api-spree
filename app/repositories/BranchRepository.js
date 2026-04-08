const { Op } = require('sequelize');
const { Branch, Warehouse } = require('../models');
const ImageService = require('../services/ImageService');
const logger = require('../../config/logger');

const BranchRepository = {
  // ✅ Método flexible: por company_id, user_id o ambos
  async findFiltered({ companyId, userId, status = 1 }) {
  const where = {};

  if (companyId !== undefined) {
    where.company_id = companyId;
  }

  if (userId !== undefined) {
    where.user_id = userId;
  }

  where.status = status !== undefined ? status : 1;

  const branches = await Branch.findAll({
    where,
    attributes: ['id', 'company_id', 'user_id', 'name', 'address', 'city', 'phone', 'status', 'image'],
    include: [{
      model: Warehouse,
      as: 'warehouses',
      attributes: ['id', 'name', 'status'], // o lo que necesites
    }]
  });

  return branches.map(branch => ({
    id: branch.id,
    company_id: branch.company_id,
    user_id: branch.user_id,
    name: branch.name,
    address: branch.address,
    city: branch.city,
    phone: branch.phone,
    status: branch.status === 1 ? 'activa' : 'inactiva',
    status_code: branch.status,
    image: branch.image,
    warehouses: branch.warehouses || [], // ← aquí tienes el array
    has_warehouses: (branch.warehouses?.length || 0) > 0 // ← boolean útil
  }));
},

  async findById(id) {
    return await Branch.findByPk(id, {
      attributes: ['id', 'company_id', 'user_id', 'name', 'address', 'city', 'phone', 'status', 'image'],
    });
  },

  async countByCompanyId (companyId, options = {}){
  const where = { company_id: companyId, ...options.where };
  return Branch.count({ where });
},

  async create(body, file, transaction = null) {
    const { name, address, city, phone, status, company_id, user_id } = body;

    const branch = await Branch.create({
      name,
      address,
      city,
      phone,
      status: status !== undefined ? status : 1,
      company_id: company_id || null,
      user_id: user_id || null,
      image: 'branches/default.jpg',
    }, { transaction });

    if (file) {
      const newFilename = ImageService.generateFilename('branches', branch.id, file.originalname);
      branch.image = await ImageService.moveFile(file, newFilename);
      await branch.update({ image: branch.image }, { transaction });
    }

    return branch;
  },

  async update(branch, body, file) {
    const fieldsToUpdate = ['name', 'address', 'city', 'phone', 'status', 'company_id', 'user_id'];

    const updatedData = Object.keys(body)
      .filter(key => fieldsToUpdate.includes(key) && body[key] !== undefined)
      .reduce((obj, key) => {
        obj[key] = body[key];
        return obj;
      }, {});

    if (file) {
      if (branch.image && branch.image !== 'branches/default.jpg') {
        await ImageService.deleteFile(branch.image);
      }
      const newFilename = ImageService.generateFilename('branches', branch.id, file.originalname);
      updatedData.image = await ImageService.moveFile(file, newFilename);
    }

    if (Object.keys(updatedData).length > 0) {
      await branch.update(updatedData);
      logger.info(`Sucursal actualizada (ID: ${branch.id})`);
    }

    return branch;
  },

  async delete(branch) {
    if (branch.image && branch.image !== 'branches/default.jpg') {
      await ImageService.deleteFile(branch.image);
    }
    return await branch.destroy();
  },
};

module.exports = BranchRepository;