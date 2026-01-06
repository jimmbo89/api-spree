// app/controllers/PermissionController.js
const logger = require("../../config/logger");
const { PermissionRepository } = require("../repositories");

const PermissionController = {
  async index(req, res) {
    const userName = req.user?.name || 'Anonymous';
    logger.info(`${userName} - Solicita listado de permisos`);

    try {
      const permissions = await PermissionRepository.findAll();
      return permissions.length === 0
        ? res.status(204).json({ success: false, message: "Permiso no encontrados", permissions: [] })
        : res.status(200).json({ success: true, permissions: permissions });
    } catch (err) {
      logger.error("PermissionController->index: " + err.message);
      return res.status(500).json({success: false, message: "Error interno del servidor", details: err.message });
    }
  },

  async store(req, res) {
    const userName = req.user?.name || 'Anonymous';
    logger.info(`${userName} - Crea nuevo permiso`);
    logger.info("Datos recibidos al crear permiso");
    logger.info(JSON.stringify(req.body));

    // 👇 Desglose explícito de los atributos esperados
    const {
      name,
      description,
      service,
      resource,
      action,
      is_conditional
    } = req.body;

    const permissionData = {
      name,
      description,
      service,
      resource,
      action,
      is_conditional
    };

    try {
      await PermissionRepository.create(permissionData);
      const permissions = await PermissionRepository.findAll();
      return res.status(201).json({ success: true, permissions: permissions, msg: "Permiso creado correctamente" });
    } catch (err) {
      logger.error("PermissionController->store: " + err.message);
      return res.status(500).json({success: false, message: "Error interno del servidor", details: err.message });
    }
  },

  async update(req, res) {
    const userName = req.user?.name || 'Anonymous';
    logger.info(`${userName} - Actualiza permiso`);
    logger.info("Datos recibidos al actualizar permiso");
    logger.info(JSON.stringify(req.body));

    // 👇 Desglose explícito
    const {
        id,
      name,
      description,
      service,
      resource,
      action,
      is_conditional
    } = req.body;

    const permissionData = {
      name,
      description,
      service,
      resource,
      action,
      is_conditional
    };

    try {
      const permission = await PermissionRepository.findById(id);
      if (!permission) return res.status(404).json({success: false, message: "Permiso no ncontrado", permissions: [] });

      await PermissionRepository.update(permission, permissionData);
      const permissions = await PermissionRepository.findAll();
      return res.status(200).json({success: true, permissions: permissions, message: "Permiso editado correctamente" });
    } catch (err) {
      logger.error("PermissionController->update: " + err.message);
      return res.status(500).json({success: false, message: "Error interno del servidor", details: err.message });
    }
  },

  async destroy(req, res) {
    const userName = req.user?.name || 'Anonymous';
    const {id} = req.body;
    logger.info(`${userName} - Elimina permiso`);
    logger.info("Datos recibidos al eliminar permiso");
    logger.info(JSON.stringify(req.body));

    try {
      const permission = await PermissionRepository.findById(id);
      if (!permission) return res.status(404).json({success: false, message: "Permiso no encontrado", permissions: [] });

      await PermissionRepository.delete(permission);
      const permissions = await PermissionRepository.findAll();
      return res.status(200).json({ msg: "Permiso eliminado correctamente", permissions });
    } catch (err) {
      logger.error("PermissionController->destroy: " + err.message);
      return res.status(500).json({success: false, message: "Error interno del servidor", details: err.message });
    }
  },

  async show(req, res) {
    const userName = req.user?.name || 'Anonymous';
    const {id} = req.body;
    logger.info(`${userName} - Consulta permiso`);
    logger.info("Datos recibidos al consultar permiso");
    logger.info(JSON.stringify(req.body));

    try {
      const permission = await PermissionRepository.findById(id);
      if (!permission) return res.status(404).json({success: false, message: "Permiso no encontrado", permissions: [] });
      return res.status(200).json({success: true, permissions: permission });
    } catch (err) {
      logger.error("PermissionController->show: " + err.message);
      return res.status(500).json({success: false, message: "Error interno del servidor", details: err.message });
    }
  }
};

module.exports = PermissionController;