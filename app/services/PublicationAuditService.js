const AuditEventService = require('./AuditEventService');
const { detectChanges, normalizeAuditValue } = require('../util/auditUtils');

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
        normalizedKey.includes('api_key') ||
        normalizedKey.includes('password')
      ) {
        safe[key] = '[REDACTED]';
      } else {
        safe[key] = redactSensitive(parsed[key]);
      }
      return safe;
    }, {});
  }

  return parsed;
}

function normalizeId(value) {
  if (value === null || value === undefined || value === '') return null;
  return Number.isFinite(Number(value)) ? Number(value) : String(value);
}

function uniqBy(items, keyBuilder) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyBuilder(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractProductsFromConfig(config = {}) {
  const parsed = parseJsonMaybe(config) || {};
  const products = Array.isArray(parsed.products) ? parsed.products : [];
  return uniqBy(products.map((product) => ({
    id: normalizeId(product.id || product.product_id),
    sku: product.sku || null,
    name: product.name || null
  })).filter((product) => product.id), (product) => String(product.id));
}

function extractMarketplacesFromConfig(config = {}) {
  const parsed = parseJsonMaybe(config) || {};
  const marketplaces = Array.isArray(parsed.marketplaces) ? parsed.marketplaces : [];
  return uniqBy(marketplaces.map((marketplace) => ({
    marketplace_id: normalizeId(marketplace.marketplace_id || marketplace.marketplace?.id || marketplace.marketplaceId),
    credential_id: normalizeId(marketplace.credential_id || marketplace.id),
    name: marketplace.name || marketplace.marketplace?.name || marketplace.marketplace_name || null,
    domain: marketplace.domain || marketplace.marketplace?.domain || null
  })).filter((marketplace) => marketplace.marketplace_id || marketplace.credential_id), (marketplace) =>
    `${marketplace.marketplace_id || ''}-${marketplace.credential_id || ''}`
  );
}

function diffByKey(previousItems, nextItems, keyBuilder) {
  const previous = new Map(previousItems.map((item) => [keyBuilder(item), item]));
  const next = new Map(nextItems.map((item) => [keyBuilder(item), item]));

  return {
    added: nextItems.filter((item) => !previous.has(keyBuilder(item))),
    removed: previousItems.filter((item) => !next.has(keyBuilder(item)))
  };
}

function getPayloadValue(payload, keys) {
  const parsed = parseJsonMaybe(payload) || {};
  for (const key of keys) {
    if (parsed[key] !== undefined) return parsed[key];
  }
  return null;
}

function buildPreparedPayloadSnapshot(payload) {
  const parsed = parseJsonMaybe(payload) || {};
  return {
    price: getPayloadValue(parsed, ['price', 'sale_price', 'regular_price']),
    prepared_stock: getPayloadValue(parsed, ['publishStock', 'stock', 'available_quantity', 'quantity']),
    attributes: redactSensitive(parsed.attributes || parsed.attribute_combinations || parsed.ProductData || null)
  };
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === '') return [];
  return [value];
}

function normalizeProcessProducts(products = []) {
  return toArray(products)
    .map((product) => {
      const plain = parseJsonMaybe(product) || {};
      const stockValue = plain.stock ?? plain.available_quantity ?? plain.quantity ?? plain.publishStock ?? null;
      const marketplaceCount = Array.isArray(plain.marketplaces) ? plain.marketplaces.length : plain.marketplace_count ?? null;
      return {
        id: plain.id ?? plain.product_id ?? null,
        sku: plain.sku || null,
        name: plain.name || plain.title || plain.product_name || null,
        stock: stockValue != null ? Number(stockValue) || stockValue : null,
        total_stock: plain.total_stock ?? plain.stock_total ?? null,
        marketplaces_count: marketplaceCount
      };
    })
    .filter((product) => product.id != null || product.sku || product.name);
}

function normalizeProcessMarketplaces(marketplaces = []) {
  return toArray(marketplaces)
    .map((marketplace) => {
      const plain = parseJsonMaybe(marketplace) || {};
      return {
        id: plain.id ?? plain.marketplace_id ?? plain.credential_id ?? null,
        name: plain.name || plain.marketplace_name || plain.marketplace?.name || null,
        domain: plain.domain || plain.marketplace?.domain || null,
        credential_name: plain.credential_name || plain.credential?.name || null
      };
    })
    .filter((marketplace) => marketplace.id != null || marketplace.name || marketplace.domain);
}

function buildProcessMetadata(job, data = {}) {
  const plain = toPlain(job) || {};
  const config = parseJsonMaybe(plain.config || {}) || {};
  const products = normalizeProcessProducts(data.products || config.products || []);
  const marketplaces = normalizeProcessMarketplaces(data.marketplaces || config.marketplaces || []);

  const stockTotal = products.reduce((total, product) => {
    const stock = Number(product.stock);
    return Number.isFinite(stock) ? total + stock : total;
  }, 0);

  return {
    batch_id: plain.batch_id || null,
    job_type: plain.job_type || null,
    mode: plain.mode || null,
    publication_step: plain.publication_step ?? null,
    total_products: plain.total_products ?? null,
    total_expected: config._total_expected ?? data.total_expected ?? null,
    products_count: products.length,
    marketplaces_count: marketplaces.length,
    stock_total: stockTotal,
    products,
    marketplaces,
    origin_job_id: data.origin_job_id || null,
    reprocess_job_id: data.reprocess_job_id || null,
    reprocessed_tasks_count: Array.isArray(data.reprocessed_tasks)
      ? data.reprocessed_tasks.length
      : (data.reprocessed_tasks_count ?? null),
    ...data.metadata
  };
}

function formatDraftCreatedAt(value) {
  if (!value) return null;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  return new Intl.DateTimeFormat('es-CL', {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(date);
}

function buildDraftLabel(job) {
  const batchLabel = job.batch_id ? `Lote ${job.batch_id}` : 'Lote sin identificar';
  const createdAt = formatDraftCreatedAt(job.createdAt || job.created_at);

  return createdAt
    ? `Borrador ${batchLabel}, creado el ${createdAt}`
    : `Borrador ${batchLabel}`;
}

function buildJobAuditPayload(job, data = {}) {
  const plain = toPlain(job) || {};
  const isDraft = data.module === 'publication_draft' || plain.job_type === 'draft';
  return {
    company_id: data.company_id || plain.company_id,
    module: data.module || (plain.job_type === 'draft' ? 'publication_draft' : 'process'),
    resource_type: 'job',
    resource_id: plain.id,
    resource_label: isDraft ? buildDraftLabel(plain) : `Proceso #${plain.id}`,
    job_id: plain.id,
    correlation_id: data.correlation_id || plain.batch_id || null,
    ...data
  };
}

function buildTaskAuditPayload(task, data = {}) {
  const plain = toPlain(task) || {};
  return {
    company_id: data.company_id || plain.company_id,
    module: data.module || 'published_product',
    resource_type: data.resource_type || 'product_marketplace_publication',
    resource_id: data.resource_id || plain.id,
    resource_label: data.resource_label || [
      plain.product?.sku || plain.product_id,
      plain.marketplace?.name || plain.marketplace_id,
      plain.external_id
    ].filter(Boolean).join(' / '),
    related_resource_type: data.related_resource_type || 'product',
    related_resource_id: data.related_resource_id || plain.product_id,
    marketplace_id: data.marketplace_id || plain.marketplace_id,
    marketplace_credential_id: data.marketplace_credential_id || plain.credential_id,
    warehouse_id: data.warehouse_id || plain.warehouse_id,
    branch_id: data.branch_id || plain.branch_id,
    correlation_id: data.correlation_id || plain.batch_id || null,
    ...data
  };
}

function buildLinkAuditPayload(link, data = {}) {
  const plain = toPlain(link) || {};
  return {
    company_id: data.company_id || plain.company_id,
    module: data.module || 'published_product',
    resource_type: 'product_marketplace_publication',
    resource_id: data.resource_id || plain.id,
    resource_label: data.resource_label || [
      plain.product_id,
      plain.marketplace_id,
      plain.external_id
    ].filter(Boolean).join(' / '),
    related_resource_type: 'product',
    related_resource_id: plain.product_id,
    marketplace_id: plain.marketplace_id,
    marketplace_credential_id: plain.credential_id,
    branch_id: plain.branch_id,
    ...data
  };
}

const PublicationAuditService = {
  redactSensitive,
  buildPreparedPayloadSnapshot,

  async recordDraftCreated(req, job, { products = [], marketplaces = [] } = {}) {
    await AuditEventService.safeRecordFromRequest(req, buildJobAuditPayload(job, {
      module: 'publication_draft',
      action: 'publication_draft.created',
      result: 'success',
      new_value: {
        products_count: products.length,
        marketplaces_count: marketplaces.length,
        products: redactSensitive(products),
        marketplaces: redactSensitive(marketplaces)
      },
      description: `Borrador creado: ${buildDraftLabel(job)}`,
      metadata: {
        batch_id: job.batch_id,
        mode: job.mode,
        publication_step: job.publication_step
      }
    }));
  },

  async recordDraftDiff(req, previousJob, nextJob) {
    const previousProducts = extractProductsFromConfig(previousJob?.config);
    const nextProducts = extractProductsFromConfig(nextJob?.config);
    const previousMarketplaces = extractMarketplacesFromConfig(previousJob?.config);
    const nextMarketplaces = extractMarketplacesFromConfig(nextJob?.config);
    const productDiff = diffByKey(previousProducts, nextProducts, (product) => String(product.id));
    const marketplaceDiff = diffByKey(
      previousMarketplaces,
      nextMarketplaces,
      (marketplace) => `${marketplace.marketplace_id || ''}-${marketplace.credential_id || ''}`
    );

    const events = [];
    if (productDiff.added.length > 0) {
      events.push({
        action: 'publication_draft.products_added',
        description: `${productDiff.added.length} productos agregados al borrador`,
        new_value: { products: productDiff.added, count: productDiff.added.length }
      });
    }
    if (productDiff.removed.length > 0) {
      events.push({
        action: 'publication_draft.products_removed',
        description: `${productDiff.removed.length} productos eliminados del borrador`,
        previous_value: { products: productDiff.removed, count: productDiff.removed.length }
      });
    }
    if (marketplaceDiff.added.length > 0) {
      events.push({
        action: 'publication_draft.marketplaces_added',
        description: `${marketplaceDiff.added.length} marketplaces agregados al borrador`,
        new_value: { marketplaces: marketplaceDiff.added, count: marketplaceDiff.added.length }
      });
    }
    if (marketplaceDiff.removed.length > 0) {
      events.push({
        action: 'publication_draft.marketplaces_removed',
        description: `${marketplaceDiff.removed.length} marketplaces eliminados del borrador`,
        previous_value: { marketplaces: marketplaceDiff.removed, count: marketplaceDiff.removed.length }
      });
    }

    const configChanges = detectChanges(
      normalizeAuditValue(redactSensitive(previousJob?.config || {})),
      normalizeAuditValue(redactSensitive(nextJob?.config || {})),
      ['economic_config', 'publication_step', 'mode']
    );
    if (configChanges.length > 0) {
      events.push({
        action: 'publication_draft.attributes_changed',
        description: 'Cambios generales en el borrador',
        previous_value: configChanges.reduce((acc, change) => ({ ...acc, [change.field]: change.old_value }), {}),
        new_value: configChanges.reduce((acc, change) => ({ ...acc, [change.field]: change.new_value }), {}),
        changes: configChanges
      });
    }

    await Promise.all(events.map((event) =>
      AuditEventService.safeRecordFromRequest(req, buildJobAuditPayload(nextJob, {
        module: 'publication_draft',
        result: 'success',
        metadata: {
          batch_id: nextJob.batch_id
        },
        ...event
      }))
    ));
  },

  async recordDraftExecuted(req, job) {
    await AuditEventService.safeRecordFromRequest(req, buildJobAuditPayload(job, {
      module: 'publication_draft',
      action: 'publication_draft.executed',
      result: 'success',
      description: `Publicación ejecutada desde ${buildDraftLabel(job)}`,
      metadata: {
        batch_id: job.batch_id,
        total_products: job.total_products
      }
    }));
  },

  async recordDraftCancelled(req, job) {
    await AuditEventService.safeRecordFromRequest(req, buildJobAuditPayload(job, {
      module: 'publication_draft',
      action: 'publication_draft.cancelled',
      result: 'success',
      previous_value: { status: job.status },
      description: `Borrador eliminado: ${buildDraftLabel(job)}`,
      metadata: {
        batch_id: job.batch_id
      }
    }));
  },

  async recordDraftPayloadChanges(req, task, previousPayload, nextPayload) {
    const changes = this.getPayloadChanges(previousPayload, nextPayload);
    const actionByField = {
      price: 'publication_draft.price_changed',
      prepared_stock: 'publication_draft.prepared_stock_changed',
      attributes: 'publication_draft.attributes_changed'
    };

    await Promise.all(changes.map((change) =>
      AuditEventService.safeRecordFromRequest(req, buildTaskAuditPayload(task, {
        module: 'publication_draft',
        resource_type: 'product_publishing_task',
        resource_id: task.id,
        action: actionByField[change.field] || 'publication_draft.attributes_changed',
        result: 'success',
        previous_value: { [change.field]: change.old_value },
        new_value: { [change.field]: change.new_value },
        changes: [change],
        description: `Cambio de ${change.field} en preparación de publicación`,
        metadata: {
          source: 'draft_payload_edit',
          task_id: task.id,
          batch_id: task.batch_id
        }
      }))
    ));
  },

  async recordProcessEvent(req, job, action, data = {}) {
    return AuditEventService.safeRecordFromRequest(req, buildJobAuditPayload(job, {
      module: 'process',
      action,
      result: 'success',
      description: data.description || `Proceso #${job.id}`,
      metadata: buildProcessMetadata(job, data),
      ...data
    }));
  },

  async recordProcessSystemEvent(job, action, data = {}) {
    const actor = AuditEventService.automaticProcessActor(job);
    return AuditEventService.safeRecord({
      ...actor,
      ...buildJobAuditPayload(job, {
        module: 'process',
        action,
        result: data.result || 'success',
        description: data.description || `Proceso #${job.id}`,
        previous_value: data.previous_value,
        new_value: data.new_value,
        changes: data.changes,
        metadata: buildProcessMetadata(job, data),
        origin_job_id: data.origin_job_id || null,
        ...data
      })
    });
  },

  async recordPublishedProductFromRequest(req, task, action, data = {}) {
    return AuditEventService.safeRecordFromRequest(req, buildTaskAuditPayload(task, {
      action,
      result: 'success',
      metadata: {
        source: 'spree',
        external_id: task.external_id,
        ...data.metadata
      },
      ...data
    }));
  },

  async recordPublishedProductByUser(userId, task, action, data = {}) {
    return AuditEventService.safeRecord({
      actor_type: userId ? AuditEventService.ACTOR_TYPES.USER : AuditEventService.ACTOR_TYPES.SYSTEM,
      actor_id: userId ? String(userId) : null,
      actor_name: userId ? `Usuario ${userId}` : 'Spree',
      ...buildTaskAuditPayload(task, {
        action,
        result: data.result || 'success',
        metadata: {
          source: 'spree',
          external_id: task.external_id,
          ...data.metadata
        },
        ...data
      })
    });
  },

  async recordPublishedProductFromMarketplace(marketplace, publication, action, data = {}) {
    const actor = AuditEventService.marketplaceActor(marketplace);
    return AuditEventService.safeRecord({
      ...actor,
      ...buildLinkAuditPayload(publication, {
        action,
        result: data.result || 'success',
        metadata: {
          source: 'marketplace_webhook',
          external_id: publication?.external_id,
          ...data.metadata
        },
        ...data
      })
    });
  },

  getPayloadChanges(previousPayload, nextPayload) {
    const previous = buildPreparedPayloadSnapshot(previousPayload);
    const next = buildPreparedPayloadSnapshot(nextPayload);
    return detectChanges(previous, next, ['price', 'prepared_stock', 'attributes']);
  },

  getPublishedProductChanges(previousState, nextState) {
    return detectChanges(previousState || {}, nextState || {}, [
      'status',
      'price',
      'available_quantity',
      'published_stock',
      'external_url'
    ]);
  },

  changesToValueSnapshot(changes, valueKey) {
    return changes.reduce((snapshot, change) => {
      snapshot[change.field] = change[valueKey];
      return snapshot;
    }, {});
  }
};

module.exports = PublicationAuditService;
