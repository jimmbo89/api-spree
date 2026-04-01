const { MarketplaceOrder } = require('../models');
const { Op } = require('sequelize');
const logger = require('../../config/logger');

const MarketplaceOrderRepository = {
  /**
   * Crea o actualiza una orden de marketplace (upsert)
   * @param {Object} data - Datos de la orden
   * @param {Object} options - Opciones de Sequelize
   * @returns {Promise<Object>} Orden creada/actualizada
   */
  async upsert(data, options = {}) {
    try {
      const { marketplace, marketplace_order_id, ...updateData } = data;
      
      const [record, created] = await MarketplaceOrder.findOrCreate({
        where: {
          marketplace,
          marketplace_order_id
        },
        defaults: updateData,
        ...options
      });

      if (!created) {
        await record.update(updateData, options);
      }

      return { record, created };
    } catch (error) {
      logger.error('[MarketplaceOrderRepository] Error en upsert:', error.message);
      throw error;
    }
  },

  /**
   * Crea una nueva orden
   * @param {Object} data - Datos de la orden
   * @param {Object} options - Opciones de Sequelize
   * @returns {Promise<Object>} Orden creada
   */
  async create(data, options = {}) {
    try {
      const record = await MarketplaceOrder.create(data, options);
      return record;
    } catch (error) {
      logger.error('[MarketplaceOrderRepository] Error en create:', error.message);
      throw error;
    }
  },

  /**
   * Busca una orden por ID de marketplace
   * @param {String} marketplace - Nombre del marketplace
   * @param {String} marketplaceOrderId - ID de la orden en el marketplace
   * @returns {Promise<MarketplaceOrder|null>}
   */
  async findByMarketplaceOrderId(marketplace, marketplaceOrderId) {
    return await MarketplaceOrder.findOne({
      where: { marketplace, marketplace_order_id: marketplaceOrderId }
    });
  },

  /**
   * Busca una orden por ID local
   * @param {Number} id - ID local de la orden
   * @returns {Promise<MarketplaceOrder|null>}
   */
  async findById(id) {
    return await MarketplaceOrder.findByPk(id, {
      include: [
        { association: 'items' },
        { association: 'fees' },
        { association: 'events' }
      ]
    });
  },

  /**
   * Actualiza una orden por ID
   * @param {Number} id - ID de la orden
   * @param {Object} data - Datos a actualizar
   * @param {Object} options - Opciones de Sequelize
   * @returns {Promise<Array>} Resultado del update
   */
  async updateById(id, data, options = {}) {
    try {
      return await MarketplaceOrder.update(data, {
        where: { id },
        ...options
      });
    } catch (error) {
      logger.error('[MarketplaceOrderRepository] Error en update:', error.message);
      throw error;
    }
  },

  /**
   * Lista órdenes con filtros
   * @param {Object} filters - Filtros de búsqueda
   * @param {Object} pagination - Paginación (limit, offset)
   * @returns {Promise<Object>} { rows, count }
   */
  async findAndCountAll({ filters = {}, pagination = {} } = {}) {
    try {
      const {
        marketplace,
        order_status,
        payment_status,
        company_id,
        user_id,
        from,
        to
      } = filters;

      const { limit = 50, offset = 0 } = pagination;

      const where = {};
      if (marketplace) where.marketplace = marketplace;
      if (order_status) where.order_status = order_status;
      if (payment_status) where.payment_status = payment_status;
      if (company_id) where.company_id = company_id;
      if (user_id) where.user_id = user_id;
      if (from || to) {
        where.createdAt = {};
        if (from) where.createdAt[Op.gte] = new Date(from);
        if (to) where.createdAt[Op.lte] = new Date(to);
      }

      const result = await MarketplaceOrder.findAndCountAll({
        where,
        limit,
        offset,
        order: [['createdAt', 'DESC']],
        include: [
          { association: 'items', limit: 10 },
          { association: 'company' },
          { association: 'user', attributes: ['id', 'name', 'email'] }
        ]
      });

      return result;
    } catch (error) {
      logger.error('[MarketplaceOrderRepository] Error en findAndCountAll:', error.message);
      throw error;
    }
  },

  /**
   * Obtiene estadísticas de ventas
   * @param {Object} filters - Filtros de búsqueda
   * @returns {Promise<Object>} Estadísticas
   */
  async getSalesStats({ filters = {} } = {}) {
    try {
      const {
        marketplace,
        company_id,
        user_id,
        from,
        to
      } = filters;

      const where = {
        order_status: 'paid'
      };
      if (marketplace) where.marketplace = marketplace;
      if (company_id) where.company_id = company_id;
      if (user_id) where.user_id = user_id;
      if (from || to) {
        where.createdAt = {};
        if (from) where.createdAt[Op.gte] = new Date(from);
        if (to) where.createdAt[Op.lte] = new Date(to);
      }

      const result = await MarketplaceOrder.findOne({
        where,
        attributes: [
          [sequelize.fn('COUNT', sequelize.col('id')), 'total_orders'],
          [sequelize.fn('SUM', sequelize.col('total_amount')), 'total_revenue'],
          [sequelize.fn('SUM', sequelize.col('subtotal')), 'total_subtotal'],
          [sequelize.fn('SUM', sequelize.col('shipping_total')), 'total_shipping'],
          [sequelize.fn('SUM', sequelize.col('tax_total')), 'total_tax']
        ],
        raw: true
      });

      return result;
    } catch (error) {
      logger.error('[MarketplaceOrderRepository] Error en getSalesStats:', error.message);
      throw error;
    }
  }
};

module.exports = MarketplaceOrderRepository;
