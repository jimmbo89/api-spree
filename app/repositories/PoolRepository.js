// repositories/PoolRepository.js
const { Pool, PoolWarehouse, Warehouse, Company, User } = require('../models');
const { Op } = require('sequelize');
const logger = require('../../config/logger');

const PoolRepository = {
  async findFiltered({ companyId, userId, isActive } = {}) {
    const where = {};
    if (companyId) where.company_id = companyId;
    if (userId) where.user_id = userId;
    if (isActive !== undefined) where.is_active = isActive;

    const pools = await Pool.findAll({
      where,
      attributes: [
        'id', 'name', 'description', 
        'company_id', 'user_id', 'is_active',
        'createdAt', 'updatedAt'
      ],
      include: [
        {
          model: PoolWarehouse,
          as: 'poolWarehouses',
          include: [{
            model: Warehouse,
            as: 'warehouse',
          }],
          order: [['position', 'ASC']]
        },
      ],
      order: [['name', 'ASC']]
    });

    return pools.map(pool => {
      const warehouses = pool.poolWarehouses.map(pw => ({
        warehouse_id: pw.warehouse_id,
        name: pw.warehouse.name,
        code: pw.warehouse.code,
        type: pw.warehouse.type,
        description: pw.warehouse.description,
        image: pw.warehouse.image,
        is_primary: pw.is_primary,
        position: pw.position,
        id: pw.id
      }));

      const primaryWarehouse = warehouses.find(w => w.is_primary);

      return {
        id: pool.id,
        name: pool.name,
        description: pool.description,
        company_id: pool.company_id,
        user_id: pool.user_id,
        is_active: pool.is_active,
        warehouses,
        primary_warehouse: primaryWarehouse,
        warehouse_count: warehouses.length
      };
    });
  },

  async findById(id, includeWarehouses = true) {
    const include = [];
    
    if (includeWarehouses) {
      include.push({
        model: PoolWarehouse,
        as: 'poolWarehouses',
        include: [{
          model: Warehouse,
          as: 'warehouse',
        }],
        order: [['position', 'ASC']]
      });
    }

    const pool = await Pool.findByPk(id, {
      include,
      attributes: [
        'id', 'name', 'description', 
        'company_id', 'user_id', 'is_active',
        'createdAt', 'updatedAt', 'deletedAt'
      ]
    });

    if (!pool) return null;

    if (includeWarehouses) {
      const warehouses = pool.poolWarehouses.map(pw => ({
        id: pw.warehouse.id,
        name: pw.warehouse.name,
        code: pw.warehouse.code,
        type: pw.warehouse.type,
        description: pw.warehouse.description,
        image: pw.warehouse.image,
        is_primary: pw.is_primary,
        position: pw.position,
        association_id: pw.id
      }));

      pool.dataValues.warehouses = warehouses;
      pool.dataValues.primary_warehouse = warehouses.find(w => w.is_primary);
      pool.dataValues.warehouse_count = warehouses.length;
    }

    return pool;
  },

  async create(body, options = {}) {
    try {
      const poolData = {
        name: body.name,
        description: body.description || null,
        company_id: body.company_id,
        user_id: body.user_id || null,
        is_active: body.is_active !== undefined ? body.is_active : true
      };

      const pool = await Pool.create(poolData, options);

      logger.info(`Pool creado: ${pool.name} (ID: ${pool.id})`);
      return pool;
    } catch (error) {
      logger.error("Error en PoolRepository->create:", error);
      throw new Error(`Error al crear pool: ${error.message}`);
    }
  },

  async update(pool, body, options = {}) {
    try {
      const fieldsToUpdate = [
        'name', 'description', 'company_id', 
        'user_id', 'is_active'
      ];

      const updatedData = {};
      for (const key of fieldsToUpdate) {
        if (body[key] !== undefined) updatedData[key] = body[key];
      }
      
      await pool.update(updatedData, options);
      logger.info(`Pool actualizado (ID: ${pool.id})`);
      return pool;
    } catch (error) {
      logger.error(`Error en PoolRepository->update (ID: ${pool.id}):`, error);
      throw new Error(`Error al actualizar pool: ${error.message}`);
    }
  },

  async delete(pool) {
    return await pool.destroy();
  },

  async existsByName(name, companyId, excludeId = null) {
    const where = {
      name,
      company_id: companyId
    };

    if (excludeId) {
      where.id = { [Op.ne]: excludeId }; // ✅ ahora Op está definido
    }

    const count = await Pool.count({ where });
    return count > 0;
  },

  async findByCompany(companyId) {
    return await Pool.findAll({
      where: { company_id: companyId, is_active: true },
      attributes: ['id', 'name', 'description'],
      order: [['name', 'ASC']]
    });
  },

  async getAvailableWarehouses(poolId, companyId) {
    // Obtener almacenes ya asociados al pool
    const poolWarehouses = await PoolWarehouse.findAll({
      where: { pool_id: poolId },
      attributes: ['warehouse_id']
    });

    const excludedIds = poolWarehouses.map(pw => pw.warehouse_id);

    // Buscar almacenes disponibles
    return await Warehouse.findAll({
      where: {
        company_id: companyId,
        is_active: true,
        id: { [Op.notIn]: excludedIds }
      },
      attributes: ['id', 'name', 'code', 'type'],
      order: [['name', 'ASC']]
    });
  }
};

module.exports = PoolRepository;