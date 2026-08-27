const logger = require('../../config/logger');
const { AuditEventRepository } = require('../repositories');
const { getRequestMetadata } = require('../util/requestUtil');
const { normalizeAuditValue } = require('../util/auditUtils');

const ACTOR_TYPES = Object.freeze({
  USER: 'user',
  SYSTEM: 'system',
  MARKETPLACE: 'marketplace',
  AUTOMATIC_PROCESS: 'automatic_process',
  EXTERNAL_INTEGRATION: 'external_integration'
});

const JOB_TYPE_LABELS = Object.freeze({
  draft: 'borrador',
  publish: 'publicación',
  sync: 'sincronización',
  processing: 'procesamiento',
  manual: 'manual',
  quick: 'rápido',
  advanced: 'avanzado',
  republish: 'republicación'
});

const RESULTS = Object.freeze({
  SUCCESS: 'success',
  ERROR: 'error',
  WARNING: 'warning',
  PENDING: 'pending'
});

function normalizeId(value) {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

function resolveActorFromRequest(req) {
  if (!req?.user) {
    return {
      actor_type: ACTOR_TYPES.SYSTEM,
      actor_id: null,
      actor_name: 'Spree'
    };
  }

  return {
    actor_type: ACTOR_TYPES.USER,
    actor_id: normalizeId(req.user.id),
    actor_name: req.user.name || req.user.email || `Usuario ${req.user.id}`
  };
}

const AuditEventService = {
  ACTOR_TYPES,
  RESULTS,

  actorFromRequest: resolveActorFromRequest,

  systemActor(name = 'Spree') {
    return {
      actor_type: ACTOR_TYPES.SYSTEM,
      actor_id: null,
      actor_name: name
    };
  },

  marketplaceActor(marketplace) {
    return {
      actor_type: ACTOR_TYPES.MARKETPLACE,
      actor_id: normalizeId(marketplace?.id),
      actor_name: marketplace?.name || marketplace?.type || marketplace?.domain || 'Marketplace'
    };
  },

  automaticProcessActor(job) {
    const jobTypeLabel = JOB_TYPE_LABELS[String(job?.job_type || '').toLowerCase()] || 'proceso automático';
    return {
      actor_type: ACTOR_TYPES.AUTOMATIC_PROCESS,
      actor_id: normalizeId(job?.id),
      actor_name: job?.id ? `Proceso de ${jobTypeLabel} #${job.id}` : 'Proceso automático'
    };
  },

  async record(eventData, options = {}) {
    const payload = {
      occurred_at: eventData.occurred_at || new Date(),
      result: RESULTS.SUCCESS,
      ...eventData,
      actor_id: normalizeId(eventData.actor_id),
      resource_id: normalizeId(eventData.resource_id),
      related_resource_id: normalizeId(eventData.related_resource_id),
      previous_value: normalizeAuditValue(eventData.previous_value),
      new_value: normalizeAuditValue(eventData.new_value),
      changes: normalizeAuditValue(eventData.changes),
      metadata: normalizeAuditValue(eventData.metadata)
    };

    if (payload.dedupe_key) {
      const existing = await AuditEventRepository.findOneByDedupeKey(payload.dedupe_key, options);
      if (existing) return existing;
    }

    return AuditEventRepository.create(payload, options);
  },

  async recordFromRequest(req, eventData, options = {}) {
    const metadata = getRequestMetadata(req);
    const actor = eventData.actor_type ? {} : resolveActorFromRequest(req);

    return this.record({
      ...actor,
      ip_address: metadata.ip_address,
      user_agent: metadata.user_agent,
      ...eventData
    }, options);
  },

  async safeRecord(eventData, options = {}) {
    try {
      return await this.record(eventData, options);
    } catch (error) {
      logger.error(`[AuditEventService->safeRecord] ${error.message}`);
      return null;
    }
  },

  async safeRecordFromRequest(req, eventData, options = {}) {
    try {
      return await this.recordFromRequest(req, eventData, options);
    } catch (error) {
      logger.error(`[AuditEventService->safeRecordFromRequest] ${error.message}`);
      return null;
    }
  }
};

module.exports = AuditEventService;
