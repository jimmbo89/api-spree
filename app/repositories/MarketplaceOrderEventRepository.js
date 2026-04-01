const { MarketplaceOrderEvent } = require('../models');
const { Op } = require('sequelize');
const logger = require('../../config/logger');

const MarketplaceOrderEventRepository = {
  /**
   * Crea un nuevo evento de orden
   * @param {Object} data - Datos del evento
   * @param {Object} options - Opciones de Sequelize
   * @returns {Promise<Object>} Evento creado
   */
  async create(data, options = {}) {
    try {
      const record = await MarketplaceOrderEvent.create(data, options);
      return record;
    } catch (error) {
      logger.error('[MarketplaceOrderEventRepository] Error en create:', error.message);
      throw error;
    }
  },

  /**
   * Crea un evento de cambio de estado
   * @param {Number} orderId - ID de la orden
   * @param {String} eventType - Tipo de evento
   * @param {String} previousStatus - Estado anterior
   * @param {String} newStatus - Nuevo estado
   * @param {Object} payload - Payload del evento
   * @param {Object} options - Opciones de Sequelize
   * @returns {Promise<Object>} Evento creado
   */
  async createStatusChange(orderId, eventType, previousStatus, newStatus, payload = null, options = {}) {
    try {
      const record = await MarketplaceOrderEvent.create({
        order_id: orderId,
        event_type: eventType,
        previous_status: previousStatus,
        new_status: newStatus,
        raw_payload: payload,
        notes: `Cambio de estado: ${previousStatus} → ${newStatus}`,
        ...options
      });
      return record;
    } catch (error) {
      logger.error('[MarketplaceOrderEventRepository] Error en createStatusChange:', error.message);
      throw error;
    }
  },

  /**
   * Busca eventos por orden
   * @param {Number} orderId - ID de la orden
   * @returns {Promise<Array>} Lista de eventos
   */
  async findByOrderId(orderId) {
    return await MarketplaceOrderEvent.findAll({
      where: { order_id: orderId },
      order: [['createdAt', 'DESC']]
    });
  },

  /**
   * Busca eventos por tipo
   * @param {String} eventType - Tipo de evento
   * @param {Object} filters - Filtros adicionales
   * @returns {Promise<Array>} Lista de eventos
   */
  async findByEventType(eventType, filters = {}) {
    const { company_id, from, to } = filters;
    const where = { event_type: eventType };
    if (company_id) where.company_id = company_id;
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt[Op.gte] = new Date(from);
      if (to) where.createdAt[Op.lte] = new Date(to);
    }

    return await MarketplaceOrderEvent.findAll({
      where,
      order: [['createdAt', 'DESC']]
    });
  },

  /**
   * Busca un evento por ID
   * @param {Number} id - ID del evento
   * @returns {Promise<MarketplaceOrderEvent|null>}
   */
  async findById(id) {
    return await MarketplaceOrderEvent.findByPk(id, {
      include: [
        { association: 'order' },
        { association: 'webhookEvent' }
      ]
    });
  },

  /**
   * Obtiene el historial de estados de una orden
   * @param {Number} orderId - ID de la orden
   * @returns {Promise<Array>} Historial de estados
   */
  async getStatusHistory(orderId) {
    const events = await MarketplaceOrderEvent.findAll({
      where: { order_id: orderId },
      order: [['createdAt', 'ASC']],
      attributes: ['event_type', 'previous_status', 'new_status', 'createdAt']
    });

    return events.map(event => ({
      event_type: event.event_type,
      previous_status: event.previous_status,
      new_status: event.new_status,
      timestamp: event.createdAt
    }));
  }
};

module.exports = MarketplaceOrderEventRepository;
