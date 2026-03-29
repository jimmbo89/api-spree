const { MarketplaceWebhookEvent } = require('../models');
const logger = require('../../config/logger');

const MarketplaceWebhookEventRepository = {
  async createUnique(data, options = {}) {
    try {
      const record = await MarketplaceWebhookEvent.create(data, options);
      return { created: true, record };
    } catch (error) {
      if (error?.name === 'SequelizeUniqueConstraintError') {
        return { created: false, record: null };
      }
      logger.error('[REPO] ERROR al crear webhook event:', error.message);
      throw error;
    }
  },

  async updateById(id, data, options = {}) {
    return await MarketplaceWebhookEvent.update(data, {
      where: { id },
      ...options
    });
  },

  async findByMarketplaceAndExternalId(marketplace, externalId, statuses = null) {
    const where = {
      marketplace,
      external_id: String(externalId)
    };
    if (Array.isArray(statuses) && statuses.length > 0) {
      where.status = statuses;
    }

    return await MarketplaceWebhookEvent.findOne({
      where,
      order: [['createdAt', 'DESC']]
    });
  }
};

module.exports = MarketplaceWebhookEventRepository;
