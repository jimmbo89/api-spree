// repositories/PoolWarehouseRepository.js
const { PoolWarehouse, Warehouse, Pool, Branch, sequelize } = require('../models');
const { Op } = require('sequelize');
const logger = require('../../config/logger');

const PoolWarehouseRepository = {
  async findByPoolId(poolId) {
    return await PoolWarehouse.findAll({
      where: { pool_id: poolId },
      include: [{
        model: Warehouse,
        as: 'warehouse',
        attributes: ['id', 'name', 'code', 'type', 'description', 'image']
      }],
      order: [['position', 'ASC']]
    });
  },

  async findByWarehouseId(warehouseId) {
    return await PoolWarehouse.findAll({
      where: { warehouse_id: warehouseId },
      include: [{
        model: Pool,
        as: 'pool',
        attributes: ['id', 'name', 'is_active']
      }]
    });
  },

  async findPrimaryByPoolId(poolId) {
    return await PoolWarehouse.findOne({
      where: {
        pool_id: poolId,
        is_primary: true
      },
      include: [{
        model: Warehouse,
        as: 'warehouse'
      }]
    });
  },

  async findByPoolAndWarehouse(poolId, warehouseId) {
    return await PoolWarehouse.findOne({
      where: {
        pool_id: poolId,
        warehouse_id: warehouseId
      }
    });
  },

  async create(poolId, warehouseId, data = {}, options = {}) {
    const existing = await this.findByPoolAndWarehouse(poolId, warehouseId);
    if (existing) {
      throw new Error('El almacén ya está asociado a este pool');
    }

    return await PoolWarehouse.create({
      pool_id: poolId,
      warehouse_id: warehouseId,
      is_primary: data.is_primary || false,
      position: data.position || 0
    }, options);
  },

  async update(poolWarehouseId, data = {}, options = {}) {
    const poolWarehouse = await PoolWarehouse.findByPk(poolWarehouseId);
    if (!poolWarehouse) {
      throw new Error('Asociación no encontrada');
    }

    return await poolWarehouse.update(data, options);
  },

  async delete(poolWarehouseId, options = {}) {
    const poolWarehouse = await PoolWarehouse.findByPk(poolWarehouseId);
    if (!poolWarehouse) {
      throw new Error('Asociación no encontrada');
    }

    // Si es el principal, podemos lanzar error o buscar otro principal
    if (poolWarehouse.is_primary) {
      // Buscar otro almacén en el mismo pool para convertirlo en principal
      const otherWarehouse = await PoolWarehouse.findOne({
        where: {
          pool_id: poolWarehouse.pool_id,
          id: { [Op.ne]: poolWarehouseId }
        },
        order: [['position', 'ASC']]
      });

      if (otherWarehouse) {
        await otherWarehouse.update({ is_primary: true }, options);
      }
    }

    return await poolWarehouse.destroy(options);
  },

  async deleteByPoolAndWarehouse(poolId, warehouseId, options = {}) {
    const association = await this.findByPoolAndWarehouse(poolId, warehouseId);
    if (!association) {
      throw new Error('Asociación no encontrada');
    }

    return await this.delete(association.id, options);
  },

  async changePrimary(poolId, newPrimaryWarehouseId, options = {}) {
    try {
      // Quitar principal actual
      await PoolWarehouse.update(
        { is_primary: false },
        {
          where: {
            pool_id: poolId,
            is_primary: true
          },
          options
        }
      );

      // Establecer nuevo principal
      const newPrimary = await PoolWarehouse.findOne({
        where: {
          pool_id: poolId,
          warehouse_id: newPrimaryWarehouseId
        },
        options
      });

      if (!newPrimary) {
        throw new Error('El almacén no está asociado a este pool');
      }

      await newPrimary.update({ is_primary: true }, options);
      return newPrimary;
    } catch (error) {
      throw error;
    }
  },

  async reorder(poolId, warehouseOrder, options = {}) {
    try {
      for (let i = 0; i < warehouseOrder.length; i++) {
        const warehouseId = warehouseOrder[i];
        await PoolWarehouse.update(
          { position: i },
          {
            where: {
              pool_id: poolId,
              warehouse_id: warehouseId
            },
           options
          }
        );
      }
    } catch (error) {
      throw error;
    }
  },

  async validateWarehousesExist(warehouseIds, companyId) {
  if (!companyId) {
    const warehouses = await Warehouse.findAll({
      where: { id: warehouseIds },
      attributes: ['id', 'name', 'company_id', 'branch_id']
    });
    const foundIds = warehouses.map(w => w.id);
    const missingIds = warehouseIds.filter(id => !foundIds.includes(id));
    return { valid: missingIds.length === 0, warehouses, missingIds };
  }

  // Obtener branch_ids pertenecientes a la company
  const branchIds = (
    await Branch.findAll({
      where: { company_id: companyId },
      attributes: ['id'],
      raw: true
    })
  ).map(b => b.id);

  // Buscar almacenes que coincidan (directo o vía branch)
  const warehouses = await Warehouse.findAll({
    where: {
      id: warehouseIds,
      [Op.or]: [
        { company_id: companyId },
        ...(branchIds.length > 0 ? [{ branch_id: { [Op.in]: branchIds } }] : [])
      ]
    },
    attributes: ['id', 'name', 'company_id', 'branch_id']
  });

  const foundIds = warehouses.map(w => w.id);
  const missingIds = warehouseIds.filter(id => !foundIds.includes(id));

  return {
    valid: missingIds.length === 0,
    warehouses,
    missingIds
  };
}
};

module.exports = PoolWarehouseRepository;