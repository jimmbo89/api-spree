// src/controllers/BusinessTypeController.js
const logger = require("../../config/logger");
const { BusinessTypeRepository } = require("../repositories");

const BusinessTypeController = {
  async index(req, res) {
    const userName = req.user?.name || 'Anonymous';
    logger.info(`${userName} - Solicita listado de tipos de negocio`);

    try {
      const businessTypes = await BusinessTypeRepository.findAll();
      return businessTypes.length === 0
        ? res.status(204).json({ msg: "NoBusinessTypesFound", businessTypes: [] })
        : res.status(200).json({ businessTypes: businessTypes });
    } catch (err) {
      logger.error("BusinessTypeController->index: " + err.message);
      return res.status(500).json({ error: "ServerError", details: err.message });
    }
  },

  async store(req, res) {
    const userName = req.user?.name || 'Anonymous';
    logger.info(`${userName} - Crea nuevo tipo de negocio`);
    logger.info("Datos recibidos (body):");
    logger.info(JSON.stringify(req.body));

    const { name, status, description } = req.body;
    const businessTypeData = { name, status, description };

    try {
      await BusinessTypeRepository.create(businessTypeData);
      const businessTypes = await BusinessTypeRepository.findAll();
      return res.status(201).json({ businessTypes: businessTypes, msg: "Tipo de negocio creado correctamente" });
    } catch (err) {
      logger.error("BusinessTypeController->store: " + err.message);
      return res.status(500).json({ error: "ServerError", details: err.message });
    }
  },

  async update(req, res) {
    const userName = req.user?.name || 'Anonymous';
    const businessTypeId = req.params.id || req.body.id;
    logger.info(`${userName} - Actualiza tipo de negocio ID ${businessTypeId}`);
    logger.info("Datos recibidos (params + body):");
    logger.info(JSON.stringify({ params: req.params, body: req.body }));

    const { name, status, description } = req.body;

    try {
      const businessType = await BusinessTypeRepository.findById(businessTypeId);
      if (!businessType) return res.status(404).json({ msg: "BusinessTypeNotFound" });

      const updatedBusinessType = await BusinessTypeRepository.update(businessType, { name, status, description });
      const businessTypes = await BusinessTypeRepository.findAll();
      return res.status(200).json({ businessTypes: businessTypes, msg: "Tipo de negocio editado correctamente" });
    } catch (err) {
      logger.error("BusinessTypeController->update: " + err.message);
      return res.status(500).json({ error: "ServerError", details: err.message });
    }
  },

  async destroy(req, res) {
    const userName = req.user?.name || 'Anonymous';
    const businessTypeId = req.params.id || req.body.id;
    logger.info(`${userName} - Elimina tipo de negocio ID ${businessTypeId}`);

    try {
      const businessType = await BusinessTypeRepository.findById(businessTypeId);
      if (!businessType) return res.status(404).json({ msg: "BusinessTypeNotFound" });

      await BusinessTypeRepository.delete(businessType);
      const businessTypes = await BusinessTypeRepository.findAll();
      return res.status(200).json({ success: true, message: "Tipo de negocio eliminado correctamente", businessTypes: businessTypes });
    } catch (err) {
      logger.error("BusinessTypeController->destroy: " + err.message);
      return res.status(500).json({ error: "ServerError", details: err.message });
    }
  },

  async show(req, res) {
    const userName = req.user?.name || 'Anonymous';
    const businessTypeId = req.params.id || req.body.id;
    logger.info(`${userName} - Consulta tipo de negocio ID ${businessTypeId}`);

    try {
      const businessType = await BusinessTypeRepository.findById(businessTypeId);
      if (!businessType) return res.status(404).json({ msg: "BusinessTypeNotFound" });
      return res.status(200).json({ businessType });
    } catch (err) {
      logger.error("BusinessTypeController->show: " + err.message);
      return res.status(500).json({ error: "ServerError", details: err.message });
    }
  }
};

module.exports = BusinessTypeController;