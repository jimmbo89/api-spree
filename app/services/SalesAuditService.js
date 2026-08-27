const AuditEventService = require('./AuditEventService');
const { detectChanges } = require('../util/auditUtils');

function toPlain(record) {
  if (!record) return null;
  return typeof record.get === 'function' ? record.get({ plain: true }) : record;
}

function parseJsonMaybe(value) {
  if (!value) return value;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    return value;
  }
}

function redactSensitive(value) {
  const parsed = parseJsonMaybe(value);

  if (Array.isArray(parsed)) {
    return parsed.map((item) => redactSensitive(item));
  }

  if (parsed && typeof parsed === 'object') {
    return Object.keys(parsed).reduce((safe, key) => {
      const normalizedKey = String(key).toLowerCase();
      if (
        normalizedKey.includes('token') ||
        normalizedKey.includes('secret') ||
        normalizedKey.includes('password') ||
        normalizedKey.includes('authorization')
      ) {
        safe[key] = '[REDACTED]';
      } else if (
        normalizedKey.includes('document') ||
        normalizedKey.includes('email') ||
        normalizedKey.includes('address')
      ) {
        safe[key] = parsed[key] ? '[PROTECTED]' : parsed[key];
      } else {
        safe[key] = redactSensitive(parsed[key]);
      }
      return safe;
    }, {});
  }

  return parsed;
}

function getMarketplaceName(order, marketplace = null) {
  return marketplace?.name || marketplace?.domain || order?.credential?.marketplace?.name || order?.marketplace || 'Marketplace';
}

function buildOrderLabel(order) {
  const plain = toPlain(order) || {};
  const marketplaceName = getMarketplaceName(plain);
  if (marketplaceName && plain.marketplace_order_id) {
    return `Venta en ${marketplaceName} / ${plain.marketplace_order_id}`;
  }

  return marketplaceName || `Venta ${plain.id}`;
}

function buildOrderSnapshot(order) {
  const plain = toPlain(order) || {};
  return {
    id: plain.id,
    marketplace: plain.marketplace,
    marketplace_order_id: plain.marketplace_order_id,
    order_status: plain.order_status,
    payment_status: plain.payment_status,
    total_amount: plain.total_amount,
    currency: plain.currency,
    marketplace_credential_id: plain.marketplace_credential_id,
    company_id: plain.company_id,
    branch_id: plain.branch_id
  };
}

function buildOrderAuditPayload(order, data = {}) {
  const plain = toPlain(order) || {};
  return {
    company_id: data.company_id || plain.company_id,
    module: 'sales',
    resource_type: 'marketplace_order',
    resource_id: plain.id,
    resource_label: buildOrderLabel(plain),
    marketplace_credential_id: data.marketplace_credential_id || plain.marketplace_credential_id,
    branch_id: data.branch_id || plain.branch_id,
    ...data
  };
}

const SalesAuditService = {
  redactSensitive,
  buildOrderSnapshot,

  async recordMarketplaceEvent(marketplace, order, action, data = {}) {
    const actor = AuditEventService.marketplaceActor(marketplace || { name: getMarketplaceName(order) });
    return AuditEventService.safeRecord({
      ...actor,
      ...buildOrderAuditPayload(order, {
        ...data,
        action,
        result: data.result || 'success',
        marketplace_id: data.marketplace_id || marketplace?.id || order?.credential?.marketplace_id || null,
        metadata: {
          source: 'marketplace',
          marketplace_name: getMarketplaceName(order, marketplace),
          marketplace_order_id: order?.marketplace_order_id,
          ...redactSensitive(data.metadata || {})
        },
        previous_value: redactSensitive(data.previous_value),
        new_value: redactSensitive(data.new_value),
        changes: redactSensitive(data.changes)
      })
    });
  },

  async recordSystemEvent(order, action, data = {}) {
    return AuditEventService.safeRecord({
      ...AuditEventService.systemActor('Spree'),
      ...buildOrderAuditPayload(order, {
        ...data,
        action,
        result: data.result || 'success',
        metadata: {
          source: 'spree',
          marketplace_order_id: order?.marketplace_order_id,
          ...redactSensitive(data.metadata || {})
        },
        previous_value: redactSensitive(data.previous_value),
        new_value: redactSensitive(data.new_value),
        changes: redactSensitive(data.changes)
      })
    });
  },

  async recordFromRequest(req, order, action, data = {}) {
    return AuditEventService.safeRecordFromRequest(req, buildOrderAuditPayload(order, {
      ...data,
      action,
      result: data.result || 'success',
      metadata: {
        source: 'spree',
        marketplace_order_id: order?.marketplace_order_id,
        ...redactSensitive(data.metadata || {})
      },
      previous_value: redactSensitive(data.previous_value),
      new_value: redactSensitive(data.new_value),
      changes: redactSensitive(data.changes)
    }));
  },

  getOrderChanges(previousOrder, nextOrder) {
    return detectChanges(
      buildOrderSnapshot(previousOrder),
      buildOrderSnapshot(nextOrder),
      ['order_status', 'payment_status', 'total_amount', 'currency']
    );
  },

  changesToValueSnapshot(changes, valueKey) {
    return changes.reduce((snapshot, change) => {
      snapshot[change.field] = change[valueKey];
      return snapshot;
    }, {});
  }
};

module.exports = SalesAuditService;
