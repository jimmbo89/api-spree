// app/repositories/UserAclScopeRepository.js
const { UserAclScope, User, UserCompany, Company, Branch, Warehouse, Pool } = require('../models');
const { Op } = require('sequelize');
const logger = require('../../config/logger');

function mapScope(record) {
  if (!record) return null;
  return {
    id: record.id,
    user_id: record.user_id,
    company_id: record.company_id,
    warehouse_id: record.warehouse_id,
    pool_id: record.pool_id,
    warehouse: record.warehouse ? { id: record.warehouse.id, name: record.warehouse.name } : null,
    pool: record.pool ? { id: record.pool.id, name: record.pool.name } : null
  };
}

const UserAclScopeRepository = {
  async findByPk(id) {
    try {
      return await UserAclScope.findByPk(id);
    } catch (error) {
      logger.error(`Error al buscar scope por ID ${id}:`, error);
      throw new Error(`Error al buscar scope: ${error.message}`);
    }
  },

  async findByUserAndCompany(user_id, company_id) {
    try {
      const records = await UserAclScope.findAll({
        where: { user_id, company_id },
        include: [
          { model: Warehouse, as: 'warehouse' },
          { model: Pool, as: 'pool' }
        ],
        order: [['id', 'ASC']]
      });
      return records.map(mapScope);
    } catch (error) {
      logger.error(`Error al obtener scopes para usuario ${user_id} y empresa ${company_id}:`, error);
      throw new Error(`Error al obtener scopes: ${error.message}`);
    }
  },

  async findActiveUsersByWarehouseIds(warehouseIds = [], companyId) {
    const normalizedWarehouseIds = [...new Set(
      (Array.isArray(warehouseIds) ? warehouseIds : [])
        .map(warehouseId => Number(warehouseId))
        .filter(warehouseId => Number.isInteger(warehouseId) && warehouseId > 0)
    )];
    const normalizedCompanyId = Number(companyId);
    const usersByWarehouseId = new Map();

    if (
      normalizedWarehouseIds.length === 0 ||
      !Number.isInteger(normalizedCompanyId) ||
      normalizedCompanyId <= 0
    ) {
      return usersByWarehouseId;
    }

    const records = await UserAclScope.findAll({
      where: {
        company_id: normalizedCompanyId,
        warehouse_id: { [Op.in]: normalizedWarehouseIds }
      },
      attributes: ['warehouse_id'],
      include: [{
        model: User,
        as: 'user',
        required: true,
        where: { status: true },
        attributes: ['id', 'name', 'email', 'image'],
        include: [{
          model: UserCompany,
          as: 'memberships',
          required: true,
          where: {
            company_id: normalizedCompanyId,
            status: 1
          },
          attributes: []
        }]
      }],
      order: [['id', 'ASC']]
    });

    for (const record of records) {
      const plain = record.get({ plain: true });
      const warehouseId = Number(plain.warehouse_id);
      const user = plain.user;

      if (!user || !Number.isInteger(warehouseId)) continue;

      if (!usersByWarehouseId.has(warehouseId)) {
        usersByWarehouseId.set(warehouseId, []);
      }

      usersByWarehouseId.get(warehouseId).push({
        id: Number(user.id),
        name: user.name,
        email: user.email,
        image: user.image || null
      });
    }

    return usersByWarehouseId;
  },

  async syncWarehouseAccessUsers({ warehouseId, companyId, userIds = [], transaction = null }) {
    const normalizedWarehouseId = Number(warehouseId);
    const normalizedCompanyId = Number(companyId);
    const normalizedUserIds = [...new Set(
      (Array.isArray(userIds) ? userIds : [])
        .map(userId => Number(userId))
        .filter(userId => Number.isInteger(userId) && userId > 0)
    )];

    if (!Number.isInteger(normalizedWarehouseId) || normalizedWarehouseId <= 0) {
      const error = new Error('warehouseId inválido para sincronizar accesos');
      error.statusCode = 400;
      throw error;
    }

    if (!Number.isInteger(normalizedCompanyId) || normalizedCompanyId <= 0) {
      const error = new Error('companyId inválido para sincronizar accesos');
      error.statusCode = 400;
      throw error;
    }

    const warehouse = await Warehouse.findByPk(normalizedWarehouseId, {
      attributes: ['id', 'company_id', 'branch_id'],
      include: [{
        model: Branch,
        as: 'branch',
        attributes: ['company_id'],
        required: false
      }],
      transaction
    });
    const warehouseCompanyId = warehouse?.company_id || warehouse?.branch?.company_id;

    if (!warehouse || Number(warehouseCompanyId) !== normalizedCompanyId) {
      const error = new Error('El almacén no pertenece a la empresa indicada');
      error.statusCode = 400;
      throw error;
    }

    if (normalizedUserIds.length > 0) {
      const activeMemberships = await UserCompany.findAll({
        where: {
          company_id: normalizedCompanyId,
          status: 1,
          user_id: { [Op.in]: normalizedUserIds }
        },
        attributes: ['user_id'],
        include: [{
          model: User,
          as: 'user',
          required: true,
          where: { status: true },
          attributes: ['id']
        }],
        transaction
      });
      const validUserIds = new Set(activeMemberships.map(record => Number(record.user_id)));
      const invalidUserIds = normalizedUserIds.filter(userId => !validUserIds.has(userId));

      if (invalidUserIds.length > 0) {
        const error = new Error(
          `Los usuarios ${invalidUserIds.join(', ')} no pertenecen a la empresa o no están activos`
        );
        error.statusCode = 400;
        error.field = 'access_user_ids';
        throw error;
      }
    }

    const existing = await UserAclScope.findAll({
      where: { warehouse_id: normalizedWarehouseId },
      transaction
    });
    const requestedUserIds = new Set(normalizedUserIds);
    const existingByUserId = new Map(existing.map(record => [Number(record.user_id), record]));

    for (const userId of normalizedUserIds) {
      const existingRecord = existingByUserId.get(userId);
      if (!existingRecord) {
        await UserAclScope.create({
          user_id: userId,
          company_id: normalizedCompanyId,
          warehouse_id: normalizedWarehouseId,
          pool_id: null
        }, { transaction });
      } else if (Number(existingRecord.company_id) !== normalizedCompanyId) {
        await existingRecord.update({ company_id: normalizedCompanyId }, { transaction });
      }
    }

    for (const existingRecord of existing) {
      if (!requestedUserIds.has(Number(existingRecord.user_id))) {
        await existingRecord.destroy({ transaction });
      }
    }

    return normalizedUserIds;
  },

async create(data, transaction = null) {
  try {
    const record = await UserAclScope.create(data, { transaction });
    return record;
  } catch (error) {
    logger.error('Error al crear scope ACL:', error);
    throw new Error(`Error al crear scope ACL: ${error.message}`);
  }
},

// Nuevo: bulkCreate para múltiples scopes
async bulkCreate(scopes, transaction = null) {
  try {
    return await UserAclScope.bulkCreate(scopes, { transaction });
  } catch (error) {
    logger.error('Error al crear múltiples scopes ACL:', error);
    throw new Error(`Error al crear scopes ACL: ${error.message}`);
  }
},

  async delete(record) {
    try {
      return await record.destroy();
    } catch (error) {
      logger.error(`Error al eliminar scope ID ${record.id}:`, error);
      throw new Error(`Error al eliminar scope: ${error.message}`);
    }
  },

  async deleteAllByUserAndCompany(user_id, company_id, transaction = null) {
    try {
      await UserAclScope.destroy({
        where: { user_id, company_id },
        transaction
      });
    } catch (error) {
      logger.error(`Error al eliminar scopes para usuario ${user_id} y empresa ${company_id}:`, error);
      throw new Error(`Error al limpiar scopes: ${error.message}`);
    }
  },

  async deleteWarehousesByUserAndCompany(user_id, company_id, transaction = null) {
    try {
      await UserAclScope.destroy({
        where: {
          user_id,
          company_id,
          warehouse_id: { [require('sequelize').Op.not]: null }
        },
        transaction
      });
    } catch (error) {
      logger.error(`Error al eliminar warehouses ACL para usuario ${user_id} y empresa ${company_id}:`, error);
      throw new Error(`Error al limpiar warehouses ACL: ${error.message}`);
    }
  },

  async deletePoolsByUserAndCompany(user_id, company_id, transaction = null) {
    try {
      await UserAclScope.destroy({
        where: {
          user_id,
          company_id,
          pool_id: { [require('sequelize').Op.not]: null }
        },
        transaction
      });
    } catch (error) {
      logger.error(`Error al eliminar pools ACL para usuario ${user_id} y empresa ${company_id}:`, error);
      throw new Error(`Error al limpiar pools ACL: ${error.message}`);
    }
  }
};

module.exports = UserAclScopeRepository;
