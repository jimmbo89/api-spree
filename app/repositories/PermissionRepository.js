// app/repositories/PermissionRepository.js
const { Permission } = require("../models");
const logger = require("../../config/logger");

// Función de mapeo reutilizable
function mapPermission(permission) {
  if (!permission) return null;
  return {
    id: permission.id,
    name: permission.name,
    description: permission.description,
    service: permission.service,
    resource: permission.resource,
    action: permission.action,
    is_conditional: permission.is_conditional
  };
}

const PermissionRepository = {
  async findAll() {
    try {
      const permissions = await Permission.findAll({
        order: [["id", "ASC"]]
      });
      return permissions.map(permission => mapPermission(permission));
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
  }
};

module.exports = PermissionRepository;