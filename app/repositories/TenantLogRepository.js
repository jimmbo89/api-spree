// repositories/tenantLogRepository.js
const { TenantLog } = require("../models");
const { Op } = require('sequelize');
const logger = require("../../config/logger");

const TenantLogRepository = {
  async create(data, options = {}) {
    try {
      const log = await TenantLog.create(data, options);
      logger.debug(`[TenantLog] Creado ID ${log.id} para tenant ${data.company_id}`);
      return log;
    } catch (error) {
      logger.error(`[TenantLogRepository->create] Error: ${error.message}`);
      throw error;
    }
  },

  async findById(log_id, options = {}) {
    try {
      return await TenantLog.findByPk(log_id, options);
    } catch (error) {
      logger.error(`[TenantLogRepository->findById] Error: ${error.message}`);
      throw error;
    }
  },

  async findByCompanyId(company_id, filters = {}, options = {}) {
    try {
      const { 
        module, 
        event_type, 
        result, 
        date_from, 
        date_to, 
        page = 1, 
        limit = 10 
      } = filters;
      
      const where = { company_id };
      
      if (module) where.module = module;
      if (event_type) where.event_type = event_type;
      if (result) where.result = result;
      
      if (date_from || date_to) {
        where.createdAt = {};
        if (date_from) {
          where.createdAt[Op.gte] = new Date(date_from);
        }
        if (date_to) {
          const endDate = new Date(date_to);
          endDate.setHours(23, 59, 59, 999);
          where.createdAt[Op.lte] = endDate;
        }
      }

      const { count, rows } = await TenantLog.findAndCountAll({
        where,
        order: [['createdAt', 'DESC']],
        limit: parseInt(limit),
        offset: (parseInt(page) - 1) * parseInt(limit),
        ...options
      });

      return {
        logs: rows,
        pagination: {
          total: count,
          page: parseInt(page),
          limit: parseInt(limit),
          pages: Math.ceil(count / limit)
        }
      };
    } catch (error) {
      logger.error(`[TenantLogRepository->findByCompanyId] Error: ${error.message}`);
      throw error;
    }
  },

  async countByCompany(company_id, options = {}) {
    try {
      return await TenantLog.count({
        where: { company_id },
        ...options
      });
    } catch (error) {
      logger.error(`[TenantLogRepository->countByCompany] Error: ${error.message}`);
      throw error;
    }
  },

  async getStatsByModule(company_id, options = {}) {
    try {
      const { sequelize } = require('../models');
      const stats = await TenantLog.findAll({
        where: { company_id },
        attributes: [
          'module',
          [sequelize.fn('COUNT', sequelize.col('id')), 'count'],
          [sequelize.fn('SUM', sequelize.literal("CASE WHEN result = 'error' THEN 1 ELSE 0 END")), 'errors'],
          [sequelize.fn('SUM', sequelize.literal("CASE WHEN result = 'success' THEN 1 ELSE 0 END")), 'success']
        ],
        group: ['module'],
        ...options
      });

      return stats.map(stat => ({
        module: stat.module,
        total: parseInt(stat.get('count')),
        errors: parseInt(stat.get('errors') || 0),
        success: parseInt(stat.get('success') || 0)
      }));
    } catch (error) {
      logger.error(`[TenantLogRepository->getStatsByModule] Error: ${error.message}`);
      throw error;
    }
  },

  async getRecentSuccess(company_id, limit = 10, options = {}) {
    try {
      return await TenantLog.findAll({
        where: { 
          company_id,
          result: 'success'
        },
        order: [['createdAt', 'DESC']],
        limit: parseInt(limit),
        ...options
      });
    } catch (error) {
      logger.error(`[TenantLogRepository->getRecentSuccess] Error: ${error.message}`);
      throw error;
    }
  },

  async getRecentErrors(company_id, limit = 10, options = {}) {
    try {
      return await TenantLog.findAll({
        where: { 
          company_id,
          result: 'error'
        },
        order: [['createdAt', 'DESC']],
        limit: parseInt(limit),
        ...options
      });
    } catch (error) {
      logger.error(`[TenantLogRepository->getRecentErrors] Error: ${error.message}`);
      throw error;
    }
  }
};

module.exports = TenantLogRepository;