const { MarketplaceOrderFee } = require('../models');
const { Op } = require('sequelize');
const logger = require('../../config/logger');

const MarketplaceOrderFeeRepository = {
  /**
   * Crea un nuevo fee de orden
   * @param {Object} data - Datos del fee
   * @param {Object} options - Opciones de Sequelize
   * @returns {Promise<Object>} Fee creado
   */
  async create(data, options = {}) {
    try {
      const record = await MarketplaceOrderFee.create(data, options);
      return record;
    } catch (error) {
      logger.error('[MarketplaceOrderFeeRepository] Error en create:', error.message);
      throw error;
    }
  },

  /**
   * Crea múltiples fees de orden
   * @param {Array} fees - Lista de fees a crear
   * @param {Object} options - Opciones de Sequelize
   * @returns {Promise<Array>} Fees creados
   */
  async bulkCreate(fees, options = {}) {
    try {
      const records = await MarketplaceOrderFee.bulkCreate(fees, options);
      return records;
    } catch (error) {
      logger.error('[MarketplaceOrderFeeRepository] Error en bulkCreate:', error.message);
      throw error;
    }
  },

  /**
   * Busca fees por orden
   * @param {Number} orderId - ID de la orden
   * @returns {Promise<Array>} Lista de fees
   */
  async findByOrderId(orderId) {
    return await MarketplaceOrderFee.findAll({
      where: { order_id: orderId }
    });
  },

  /**
   * Busca fees por item
   * @param {Number} orderItemId - ID del item
   * @returns {Promise<Array>} Lista de fees
   */
  async findByOrderItemId(orderItemId) {
    return await MarketplaceOrderFee.findAll({
      where: { order_item_id: orderItemId }
    });
  },

  /**
   * Busca un fee por ID
   * @param {Number} id - ID del fee
   * @returns {Promise<MarketplaceOrderFee|null>}
   */
  async findById(id) {
    return await MarketplaceOrderFee.findByPk(id);
  },

  /**
   * Actualiza un fee por ID
   * @param {Number} id - ID del fee
   * @param {Object} data - Datos a actualizar
   * @param {Object} options - Opciones de Sequelize
   * @returns {Promise<Array>} Resultado del update
   */
  async updateById(id, data, options = {}) {
    try {
      return await MarketplaceOrderFee.update(data, {
        where: { id },
        ...options
      });
    } catch (error) {
      logger.error('[MarketplaceOrderFeeRepository] Error en update:', error.message);
      throw error;
    }
  },

  /**
   * Actualiza el estado de los fees de una orden
   * @param {Number} orderId - ID de la orden
   * @param {String} status - Nuevo estado
   * @param {Date} payoutDate - Fecha de payout
   * @param {String} payoutReference - Referencia de payout
   * @returns {Promise<Array>} Resultado del update
   */
  async updateOrderFeesStatus(orderId, status, payoutDate = null, payoutReference = null) {
    try {
      const data = { status };
      if (payoutDate) data.payout_date = payoutDate;
      if (payoutReference) data.payout_reference = payoutReference;

      return await MarketplaceOrderFee.update(data, {
        where: { order_id: orderId }
      });
    } catch (error) {
      logger.error('[MarketplaceOrderFeeRepository] Error en updateOrderFeesStatus:', error.message);
      throw error;
    }
  },

  /**
   * Obtiene estadísticas de comisiones
   * @param {Object} filters - Filtros de búsqueda
   * @returns {Promise<Object>} Estadísticas
   */
  async getCommissionStats({ filters = {} } = {}) {
    try {
      const {
        marketplace,
        company_id,
        fee_type = 'commission',
        status,
        from,
        to
      } = filters;

      const where = { fee_type };
      if (status) where.status = status;
      if (company_id) where.company_id = company_id;

      const include = [];
      if (marketplace) {
        include.push({
          association: 'order',
          where: { marketplace }
        });
      }
      if (from || to) {
        if (!include.length) {
          include.push({ association: 'order', where: {} });
        }
        if (!include[0].where) include[0].where = {};
        if (from) include[0].where.createdAt[Op.gte] = new Date(from);
        if (to) include[0].where.createdAt[Op.lte] = new Date(to);
      }

      const result = await MarketplaceOrderFee.findOne({
        where,
        include,
        attributes: [
          [sequelize.fn('COUNT', sequelize.col('id')), 'total_fees'],
          [sequelize.fn('SUM', sequelize.col('amount')), 'total_amount'],
          [sequelize.fn('AVG', sequelize.col('percentage')), 'avg_percentage']
        ],
        raw: true,
        group: ['status']
      });

      return result;
    } catch (error) {
      logger.error('[MarketplaceOrderFeeRepository] Error en getCommissionStats:', error.message);
      throw error;
    }
  },

  /**
   * Lista fees con filtros
   * @param {Object} filters - Filtros de búsqueda
   * @param {Object} pagination - Paginación (limit, offset)
   * @returns {Promise<Object>} { rows, count }
   */
  async findAndCountAll({ filters = {}, pagination = {} } = {}) {
    try {
      const {
        company_id,
        fee_type,
        status,
        from,
        to
      } = filters;

      const { limit = 50, offset = 0 } = pagination;

      const where = {};
      if (company_id) where.company_id = company_id;
      if (fee_type) where.fee_type = fee_type;
      if (status) where.status = status;
      if (from || to) {
        where.createdAt = {};
        if (from) where.createdAt[Op.gte] = new Date(from);
        if (to) where.createdAt[Op.lte] = new Date(to);
      }

      const result = await MarketplaceOrderFee.findAndCountAll({
        where,
        limit,
        offset,
        order: [['createdAt', 'DESC']],
        include: [
          {
            association: 'order',
            attributes: ['id', 'marketplace', 'marketplace_order_id', 'marketplace_credential_id'],
            include: [
              {
                association: 'credential',
                include: [
                  { association: 'marketplace' }
                ]
              }
            ]
          }
        ]
      });

      return result;
    } catch (error) {
      logger.error('[MarketplaceOrderFeeRepository] Error en findAndCountAll:', error.message);
      throw error;
    }
  }
};

module.exports = MarketplaceOrderFeeRepository;
