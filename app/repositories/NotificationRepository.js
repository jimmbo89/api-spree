const { Notification, User, Company, sequelize } = require("../models");
const { Op } = require("sequelize");
const logger = require("../../config/logger");

const NotificationRepository = {
  async findFiltered({ user_id, company_id, status, search, page = 1, limit = 20 }) {
    const offset = (page - 1) * limit;
    const where = {};

    if (user_id !== undefined) where.user_id = user_id;
    if (company_id !== undefined) where.company_id = company_id;
    if (status !== undefined) where.status = status;
    if (search) {
      where[Op.or] = [
        { title: { [Op.iLike]: `%${search}%` } },
        { description: { [Op.iLike]: `%${search}%` } }
      ];
    }

    const { count, rows } = await Notification.findAndCountAll({
      where,
      attributes: ['id', 'title', 'description', 'type', 'data', 'status', 'firebaseId', 'user_id', 'company_id', 'createdAt', 'updatedAt'],
      order: [['createdAt', 'DESC']],
      limit,
      offset
    });

    return {
      notifications: rows.map(n => ({
        id: n.id,
        title: n.title,
        description: n.description,
        type: n.type,
        data: typeof n.data === 'string' ? JSON.parse(n.data || '{}') : n.data || {},
        status: n.status,
        firebaseId: n.firebaseId,
        user_id: n.user_id,
        company_id: n.company_id,
        createdAt: n.createdAt,
        updatedAt: n.updatedAt
      })),
      total: count,
      page,
      totalPages: Math.ceil(count / limit)
    };
  },

/**
 * Obtiene notificaciones del usuario con paginación por cursor y filtro opcional por compañía.
 * @param {Object} params
 * @param {number} params.userId - ID del usuario destinatario
 * @param {number} [params.company_id] - ID de compañía (opcional)
 * @param {number} [params.limit=10] - Cantidad máxima de notificaciones
 * @param {string|null} [params.cursor] - Cursor para paginación
 * @returns {Promise<{ notifications: Array, hasMore: boolean, nextCursor: string|null }>}
 */
async getUserNotifications({ user_id, company_id, limit = 10, cursor = null }) {
  logger.info(`"Datos recibidos reposiotry:", ${JSON.stringify({user_id, company_id, limit, cursor})}`);
  
  try {
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 100);

    const whereCondition = {
      user_id: user_id
    };

    if (company_id !== undefined) {
      whereCondition.company_id = company_id;
    }

    if (cursor) {
      whereCondition.createdAt = { [Op.lt]: new Date(cursor) };
    }

    // 👇 Incluir relaciones user y company
    const notifications = await Notification.findAll({
      where: whereCondition,
      attributes: [
        'id',
        'user_id',
        'company_id',
        'title',
        'description',
        'type',
        'data',
        'status',
        'createdAt'
      ],
      include: [
        {
          model: User,
          as: 'user',
          attributes: ['image'], // solo la imagen del usuario
          required: false, // left join
        },
        {
          model: Company,
          as: 'company',
          attributes: ['image'], // solo la imagen de la empresa
          required: false
        }
      ],
      order: [['createdAt', 'DESC']],
      limit: safeLimit + 1
    });

    const hasMore = notifications.length > safeLimit;
    if (hasMore) {
      notifications.pop();
    }

    const nextCursor = hasMore
      ? notifications[notifications.length - 1].createdAt.toISOString()
      : null;

    const mappedNotifications = notifications.map(notification => ({
      id: notification.id,
      user_id: notification.user_id,
      company_id: notification.company_id,
      title: notification.title,
      description: notification.description,
      type: notification.type,
      data: typeof notification.data === 'string'
        ? JSON.parse(notification.data || '{}')
        : notification.data || {},
      status: notification.status,
      createdAt: notification.createdAt.toISOString(),
      // 👇 Imágenes planas
      userImage: notification.user?.image || null,
      companyImage: notification.company?.image || null
    }));

    return { notifications: mappedNotifications, hasMore, nextCursor };
  } catch (error) {
    logger.error("Error en NotificationRepository->getUserNotifications:", error);
    throw error;
  }
},

  async findById(id) {
    return await Notification.findByPk(id);
  },

  /**
 * Verifica si todas las notificaciones con los IDs dados existen y pertenecen al usuario especificado.
 * @param {number[]} notificationIds - Array de IDs de notificaciones
 * @param {number} userId - ID del usuario propietario
 * @returns {Promise<boolean>} - true si todas existen y pertenecen al usuario, false en caso contrario
 */
async allExistForUser(notificationIds, userId) {

  const count = await Notification.count({
    where: {
      id: notificationIds,
      user_id: userId
    }
  });

  // Si el conteo coincide con la cantidad de IDs, todas existen y pertenecen al usuario
  return count === notificationIds.length;
},
  async create(body, options = {}) {
    try {
      const notificationData = {
        title: body.title,
        description: body.description || null,
        type: body.type,
        data: body.data || {},
        status: body.status !== undefined ? body.status : 0,
        firebaseId: body.firebaseId || null,
        user_id: body.user_id,
        company_id: body.company_id
      };

      const notification = await Notification.create(notificationData, options);
      logger.info(`Notificación creada para usuario ${body.user_id} (ID: ${notification.id})`);
      return notification;
    } catch (error) {
      logger.error("Error en NotificationRepository->create:", error);
      throw new Error(`Error al crear notificación: ${error.message}`);
    }
  },

  async update(notification, body, options = {}) {
    try {
      const fieldsToUpdate = ["title", "description", "type", "data", "status", "firebaseId"];
      const updatedData = {};

      for (const key of fieldsToUpdate) {
        if (body[key] !== undefined) updatedData[key] = body[key];
      }

      await notification.update(updatedData, options);
      logger.info(`Notificación actualizada (ID: ${notification.id})`);
      return notification;
    } catch (error) {
      logger.error(`Error en NotificationRepository->update (ID: ${notification.id}):`, error);
      throw new Error(`Error al actualizar notificación: ${error.message}`);
    }
  },

  async delete(notification, options = {}) {
    await notification.destroy(options);
    logger.info(`Notificación eliminada (ID: ${notification.id})`);
    return true;
  },

  // Marcar como vista o leída
/**
 * Marca múltiples notificaciones como vistas o leídas (status 1 o 2)
 * @param {number} userId - ID del usuario autenticado
 * @param {number[]} notificationIds - Array de IDs de notificaciones
 * @param {number} newStatus - Estado destino (1 = vista, 2 = leída)
 * @returns {Promise<number>} - Cantidad de notificaciones actualizadas
 */
async markAsRead(userId, notificationIds, newStatus = 2) {

  const [updatedCount] = await Notification.update(
    { status: newStatus },
    {
      where: {
        id: notificationIds,
        user_id: userId
      }
    }
  );

  logger.info(`Usuario ${userId} actualizó ${updatedCount} notificaciones a estado ${newStatus}`);
  return updatedCount;
},

/**
 * Crea la misma notificación para múltiples usuarios de una empresa.
 * @param {Object} params
 * @param {number} params.company_id - ID de la empresa
 * @param {number[]} params.user_ids - Lista de IDs de usuarios destinatarios
 * @param {string} params.title - Título de la notificación
 * @param {string} [params.description] - Descripción opcional
 * @param {Object} [params.data] - Datos adicionales (JSON)
 * @param {number} [params.status=0] - Estado inicial (0 = no leída)
 * @param {Object} [options={}] - Opciones de Sequelize (ej. transacción)
 * @returns {Promise<Array>} - Array de notificaciones creadas
 */
async createForMultipleUsers({ company_id, user_ids, title, description, type, data, status = 0 }, options = {}) {
  const notificationsToCreate = user_ids.map(user_id => ({
    company_id,
    user_id,
    title,
    description: description || null,
    type: type,
    data: data || {},
    status,
    createdAt: new Date(),
    updatedAt: new Date()
  }));

  try {
    const created = await Notification.bulkCreate(notificationsToCreate, {
      validate: true,
      ...options
    });

    logger.info(
      `Notificaciones masivas creadas: ${created.length} para compañía ${company_id}, usuarios: [${user_ids.join(', ')}]`
    );

    return created;
  } catch (error) {
    logger.error("Error en NotificationRepository->createForMultipleUsers:", error.message);
    throw new Error(`Error al crear notificaciones masivas: ${error.message}`);
  }
},

// src/repositories/NotificationRepository.js (agregar método)

async getUnreadCount({ user_id, company_id }) {
  try {
    const where = {
      user_id,
      status: 0  // 0 = no leída
    };
    if (company_id) {
      where.company_id = company_id;
    }
    
    const count = await Notification.count({ where });
    return count;
    
  } catch (error) {
    logger.error('[NotificationRepository.getUnreadCount] Error:', error.message);
    throw error;
  }
}
};

module.exports = NotificationRepository;