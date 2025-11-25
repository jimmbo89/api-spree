// src/controllers/ProductFieldMappingController.js
const logger = require('../../config/logger');
const {
  ProductFieldMappingRepository,
  MarketplaceRepository,
  LogRepository
} = require('../repositories');
const { getRequestMetadata } = require('../util/requestUtil');

const ProductFieldMappingController = {
  async list(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Lista mapeos de campos del marketplace`);

    const { marketplace_id } = req.body;
    if (!marketplace_id) return res.status(400).json({ msg: "marketplace_id es obligatorio" });

    try {
      // Validar que el marketplace exista
      const mp = await MarketplaceRepository.findById(marketplace_id);
      if (!mp) return res.status(400).json({ msg: "marketplaceNotFound" });

      const mappings = await ProductFieldMappingRepository.findByMarketplace(marketplace_id);
      res.status(200).json({ mappings });
    } catch (error) {
      logger.error('ProductFieldMappingController->list: ' + error.message);
      res.status(500).json({ error: 'ServerError' });
    }
  },

  async store(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Crea nuevo mapeo de campo`);
    logger.info('Datos recibidos:');
    logger.info(JSON.stringify(req.body));

    const metadata = getRequestMetadata(req);
    const { marketplace_id } = req.body;

    try {
      const mp = await MarketplaceRepository.findById(marketplace_id);
      if (!mp) return res.status(400).json({ msg: "marketplaceNotFound" });

      const mapping = await ProductFieldMappingRepository.create(req.body);

      await LogRepository.create({
        user_id: metadata.user_id,
        action: 'field_mapping.create',
        description: `Mapeo creado: ${mapping.internalField} → ${mapping.externalField} (marketplace ${marketplace_id})`,
        ip_address: metadata.ip_address,
        user_agent: metadata.user_agent,
        status: 'success',
        meta: { id: mapping.id, marketplace_id }
      });

      const formatted = {
        id: mapping.id,
        marketplace_id: mapping.marketplace_id,
        internal_field: mapping.internal_field,
        external_field: mapping.external_field,
        required: mapping.required,
        data_type: mapping.data_type,
        direction: mapping.direction,
        default_value: mapping.default_value,
        validation_rules: mapping.validation_rules
      };

      res.status(201).json({ message: "Mapeo de campo creado correctamente", mapping: formatted });
    } catch (error) {
      await LogRepository.create({
        user_id: metadata?.user_id,
        action: 'field_mapping.create',
        description: `Error al crear mapeo: ${error.message}`,
        ip_address: metadata?.ip_address,
        user_agent: metadata?.user_agent,
        status: 'error',
        meta: null
      });
      logger.error('ProductFieldMappingController->store: ' + error.message);
      res.status(500).json({ error: 'ServerError' });
    }
  },

  async show(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Muestra mapeo de campo con ID ${req.body.id}`);

    try {
      const mapping = await ProductFieldMappingRepository.findById(req.body.id);
      if (!mapping) return res.status(404).json({ msg: "FieldMappingNotFound" });

      const formatted = {
        id: mapping.id,
        marketplace_id: mapping.marketplace_id,
        internal_field: mapping.internal_field,
        external_field: mapping.external_field,
        required: mapping.required,
        data_type: mapping.data_type,
        direction: mapping.direction,
        default_value: mapping.default_value,
        validation_rules: mapping.validation_rules
      };

      res.status(200).json({ mapping: formatted });
    } catch (error) {
      logger.error('ProductFieldMappingController->show: ' + error.message);
      res.status(500).json({ error: 'ServerError' });
    }
  },

  async update(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Actualiza mapeo de campo ${req.body.id}`);
    logger.info('Datos recibidos:');
    logger.info(JSON.stringify(req.body));

    const metadata = getRequestMetadata(req);
    const { id } = req.body;

    try {
      const mapping = await ProductFieldMappingRepository.findById(id);
      if (!mapping) return res.status(404).json({ msg: "FieldMappingNotFound" });

      // Validar que el marketplace exista (opcional, pero bueno para consistencia)
      const mp = await MarketplaceRepository.findById(mapping.marketplace_id);
      if (!mp) return res.status(400).json({ msg: "marketplaceNotFound" });

      const updated = await ProductFieldMappingRepository.update(mapping, req.body);

      await LogRepository.create({
        user_id: metadata.user_id,
        action: 'field_mapping.update',
        description: `Mapeo actualizado: ID ${id}`,
        ip_address: metadata.ip_address,
        user_agent: metadata.user_agent,
        status: 'success',
        meta: { id }
      });

      const formatted = {
        id: updated.id,
        marketplace_id: mapping.marketplace_id,
        internal_field: mapping.internal_field,
        external_field: mapping.external_field,
        required: mapping.required,
        data_type: mapping.data_type,
        direction: mapping.direction,
        default_value: mapping.default_value,
        validation_rules: mapping.validation_rules
      };

      res.status(200).json({ message: "Mapeo de campo actualizado correctamente", mapping: formatted });
    } catch (error) {
      await LogRepository.create({
        user_id: metadata?.user_id,
        action: 'field_mapping.update',
        description: `Error al actualizar mapeo ID ${req.body?.id}: ${error.message}`,
        ip_address: metadata?.ip_address,
        user_agent: metadata?.user_agent,
        status: 'error',
        meta: null
      });
      logger.error('ProductFieldMappingController->update: ' + error.message);
      res.status(500).json({ error: 'ServerError', details: error.message });
    }
  },

  async destroy(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Elimina mapeo de campo con ID ${req.body.id}`);

    const metadata = getRequestMetadata(req);
    const { id } = req.body;

    try {
      const mapping = await ProductFieldMappingRepository.findById(id);
      if (!mapping) return res.status(404).json({ msg: "FieldMappingNotFound" });

      await ProductFieldMappingRepository.delete(mapping);

      await LogRepository.create({
        user_id: metadata.user_id,
        action: 'field_mapping.delete',
        description: `Mapeo eliminado: ID ${id}`,
        ip_address: metadata.ip_address,
        user_agent: metadata.user_agent,
        status: 'success',
        meta: { id }
      });

      res.status(200).json({ message: "Mapeo de campo eliminado correctamente" });
    } catch (error) {
      await LogRepository.create({
        user_id: metadata?.user_id,
        action: 'field_mapping.delete',
        description: `Error al eliminar mapeo ID ${req.body?.id}: ${error.message}`,
        ip_address: metadata?.ip_address,
        user_agent: metadata?.user_agent,
        status: 'error',
        meta: null
      });
      logger.error('ProductFieldMappingController->destroy: ' + error.message);
      res.status(500).json({ error: 'ServerError', details: error.message });
    }
  }
};

module.exports = ProductFieldMappingController;