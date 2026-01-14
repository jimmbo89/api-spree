const logger = require("../../config/logger");
const { AttributeRepository } = require("../repositories");

const AttributeController = {
  async index(req, res) {
    const userName = req.user?.name || 'Anonymous';
    logger.info(`${userName} - Solicita listado de atributos`);
    const { usage } = req.body;
    let  withUsageCount = usage || false;
    try {
      const attributes = await AttributeRepository.findAll({ withUsageCount });
      return attributes.length === 0
        ? res.status(204).json({ msg: "NoAttributesFound", attributes: [] })
        : res.status(200).json({ attributes: attributes });
    } catch (err) {
      logger.error("AttributeController->index: " + err.message);
      return res.status(500).json({ error: "ServerError", details: err.message });
    }
  },

  async store(req, res) {
    const userName = req.user?.name || 'Anonymous';
    logger.info(`${userName} - Crea nuevo atributo`);
    logger.info("Datos recibidos (body):");
    logger.info(JSON.stringify(req.body));

    const { name, type, cant } = req.body;
    const attributeData = { name, type, cant };
    let  withUsageCount = true;
    try {
      await AttributeRepository.create(attributeData);
      const attributes = await AttributeRepository.findAll({ withUsageCount });
      return res.status(201).json({ attributes: attributes, msg: "Atributo creado correctamente" });
    } catch (err) {
      logger.error("AttributeController->store: " + err.message);
      return res.status(500).json({ error: "ServerError", details: err.message });
    }
  },

  async update(req, res) {
    const userName = req.user?.name || 'Anonymous';
    const attributeId = req.params.id || req.body.id;
    logger.info(`${userName} - Actualiza atributo ID ${attributeId}`);
    logger.info("Datos recibidos (params + body):");
    logger.info(JSON.stringify({ params: req.params, body: req.body }));

    const { name, type, cant } = req.body;
    let  withUsageCount = true;
    try {
      const attribute = await AttributeRepository.findById(attributeId);
      if (!attribute) return res.status(404).json({ msg: "AttributeNotFound" });

      const updatedAttribute = await AttributeRepository.update(attribute, { name, type, cant });
      const attributes = await AttributeRepository.findAll({ withUsageCount });
      return res.status(200).json({ attributes: attributes, msg: "Atributo editado correctamente" });
    } catch (err) {
      logger.error("AttributeController->update: " + err.message);
      return res.status(500).json({ error: "ServerError", details: err.message });
    }
  },

  async destroy(req, res) {
    const userName = req.user?.name || 'Anonymous';
    const attributeId = req.params.id || req.body.id;
    logger.info(`${userName} - Elimina atributo ID ${attributeId}`);
    logger.info("Datos recibidos (params):");
    logger.info(JSON.stringify({ params: req.params, body: req.body }));
    let  withUsageCount = true;
    try {
      const attribute = await AttributeRepository.findById(attributeId);
      if (!attribute) return res.status(404).json({ msg: "AttributeNotFound" });

      await AttributeRepository.delete(attribute);
      const attributes = await AttributeRepository.findAll({ withUsageCount });
      return res.status(200).json({ msg: "Atributo eliminado correctamente", attributes: attributes });
    } catch (err) {
      logger.error("AttributeController->destroy: " + err.message);
      return res.status(500).json({ error: "ServerError", details: err.message });
    }
  },

  async show(req, res) {
    const userName = req.user?.name || 'Anonymous';
    const attributeId = req.params.id || req.body.id;
    logger.info(`${userName} - Consulta atributo ID ${attributeId}`);
    logger.info("Datos recibidos (params):");
    logger.info(JSON.stringify({ params: req.params, body: req.body }));

    try {
      const attribute = await AttributeRepository.findById(attributeId);
      if (!attribute) return res.status(404).json({ msg: "AttributeNotFound" });
      return res.status(200).json({ attribute: attribute });
    } catch (err) {
      logger.error("AttributeController->show: " + err.message);
      return res.status(500).json({ error: "ServerError", details: err.message });
    }
  }
};

module.exports = AttributeController;