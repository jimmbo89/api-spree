const logger = require("../../config/logger");
const { VariantDefinitionRepository, VariantValueRepository } = require("../repositories");

const VariantValueController = {
  async index(req, res) {
    const userName = req.user?.name || 'Anonymous';
    const { variant_definition_id } = req.body;
    logger.info(`${userName} - Solicita listado de valores de variante`);

    try {
      const values = await VariantValueRepository.findByDefinitionId(variant_definition_id);
      return values.length === 0
        ? res.status(204).json({ msg: "NoVariantValuesFound", values: [] })
        : res.status(200).json({ values });
    } catch (err) {
      logger.error("VariantValueController->index: " + err.message);
      return res.status(500).json({ error: "ServerError", details: err.message });
    }
  },

  async store(req, res) {
    const userName = req.user?.name || 'Anonymous';
    logger.info(`${userName} - Crea nuevo valor de variante`);
    logger.info(JSON.stringify(req.body));

    const { variant_definition_id, name, code } = req.body;

    try {
      const definition = await VariantDefinitionRepository.findById(variant_definition_id);
      if (!definition) {
        return res.status(400).json({ error: "VariantDefinitionNotFound", message: "La definicion de variante no existe" });
      }

      const value = await VariantValueRepository.create({ variant_definition_id, name, code });
      const values = await VariantValueRepository.findByDefinitionId(variant_definition_id);
      return res.status(201).json({ values, value, msg: "Valor de variante creado correctamente" });
    } catch (err) {
      logger.error("VariantValueController->store: " + err.message);
      return res.status(500).json({ error: "ServerError", details: err.message });
    }
  },

  async update(req, res) {
    const userName = req.user?.name || 'Anonymous';
    const valueId = req.params.id || req.body.id;
    logger.info(`${userName} - Actualiza valor de variante ID ${valueId}`);
    logger.info(JSON.stringify({ params: req.params, body: req.body }));

    const { name, code, variant_definition_id } = req.body;

    try {
      const value = await VariantValueRepository.findById(valueId);
      if (!value) return res.status(404).json({ msg: "VariantValueNotFound" });

      if (variant_definition_id) {
        const definition = await VariantDefinitionRepository.findById(variant_definition_id);
        if (!definition) {
          return res.status(400).json({ error: "VariantDefinitionNotFound", message: "La definicion de variante no existe" });
        }
      }

      await VariantValueRepository.update(value, { name, code, variant_definition_id });
      const values = await VariantValueRepository.findByDefinitionId(variant_definition_id || value.variant_definition_id);
      return res.status(200).json({ values, msg: "Valor de variante editado correctamente" });
    } catch (err) {
      logger.error("VariantValueController->update: " + err.message);
      return res.status(500).json({ error: "ServerError", details: err.message });
    }
  },

  async destroy(req, res) {
    const userName = req.user?.name || 'Anonymous';
    const valueId = req.params.id || req.body.id;
    logger.info(`${userName} - Elimina valor de variante ID ${valueId}`);
    logger.info(JSON.stringify({ params: req.params, body: req.body }));

    try {
      const value = await VariantValueRepository.findById(valueId);
      if (!value) return res.status(404).json({ msg: "VariantValueNotFound" });

      await VariantValueRepository.delete(value);
      const values = await VariantValueRepository.findByDefinitionId(value.variant_definition_id);
      return res.status(200).json({ msg: "Valor de variante eliminado correctamente", values });
    } catch (err) {
      logger.error("VariantValueController->destroy: " + err.message);
      return res.status(500).json({ error: "ServerError", details: err.message });
    }
  }
};

module.exports = VariantValueController;
