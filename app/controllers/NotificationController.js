const logger = require("../../config/logger");
const { NotificationRepository, CompanyRepository, UserRepository } = require("../repositories");
const { sequelize } = require('../models');
const { getUserId } = require("../../config/context");

const NotificationController = {
  async index(req, res) {
    try {
      const { user_id, company_id, status, search, page, limit } = req.body;
      const result = await NotificationRepository.findFiltered({ user_id, company_id, status, search, page, limit });
      return res.status(200).json({ success: true, ...result });
    } catch (err) {
      logger.error("NotificationController->index: " + err.message);
      return res.status(500).json({ success: false, message: "Error interno del servidor", details: err.message });
    }
  },

async getUserNotifications(req, res) {
  //logger.info(`${req.user?.name || 'Anonymous'} - Obteniendo notificaciones`);

  try {

    const { limit = 10, cursor, company_id, user_id: bodyUserId } = req.body;
    const user_id = bodyUserId || getUserId();

    // Si se envía company_id, validamos que exista (opcional pero recomendado)
    if (company_id !== undefined) {
      const company = await CompanyRepository.findById(company_id);
      if (!company) {
        return res.status(404).json({ success: false, message: "Compañía no encontrada" });
      }
    }

    const result = await NotificationRepository.getUserNotifications({
      user_id: user_id,
      company_id,
      limit,
      cursor
    });

    return res.status(200).json({
      success: true,
      notifications: result.notifications,
      hasMore: result.hasMore,
      nextCursor: result.nextCursor
    });
  } catch (error) {
    logger.error("NotificationController->getUserNotifications: " + error.message);
    return res.status(500).json({
      success: false,
      message: "Error al obtener notificaciones",
      details: error.message
    });
  }
},

  async show(req, res) {
    try {
      const notification = await NotificationRepository.findById(req.body.id);
      if (!notification) return res.status(404).json({ success: false, message: "Notificación no encontrada" });
      return res.status(200).json({ success: true, notification });
    } catch (err) {
      logger.error("NotificationController->show: " + err.message);
      return res.status(500).json({ success: false, message: "Error interno del servidor", details: err.message });
    }
  },

  async store(req, res) {
    logger.info(`${req.user?.user || 'Anonymous'} - Crea notificación`);
    logger.info(`'Datos recibidos:', ${JSON.stringify(req.body)}`);

    const { title, description, type, data, status, firebaseId, company_id, user_id: bodyUserId } = req.body;
    const user_id = bodyUserId || getUserId();

    // Validar existencia de compañía y usuario
    const company = await CompanyRepository.findById(company_id);
    if (!company) {
      return res.status(404).json({ success: false, message: "Compañía no encontrada" });
    }

    const user = await UserRepository.findById(user_id);
    if (!user) {
      return res.status(404).json({ success: false, message: "Usuario no encontrado" });
    }

    const t = await sequelize.transaction();
    try {
      const notification = await NotificationRepository.create({
        title, description, type, data, status, firebaseId, user_id, company_id
      }, t);
      await t.commit();

      return res.status(201).json({
        success: true,
        notification: {
          id: notification.id,
          title: notification.title,
          description: notification.description,
          type: notification.type,
          data: notification.data,
          status: notification.status,
          firebaseId: notification.firebaseId,
          user_id: notification.user_id,
          company_id: notification.company_id,
          createdAt: notification.createdAt
        },
        message: "Notificación creada correctamente"
      });
    } catch (err) {
      await t.rollback();
      logger.error("NotificationController->store: " + err.message);
      return res.status(500).json({ success: false, message: "Error al crear notificación", details: err.message });
    }
  },

  async update(req, res) {
    logger.info(`${req.user?.user || 'Anonymous'} - Edita notificación ${req.body.id}`);
    logger.info(`'Datos recibidos:', ${JSON.stringify(req.body)}`);
    const { id, title, description, type, data, status, firebaseId } = req.body;

    try {
      const notification = await NotificationRepository.findById(id);
      if (!notification) return res.status(404).json({ success: false, message: "Notificación no encontrada" });

      const t = await sequelize.transaction();
      try {
        const updated = await NotificationRepository.update(notification, { title, description, type, data, status, firebaseId }, t);
        await t.commit();

        return res.status(200).json({
          success: true,
          notification: updated,
          message: "Notificación actualizada correctamente"
        });
      } catch (err) {
        await t.rollback();
        throw err;
      }
    } catch (err) {
      logger.error("NotificationController->update: " + err.message);
      return res.status(500).json({ success: false, message: "Error al actualizar notificación", details: err.message });
    }
  },

  async destroy(req, res) {
    logger.info(`${req.user?.user || 'Anonymous'} - elimina notificación ${req.body.id}`);
    logger.info(`'Datos recibidos:', ${JSON.stringify(req.body)}`);
    try {
      const notification = await NotificationRepository.findById(req.body.id);
      if (!notification) return res.status(404).json({ success: false, message: "Notificación no encontrada" });
      await NotificationRepository.delete(notification);
      return res.status(200).json({ success: true, message: "Notificación eliminada" });
    } catch (err) {
      logger.error("NotificationController->destroy: " + err.message);
      return res.status(500).json({ success: false, message: "Error al eliminar notificación", details: err.message });
    }
  },

  // Acción adicional: marcar como leída
  async markAsRead(req, res) {
    logger.info(`${req.user?.user || 'Anonymous'} - Edita estado de las notificaciones ${req.body.ids}`);
    logger.info(`'Datos recibidos:', ${JSON.stringify(req.body)}`);
    const { ids, company_id, status, user_id: bodyUserId } = req.body;
    const user_id = bodyUserId || getUserId();

    const allExist = await NotificationRepository.allExistForUser(ids, user_id);
    if (!allExist) {
    return res.status(404).json({
        success: false,
        message: "Una o más notificaciones no existen o no pertenecen al usuario"
    });
    }

     if (company_id !== undefined) {
      const company = await CompanyRepository.findById(company_id);
      if (!company) {
        return res.status(404).json({ success: false, message: "Compañía no encontrada" });
      }
    }

    try {
      const success = await NotificationRepository.markAsRead(user_id, ids, status);
      if (!success) {
        return res.status(404).json({ success: false, message: "Notificación no encontrada o no pertenece al usuario" });
      }
          const result = await NotificationRepository.getUserNotifications({
      user_id: user_id,
      company_id,
      limit: 10,
      cursor: null
    });
      return res.status(200).json({ success: true, message: "Notificación marcada como leída", notifications: result.notifications,
      hasMore: result.hasMore,
      nextCursor: result.nextCursor });
    } catch (err) {
      logger.error("NotificationController->markAsRead: " + err.message);
      return res.status(500).json({ success: false, message: "Error al marcar notificación", details: err.message });
    }
  },

  async getUnreadCount(req, res) {
  try {
    const user_id = req.user?.id;
    const company_id = req.user?.company_id || req.query.company_id;
    
    if (!user_id) {
      return res.status(401).json({ success: false, msg: 'unauthorized' });
    }
    
    const count = await NotificationRepository.getUnreadCount({
      user_id,
      company_id
    });
    
    return res.json({
      success: true,
       data: {
        unread_count: count,
        timestamp: new Date().toISOString()
      }
    });
    
  } catch (error) {
    logger.error('[NotificationController.getUnreadCount] Error:', error.message);
    return res.status(500).json({
      success: false,
      msg: 'count_fetch_failed',
      error: error.message
    });
  }
},
};

module.exports = NotificationController;