const { MarketplaceOrderItem } = require('../models');
const logger = require('../../config/logger');

const MarketplaceOrderItemRepository = {
  /**
   * Crea un nuevo item de orden
   * @param {Object} data - Datos del item
   * @param {Object} options - Opciones de Sequelize
   * @returns {Promise<Object>} Item creado
   */
  async create(data, options = {}) {
    try {
      const record = await MarketplaceOrderItem.create(data, options);
      return record;
    } catch (error) {
      logger.error('[MarketplaceOrderItemRepository] Error en create:', error.message);
      throw error;
    }
  },

  /**
   * Crea múltiples items de orden
   * @param {Array} items - Lista de items a crear
   * @param {Object} options - Opciones de Sequelize
   * @returns {Promise<Array>} Items creados
   */
  async bulkCreate(items, options = {}) {
    try {
      const records = await MarketplaceOrderItem.bulkCreate(items, options);
      return records;
    } catch (error) {
      logger.error('[MarketplaceOrderItemRepository] Error en bulkCreate:', error.message);
      throw error;
    }
  },

  /**
   * Busca items por orden
   * @param {Number} orderId - ID de la orden
   * @returns {Promise<Array>} Lista de items
   */
  async findByOrderId(orderId) {
    return await MarketplaceOrderItem.findAll({
      where: { order_id: orderId },
      include: [
        { association: 'product' },
        { association: 'variant' },
        { association: 'inventoryMovement' }
      ]
    });
  },

  /**
   * Busca un item por ID
   * @param {Number} id - ID del item
   * @returns {Promise<MarketplaceOrderItem|null>}
   */
  async findById(id) {
    return await MarketplaceOrderItem.findByPk(id, {
      include: [
        { association: 'order' },
        { association: 'product' },
        { association: 'variant' }
      ]
    });
  },

  /**
   * Actualiza un item por ID
   * @param {Number} id - ID del item
   * @param {Object} data - Datos a actualizar
   * @param {Object} options - Opciones de Sequelize
   * @returns {Promise<Array>} Resultado del update
   */
  async updateById(id, data, options = {}) {
    try {
      return await MarketplaceOrderItem.update(data, {
        where: { id },
        ...options
      });
    } catch (error) {
      logger.error('[MarketplaceOrderItemRepository] Error en update:', error.message);
      throw error;
    }
  },

  /**
   * Busca items por producto
   * @param {Number} productId - ID del producto
   * @param {Object} filters - Filtros adicionales
   * @returns {Promise<Array>} Lista de items
   */
  async findByProductId(productId, filters = {}) {
    const { from, to, marketplace } = filters;
    const where = { product_id: productId };

    const include = [{
      association: 'order',
      where: {}
    }];

    if (marketplace) {
      include[0].where.marketplace = marketplace;
    }
    if (from || to) {
      include[0].where.createdAt = {};
      if (from) include[0].where.createdAt[Op.gte] = new Date(from);
      if (to) include[0].where.createdAt[Op.lte] = new Date(to);
    }

    return await MarketplaceOrderItem.findAll({
      where,
      include
    });
  },

  /**
   * Busca items por listing ID
   * @param {String} listingId - ID del listing en el marketplace
   * @returns {Promise<MarketplaceOrderItem|null>}
   */
  async findByListingId(listingId) {
    return await MarketplaceOrderItem.findOne({
      where: { listing_id: listingId },
      include: [{ association: 'order' }]
    });
  }
};

module.exports = MarketplaceOrderItemRepository;
