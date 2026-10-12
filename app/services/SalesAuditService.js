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
        safe[key] = '[PROTEGIDO]';
      } else if (
        normalizedKey.includes('document') ||
        normalizedKey.includes('email') ||
        normalizedKey.includes('address')
      ) {
        safe[key] = parsed[key] ? '[PROTEGIDO]' : parsed[key];
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

function buildSaleItemsSnapshot(items = []) {
  const source = Array.isArray(items) ? items : [];

  return source.map((item) => {
    const plain = toPlain(item) || {};
    const nested = plain.item || {};
    const product = plain.product || {};
    const variant = plain.variant || {};
    const sku = plain.sku || plain.seller_custom_field || plain.seller_sku
      || nested.sku || nested.seller_custom_field || nested.seller_sku || variant.sku || null;
    const name = plain.product_name || plain.title || nested.title || nested.name || product.name || null;
    const quantity = Number(plain.quantity ?? nested.quantity ?? 0);

    return {
      product_id: plain.product_id || product.id || null,
      product_name: name,
      producto: name,
      sku,
      quantity: Number.isFinite(quantity) ? quantity : 0
    };
  }).filter((item) => item.product_name || item.sku || item.product_id);
}

function parseJobConfig(job) {
  const config = toPlain(job)?.config || {};
  if (typeof config !== 'string') return config || {};

  try {
    return JSON.parse(config) || {};
  } catch (error) {
    return {};
  }
}

function normalizeSyncResult(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value) || {};
  } catch (error) {
    return {};
  }
}

function buildStockSyncDestinations(job, jobProducts = []) {
  const config = parseJobConfig(job);
  const sale = config.sale || {};
  const localChanges = Array.isArray(config.local_stock_changes) ? config.local_stock_changes : [];
  const warehouses = localChanges.map((change) => ({
    destination_type: 'warehouse',
    destination: change.warehouse_name || change.warehouse_label || `Almacén ${change.warehouse_id}`,
    warehouse_id: change.warehouse_id || null,
    status: change.status || 'success',
    quantity: change.quantity ?? sale.quantity ?? null,
    stock_before: change.stock_before ?? null,
    stock_after: change.stock_after ?? null,
    variation: change.variation ?? (change.quantity != null ? -Number(change.quantity) : null),
    reason: change.reason || 'Venta',
    inventory_movement_id: change.inventory_movement_id || null
  }));

  const marketplaces = jobProducts.map((jobProduct) => {
    const payload = normalizeSyncResult(jobProduct.product_payload);
    const syncResult = normalizeSyncResult(payload.sync_result);
    const stockBefore = syncResult.stock_before ?? payload.stock_before ?? null;
    const stockAfter = syncResult.stock_after ?? payload.stock ?? null;
    const status = String(jobProduct.status || '').toLowerCase() === 'success' ? 'success' : 'error';

    return {
      destination_type: 'marketplace',
      destination: jobProduct.marketplace?.name || payload.marketplace_name || `Marketplace ${jobProduct.marketplace_id}`,
      marketplace_id: jobProduct.marketplace_id || null,
      credential_id: jobProduct.credential_id || null,
      external_id: jobProduct.external_id || payload.external_id || null,
      status,
      quantity: payload.quantity_sold ?? sale.quantity ?? null,
      stock_before: stockBefore,
      stock_after: stockAfter,
      variation: stockBefore != null && stockAfter != null ? Number(stockAfter) - Number(stockBefore) : null,
      error: status === 'error'
        ? (jobProduct.error_message || syncResult.error || (jobProduct.status ? `estado_${jobProduct.status}` : null))
        : null
    };
  });

  return [...warehouses, ...marketplaces];
}

function buildStockSyncAuditPayload(job, jobProducts = [], options = {}) {
  const plainJob = toPlain(job) || {};
  const config = parseJobConfig(plainJob);
  const sale = config.sale || {};
  const firstJobProduct = jobProducts[0] || {};
  const firstPayload = normalizeSyncResult(firstJobProduct.product_payload);
  const productId = sale.product_id || firstJobProduct.product_id || firstPayload.product_id || null;
  const productName = sale.product_name || firstJobProduct.product?.name || firstPayload.product_name || null;
  const sku = sale.sku || firstPayload.sku || firstJobProduct.product?.sku || null;
  const quantity = sale.quantity ?? firstPayload.quantity_sold ?? null;
  const orderId = sale.order_id || sale.marketplace_order_id || null;
  const localOrderId = sale.local_order_id || null;
  const marketplaceName = sale.marketplace_name || sale.marketplace || getMarketplaceName({}, { name: sale.marketplace });
  const destinations = buildStockSyncDestinations(plainJob, jobProducts);
  const successful = destinations.filter((destination) => destination.status === 'success').length;
  const failed = destinations.filter((destination) => destination.status === 'error').length;
  const result = options.result || (failed === 0 ? 'success' : (successful > 0 ? 'warning' : 'error'));
  const correlationId = String(
    sale.correlation_id || config.correlation_id || plainJob.batch_id || `stock-sync:${plainJob.id || orderId || 'unknown'}`
  ).slice(0, 100);
  const productLabel = [sku, productName].filter(Boolean).join(' / ') || `Producto ${productId || 'sin identificar'}`;
  const resourceId = localOrderId || orderId || `${correlationId}:${productId || 'unknown'}`;
  const product = {
    product_id: productId,
    product_name: productName,
    producto: productName,
    sku,
    quantity
  };

  return {
    ...AuditEventService.automaticProcessActor(plainJob),
    company_id: plainJob.company_id || sale.company_id || null,
    module: 'sales',
    action: 'sales.stock_sync',
    result,
    resource_type: 'marketplace_order',
    resource_id: resourceId,
    resource_label: `Venta ${marketplaceName || 'Marketplace'}${orderId ? ` #${orderId}` : ''}`,
    related_resource_type: productId ? 'product' : null,
    related_resource_id: productId,
    marketplace_id: sale.marketplace_id || null,
    marketplace_credential_id: sale.marketplace_credential_id || null,
    job_id: plainJob.id || null,
    branch_id: sale.branch_id || null,
    correlation_id: correlationId,
    dedupe_key: `automatic-stock-sync:${correlationId}`.slice(0, 190),
    description: `Sincronización automática de Stock: ${productLabel}`,
    new_value: {
      producto: product,
      order_id: orderId,
      marketplace: marketplaceName,
      destinos: destinations
    },
    metadata: {
      source: 'sale',
      order_id: orderId,
      local_order_id: localOrderId,
      marketplace: sale.marketplace || marketplaceName,
      marketplace_name: marketplaceName,
      marketplace_id: sale.marketplace_id || null,
      product_id: productId,
      product_name: productName,
      product_label: productLabel,
      producto: productName,
      sku,
      quantity,
      quantity_sold: quantity,
      successful_destinations: successful,
      failed_destinations: failed,
      destinos: destinations,
      error: options.error || null
    }
  };
}

function buildOrderLabel(order) {
  const plain = toPlain(order) || {};
  const marketplaceName = getMarketplaceName(plain);
  if (marketplaceName && plain.buyer_name) {
    return `Venta en ${marketplaceName} / ${plain.buyer_name}`;
  }

  return marketplaceName ? `Venta en ${marketplaceName}` : 'Venta marketplace';
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
    subtotal: plain.subtotal,
    shipping_total: plain.shipping_total,
    discount_total: plain.discount_total,
    tax_total: plain.tax_total,
    payment_method: plain.payment_method,
    shipping_city: plain.shipping_city,
    shipping_region: plain.shipping_region,
    invoice_type: plain.invoice_type,
    marketplace_credential_id: plain.marketplace_credential_id,
    company_id: plain.company_id,
    branch_id: plain.branch_id
  };
}

function buildOrderMetadata(order, source, marketplace = null, extra = {}) {
  const plain = toPlain(order) || {};
  const items = Array.isArray(extra.productos)
    ? extra.productos
    : buildSaleItemsSnapshot(plain.items || []);
  const totalQuantity = items.reduce((total, item) => total + (Number(item.quantity) || 0), 0);
  return {
    source,
    marketplace_name: getMarketplaceName(plain, marketplace),
    marketplace_order_id: plain.marketplace_order_id || null,
    order_id: plain.marketplace_order_id || null,
    credential_name: plain.credential?.name || null,
    order_status: plain.order_status || null,
    payment_status: plain.payment_status || null,
    total_amount: plain.total_amount || null,
    currency: plain.currency || null,
    buyer_name: plain.buyer_name || null,
    seller_name: plain.credential?.name || null,
    subtotal: plain.subtotal ?? null,
    shipping_total: plain.shipping_total ?? null,
    discount_total: plain.discount_total ?? null,
    tax_total: plain.tax_total ?? null,
    payment_method: plain.payment_method || null,
    shipping_city: plain.shipping_city || null,
    shipping_region: plain.shipping_region || null,
    invoice_type: plain.invoice_type || null,
    total_quantity: totalQuantity || null,
    productos: items,
    ...redactSensitive(extra || {})
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
  buildSaleItemsSnapshot,

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
          ...buildOrderMetadata(order, 'marketplace', marketplace, data.metadata)
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
          ...buildOrderMetadata(order, 'spree', null, data.metadata)
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
        ...buildOrderMetadata(order, 'spree', null, data.metadata)
      },
      previous_value: redactSensitive(data.previous_value),
      new_value: redactSensitive(data.new_value),
      changes: redactSensitive(data.changes)
    }));
  },

  async recordAutomaticStockSync(job, jobProducts = [], options = {}) {
    return AuditEventService.safeUpsertByDedupeKey(
      buildStockSyncAuditPayload(job, jobProducts, options)
    );
  },

  getOrderChanges(previousOrder, nextOrder) {
    return detectChanges(
      buildOrderSnapshot(previousOrder),
      buildOrderSnapshot(nextOrder),
      [
        'order_status',
        'payment_status',
        'total_amount',
        'currency',
        'subtotal',
        'shipping_total',
        'discount_total',
        'tax_total',
        'payment_method',
        'shipping_city',
        'shipping_region',
        'invoice_type'
      ]
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
