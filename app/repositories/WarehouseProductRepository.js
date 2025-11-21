const { Op } = require('sequelize');
const { WarehouseProduct } = require('../models');
const ImageService = require('../services/ImageService');
const logger = require('../../config/logger');

const WarehouseProductRepository = {
  async findFiltered({ companyId, userId, branchId, warehouseId }) {
    const where = { company_id: companyId };

    if (userId !== undefined) where.user_id = userId;
    if (branchId !== undefined) where.branch_id = branchId;
    if (warehouseId !== undefined) where.warehouse_id = warehouseId;

    const records = await WarehouseProduct.findAll({
      where,
      attributes: [
        'id', 'product_id', 'warehouse_id', 'stock', 'image',
        'price', 'published', 'company_id', 'branch_id', 'user_id'
      ]
    });

    return records.map(r => ({
      id: r.id,
      product_id: r.product_id,
      warehouse_id: r.warehouse_id,
      stock: r.stock,
      image: r.image,
      price: r.price,
      published: r.published,
      company_id: r.company_id,
      branch_id: r.branch_id,
      user_id: r.user_id
    }));
  },

  async findById(id) {
    return await WarehouseProduct.findByPk(id, {
      attributes: [
        'id', 'product_id', 'warehouse_id', 'stock', 'image',
        'price', 'published', 'company_id', 'branch_id', 'user_id'
      ]
    });
  },

  async findByProductAndWarehouse(productId, warehouseId, options = {}) {
  return await WarehouseProduct.findOne({
    where: { product_id: productId, warehouse_id: warehouseId },
    transaction: options.transaction // 👈
  });
},

  async create(body, file, options = {}) {
  const {
    product_id, warehouse_id, stock, price, published,
    company_id, branch_id, user_id
  } = body;

  logger.info(`[REPO] Creando warehouse_product:`, {
    product_id,
    warehouse_id,
    company_id,
    branch_id,
    user_id
  });

  try {
    const record = await WarehouseProduct.create({
      product_id,
      warehouse_id,
      stock: stock || 0,
      price: price || null,
      published: published !== undefined ? published : false,
      company_id,
      branch_id: branch_id || null,
      user_id
    }, options);

    if (file) {
      const newFilename = ImageService.generateFilename('warehouse_products', record.id, file.originalname);
      record.image = await ImageService.moveFile(file, newFilename);
      await record.update({ image: record.image }, options);
    }

    return record;
  } catch (error) {
    logger.error(`[REPO] ERROR al crear warehouse_product:`, error.message);
    throw error;
  }
},

  async update(record, body, file) {
    const fieldsToUpdate = [
      'product_id', 'warehouse_id', 'stock', 'price', 'published',
      'company_id', 'branch_id', 'user_id'
    ];

    const updatedData = Object.keys(body)
      .filter(key => fieldsToUpdate.includes(key) && body[key] !== undefined)
      .reduce((obj, key) => {
        obj[key] = body[key];
        return obj;
      }, {});

    if (file) {
      if (record.image && record.image !== 'warehouse_products/default.jpg') {
        await ImageService.deleteFile(record.image);
      }
      const newFilename = ImageService.generateFilename('warehouse_products', record.id, file.originalname);
      updatedData.image = await ImageService.moveFile(file, newFilename);
    }

    if (Object.keys(updatedData).length > 0) {
      await record.update(updatedData);
      logger.info(`Registro warehouse_product actualizado (ID: ${record.id})`);
    }

    return record;
  },

  async delete(record) {
    if (record.image && record.image !== 'warehouse_products/default.jpg') {
      await ImageService.deleteFile(record.image);
    }
    return await record.destroy();
  },

  async getOrCreateForWarehouse(productId, warehouseId, options = {}) {
  let record = await WarehouseProduct.findOne({
    where: { product_id: productId, warehouse_id: warehouseId },
    transaction: options.transaction
  });

  if (!record) {
    // Crear con stock 0 inicial
    record = await WarehouseProduct.create({
      product_id: productId,
      warehouse_id: warehouseId,
      stock: 0,
      published: false,
      company_id: options.company_id,
      branch_id: options.branch_id,
      user_id: options.user_id
    }, options);
  }

  return record;
},

// Actualizar stock (con transacción)
async updateStock(record, newStock, options = {}) {
  return await record.update({ stock: newStock }, options);
}
};

module.exports = WarehouseProductRepository;