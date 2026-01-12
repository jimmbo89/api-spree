const { RolePermission, Permission, sequelize } = require('../models');
const logger = require('../../config/logger');
const { Op } = require('sequelize');

function mapRolePermission(rp) {
  if (!rp || !rp.permission) return null;
  return {
    id: rp.id,
    role_id: rp.role_id,
    permission_id: rp.permission_id,
    status: rp.status,
    permission: {
      id: rp.permission.id,
      name: rp.permission.name,
      description: rp.permission.description,
      is_conditional: rp.permission.is_conditional
    }
  };
}

const RolePermissionRepository = {
  async getPermissionsByRoleId(role_id, status = null) {
    const where = { role_id };
    if (status !== null) where.status = status;

    try {
      const records = await RolePermission.findAll({
        where,
        include: [{ model: Permission, as: 'permission' }],
        order: [['id', 'ASC']]
      });
      return records.map(mapRolePermission);
    } catch (error) {
      logger.error(`Error al obtener permisos del rol ${role_id}:`, error);
      throw new Error(`Error al obtener permisos del rol: ${error.message}`);
    }
  },

  async getAll(status = null) {
    const where = { };
    if (status !== null) where.status = status;

    try {
      const records = await RolePermission.findAll({
        where,
        include: [{ model: Permission, as: 'permission' }],
        order: [['id', 'ASC']]
      });
      return records.map(mapRolePermission);
    } catch (error) {
      logger.error(`Error al obtener permisos del rol ${role_id}:`, error);
      throw new Error(`Error al obtener permisos del rol: ${error.message}`);
    }
  },

  async findById(id) {
    try {
      return await RolePermission.findByPk(id);
    } catch (error) {
      logger.error(`Error al buscar asignación por ID ${id}:`, error);
      throw new Error(`Error al buscar asignación: ${error.message}`);
    }
  },

  async assignPermissionToRole(data) {
    try {
      const existing = await RolePermission.findOne({
        where: { role_id: data.role_id, permission_id: data.permission_id }
      });

      if (existing) {
        await RolePermission.update({ status: data.status }, { where: { id: existing.id } });
        const updated = await RolePermission.findByPk(existing.id, {
          include: [{ model: Permission, as: 'permission' }]
        });
        return mapRolePermission(updated);
      } else {
        const rp = await RolePermission.create(data);
        const withPerm = await RolePermission.findByPk(rp.id, {
          include: [{ model: Permission, as: 'permission' }]
        });
        return mapRolePermission(withPerm);
      }
    } catch (error) {
      logger.error('Error al asignar permiso a rol:', error);
      throw new Error(`Error al asignar permiso a rol: ${error.message}`);
    }
  },

  async assignMultiplePermissionsToRole(role_id, permission_ids, status = 1) {
    try {
      return await sequelize.transaction(async (t) => {
        for (const permission_id of permission_ids) {
          const existing = await RolePermission.findOne({
            where: { role_id, permission_id },
            transaction: t
          });

          if (existing) {
            await RolePermission.update({ status }, { where: { id: existing.id }, transaction: t });
          } else {
            await RolePermission.create({ role_id, permission_id, status }, { transaction: t });
          }
        }
        return await this.getPermissionsByRoleId(role_id);
      });
    } catch (error) {
      logger.error(`Error al asignar múltiples permisos al rol ${role_id}:`, error);
      throw new Error(`Error al asignar permisos: ${error.message}`);
    }
  },

  async updateStatus(record, status) {
    try {
      return await record.update({ status });
    } catch (error) {
      logger.error(`Error al actualizar asignación ID ${record.id}:`, error);
      throw new Error(`Error al actualizar asignación: ${error.message}`);
    }
  },

  async delete(record) {
    try {
      return await record.destroy();
    } catch (error) {
      logger.error(`Error al eliminar asignación ID ${record.id}:`, error);
      throw new Error(`Error al eliminar asignación: ${error.message}`);
    }
  },

  async getAvailablePermissionsForRole(role_id, permission_id = null) {
  try {
    // Obtener IDs de permisos ya asignados al rol
    const assigned = await RolePermission.findAll({
      where: { role_id },
      attributes: ['permission_id']
    });
    const assignedIds = assigned.map(a => a.permission_id);

    // Si se pasa permission_id, aseguramos que no se filtre aunque esté asignado
    let availableIds = [];
    if (permission_id !== null) {
      // Incluir permission_id incluso si está asignado
      availableIds = [permission_id];
    } else {
      // Obtener todos los permisos que NO están asignados
      const allPermissions = await Permission.findAll({
        attributes: ['id'],
        where: { id: { [Op.notIn]: assignedIds } }
      });
      availableIds = allPermissions.map(p => p.id);
    }

    // Obtener los permisos completos (con todos los atributos)
    const permissions = await Permission.findAll({
      where: { id: availableIds },
      order: [['id', 'ASC']]
    });

    // Mapear a la estructura estándar (igual que en PermissionRepository.findAll)
    return permissions.map(p => ({
      id: p.id,
      name: p.name,
      description: p.description,
      is_conditional: p.is_conditional,
      service: p.service,
      resource: p.resource,
      action: p.action
    }));
  } catch (error) {
    logger.error(`Error al obtener permisos disponibles para el rol ${role_id}:`, error);
    throw new Error(`Error al obtener permisos disponibles: ${error.message}`);
  }
}
};

module.exports = RolePermissionRepository;