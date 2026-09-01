const { AuditEvent, UserCompany } = require('../models');
const { Op } = require('sequelize');
const logger = require('../../config/logger');

function removeUndefinedValues(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)
  );
}

function hasWhereConditions(where = {}) {
  return Object.keys(where).length > 0 || Object.getOwnPropertySymbols(where).length > 0;
}

function normalizeDateBoundary(value, boundary) {
  if (!value) return null;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    if (boundary === 'start') date.setHours(0, 0, 0, 0);
    if (boundary === 'end') date.setHours(23, 59, 59, 999);
  }

  return date;
}

const AuditEventRepository = {
  async create(data, options = {}) {
    try {
      return await AuditEvent.create(removeUndefinedValues(data), options);
    } catch (error) {
      logger.error(`[AuditEventRepository->create] ${error.message}`);
      throw error;
    }
  },

  async findById(id, options = {}) {
    try {
      return await AuditEvent.findByPk(id, options);
    } catch (error) {
      logger.error(`[AuditEventRepository->findById] ${error.message}`);
      throw error;
    }
  },

  async findOneByDedupeKey(dedupeKey, options = {}) {
    if (!dedupeKey) return null;

    try {
      return await AuditEvent.findOne({
        where: { dedupe_key: dedupeKey },
        ...options
      });
    } catch (error) {
      logger.error(`[AuditEventRepository->findOneByDedupeKey] ${error.message}`);
      throw error;
    }
  },

  async list(filters = {}, options = {}) {
    try {
      const {
        company_id,
        module,
        action,
        result,
        actor_type,
        actor_id,
        resource_type,
        resource_id,
        related_resource_type,
        related_resource_id,
        marketplace_id,
        marketplace_credential_id,
        pool_id,
        warehouse_id,
        branch_id,
        job_id,
        origin_job_id,
        correlation_id,
        cursor,
        start,
        end,
        date_from,
        date_to,
        limit = 100
      } = filters;

      const where = removeUndefinedValues({
        company_id,
        module,
        action,
        result,
        actor_type,
        actor_id: actor_id != null ? String(actor_id) : undefined,
        resource_type,
        resource_id: resource_id != null ? String(resource_id) : undefined,
        related_resource_type,
        related_resource_id: related_resource_id != null ? String(related_resource_id) : undefined,
        marketplace_id,
        marketplace_credential_id,
        pool_id,
        warehouse_id,
        branch_id,
        job_id,
        origin_job_id,
        correlation_id
      });

      // El historial individual usa contrato existente actor_type/actor_id.
      // Solo se amplía cuando no hay filtro de recurso explícito.
      const normalizedActorId = actor_id != null && actor_id !== ''
        ? String(actor_id)
        : null;
      const isUserHistoryQuery = actor_type === 'user'
        && normalizedActorId
        && [resource_type, resource_id, related_resource_type, related_resource_id]
          .every(value => value == null || value === '');

      if (isUserHistoryQuery) {
        const memberships = await UserCompany.findAll({
          where: {
            company_id,
            user_id: normalizedActorId
          },
          attributes: ['id'],
          raw: true
        });
        const membershipIds = memberships.map(membership => String(membership.id));

        where[Op.or] = [
          {
            actor_type: 'user',
            actor_id: normalizedActorId
          },
          {
            resource_type: 'user',
            resource_id: normalizedActorId
          },
          {
            related_resource_type: 'user',
            related_resource_id: normalizedActorId
          },
          ...(membershipIds.length > 0 ? [{
            resource_type: 'user_company',
            resource_id: { [Op.in]: membershipIds }
          }] : [])
        ];
        delete where.actor_type;
        delete where.actor_id;
      }

      const startDate = normalizeDateBoundary(start || date_from, 'start');
      const endDate = normalizeDateBoundary(end || date_to, 'end');

      if (startDate || endDate) {
        where.occurred_at = {};
        if (startDate) where.occurred_at[Op.gte] = startDate;
        if (endDate) where.occurred_at[Op.lte] = endDate;
      }

      const normalizedLimit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 100);
      const normalizedCursor = cursor != null && cursor !== ''
        ? parseInt(cursor, 10)
        : null;
      const extraWhere = options.where || {};
      const queryOptions = { ...options };
      delete queryOptions.where;

      const andConditions = [];
      if (hasWhereConditions(where)) andConditions.push(where);
      if (hasWhereConditions(extraWhere)) andConditions.push(extraWhere);
      if (Number.isFinite(normalizedCursor) && normalizedCursor > 0) {
        andConditions.push({ id: { [Op.lt]: normalizedCursor } });
      }

      const rows = await AuditEvent.findAll({
        where: andConditions.length > 1
          ? { [Op.and]: andConditions }
          : (andConditions[0] || {}),
        order: [['id', 'DESC']],
        limit: normalizedLimit + 1,
        ...queryOptions
      });

      const hasMore = rows.length > normalizedLimit;
      const events = hasMore ? rows.slice(0, normalizedLimit) : rows;
      const lastEvent = events[events.length - 1] || null;

      return {
        events,
        pagination: {
          limit: normalizedLimit,
          cursor: Number.isFinite(normalizedCursor) && normalizedCursor > 0 ? normalizedCursor : null,
          next_cursor: hasMore && lastEvent ? lastEvent.id : null,
          has_more: hasMore,
          order: 'id_desc'
        }
      };
    } catch (error) {
      logger.error(`[AuditEventRepository->list] ${error.message}`);
      throw error;
    }
  }
};

module.exports = AuditEventRepository;
