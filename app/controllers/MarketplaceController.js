// src/controllers/MarketplaceController.js
const logger = require('../../config/logger');
const { sequelize } = require('../models');
const {
  MarketplaceRepository,
  CompanyRepository,
  UserRepository,
  LogRepository,
  BranchRepository
} = require('../repositories');
const { getRequestMetadata } = require('../util/requestUtil');

const MarketplaceController = {
   async list(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Lista marketplaces`);
    const metadata = getRequestMetadata(req);

    try {
      const marketplaces = await MarketplaceRepository.findAllByContext();
      res.status(200).json({ marketplaces });
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
    const { user_id: bodyUserId } = req.body;
    const user_id = bodyUserId || req.user.id;

    let transaction;
    try {
      transaction = await sequelize.transaction();

      const mp = await MarketplaceRepository.create({
        name: req.body.name,
        description: req.body.description,
        type: req.body.type,
        domain: req.body.domain,
        config: req.body.config,
        active: req.body.active !== undefined ? req.body.active : true
      }, { transaction });

      if (Array.isArray(req.body.mappings)) {
        for (const m of req.body.mappings) {
          await MarketplaceRepository.createMapping({
            marketplace_id: mp.id,
            internal_field: m.internal_field,
            external_field: m.external_field,
            required: m.required,
            data_type: m.data_type,
            direction: m.direction,
            default_value: m.default_value,
            validation_rules: m.validation_rules
          }, { transaction });
        }
      }

      await transaction.commit();
      transaction = null; 
      await LogRepository.create({
        user_id: metadata.user_id,
        action: 'marketplace.create',
        description: `Marketplace "${mp.name}" creado`,
        ip_address: metadata.ip_address,
        user_agent: metadata.user_agent,
        status: 'success',
        meta: { id: mp.id }
      });

      const marketplaces = await MarketplaceRepository.findAllByContext();
      res.status(201).json({ message: "Marketplace creado correctamente", marketplaces });
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
      res.status(500).json({ error: 'ServerError' });
    }
  },

  async show(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Muestra marketplace con ID ${req.body.id}`);

    try {
      const mp = await MarketplaceRepository.findById(req.body.id);
      if (!mp) return res.status(404).json({ msg: 'MarketplaceNotFound' });

      const mappings = await MarketplaceRepository.findMappingsByMarketplace(mp.id);

      const marketplace = {
        id: mp.id,
        name: mp.name,
        description: mp.description,
        type: mp.type,
        domain: mp.domain,
        config: mp.config,
        active: mp.active
      };

      res.status(200).json({ marketplace, mappings });
    } catch (error) {
      logger.error('MarketplaceController->show: ' + error.message);
      res.status(500).json({ error: 'ServerError' });
    }
  },

  async update(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Actualiza marketplace ${req.body.id}`);
    logger.info('Datos recibidos:');
    logger.info(JSON.stringify(req.body));

    const metadata = getRequestMetadata(req);

    try {
      const mp = await MarketplaceRepository.findById(req.body.id);
      if (!mp) return res.status(404).json({ msg: 'MarketplaceNotFound' });

       let transaction = await sequelize.transaction();

      await MarketplaceRepository.update(mp, req.body);

      if (Array.isArray(req.body.mappings)) {
        await MarketplaceRepository.deleteMappingsByMarketplace(mp.id, { transaction });
        for (const m of req.body.mappings) {
          await MarketplaceRepository.createMapping({
            marketplace_id: mp.id,
            internal_field: m.internal_field,
            external_field: m.external_field,
            required: m.required,
            data_type: m.data_type,
            direction: m.direction,
            defaul_value: m.defaul_value,
            validation_rules: m.validation_rules
          }, { transaction });
        }
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

       const marketplaces = await MarketplaceRepository.findAllByContext();
      res.status(200).json({ message: "Marketplace actualizado correctamente", marketplaces: marketplaces });
    } catch (error) {
      await LogRepository.create({
        user_id: metadata?.user_id,
        action: 'marketplace.update',
        description: `Error al actualizar marketplace ID ${req.body?.id}: ${error.message}`,
        ip_address: metadata?.ip_address,
        user_agent: metadata?.user_agent,
        status: 'error',
        meta: null
      });
      logger.error('MarketplaceController->update: ' + error.message);
      res.status(500).json({ error: 'ServerError', details: error.message });
    }
  },

  async destroy(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Elimina marketplace con ID ${req.body.id}`);

    const metadata = getRequestMetadata(req);

    try {
      const mp = await MarketplaceRepository.findById(req.body.id);
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
        description: `Error al eliminar marketplace ID ${req.body?.id}: ${error.message}`,
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