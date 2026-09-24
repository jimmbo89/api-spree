// src/controllers/MarketplaceController.js
const logger = require('../../config/logger');
const { sequelize } = require('../models');
const {
  MarketplaceRepository,
  ProductFieldMappingRepository,
  LogRepository
} = require('../repositories');
const { getRequestMetadata } = require('../util/requestUtil');

const MarketplaceController = {
  async list(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Lista marketplaces`);
    try {
      const marketplaces = await MarketplaceRepository.findAllWithCredentialCount();
      // ⚠️ Eliminar client_secret de la respuesta
      const safeMarketplaces = marketplaces.map(mp => {
        const { client_secret, ...safeMp } = mp;
        return safeMp;
      });
      res.status(200).json({ success:true, marketplaces: marketplaces });
    } catch (error) {
      logger.error('MarketplaceController->list: ' + error.message);
      res.status(500).json({ error: 'ServerError' });
    }
  },

  async store(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Crea nuevo marketplace`);
    logger.info('Datos recibidos:');
    logger.info(JSON.stringify(req.body));

    const metadata = getRequestMetadata(req);
    let transaction;

    try {
      transaction = await sequelize.transaction();

      const mpData = {
        name: req.body.name,
        description: req.body.description,
        type: req.body.type,
        domain: req.body.domain,
        client_id: req.body.client_id,
        client_secret: req.body.client_secret, // se cifra en el repositorio
        redirect_uri: req.body.redirect_uri,
        scopes: req.body.scopes,
        active: req.body.active !== undefined ? req.body.active : true
      };

      const mp = await MarketplaceRepository.create(mpData, { transaction });
      const marketplace_id = mp.id;

      if (Array.isArray(req.body.mappings)) {
        const cleanMappings = req.body.mappings.map(m => ({
          marketplace_id,
          internal_field: m.internal_field,
          external_field: m.external_field,
          required: Boolean(m.required),
          data_type: m.data_type || null,
          direction: m.direction || 'export',
          default_value: m.default_value,
          validation_rules: m.validation_rules
        }));

        await ProductFieldMappingRepository.bulkCreate(cleanMappings, { transaction });
      }

      await transaction.commit();

      await LogRepository.create({
        user_id: metadata.user_id,
        action: 'marketplace.create',
        description: `Marketplace "${mp.name}" creado`,
        ip_address: metadata.ip_address,
        user_agent: metadata.user_agent,
        status: 'success',
        meta: { id: mp.id }
      });

      const marketplaces = await MarketplaceRepository.findAll();
      const safeMarketplaces = marketplaces.map(m => {
        const { client_secret, ...safe } = m;
        return safe;
      });

      res.status(201).json({ success: true, message: "Marketplace creado correctamente", marketplaces: marketplaces });
    } catch (error) {
      if (transaction) await transaction.rollback();
      await LogRepository.create({
        user_id: metadata?.user_id,
        action: 'marketplace.create',
        description: `Error: ${error.message}`,
        ip_address: metadata?.ip_address,
        user_agent: metadata?.user_agent,
        status: 'error',
        meta: null
      });
      logger.error('MarketplaceController->store: ' + error.message);
      res.status(500).json({ success: false, message: 'Error interno del servidor', details: error.message });
    }
  },

  async show(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Muestra marketplace con ID ${req.params.id || req.body.id}`);

    const id = req.params.id || req.body.id;
    if (!id) return res.status(400).json({ msg: 'ID requerido' });

    try {
      const mp = await MarketplaceRepository.findById(id);
      if (!mp) return res.status(404).json({ msg: 'MarketplaceNotFound' });

      const mappings = await MarketplaceRepository.findMappingsByMarketplace(mp.id);

      const { client_secret, ...safeMarketplace } = mp; // ocultar secreto

      res.status(200).json({ marketplace: safeMarketplace, mappings });
    } catch (error) {
      logger.error('MarketplaceController->show: ' + error.message);
      res.status(500).json({ success: false, message: 'Error interno del servidor', details: error.message });
    }
  },

  async update(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Actualiza marketplace ${req.params.id || req.body.id}`);
    logger.info('Datos recibidos:');
    logger.info(JSON.stringify(req.body));

    const id = req.body.id;

    const metadata = getRequestMetadata(req);
    let transaction;

    try {
      const mp = await MarketplaceRepository.findById(id);
      if (!mp) return res.status(404).json({ success: false, message: 'Marketplace no encontrado' });

      transaction = await sequelize.transaction();

      await MarketplaceRepository.update(mp, req.body);

      if (Array.isArray(req.body.mappings)) {
        await MarketplaceRepository.deleteMappingsByMarketplace(mp.id, { transaction });
        const cleanMappings = req.body.mappings.map(m => ({
          marketplace_id: mp.id,
          internal_field: m.internal_field,
          external_field: m.external_field,
          required: Boolean(m.required),
          data_type: m.data_type || null,
          direction: m.direction || 'export',
          default_value: m.default_value,
          validation_rules: m.validation_rules
        }));
        await ProductFieldMappingRepository.bulkCreate(cleanMappings, { transaction });
      }

      await transaction.commit();

      await LogRepository.create({
        user_id: metadata.user_id,
        action: 'marketplace.update',
        description: `Marketplace "${mp.name}" actualizado`,
        ip_address: metadata.ip_address,
        user_agent: metadata.user_agent,
        status: 'success',
        meta: { id: mp.id }
      });

      const marketplaces = await MarketplaceRepository.findAll();
      const safeMarketplaces = marketplaces.map(m => {
        const { client_secret, ...safe } = m;
        return safe;
      });

      res.status(200).json({ message: "Marketplace actualizado correctamente", marketplaces: marketplaces });
    } catch (error) {
      if (transaction) await transaction.rollback();
      await LogRepository.create({
        user_id: metadata?.user_id,
        action: 'marketplace.update',
        description: `Error al actualizar marketplace ID ${id}: ${error.message}`,
        ip_address: metadata?.ip_address,
        user_agent: metadata?.user_agent,
        status: 'error',
        meta: null
      });
      logger.error('MarketplaceController->update: ' + error.message);
      res.status(500).json({ success: false, message: 'Error interno del servidor', details: error.message });
    }
  },

  async destroy(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Elimina marketplace con ID ${req.params.id || req.body.id}`);

    const id = req.params.id || req.body.id;
    if (!id) return res.status(400).json({ msg: 'ID requerido' });

    const metadata = getRequestMetadata(req);

    try {
      const mp = await MarketplaceRepository.findById(id);
      if (!mp) return res.status(404).json({ msg: 'MarketplaceNotFound' });

      await MarketplaceRepository.delete(mp);

      await LogRepository.create({
        user_id: metadata.user_id,
        action: 'marketplace.delete',
        description: `Marketplace "${mp.name}" eliminado`,
        ip_address: metadata.ip_address,
        user_agent: metadata.user_agent,
        status: 'success',
        meta: { id: mp.id }
      });

      res.status(200).json({ message: "Marketplace eliminado correctamente" });
    } catch (error) {
      await LogRepository.create({
        user_id: metadata?.user_id,
        action: 'marketplace.delete',
        description: `Error al eliminar marketplace ID ${id}: ${error.message}`,
        ip_address: metadata?.ip_address,
        user_agent: metadata?.user_agent,
        status: 'error',
        meta: null
      });
      logger.error('MarketplaceController->destroy: ' + error.message);
      res.status(500).json({ error: 'ServerError', details: error.message });
    }
  }
};

module.exports = MarketplaceController;
