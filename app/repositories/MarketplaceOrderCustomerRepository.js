const { MarketplaceOrderCustomer } = require('../models');
const logger = require('../../config/logger');

const MarketplaceOrderCustomerRepository = {
  async upsertByOrderId(orderId, data, options = {}) {
    try {
      const [record, created] = await MarketplaceOrderCustomer.findOrCreate({
        where: { order_id: orderId },
        defaults: {
          order_id: orderId,
          ...data
        },
        ...options
      });

      if (!created) {
        await record.update(data, options);
      }

      return { record, created };
    } catch (error) {
      logger.error('[MarketplaceOrderCustomerRepository] Error en upsertByOrderId:', error.message);
      throw error;
    }
  }
};

module.exports = MarketplaceOrderCustomerRepository;
