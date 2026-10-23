'use strict';

const { Op } = require('sequelize');
const { MarketplaceImportOperation, MarketplaceImportItem } = require('../models');

const TERMINAL_STATUSES = ['completed', 'completed_with_errors', 'failed', 'cancelled'];

const MarketplaceImportRepository = {
  async createOperation(values) {
    return MarketplaceImportOperation.create(values);
  },

  async findOperation(id) {
    return MarketplaceImportOperation.findByPk(id);
  },

  async updateOperation(id, values) {
    await MarketplaceImportOperation.update(values, { where: { id } });
    return this.findOperation(id);
  },

  async requestCancel(id) {
    await MarketplaceImportOperation.update(
      { cancel_requested: true },
      { where: { id, status: { [Op.notIn]: TERMINAL_STATUSES } } }
    );
    return this.findOperation(id);
  },

  async claimNext(workerId, leaseMs) {
    const now = new Date();
    const candidate = await MarketplaceImportOperation.findOne({
      where: {
        [Op.or]: [
          { status: 'queued' },
          { status: 'processing', lease_until: { [Op.lt]: now } }
        ]
      },
      order: [['createdAt', 'ASC']]
    });
    if (!candidate) return null;

    const [updated] = await MarketplaceImportOperation.update({
      status: 'processing',
      phase: candidate.status === 'queued' ? 'processing' : candidate.phase,
      worker_id: workerId,
      lease_until: new Date(Date.now() + leaseMs),
      started_at: candidate.started_at || now
    }, {
      where: {
        id: candidate.id,
        [Op.or]: [
          { status: 'queued' },
          { status: 'processing', lease_until: { [Op.lt]: now } }
        ]
      }
    });

    return updated === 1 ? this.findOperation(candidate.id) : null;
  },

  async createItems(items) {
    return MarketplaceImportItem.bulkCreate(items, { validate: true });
  },

  async findItem({ operationId, itemId }) {
    return MarketplaceImportItem.findOne({ where: { id: itemId, operation_id: operationId } });
  },

  async updateItem({ operationId, itemId, values }) {
    await MarketplaceImportItem.update(values, { where: { id: itemId, operation_id: operationId } });
    return this.findItem({ operationId, itemId });
  },

  async resetProcessingItems(operationId) {
    return MarketplaceImportItem.update(
      { status: 'queued', started_at: null },
      { where: { operation_id: operationId, status: 'processing' } }
    );
  },

  async listQueuedItems(operationId) {
    return MarketplaceImportItem.findAll({
      where: { operation_id: operationId, status: { [Op.in]: ['queued', 'processing'] } },
      order: [['id', 'ASC']]
    });
  },

  async listItems({ operationId, cursor = null, limit = 100 }) {
    const normalizedLimit = Math.min(Math.max(Number(limit) || 100, 1), 100);
    const where = { operation_id: operationId };
    if (cursor !== null && cursor !== undefined && cursor !== '') {
      where.id = { [Op.lt]: Number(cursor) };
    }
    const rows = await MarketplaceImportItem.findAll({
      where,
      order: [['id', 'DESC']],
      limit: normalizedLimit + 1
    });
    const hasMore = rows.length > normalizedLimit;
    const items = hasMore ? rows.slice(0, normalizedLimit) : rows;
    return {
      items,
      hasMore,
      nextCursor: items.length ? String(items[items.length - 1].id) : null
    };
  },

  async deleteExpired() {
    return MarketplaceImportOperation.destroy({
      where: { expires_at: { [Op.lt]: new Date() }, status: { [Op.not]: 'processing' } }
    });
  }
};

module.exports = MarketplaceImportRepository;
