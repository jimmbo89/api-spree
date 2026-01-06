const logger = require('../../config/logger');
const { RoleRepository, PermissionRepository } = require('../repositories');
const RolePermissionRepository = require('../repositories/RolePermissionRepository');

const RolePermissionController = {
  async index(req, res) {
    const { role_id, status } = req.body;
    const role = await RoleRepository.findById(role_id);
    if (!role) {
      return res.status(400).json({ success: false, message: 'Rol no encontrado', permissions: [] });
    }

    try {
      const permissions = await RolePermissionRepository.getPermissionsByRoleId(
        parseInt(role_id, 10),
        status ? parseInt(status, 10) : null
      );
      return res.status(200).json({ success: true, permissions });
    } catch (error) {
      logger.error("RolePermissionController->index:", error.message);
      return res.status(500).json({ success: false, error: "Error interno del servidor", details: error.message });
    }
  },

  async assign(req, res) {
    const { role_id, permission_id, status } = req.body;
    const role = await RoleRepository.findById(role_id);
    if (!role) return res.status(400).json({ success: false, message: 'Rol no encontrado' });

    const permission = await PermissionRepository.findById(permission_id);
    if (!permission) return res.status(400).json({ success: false, message: 'Permiso no encontrado' });

    try {
      await RolePermissionRepository.assignPermissionToRole({ role_id, permission_id, status });
      const permissions = await RolePermissionRepository.getPermissionsByRoleId(role_id);
      return res.status(201).json({ success: true, permissions, message: "Permiso asignado al rol correctamente" });
    } catch (error) {
      logger.error("RolePermissionController->assign:", error.message);
      return res.status(500).json({ success: false, error: "Error interno del servidor", details: error.message });
    }
  },

  async assignMultiple(req, res) {
    const { role_id, permission_ids, status } = req.body;
    const role = await RoleRepository.findById(role_id);
    if (!role) return res.status(400).json({ success: false, message: 'Rol no encontrado' });
     try {
      await PermissionRepository.validatePermissionsExist(permission_ids);
    } catch (error) {
      return res.status(400).json({ 
        success: false, 
        message: error.message 
      });
    }

    try {
      await RolePermissionRepository.assignMultiplePermissionsToRole(role_id, permission_ids, status);
      const permissions = await RolePermissionRepository.getPermissionsByRoleId(role_id);
      return res.status(201).json({ success: true, permissions, message: `${permission_ids.length} permisos asignados al rol` });
    } catch (error) {
      return res.status(400).json({ success: false, message: error.message });
    }
  },

  async updateStatus(req, res) {
    const { id, status } = req.body;
    const record = await RolePermissionRepository.findById(id);
    if (!record) return res.status(400).json({ success: false, message: 'Asignación no encontrada' });

    try {
      await RolePermissionRepository.updateStatus(record, status);
      const permissions = await RolePermissionRepository.getPermissionsByRoleId(record.role_id);
      return res.status(200).json({ success: true, permissions, message: "Estado actualizado" });
    } catch (error) {
      logger.error("RolePermissionController->updateStatus:", error.message);
      return res.status(500).json({ success: false, error: "Error interno del servidor", details: error.message });
    }
  },

  async destroy(req, res) {
    const { id } = req.body;
    const record = await RolePermissionRepository.findById(id);
    if (!record) return res.status(400).json({ success: false, message: 'Asignación no encontrada' });

    try {
      await RolePermissionRepository.delete(record);
      const permissions = await RolePermissionRepository.getPermissionsByRoleId(record.role_id);
      return res.status(200).json({ success: true, permissions, message: "Asignación eliminada" });
    } catch (error) {
      logger.error("RolePermissionController->destroy:", error.message);
      return res.status(500).json({ success: false, error: "Error interno del servidor", details: error.message });
    }
  },

  async available(req, res) {
  const { role_id, permission_id } = req.body;

  // Validar que el rol exista
  const role = await RoleRepository.findById(role_id);
  if (!role) {
    return res.status(400).json({ success: false, message: 'Rol no encontrado' });
  }

  try {
    const permissions = await RolePermissionRepository.getAvailablePermissionsForRole(
      parseInt(role_id, 10),
      permission_id ? parseInt(permission_id, 10) : null
    );
    return res.status(200).json({ success: true, permissions: permissions });
  } catch (error) {
    logger.error("RolePermissionController->available:", error.message);
    return res.status(500).json({ success: false, error: "Error interno del servidor", details: error.message });
  }
}
};

module.exports = RolePermissionController;