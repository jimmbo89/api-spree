// app/repositories/PermissionRepository.js
const { Permission, RolePermission } = require("../models");
const logger = require("../../config/logger");
const { Op } = require("sequelize");

// Función de mapeo reutilizable
function mapPermission(permission, hasRoles = false) {
  if (!permission) return null;
  return {
    id: permission.id,
    name: permission.name,
    description: permission.description,
    service: permission.service,
    resource: permission.resource,
    action: permission.action,
    is_conditional: permission.is_conditional,
    is_active: !hasRoles // ✅ true si NO tiene roles asignados, false si tiene roles
  };
}

const PermissionRepository = {
  async findAll() {
    try {
      // Obtener todos los permisos
      const permissions = await Permission.findAll({
        order: [["id", "ASC"]]
      });
      
      // Obtener los permission_id que ya tienen roles asignados
      const rolePermissions = await RolePermission.findAll({
        attributes: ['permission_id'],
        where: { status: 1 }, // Solo activos
        raw: true
      });
      
      const permissionIdsWithRoles = new Set(
        rolePermissions.map(rp => rp.permission_id)
      );
      
      // Mapear cada permiso con su estado is_active
      return permissions.map(permission => {
        const hasRoles = permissionIdsWithRoles.has(permission.id);
        return mapPermission(permission, hasRoles);
      });
    } catch (error) {
      logger.error("Error en PermissionRepository->findAll:", error);
      throw new Error(`Error al obtener permisos: ${error.message}`);
    }
  },

  async findById(id) {
    try {
      const permission = await Permission.findByPk(id);
      return permission;
    } catch (error) {
      logger.error(`Error en PermissionRepository->findById (ID: ${id}):`, error);
      throw new Error(`Error al obtener el permiso: ${error.message}`);
    }
  },

  async findByName(name) {
    try {
      if (!name) {
        throw new Error("El nombre del permiso no puede estar vacío");
      }
      const permission = await Permission.findOne({ where: { name } });
      return mapPermission(permission);
    } catch (error) {
      logger.error(`Error en PermissionRepository->findByName (Name: ${name}):`, error);
      throw new Error(`Error al obtener el permiso por nombre: ${error.message}`);
    }
  },

  async create(data) {
    try {
      // Extraemos solo los campos permitidos (defensivo)
      const { name, description, service, resource, action, is_conditional } = data;
      const permission = await Permission.create({
        name,
        description: description || null,
        service: service || null,
        resource: resource || null,
        action: action || null,
        is_conditional: is_conditional !== undefined ? is_conditional : false
      });
      logger.info(`Nuevo permiso creado: ID ${permission.id}, nombre: ${permission.name}`);
      return mapPermission(permission);
    } catch (error) {
      logger.error("Error en PermissionRepository->create:", error);
      throw new Error(`Error al crear permiso: ${error.message}`);
    }
  },

  // Dentro de PermissionRepository
async update(permission, body) {
  const fieldsToUpdate = [
    'name',
    'description',
    'service',
    'resource',
    'action',
    'is_conditional'
  ];

  const updatedData = {};
  for (const key of fieldsToUpdate) {
    if (body[key] !== undefined) {
      updatedData[key] = body[key];
    }
  }

  if (Object.keys(updatedData).length > 0) {
    await permission.update(updatedData);
    logger.info(`Permiso actualizado (ID: ${permission.id})`);
  } else {
    logger.info(`Permiso (ID: ${permission.id}) - No hay cambios para actualizar`);
  }

  // Devuelve la instancia actualizada (como en tu flujo de Company)
  return permission;
},

  async delete(permissionInstance) {
    try {
      await permissionInstance.destroy();
      logger.info(`Permiso eliminado (ID: ${permissionInstance.id})`);
      return { success: true, message: "Permiso eliminado correctamente" };
    } catch (error) {
      logger.error(`Error en PermissionRepository->delete (ID: ${permissionInstance.id}):`, error);
      throw new Error(`Error al eliminar permiso: ${error.message}`);
    }
  },

  async validatePermissionsExist(permissionIds) {
  if (!Array.isArray(permissionIds) || permissionIds.length === 0) {
    throw new Error('La lista de IDs de permisos no puede estar vacía');
  }

  // Obtener todos los permisos que existen con los IDs dados
  const found = await Permission.findAll({
    where: { id: permissionIds },
    attributes: ['id']
  });

  const foundIds = new Set(found.map(p => p.id));
  const missingIds = permissionIds.filter(id => !foundIds.has(id));

  if (missingIds.length > 0) {
    throw new Error(`Los siguientes permisos no existen: ${missingIds.join(', ')}`);
  }

  return true;
}
};

module.exports = PermissionRepository;