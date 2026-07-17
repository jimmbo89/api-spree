// app/controllers/RoleController.js
const logger = require("../../config/logger");
const { RoleRepository } = require("../repositories");

const RoleController = {
  async index(req, res) {
    const userName = req.user?.name || 'Anonymous';
    logger.info(`${userName} - Solicita listado de roles`);

    try {
      const roles = await RoleRepository.findAll();
      return roles.length === 0
        ? res.status(204).json({ msg: "NoRolesFound", roles: [] })
        : res.status(200).json({ roles: roles });
    } catch (err) {
      logger.error("RoleController->index: " + err.message);
      return res.status(500).json({ error: "ServerError", details: err.message });
    }
  },

  async store(req, res) {
    const userName = req.user?.name || 'Anonymous';
    logger.info(`${userName} - Crea nuevo rol`);
    logger.info("Datos recibidos (body):");
    logger.info(JSON.stringify(req.body));

    const { name, status, visible_to_companies, description } = req.body;

    const roleData = { name, status, visible_to_companies, description };

    try {
      await RoleRepository.create(roleData);
        const roles = await RoleRepository.findAll();
      return res.status(201).json({ roles: roles, msg: "Rol creado correctamente" } );
    } catch (err) {
      logger.error("RoleController->store: " + err.message);
      return res.status(500).json({ error: "ServerError", details: err.message });
    }
  },

  async update(req, res) {
    const userName = req.user?.name || 'Anonymous';
    const roleId = req.params.id || req.body.id;
    logger.info(`${userName} - Actualiza rol ID ${roleId}`);
    logger.info("Datos recibidos (params + body):");
    logger.info(JSON.stringify({ params: req.params, body: req.body }));

    const { name, status, visible_to_companies, description } = req.body;
    const user_id = req.body.user_id || req.user?.id;
     const roleData = { name, status, visible_to_companies, description };
    try {
      const role = await RoleRepository.findById(roleId);
      if (!role) return res.status(404).json({ msg: "RoleNotFound" });

      const updatedRole = await RoleRepository.update(role, roleData);
      const roles = await RoleRepository.findAll();
      return res.status(200).json({ roles: roles, msg: "Rol editado correctamente" });
    } catch (err) {
      logger.error("RoleController->update: " + err.message);
      return res.status(500).json({ error: "ServerError", details: err.message });
    }
  },

  async destroy(req, res) {
    const userName = req.user?.name || 'Anonymous';
    const roleId = req.params.id || req.body.id;
    logger.info(`${userName} - Elimina rol ID ${roleId}`);
    logger.info("Datos recibidos (params):");
    logger.info(JSON.stringify({ params: req.params, body: req.body }));

    const user_id = req.body?.user_id || req.user?.id;

    try {
      const role = await RoleRepository.findById(roleId);
      if (!role) return res.status(404).json({ msg: "RoleNotFound" });

      await RoleRepository.delete(role);
      const roles = await RoleRepository.findAll();
      return res.status(200).json({ msg: "Rol eliminado correctamente", roles: roles });
    } catch (err) {
      logger.error("RoleController->destroy: " + err.message);
      return res.status(500).json({ error: "ServerError", details: err.message });
    }
  },

  async show(req, res) {
    const userName = req.user?.name || 'Anonymous';
    const roleId = req.params.id || req.body.id;
    logger.info(`${userName} - Consulta rol ID ${roleId}`);
    logger.info("Datos recibidos (params):");
    logger.info(JSON.stringify({ params: req.params, body: req.body }));

    try {
      const role = await RoleRepository.findById(roleId);
      if (!role) return res.status(404).json({ msg: "RoleNotFound" });
      return res.status(200).json({ role: role });
    } catch (err) {
      logger.error("RoleController->show: " + err.message);
      return res.status(500).json({ error: "ServerError", details: err.message });
    }
  }
};

module.exports = RoleController;
