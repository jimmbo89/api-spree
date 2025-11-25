// src/controllers/MarketplaceController.js
const logger = require('../../config/logger');
const { sequelize } = require('../models');
const {
  MarketplaceRepository,
  CompanyRepository,
  UserRepository,
  LogRepository
} = require('../repositories');
const { getRequestMetadata } = require('../util/requestUtil');

const MarketplaceController = {
  async list(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Lista marketplaces`);

    const { company_id } = req.body;
    const metadata = getRequestMetadata(req);

    try {
      if (!company_id) return res.status(400).json({ msg: "company_id es obligatorio" });

      const company = await CompanyRepository.findById(company_id);
      if (!company) return res.status(400).json({ msg: "companyNotFound" });

      const marketplaces = await MarketplaceRepository.findAllByCompany(company_id);

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
    const { company_id, user_id: bodyUserId } = req.body;
    const user_id = bodyUserId || req.user.id;

    let transaction;
    try {
      const company = await CompanyRepository.findById(company_id);
      if (!company) return res.status(400).json({ msg: "companyNotFound" });

      if (user_id) {
        const user = await UserRepository.findById(user_id);
        if (!user) return res.status(400).json({ msg: "userNotFound" });
      }

      transaction = await sequelize.transaction();

      const mp = await MarketplaceRepository.create({
        company_id,
        user_id,
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
            defaul_value: m.defaul_value,
            validation_rules: m.validation_rules
          }, { transaction });
        }
      }

      await transaction.commit();

      await LogRepository.create({
        user_id: metadata.user_id,
        action: 'marketplace.create',
        description: `Marketplace "${mp.name}" creado`,
        ip_address: metadata.ip_address,
        user_agent: metadata.user_agent,
        status: 'success',
        meta: { id: mp.id, company_id }
      });

      const marketplaces = await MarketplaceRepository.findAllByCompany(mp.company_id);

      res.status(201).json({ message: "Marketplace creado correctamente", marketplaces: marketplaces });
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
        company_id: mp.company_id,
        user_id: mp.user_id,
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

      if (req.body.company_id) {
        const company = await CompanyRepository.findById(req.body.company_id);
        if (!company) return res.status(400).json({ msg: "companyNotFound" });
      }
      if (req.body.user_id) {
        const user = await UserRepository.findById(req.body.user_id);
        if (!user) return res.status(400).json({ msg: "userNotFound" });
      }

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

       const marketplaces = await MarketplaceRepository.findAllByCompany(mp.company_id);
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