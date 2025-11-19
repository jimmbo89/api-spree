const { Warehouse } = require('../models');
const ImageService = require('../services/ImageService');
const logger = require('../../config/logger');

const WarehouseRepository = {
  // ✅ Método flexible: por company_id, branch_id, user_id o combinaciones
  async findFiltered({ companyId, branchId, userId }) {
    const where = {};

    if (companyId !== undefined) where.company_id = companyId;
    if (branchId !== undefined) where.branch_id = branchId;
    if (userId !== undefined) where.user_id = userId;

    const warehouses = await Warehouse.findAll({
      where,
      attributes: ['id', 'user_id', 'company_id', 'branch_id', 'name', 'type', 'address', 'image'],
    });

    return warehouses.map(wh => ({
      id: wh.id,
      user_id: wh.user_id,
      company_id: wh.company_id,
      branch_id: wh.branch_id,
      name: wh.name,
      type: wh.type === 1 ? 'Primario' : 'Secundario', // Opcional: human-readable
      type_code: wh.type, // Si prefieres el número
      address: wh.address,
      image: wh.image,
    }));
  },

  async findById(id) {
    return await Warehouse.findByPk(id, {
      attributes: ['id', 'user_id', 'company_id', 'branch_id', 'name', 'type', 'address', 'image'],
    });
  },

  async create(body, file, transaction = null) {
    const { name, type, address, company_id, branch_id, user_id } = body;

    const warehouse = await Warehouse.create({
      name,
      type: type || 0,
      address: address || null,
      company_id: company_id || null,
      branch_id: branch_id || null,
      user_id: user_id || null,
      image: 'warehouses/default.jpg',
    }, {transaction});

    if (file) {
      const newFilename = ImageService.generateFilename('warehouses', warehouse.id, file.originalname);
      warehouse.image = await ImageService.moveFile(file, newFilename);
      await warehouse.update({ image: warehouse.image }, {transaction});
    }

    return warehouse;
  },

  async update(warehouse, body, file) {
    const fieldsToUpdate = ['name', 'type', 'address', 'company_id', 'branch_id', 'user_id'];

    const updatedData = Object.keys(body)
      .filter(key => fieldsToUpdate.includes(key) && body[key] !== undefined)
      .reduce((obj, key) => {
        obj[key] = body[key];
        return obj;
      }, {});

    if (file) {
      if (warehouse.image && warehouse.image !== 'warehouses/default.jpg') {
        await ImageService.deleteFile(warehouse.image);
      }
      const newFilename = ImageService.generateFilename('warehouses', warehouse.id, file.originalname);
      updatedData.image = await ImageService.moveFile(file, newFilename);
    }

    if (Object.keys(updatedData).length > 0) {
      await warehouse.update(updatedData);
      logger.info(`Almacén actualizado (ID: ${warehouse.id})`);
    }

    return warehouse;
  },

  async delete(warehouse) {
    if (warehouse.image && warehouse.image !== 'warehouses/default.jpg') {
      await ImageService.deleteFile(warehouse.image);
    }
    return await warehouse.destroy();
  },

  async existsPrincipalByCompany(companyId, transaction = null) {
    const warehouse = await Warehouse.findOne({
      where: {
        company_id: companyId,
        branch_id: null,
      },
      transaction
    });
    return !!warehouse; // true si existe, false si no
  },
};

module.exports = WarehouseRepository;