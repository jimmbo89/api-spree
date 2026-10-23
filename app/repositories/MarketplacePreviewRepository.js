'use strict';

const { Op } = require('sequelize');
const { MarketplacePreviewOperation, MarketplacePreviewItem } = require('../models');

const TERMINAL_STATUSES = ['completed', 'completed_with_errors', 'failed', 'cancelled'];

const MarketplacePreviewRepository = {
  async createOperation(values) {
    return MarketplacePreviewOperation.create(values);
  },

  async findOperation(id) {
    return MarketplacePreviewOperation.findByPk(id);
  },

  async updateOperation(id, values) {
    await MarketplacePreviewOperation.update(values, { where: { id } });
    return this.findOperation(id);
  },

  async requestCancel(id) {
    await MarketplacePreviewOperation.update(
      { cancel_requested: true },
      { where: { id, status: { [Op.notIn]: TERMINAL_STATUSES } } }
    );
    return this.findOperation(id);
  },

  async claimNext(workerId, leaseMs) {
    const now = new Date();
    const candidate = await MarketplacePreviewOperation.findOne({
      where: {
        [Op.or]: [
          { status: 'queued' },
          { status: 'processing', lease_until: { [Op.lt]: now } }
        ]
      },
      order: [['createdAt', 'ASC']]
    });

    if (!candidate) return null;

    const leaseUntil = new Date(Date.now() + leaseMs);
    const [updated] = await MarketplacePreviewOperation.update({
      status: 'processing',
      phase: candidate.status === 'queued' ? 'enumerating' : candidate.phase,
      worker_id: workerId,
      lease_until: leaseUntil,
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

  async insertItems(items) {
    if (!items.length) return [];
    return MarketplacePreviewItem.bulkCreate(items, { validate: true });
  },

  async findItem({ operationId, itemId }) {
    return MarketplacePreviewItem.findOne({
      where: {
        id: itemId,
        operation_id: operationId
      }
    });
  },

  async updateItem({ operationId, itemId, values }) {
    await MarketplacePreviewItem.update(values, {
      where: {
        id: itemId,
        operation_id: operationId
      }
    });
    return this.findItem({ operationId, itemId });
  },

  async deleteItems(operationId) {
    return MarketplacePreviewItem.destroy({ where: { operation_id: operationId } });
  },

  async listItems({ operationId, cursor = null, limit = 100 }) {
    const normalizedLimit = Math.min(Math.max(Number(limit) || 100, 1), 100);
    const where = { operation_id: operationId };
    if (cursor !== null && cursor !== undefined && cursor !== '') {
      where.id = { [Op.lt]: Number(cursor) };
    }

    const rows = await MarketplacePreviewItem.findAll({
      where,
      order: [['id', 'DESC']],
      limit: normalizedLimit + 1
    });
    const hasMore = rows.length > normalizedLimit;
    const items = hasMore ? rows.slice(0, normalizedLimit) : rows;
    const nextCursor = items.length ? String(items[items.length - 1].id) : null;

    return { items, hasMore, nextCursor };
  },

  async deleteExpired() {
    return MarketplacePreviewOperation.destroy({
      where: {
        expires_at: { [Op.lt]: new Date() },
        status: { [Op.not]: 'processing' }
      }
    });
  }
};

module.exports = MarketplacePreviewRepository;
