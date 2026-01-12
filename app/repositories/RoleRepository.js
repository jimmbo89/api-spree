// app/repositories/RoleRepository.js
const { Role, Permission } = require("../models");
const logger = require("../../config/logger");

const RoleRepository = {
  async findAll() {
    try {
      const roles = await Role.findAll({
        attributes: ["id", "name", "status", "description"],
        order: [["id", "ASC"]]
      });
      return roles;
    } catch (error) {
      logger.error("Error en RoleRepository->findAll:", error);
      throw new Error(`Error al obtener roles: ${error.message}`);
    }
  },

  async findAllManteiner(permissions = false) {
  try {
    const includeOptions = permissions
      ? [
          {
            model: Permission,
            as: 'permissions',
            attributes: ['id', 'name', 'description'],
            through: { attributes: [] }, // evita incluir campos de la tabla intermedia
          },
        ]
      : [];

    const roles = await Role.findAll({
      attributes: ['id', 'name', 'status', 'description'],
      include: includeOptions,
      order: [['id', 'ASC']],
    });

    // Si no se piden permisos, devolvemos tal cual
    if (!permissions) {
      return roles;
    }

    // Formateamos para que cada rol tenga un campo `permissions` con solo los datos deseados
    return roles.map(role => {
      const rolePlain = role.get({ plain: true });
      return {
        ...rolePlain,
        permissions: rolePlain.permissions || [],
      };
    });
  } catch (error) {
    logger.error('Error en RoleRepository->findAll:', error);
    throw new Error(`Error al obtener roles: ${error.message}`);
  }
},

  async findById(id) {
    try {
      const role = await Role.findByPk(id, {
        attributes: ["id", "name", "status", "description"]
      });
      return role;
    } catch (error) {
      logger.error(`Error en RoleRepository->findById (ID: ${id}):`, error);
      throw new Error(`Error al obtener el rol: ${error.message}`);
    }
  },

  async findByName(name) {
  try {
    if (!name) {
      throw new Error("El nombre del rol no puede estar vacío");
    }

    const role = await Role.findOne({
      where: { name },
      attributes: ["id", "name", "status", "description"]
    });

    return role; // Retorna el rol o null si no se encuentra
  } catch (error) {
    logger.error(`Error en RoleRepository->findByName (Name: ${name}):`, error);
    throw new Error(`Error al obtener el rol por nombre: ${error.message}`);
  }
},

  async create(data) {
    try {
      const { name, status, description } = data;
      const role = await Role.create({
        name,
        status: status !== undefined ? status : true, // valor por defecto opcional
        description: description || null
      });
      logger.info(`Nuevo rol creado: ID ${role.id}, nombre: ${role.name}`);
      return role;
    } catch (error) {
      logger.error("Error en RoleRepository->create:", error);
      throw new Error(`Error al crear rol: ${error.message}`);
    }
  },

  async update(role, data) {
    try {
      const { name, status, description } = data;

      // Solo actualizamos los campos que vienen definidos
      const updateData = {};
      if (name !== undefined) updateData.name = name;
      if (status !== undefined) updateData.status = status;
      if (description !== undefined) updateData.description = description;

      await role.update(updateData);
      logger.info(`Rol actualizado (ID: ${role.id})`);
      return role;
    } catch (error) {
      logger.error(`Error en RoleRepository->update (ID: ${role.id}):`, error);
      throw new Error(`Error al actualizar rol: ${error.message}`);
    }
  },

  async delete(role) {
    try {
      await role.destroy();
      logger.info(`Rol eliminado (ID: ${role.id})`);
      return { success: true, message: "Rol eliminado correctamente" };
    } catch (error) {
      logger.error(`Error en RoleRepository->delete (ID: ${role.id}):`, error);
      throw new Error(`Error al eliminar rol: ${error.message}`);
    }
  }
};

module.exports = RoleRepository;