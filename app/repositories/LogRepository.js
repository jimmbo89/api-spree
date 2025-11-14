'use strict';

const logger = require('../../config/logger');
const { Log, User, Role } = require('../models'); // Ajusta la ruta si es necesario
const { Op } = require('sequelize');

// Función auxiliar para formatear fecha a 'YYYY-MM-DD HH:mm:ss'
function formatDate(date) {
  if (!date) return null;
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const seconds = String(d.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

class LogRepository {
  async create(logData) {
    try {
      const log = await Log.create(logData);
      return log;
    } catch (error) {
      logger.error('Error al crear log:', error);
      throw error;
    }
  }

  async getLogsByDateRange({ startDate, endDate, user_id } = {}) {
    try {
      const now = new Date();
      const start = startDate
        ? new Date(startDate)
        : new Date(now.getFullYear(), now.getMonth(), now.getDate());

      const end = endDate
        ? new Date(new Date(endDate).setUTCHours(23, 59, 59, 999))
        : new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

      const where = {
        createdAt: {
          [Op.gte]: start,
          [Op.lte]: end
        }
      };

      if (user_id !== undefined && user_id !== null) {
        where.user_id = user_id;
      }

      const logs = await Log.findAll({
        where,
        include: [{
          model: User,
          as: 'user',
          attributes: ['name', 'user', 'image'],
          include: [{
            model: Role,
            as: 'role',
            attributes: ['name']
          }]
        }],
        order: [['createdAt', 'DESC']],
        raw: false
      });

      const plainLogs = logs.map(log => {
        const logData = log.get({ plain: true });

        return {
          id: logData.id,
          user_id: logData.user_id,
          action: logData.action,
          description: logData.description,
          ip_address: logData.ip_address,
          user_agent: logData.user_agent,
          status: logData.status,
          meta: logData.meta,

          // Formato de fecha local (sin UTC, sin 'T' ni 'Z')
          created_at: formatDate(logData.createdAt),

          // Datos planos del usuario
          user: logData.user?.user || null,
          name: logData.user?.name || null,
          image: logData.user?.image || null,
          role: logData.user?.role?.name || null
        };
      });

      return plainLogs;
    } catch (error) {
      logger.error('Error al obtener logs con datos de usuario:', error);
      throw error;
    }
  }
}

module.exports = new LogRepository();