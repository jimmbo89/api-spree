// app/repositories/UserAclScopeRepository.js
const { UserAclScope, User, Company, Warehouse, Pool } = require('../models');
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

  async create(data) {
    try {
      const record = await UserAclScope.create(data);
      const populated = await UserAclScope.findByPk(record.id, {
        include: [
          { model: Warehouse, as: 'warehouse' },
          { model: Pool, as: 'pool' }
        ]
      });
      return mapScope(populated);
    } catch (error) {
      logger.error('Error al crear scope ACL:', error);
      throw new Error(`Error al crear scope ACL: ${error.message}`);
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

  async deleteAllByUserAndCompany(user_id, company_id) {
    try {
      await UserAclScope.destroy({ where: { user_id, company_id } });
    } catch (error) {
      logger.error(`Error al eliminar scopes para usuario ${user_id} y empresa ${company_id}:`, error);
      throw new Error(`Error al limpiar scopes: ${error.message}`);
    }
  }
};

module.exports = UserAclScopeRepository;