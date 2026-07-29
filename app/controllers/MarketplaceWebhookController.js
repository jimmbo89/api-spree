const logger = require("../../config/logger");
const axios = require("axios");
const crypto = require("crypto");
const { sequelize, ProductPublishingTask } = require("../models");
const {
  MarketplaceCredentialRepository,
  ProductMarketplaceLinkRepository,
  ProductVariantRepository,
  WarehouseProductRepository,
  WarehouseProductVariantRepository,
  InventoryMovementRepository,
  ProductPublishingTaskRepository,
  WarehouseRepository,
  ProductRepository,
  MarketplaceWebhookEventRepository,
  MarketplaceOrderRepository,
  MarketplaceOrderItemRepository,
  MarketplaceOrderFeeRepository,
  MarketplaceOrderEventRepository,
  MarketplaceOrderCustomerRepository,
  JobProductRepository,
  JobRepository,
  CompanyRepository,
  UserCompanyRepository
} = require("../repositories");
const MarketplaceStockSyncService = require("../services/MarketplaceStockSyncService");
const { verifyMercadoLibreItem } = require("../services/MarketplaceItemVerificationService");
const FalabellaAdapter = require('../services/adapters/FalabellaAdapter');
const { trackPendingOperation } = require("../utils/pendingOperations");

const ML_MARKETPLACE_KEY = "mercadolibre";
const FB_MARKETPLACE_KEY = "falabella";
const ML_ORDERS_TOPIC = "orders_v2";
const ML_ITEMS_TOPIC = "items";
const ML_WEBHOOK_TIMEOUT_MS = 30000;
const ML_FETCH_RETRY_MAX = 3;
const ML_FETCH_RETRY_BASE_DELAY_MS = 1000;
const ML_FETCH_RETRY_MAX_DELAY_MS = 8000;
const FB_WEBHOOK_TIMEOUT_MS = 30000;
const FB_FETCH_RETRY_MAX = 3;
const FB_FETCH_RETRY_BASE_DELAY_MS = 1500;
const FB_FETCH_RETRY_MAX_DELAY_MS = 8000;
const FB_WEBHOOK_RECOVERY_GRACE_MS = Number(process.env.FB_WEBHOOK_RECOVERY_GRACE_MS || 3000);
const FB_ENABLE_PRODUCT_EVENT_RECONCILIATION = false;
const FB_ORDER_TOPICS = new Set(["onordercreated", "ordercreated", "onorderitemsstatuschanged"]);
const FB_FEED_TOPICS = new Set(["onfeedcompleted", "onfeedcreated"]);
const FB_PRODUCT_TOPICS = new Set([
  "onproductcreated",
  "onproductqcstatuschanged",
  "onproductupdated"
]);
const FB_KNOWN_TOPICS = new Set([
  ...FB_ORDER_TOPICS,
  ...FB_FEED_TOPICS,
  ...FB_PRODUCT_TOPICS
]);
const STOCK_SALE_STATUSES = new Set(["paid", "confirmed", "shipped", "delivered"]);
const STOCK_REVERSE_ORDER_STATUSES = new Set(["cancelled", "returned"]);
const STOCK_REVERSE_PAYMENT_STATUSES = new Set(["refunded", "charged_back", "cancelled"]);
const STOCK_DEDUCT_EVENT_TYPE = "stock_deducted";
const STOCK_REVERSE_EVENT_TYPE = "stock_reversed";
const FB_API_VERSION = process.env.FB_API_VERSION || "2.0";
const FB_USER_AGENT = process.env.FB_USER_AGENT || "Spree/1.0";

function buildFalabellaAsyncPayload(input) {
  if (!input || typeof input !== 'object') return {};

  const sourcePayload = input.payload && typeof input.payload === 'object'
    ? input.payload
    : {};

  const nestedPayload = {};
  const copyKeys = [
    'Feed',
    'SellerSkus',
    'SellerSku',
    'OrderId',
    'OrderID',
    'sku',
    'Sku',
    'resource',
    'user_id',
    'userId',
    'seller_id',
    'sellerId',
    'seller_email',
    'sellerEmail',
    'EventId',
    'event_id',
    'eventId',
    'timestamp',
    'created_at',
    'createdAt',
    'images',
    'images_with_version',
    'MainImage'
  ];

  for (const key of copyKeys) {
    if (sourcePayload[key] !== undefined) {
      nestedPayload[key] = sourcePayload[key];
    }
  }

  const safePayload = {
    event: input.event || null,
    event_type: input.event_type || null,
    topic: input.topic || null,
    type: input.type || null,
    resource: input.resource || null,
    event_id: input.event_id ?? input.EventId ?? input.eventId ?? sourcePayload.event_id ?? sourcePayload.EventId ?? sourcePayload.eventId ?? null,
    user_id: input.user_id ?? input.userId ?? sourcePayload.user_id ?? sourcePayload.userId ?? null,
    seller_email: input.seller_email ?? input.sellerEmail ?? sourcePayload.seller_email ?? sourcePayload.sellerEmail ?? null,
    seller_id: input.seller_id ?? input.sellerId ?? sourcePayload.seller_id ?? sourcePayload.sellerId ?? null,
    timestamp: input.timestamp || sourcePayload.timestamp || null,
    created_at: input.created_at || sourcePayload.created_at || null,
    payload: nestedPayload
  };

  if (sourcePayload && typeof sourcePayload === 'object') {
    for (const key of ['Feed', 'SellerSkus', 'SellerSku', 'OrderId', 'OrderID', 'resource']) {
      if (sourcePayload[key] !== undefined) {
        safePayload[key] = sourcePayload[key];
      }
    }
  }

  return safePayload;
}

const MarketplaceWebhookController = {
  async mercadoLibre(req, res) {
    logger.info(`Datos llegados desde el webhook-Mercado-Libre:\n ${JSON.stringify(req.body)}`);
    const payload = req.body || {};

    res.status(200).json({ success: true });

    trackPendingOperation(new Promise((resolve) => {
      setImmediate(async () => {
        try {
          await processMercadoLibreWebhook(payload, { timeoutMs: ML_WEBHOOK_TIMEOUT_MS });
        } catch (err) {
          logger.error(`[ML Webhook] Error en procesamiento async: ${err.message}`);
        } finally {
          resolve();
        }
      });
    }));
  },

  async falabella(req, res) {
    const payload = buildFalabellaAsyncPayload(req.body);
    const topicRaw =
      payload?.event ||
      payload?.event_type ||
      payload?.topic ||
      payload?.type ||
      null;

    logger.info(`Datos llegados desde el webhook-Falabella:\n ${JSON.stringify({
      event: payload.event,
      event_type: payload.event_type,
      topic: payload.topic,
      type: payload.type,
      resource: payload.resource,
      user_id: payload.user_id,
      seller_email: payload.seller_email,
      feed: payload.payload?.Feed || payload.Feed || null,
      seller_skus: Array.isArray(payload.payload?.SellerSkus) ? payload.payload.SellerSkus : null
    })}`);
    logger.info(`[FB Webhook] Request recibida ip=${req.ip || req.socket?.remoteAddress || 'unknown'} ua=${req.headers['user-agent'] || 'unknown'} ct=${req.headers['content-type'] || 'unknown'} topic=${topicRaw || 'unknown'}`);
    logger.info(`[FB Webhook] Payload recibido (liviano): ${JSON.stringify(payload).substring(0, 2000)}`);

    res.status(200).json({ success: true });

    trackPendingOperation(new Promise((resolve) => {
      setImmediate(async () => {
        try {
          await processFalabellaWebhook(payload, { timeoutMs: FB_WEBHOOK_TIMEOUT_MS });
        } catch (err) {
          logger.error(`[FB Webhook] Error en procesamiento async: ${err.message}`);
        } finally {
          resolve();
        }
      });
    }));
  }
};

async function createFalabellaWebhookEvent(payload, topic, resource, eventId, externalId, marketplaceUserId) {
  const eventResult = await MarketplaceWebhookEventRepository.createUnique({
    marketplace: FB_MARKETPLACE_KEY,
    topic,
    resource,
    event_id: eventId,
    external_id: String(externalId),
    marketplace_user_id: marketplaceUserId,
    status: "received",
    payload
  });

  if (eventResult.created) {
    return eventResult;
  }

  const existingEvent = await MarketplaceWebhookEventRepository.findLatestByEventId(
    eventId,
    FB_MARKETPLACE_KEY
  );

  if (!existingEvent) {
    return eventResult;
  }

  const createdAt = existingEvent.createdAt ? new Date(existingEvent.createdAt).getTime() : 0;
  const ageMs = createdAt > 0 ? Date.now() - createdAt : Number.POSITIVE_INFINITY;
  const status = String(existingEvent.status || '').toLowerCase();
  const recoverableStatus = ['received', 'processing', 'error', 'timeout'].includes(status);

  if (!recoverableStatus || ageMs < FB_WEBHOOK_RECOVERY_GRACE_MS) {
    logger.info(`[FB Webhook] Duplicado ignorado: ${resource}`);
    return eventResult;
  }

  await MarketplaceWebhookEventRepository.updateById(existingEvent.id, {
    status: 'received',
    error_message: null,
    processed_at: null,
    payload
  });

  logger.warn(
    `[FB Webhook] Evento duplicado recuperable: ${resource} (status=${status}, age_ms=${ageMs})`
  );

  return {
    created: true,
    record: await MarketplaceWebhookEventRepository.findLatestByEventId(eventId, FB_MARKETPLACE_KEY)
  };
}

async function processMercadoLibreWebhook(payload, options = {}) {
  const validation = validateMercadoLibrePayload(payload);
  if (!validation.ok) {
    logger.warn(`[ML Webhook] Payload invalido: ${validation.reason}`);
    return;
  }

  const { resource, topic, user_id } = payload;

  if (topic === ML_ORDERS_TOPIC) {
    const orderId = extractOrderId(resource);
    if (!orderId) {
      logger.warn(`[ML Webhook] Resource invalido: ${resource}`);
      return;
    }

    const eventId = buildMercadoLibreEventId(payload, resource);

    const eventResult = await MarketplaceWebhookEventRepository.createUnique({
      marketplace: ML_MARKETPLACE_KEY,
      topic,
      resource,
      event_id: eventId,
      external_id: String(orderId),
      marketplace_user_id: user_id != null ? String(user_id) : null,
      status: "received",
      payload
    });

    if (!eventResult.created) {
      logger.info(`[ML Webhook] Evento duplicado ignorado: ${eventId}`);
      return;
    }

    const event = eventResult.record;

    const timeoutMs =
      Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? options.timeoutMs
        : ML_WEBHOOK_TIMEOUT_MS;

    const processPromise = processMercadoLibreEvent({
      event,
      payload,
      orderId,
      userId: user_id
    });

    try {
      await withTimeout(processPromise, timeoutMs);
    } catch (error) {
      const isTimeout = error?.message === "timeout";
      await MarketplaceWebhookEventRepository.updateById(event.id, {
        status: isTimeout ? "timeout" : "error",
        error_message: isTimeout
          ? `timeout:${timeoutMs}ms`
          : `processing_error:${error?.message || "unknown"}`,
        processed_at: new Date()
      });
      logger.error(
        `[ML Webhook] ${isTimeout ? "Timeout" : "Error"} procesando evento ${eventId}: ${error.message}`
      );
    }
    return;
  }

  if (topic === ML_ITEMS_TOPIC) {
    await processMercadoLibreItemWebhook(payload, options);
    return;
  }

  if (topic !== ML_ORDERS_TOPIC) {
    logger.info(`[ML Webhook] Ignorado topic: ${topic}`);
    return;
  }
}

async function processMercadoLibreEvent({ event, payload, orderId, userId }) {
  const credential = await MarketplaceCredentialRepository.findByMLUserIdGlobal(userId);
  if (!credential || !credential.access_token) {
    await MarketplaceWebhookEventRepository.updateById(event.id, {
      status: "error",
      error_message: "credential_not_found",
      processed_at: new Date()
    });
    logger.warn(`[ML Webhook] Credencial no encontrada para ml_user_id=${userId}`);
    return;
  }

  const order = await fetchMercadoLibreOrderWithRetry(orderId, credential.access_token);
  if (!order) {
    await MarketplaceWebhookEventRepository.updateById(event.id, {
      status: "error",
      error_message: "order_fetch_failed",
      processed_at: new Date()
    });
    return;
  }

  const shipmentId = order?.shipping?.id || null;
  const [shipmentData, shipmentCostsData, billingInfoData] = await Promise.all([
    shipmentId
      ? fetchMercadoLibreShipmentWithRetry(shipmentId, credential.access_token)
      : Promise.resolve(null),
    shipmentId
      ? fetchMercadoLibreShipmentCostsWithRetry(shipmentId, credential.access_token)
      : Promise.resolve(null),
    fetchMercadoLibreBillingInfoWithRetry(orderId, credential.access_token)
  ]);
  const messagesData = await fetchMercadoLibreMessagesWithRetry({
    orderId,
    order,
    accessToken: credential.access_token,
    sellerId: getMercadoLibreSellerId(credential, order)
  });
  const shippingFinancials = normalizeMercadoLibreShipmentCosts(
    shipmentCostsData,
    order,
    shipmentData
  );

  const customerSnapshot = buildMercadoLibreCustomerSnapshot({
    order,
    shipment: shipmentData,
    billingInfo: billingInfoData
  });

  const items = Array.isArray(order.order_items) ? order.order_items : [];
  if (items.length === 0) {
    await MarketplaceWebhookEventRepository.updateById(event.id, {
      status: "processed_with_errors",
      error_message: "order_items_empty",
      processed_at: new Date()
    });
    return;
  }

  // ✅ RESOLVER COMPAÑÍA DESDE EL PRIMER LISTING DE LA ORDEN
  // Las credenciales son globales, el company_id viene del producto/link
  const firstListingId = getListingId(items[0]);
  const companyInfo = await resolveCompanyFromListing(ML_MARKETPLACE_KEY, firstListingId);
  const companyId = companyInfo?.company_id || null;
  const branchId = companyInfo?.branch_id || null;
  const publicationUserId = companyInfo?.user_id || credential.user_id || null;
  const existingOrder = await MarketplaceOrderRepository.findByMarketplaceOrderId(
    ML_MARKETPLACE_KEY,
    String(order.id)
  );

  // ✅ GUARDAR ORDEN EN marketplace_orders
  const orderData = {
    marketplace: ML_MARKETPLACE_KEY,
    marketplace_order_id: String(order.id),
    marketplace_credential_id: credential.id,
    user_id: publicationUserId,
    company_id: companyId,
    branch_id: branchId,
    order_status: mapMercadoLibreOrderStatus(order.order_status),
    payment_status: mapMercadoLibrePaymentStatus(order.payment_status),
    subtotal: order.total_amount || 0,
    shipping_total: shippingFinancials.seller_cost,
    discount_total: shippingFinancials.shipping_subsidy,
    tax_total: 0, // ML no devuelve impuestos separados
    total_amount: order.total_amount || 0,
    currency: order.currency_id || 'CLP',
    buyer_id: customerSnapshot.marketplace_customer_id || order?.buyer?.id?.toString() || null,
    buyer_name: customerSnapshot.full_name || order?.buyer?.nickname || null,
    buyer_email: customerSnapshot.email || null,
    buyer_document: customerSnapshot.document_number || null,
    payment_method: order?.payments?.[0]?.payment_type || null,
    payment_date: order?.payments?.[0]?.date_created || null,
    shipping_address:
      buildAddressLine([
        customerSnapshot.shipping_address_line,
        customerSnapshot.shipping_address_line_2,
        customerSnapshot.shipping_reference
      ]) || buildShippingAddress(order.shipping),
    shipping_city: customerSnapshot.shipping_city || order?.shipping?.receiver_address?.city_name || null,
    shipping_region: customerSnapshot.shipping_state || order?.shipping?.receiver_address?.state_name || null,
    messages_snapshot: buildMercadoLibreMessagesSnapshot(messagesData),
    raw_payload: {
      order,
      shipment: shipmentData,
      shipment_costs: shipmentCostsData,
      billing_info: billingInfoData,
      messages: messagesData,
      shipping_financials: shippingFinancials
    }
  };

  let savedOrder;
  let orderCreated = false;
  let previousOrderStatus = existingOrder?.order_status || null;

  try {
    const result = await MarketplaceOrderRepository.upsert(orderData);
    savedOrder = await MarketplaceOrderRepository.findById(result.record.id);
    orderCreated = result.created;
  } catch (error) {
    logger.error(`[ML Webhook] Error guardando orden ${orderId}: ${error.message}`);
    await MarketplaceWebhookEventRepository.updateById(event.id, {
      status: "error",
      error_message: `order_save_failed: ${error.message}`,
      processed_at: new Date()
    });
    return;
  }

  const currentOrderStatus = savedOrder?.order_status || orderData.order_status;
  const currentPaymentStatus = savedOrder?.payment_status || orderData.payment_status;
  const stockState = await getMarketplaceOrderStockState(
    ML_MARKETPLACE_KEY,
    savedOrder.id
  );
  const lifecycle = getMarketplaceOrderLifecycleDecision({
    orderStatus: currentOrderStatus,
    paymentStatus: currentPaymentStatus
  });
  const shouldDeductStock = lifecycle.shouldDeduct && !stockState.hasDeduction && !stockState.hasReversal;
  const shouldReverseStock = lifecycle.shouldReverse && stockState.hasDeduction && stockState.pendingReversalCount > 0;

  const statusChanged = previousOrderStatus !== currentOrderStatus;

  if (orderCreated) {
    await MarketplaceOrderEventRepository.createStatusChange(
      savedOrder.id,
      'created',
      null,
      currentOrderStatus,
      order,
      { company_id: companyId }
    );
  } else if (statusChanged) {
    await MarketplaceOrderEventRepository.createStatusChange(
      savedOrder.id,
      currentOrderStatus,
      previousOrderStatus,
      currentOrderStatus,
      order,
      { company_id: companyId }
    );
  }

  await persistMarketplaceOrderCustomerSnapshot(savedOrder, customerSnapshot, "ML Webhook");

  // ✅ DATOS DE SHIPPING PARA TODA LA ORDEN
  const shippingData = {
    shippingGrossAmount: shippingFinancials.gross_amount,
    sellerShippingCost: shippingFinancials.seller_cost,
    buyerShippingCost: shippingFinancials.buyer_cost,
    shippingSubsidy: shippingFinancials.shipping_subsidy,
    logisticType: shippingFinancials.logistic_type,
    freeShipping: shippingFinancials.free_shipping,
    whoPays: shippingFinancials.who_pays,
    shippingOption: order?.shipping?.shipping_option || null
  };
  const totalQuantity = items.reduce((sum, item) => sum + (Number(item?.quantity || 0) || 0), 0);

  const errors = [];
  const savedItems = [];

  if (shouldDeductStock) {
    // ✅ PROCESAR CADA ITEM SOLO EN PRIMERA VENTA PAGADA
    for (const orderItem of items) {
      try {
        const itemResult = await processOrderItem(orderItem, {
          orderId,
          marketplaceId: credential.marketplace_id,
          companyId,
          branchId,
          orderIdLocal: savedOrder.id,
          // Datos financieros de la orden completa
          totalAmount: order.total_amount || 0,
          shippingGrossAmount: shippingData.shippingGrossAmount,
          sellerShippingCost: shippingData.sellerShippingCost,
          buyerShippingCost: shippingData.buyerShippingCost,
          shippingSubsidy: shippingData.shippingSubsidy,
          logisticType: shippingData.logisticType,
          freeShipping: shippingData.freeShipping,
          shippingWhoPays: shippingData.whoPays,
          totalItems: items.length,
          totalQuantity
        });
        
        if (itemResult) {
          savedItems.push(itemResult);
        }
      } catch (error) {
        errors.push(error.message);
        logger.error(`[ML Webhook] Item error order=${orderId}: ${error.message}`);
      }
    }

    // ✅ GUARDAR FEES TOTALES DE LA ORDEN
    if (savedOrder && items.length > 0) {
      try {
        const totalFees = items.reduce((sum, item) => {
          return sum + (Number(item.sale_fee) || 0);
        }, 0);

        if (totalFees > 0) {
          await MarketplaceOrderFeeRepository.create({
            order_id: savedOrder.id,
            company_id: companyId,
            fee_type: 'commission',
            amount: totalFees,
            percentage: calculateAverageCommissionPercentage(totalFees, order.total_amount),
            status: 'pending',
            description: `Comisión Mercado Libre - Orden ${orderId}`,
            raw_data: { items: items.map(i => ({ id: i.id, sale_fee: i.sale_fee })) }
          });
        }
      } catch (error) {
        logger.error(`[ML Webhook] Error guardando fees de orden ${orderId}: ${error.message}`);
      }
    }

    await MarketplaceOrderEventRepository.create({
      order_id: savedOrder.id,
      event_type: STOCK_DEDUCT_EVENT_TYPE,
      previous_status: previousOrderStatus,
      new_status: currentOrderStatus,
      raw_payload: order,
      notes: `Stock debitado por orden Mercado Libre ${orderId}`,
      company_id: companyId
    });
  }

  if (shouldReverseStock) {
    const reversalResult = await reverseMarketplaceOrderStock({
      order: savedOrder,
      marketplaceKey: ML_MARKETPLACE_KEY,
      orderId,
      reason: 'mercadolibre_reversal',
      payload: order,
      sourceMarketplaceId: credential.marketplace_id,
      includeSourceMarketplace: true
    });

    if (reversalResult.errors.length > 0) {
      errors.push(...reversalResult.errors);
    }

    if (reversalResult.completed) {
      await MarketplaceOrderEventRepository.create({
        order_id: savedOrder.id,
        event_type: STOCK_REVERSE_EVENT_TYPE,
        previous_status: previousOrderStatus,
        new_status: currentOrderStatus,
        raw_payload: order,
        notes: `Stock revertido por estado ${currentOrderStatus} en orden Mercado Libre ${orderId}`,
        company_id: companyId
      });
    }
  }

  await MarketplaceWebhookEventRepository.updateById(event.id, {
    status: errors.length > 0 ? "processed_with_errors" : "processed",
    error_message: errors.length > 0 ? errors.slice(0, 5).join(" | ") : null,
    processed_at: new Date()
  });
}

async function fetchMercadoLibreOrderWithRetry(orderId, accessToken) {
  return await fetchMercadoLibreResourceWithRetry({
    resourcePath: `orders/${orderId}`,
    accessToken,
    resourceLabel: `orden ${orderId}`
  });
}

async function fetchMercadoLibreShipmentWithRetry(shipmentId, accessToken) {
  return await fetchMercadoLibreResourceWithRetry({
    resourcePath: `shipments/${shipmentId}`,
    accessToken,
    resourceLabel: `shipment ${shipmentId}`
  });
}

async function fetchMercadoLibreShipmentCostsWithRetry(shipmentId, accessToken) {
  return await fetchMercadoLibreResourceWithRetry({
    resourcePath: `shipments/${shipmentId}/costs`,
    accessToken,
    resourceLabel: `shipment_costs ${shipmentId}`,
    allowNotFound: true,
    extraHeaders: {
      "x-format-new": "true"
    }
  });
}

async function fetchMercadoLibreBillingInfoWithRetry(orderId, accessToken) {
  return await fetchMercadoLibreResourceWithRetry({
    resourcePath: `marketplace/orders/${orderId}/billing_info`,
    accessToken,
    resourceLabel: `billing_info ${orderId}`,
    allowNotFound: true
  });
}

async function fetchMercadoLibreMessagesWithRetry({ orderId, order, accessToken, sellerId }) {
  const packId = order?.pack_id || orderId;
  const finalSellerId = sellerId || order?.seller?.id || order?.seller_id || null;

  if (!packId || !finalSellerId) {
    return null;
  }

  return await fetchMercadoLibreResourceWithRetry({
    resourcePath: `messages/packs/${packId}/sellers/${finalSellerId}?tag=post_sale&mark_as_read=false`,
    accessToken,
    resourceLabel: `messages pack ${packId}`,
    allowNotFound: true
  });
}

async function fetchMercadoLibreResourceWithRetry({
  resourcePath,
  accessToken,
  resourceLabel,
  allowNotFound = false,
  extraHeaders = {}
}) {
  let lastError = null;
  const safeLabel = resourceLabel || resourcePath;

  for (let attempt = 1; attempt <= ML_FETCH_RETRY_MAX; attempt++) {
    try {
      const response = await axios.get(
        `https://api.mercadolibre.com/${resourcePath}`,
        {
          headers: { Authorization: `Bearer ${accessToken}`, ...extraHeaders },
          timeout: 10000
        }
      );
      return response.data;
    } catch (error) {
      lastError = error;
      const status = error?.response?.status;

      if (status === 404) {
        const level = allowNotFound ? "info" : "warn";
        logger[level](`[ML Webhook] Recurso ${safeLabel} no encontrado (404)`);
        return null;
      }

      if (status === 401 || status === 403) {
        logger.error(`[ML Webhook] Error autenticacion ${status} para ${safeLabel}`);
        return null;
      }

      if (attempt < ML_FETCH_RETRY_MAX) {
        const delayMs = Math.min(
          ML_FETCH_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1),
          ML_FETCH_RETRY_MAX_DELAY_MS
        );
        logger.warn(
          `[ML Webhook] Intento ${attempt}/${ML_FETCH_RETRY_MAX} fallido para ${safeLabel}. Reintentando en ${delayMs}ms...`
        );
        await sleep(delayMs);
      }
    }
  }

  logger.error(
    `[ML Webhook] Error obteniendo ${safeLabel} despues de ${ML_FETCH_RETRY_MAX} intentos: ${lastError?.message || "unknown"}`
  );
  return null;
}

function normalizeMercadoLibreShipmentCosts(shipmentCosts, order, shipment) {
  const toAmount = (value) => {
    const amount = Number(value);
    return Number.isFinite(amount) ? amount : 0;
  };

  const sumDiscounts = (discounts) => {
    if (!Array.isArray(discounts)) return 0;
    return discounts.reduce((sum, discount) => {
      if (!discount || typeof discount !== "object") return sum;
      const amount = Number(
        discount.promoted_amount ??
        discount.amount ??
        discount.value ??
        0
      );
      return sum + (Number.isFinite(amount) ? amount : 0);
    }, 0);
  };

  const senders = Array.isArray(shipmentCosts?.senders) ? shipmentCosts.senders : [];
  const receiver = shipmentCosts?.receiver || {};
  const grossAmount = toAmount(shipmentCosts?.gross_amount ?? order?.shipping?.shipping_cost ?? 0);
  const sellerCost = senders.reduce((sum, sender) => sum + toAmount(sender?.cost), 0);
  const sellerDiscount = senders.reduce((sum, sender) => {
    return sum + sumDiscounts(sender?.discounts) + sumDiscounts(sender?.discount);
  }, 0);
  const buyerCost = toAmount(receiver?.cost);
  const shippingSubsidy = Math.max(
    sellerDiscount,
    grossAmount > 0 ? grossAmount - sellerCost - buyerCost : 0
  );
  const freeShipping = typeof shipment?.free_shipping === "boolean"
    ? shipment.free_shipping
    : (typeof order?.shipping?.free_shipping === "boolean" ? order.shipping.free_shipping : null);

  let whoPays = "unknown";
  if (buyerCost > 0 && sellerCost > 0) whoPays = "shared";
  else if (buyerCost > 0) whoPays = "buyer";
  else if (sellerCost > 0) whoPays = "seller";

  return {
    shipment_id: shipment?.id || order?.shipping?.id || null,
    logistic_type: shipment?.logistic_type || order?.shipping?.logistic_type || null,
    free_shipping: freeShipping,
    gross_amount: grossAmount,
    buyer_cost: buyerCost,
    seller_cost: sellerCost,
    seller_discount: sellerDiscount,
    shipping_subsidy: shippingSubsidy,
    who_pays: whoPays,
    senders,
    receiver,
    raw: shipmentCosts || null
  };
}

function buildMercadoLibreMessagesSnapshot(messagesData) {
  const results = Array.isArray(messagesData?.messages)
    ? messagesData.messages
    : Array.isArray(messagesData?.results)
      ? messagesData.results
      : Array.isArray(messagesData)
        ? messagesData
        : [];

  return results
    .map((message) => {
      const receivedAt =
        message?.message_date?.received ||
        message?.message_date?.sent ||
        message?.created_at ||
        message?.date_created ||
        null;

      return {
        message_id: message?.message_id || message?.id || null,
        text: message?.text || "",
        conversation_status: message?.conversation_status || null,
        received_at: receivedAt,
        sender: message?.from?.role || message?.sender || message?.author || null,
        raw_payload: message
      };
    })
    .filter((message) => message.message_id || message.text)
    .sort((a, b) => {
      const aTime = a.received_at ? new Date(a.received_at).getTime() : 0;
      const bTime = b.received_at ? new Date(b.received_at).getTime() : 0;
      return aTime - bTime;
    });
}

function getMercadoLibreSellerId(credential, order) {
  return (
    credential?.seller_id ||
    credential?.additional_data?.ml_user_id ||
    order?.seller?.id ||
    order?.seller_id ||
    order?.user_id ||
    null
  );
}

function extractMercadoLibreItemId(resource) {
  if (!resource || typeof resource !== "string") return null;
  const match = resource.match(/\/?items\/([^/?]+)/i);
  if (match && match[1]) return match[1];
  const parts = resource.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : null;
}

function normalizeMercadoLibreItemStatusValue(status) {
  return String(status || "").trim().toLowerCase() || null;
}

function normalizeMercadoLibreSubStatusValue(subStatus) {
  if (!subStatus) return [];
  if (Array.isArray(subStatus)) {
    return subStatus.map((value) => String(value).trim()).filter(Boolean);
  }

  if (typeof subStatus === "string") {
    return subStatus
      .split(",")
      .map((value) => String(value).trim())
      .filter(Boolean);
  }

  return [String(subStatus).trim()].filter(Boolean);
}

function isMercadoLibreDeletedState(status, subStatus = []) {
  const normalizedStatus = normalizeMercadoLibreItemStatusValue(status);
  const normalizedSubStatus = normalizeMercadoLibreSubStatusValue(subStatus);

  return (
    normalizedStatus === 'deleted' ||
    normalizedStatus === 'closed' ||
    normalizedSubStatus.some((value) => String(value).toLowerCase() === 'deleted')
  );
}

function buildMercadoLibreItemStateSnapshot({ item, verification, payload }) {
  const status = normalizeMercadoLibreItemStatusValue(item?.status);
  const subStatus = normalizeMercadoLibreSubStatusValue(item?.sub_status);

  return {
    marketplace: ML_MARKETPLACE_KEY,
    status,
    sub_status: subStatus,
    sub_status_text: subStatus.join(", "),
    verified: !!verification?.verified,
    item_found: !!verification?.item_found,
    note: verification?.note || null,
    attempts: verification?.attempts || 0,
    updated_at: new Date().toISOString(),
    webhook: {
      topic: payload?.topic || null,
      resource: payload?.resource || null,
      sent: payload?.sent || null,
      received: payload?.received || null
    }
  };
}

async function recalculateJobProgressFromTask(task) {
  if (!task?.batch_id) return;

  const job = await JobRepository.findByBatchId(task.batch_id, task.company_id || null);
  if (job?.id) {
    await JobRepository.recalculateProgress(job.id);
  }
}

function buildMercadoLibreDeletedItemSnapshot(itemId, verification, payload) {
  return buildMercadoLibreItemStateSnapshot({
    item: {
      id: itemId,
      status: verification?.status || 'deleted',
      sub_status: ['deleted'],
      permalink: null
    },
    verification,
    payload
  });
}

async function persistMercadoLibreItemState({
  credential,
  itemId,
  item,
  verification,
  payload
}) {
  const marketplaceId = credential?.marketplace_id || null;
  const snapshot = buildMercadoLibreItemStateSnapshot({ item, verification, payload });

  logger.info(
    `[ML Webhook] Item ${itemId} verificado: ${JSON.stringify({
      topic: payload?.topic || null,
      resource: payload?.resource || null,
      snapshot: {
        id: item?.id || itemId,
        title: item?.title || null,
        status: snapshot.status,
        sub_status: snapshot.sub_status,
        category_id: item?.category_id || null,
        price: item?.price ?? null,
        permalink: item?.permalink || null,
        last_updated: item?.last_updated || null
      }
    })}`
  );

  let task = await ProductPublishingTaskRepository.findLatestByExternalId(
    marketplaceId,
    String(itemId)
  );

  let companyId = task?.company_id || null;
  let branchId = task?.branch_id || null;

  let link = await ProductMarketplaceLinkRepository.findByMarketplaceExternalId(
    marketplaceId,
    String(itemId),
    companyId,
    branchId,
    credential?.id || null
  );

  if (!link && (companyId || branchId)) {
    link = await ProductMarketplaceLinkRepository.findByMarketplaceExternalId(
      marketplaceId,
      String(itemId),
      companyId,
      branchId,
      null
    );
  }

  if (!link && task) {
    link = await ProductMarketplaceLinkRepository.findByMarketplaceExternalId(
      marketplaceId,
      String(itemId),
      task.company_id || null,
      task.branch_id || null,
      credential?.id || null
    );
  }

  const updatePayload = {
    status: isMercadoLibreDeletedState(snapshot.status, snapshot.sub_status)
      ? 'deleted'
      : (snapshot.status || link?.status || 'unpublished'),
    external_url: item?.permalink || link?.external_url || null,
    last_synced_at: new Date()
  };

  if (link) {
    await link.update(updatePayload);
  }

  if (task) {
    const isActive = String(snapshot.status || '').toLowerCase() === 'active';
    const isDeleted = isMercadoLibreDeletedState(snapshot.status, snapshot.sub_status);
    const subStatusLabel = snapshot.sub_status_text ? ` (${snapshot.sub_status_text})` : '';
    const currentDetails = normalizeFalabellaDetailObject(task.error_details);
    const mergedDetails = {
      ...currentDetails,
      marketplace_item_state: snapshot,
      terminal_state: isDeleted ? 'deleted' : null
    };
    const taskUpdate = {
      api_response: item || task.api_response || null,
      error_message: isActive
        ? null
        : (isDeleted
          ? 'ML item eliminado en Mercado Libre'
          : `ML item status: ${snapshot.status}${subStatusLabel}`),
      error_details: isActive ? null : mergedDetails
    };

    if (isActive && task.status === 'published_with_warnings') {
      taskUpdate.status = 'published';
    } else if (!isActive && !isDeleted && task.status === 'published') {
      taskUpdate.status = 'published_with_warnings';
    }

    await task.update(taskUpdate);
    await recalculateJobProgressFromTask(task);
  }

  let jobProduct = null;
  if (task?.job?.id && task.product_id && task.marketplace_id) {
    jobProduct = await JobProductRepository.findByProductAndMarketplace(
      task.job.id,
      task.product_id,
      task.marketplace_id,
      task.credential_id || null
    );

    if (jobProduct) {
      const isActive = String(snapshot.status || '').toLowerCase() === 'active';
      const isDeleted = isMercadoLibreDeletedState(snapshot.status, snapshot.sub_status);
      const subStatusLabel = snapshot.sub_status_text ? ` (${snapshot.sub_status_text})` : '';
      const currentJobDetails = normalizeFalabellaDetailObject(jobProduct.error_details);
      const mergedJobDetails = {
        ...currentJobDetails,
        marketplace_item_state: snapshot,
        terminal_state: isDeleted ? 'deleted' : null
      };

      await JobProductRepository.update(jobProduct, {
        status: 'success',
        external_id: item?.id || jobProduct.external_id || null,
        external_url: item?.permalink || jobProduct.external_url || null,
        error_message: isActive
          ? null
          : (isDeleted
            ? 'ML item eliminado en Mercado Libre'
            : `Advertencias: ML item status ${snapshot.status}${subStatusLabel}`),
        error_details: isActive ? null : mergedJobDetails
      });

      if (jobProduct?.job_id) {
        await JobRepository.recalculateProgress(jobProduct.job_id);
      }
    }
  }

  return {
    snapshot,
    taskUpdated: !!task,
    linkUpdated: !!link,
    jobProductUpdated: !!jobProduct,
    taskId: task?.id || null,
    linkId: link?.id || null,
    jobProductId: jobProduct?.id || null
  };
}

async function processMercadoLibreItemWebhook(payload, options = {}) {
  const validation = validateMercadoLibrePayload(payload);
  if (!validation.ok) {
    logger.warn(`[ML Webhook] Payload invalido para item: ${validation.reason}`);
    return;
  }

  const { resource, topic, user_id } = payload;
  const itemId = extractMercadoLibreItemId(resource);
  if (!itemId) {
    logger.warn(`[ML Webhook] Resource invalido para item: ${resource}`);
    return;
  }

  const eventId = buildMercadoLibreEventId(payload, resource);
  const eventResult = await MarketplaceWebhookEventRepository.createUnique({
    marketplace: ML_MARKETPLACE_KEY,
    topic,
    resource,
    event_id: eventId,
    external_id: String(itemId),
    marketplace_user_id: user_id != null ? String(user_id) : null,
    status: "received",
    payload
  });

  if (!eventResult.created) {
    logger.info(`[ML Webhook] Evento duplicado ignorado: ${eventId}`);
    return;
  }

  const event = eventResult.record;
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : ML_WEBHOOK_TIMEOUT_MS;

  try {
    const credential = await resolveMercadoLibreItemWebhookCredential({
      itemId,
      userId: user_id
    });
    if (!credential || !credential.access_token) {
      await MarketplaceWebhookEventRepository.updateById(event.id, {
        status: "error",
        error_message: "credential_not_found",
        processed_at: new Date()
      });
      logger.warn(`[ML Webhook] Credencial no encontrada para ml_user_id=${user_id}`);
      return;
    }

    const verificationPromise = verifyMercadoLibreItem({
      itemId,
      accessToken: credential.access_token,
      maxAttempts: 3,
      baseDelayMs: 1000,
      timeoutMs: Math.min(timeoutMs, 10000)
    });

    const verification = await withTimeout(verificationPromise, timeoutMs);

    if (!verification?.ok || !verification.item_found) {
      const isDeleted = verification?.http_status === 404 || verification?.error_code === 'item_not_found';

      if (isDeleted) {
        const deletedItem = buildMercadoLibreDeletedItemSnapshot(itemId, verification, payload);

        await persistMercadoLibreItemState({
          credential,
          itemId,
          item: deletedItem,
          verification,
          payload
        });

        await MarketplaceWebhookEventRepository.updateById(event.id, {
          status: "processed",
          error_message: null,
          processed_at: new Date()
        });

        logger.info(`[ML Webhook] Item ${itemId} marcado como deleted por 404/no encontrado`);
        return;
      }

      await MarketplaceWebhookEventRepository.updateById(event.id, {
        status: "error",
        error_message: verification?.error || "item_verification_failed",
        processed_at: new Date()
      });
      return;
    }

    const persistResult = await persistMercadoLibreItemState({
      credential,
      itemId,
      item: verification.item,
      verification,
      payload
    });

    await MarketplaceWebhookEventRepository.updateById(event.id, {
      status: "processed",
      processed_at: new Date(),
      error_message: null
    });

    logger.info(
      `[ML Webhook] Item ${itemId} sincronizado: ${persistResult.snapshot.status || 'unknown'}${persistResult.snapshot.sub_status_text ? ` (${persistResult.snapshot.sub_status_text})` : ''}`
    );
  } catch (error) {
    const isTimeout = error?.message === "timeout";
    await MarketplaceWebhookEventRepository.updateById(event.id, {
      status: isTimeout ? "timeout" : "error",
      error_message: isTimeout
        ? `timeout:${timeoutMs}ms`
        : `processing_error:${error?.message || "unknown"}`,
      processed_at: new Date()
    });
    logger.error(
      `[ML Webhook] ${isTimeout ? "Timeout" : "Error"} procesando item ${itemId}: ${error.message}`
    );
  }
}

async function resolveMercadoLibreItemWebhookCredential({ itemId, userId }) {
  if (itemId) {
    const link = await ProductMarketplaceLinkRepository.findLatestByExternalIdAndMarketplaceDomain(
      String(itemId),
      ML_MARKETPLACE_KEY
    );

    if (link?.credential_id) {
      const credential = await MarketplaceCredentialRepository.findById(link.credential_id);
      if (credential?.access_token) {
        logger.info(
          `[ML Webhook] Credencial resuelta por link external_id=${itemId} credential_id=${credential.id}`
        );
        return credential;
      }
    }

    const task = await ProductPublishingTaskRepository.findLatestByExternalIdAndMarketplaceDomain(
      String(itemId),
      ML_MARKETPLACE_KEY
    );

    if (task?.credential_id) {
      const credential = await MarketplaceCredentialRepository.findById(task.credential_id);
      if (credential?.access_token) {
        logger.info(
          `[ML Webhook] Credencial resuelta por task external_id=${itemId} credential_id=${credential.id}`
        );
        return credential;
      }
    }
  }

  const fallbackCredential = await MarketplaceCredentialRepository.findByMLUserIdGlobal(userId);
  if (fallbackCredential?.access_token) {
    logger.warn(
      `[ML Webhook] Credencial resuelta por fallback ml_user_id=${userId}; no habia task/link para item=${itemId}`
    );
  }
  return fallbackCredential;
}

async function processFalabellaWebhook(payload, options = {}) {
  const validation = validateFalabellaPayload(payload);
  if (!validation.ok) {
    logger.warn(`[FB Webhook] Payload invalido: ${validation.reason}`);
    return;
  }

  const topicRaw =
    payload?.event ||
    payload?.event_type ||
    payload?.topic ||
    payload?.type ||
    null;

  const normalizedTopic = topicRaw ? String(topicRaw).toLowerCase() : null;
  if (normalizedTopic && !FB_KNOWN_TOPICS.has(normalizedTopic)) {
    logger.info(`[FB Webhook] Ignorado topic: ${topicRaw}`);
    return;
  }

  if (normalizedTopic && FB_ORDER_TOPICS.has(normalizedTopic)) {
    await processFalabellaOrderWebhook(payload, options);
    return;
  }

  if (normalizedTopic && FB_PRODUCT_TOPICS.has(normalizedTopic)) {
    await processFalabellaProductWebhook(payload, options);
    return;
  }

  // ✅ PROCESAR EVENTOS DE FEED
  if (normalizedTopic && FB_FEED_TOPICS.has(normalizedTopic)) {
    logger.info(`[FB Webhook] Evento de feed recibido: ${topicRaw}`);
    await processFalabellaFeedWebhook(payload, normalizedTopic, options);
    return;
  }

  logger.info(`[FB Webhook] Evento ignorado: ${topicRaw}`);
}

async function processFalabellaFeedWebhook(payload, topic, options = {}) {
  const feedId = payload?.payload?.Feed || payload?.Feed || payload?.data?.Feed || null;
  
  if (!feedId) {
    logger.warn(`[FB Webhook] No se pudo extraer FeedID del payload de feed`);
    return;
  }

  logger.info(`[FB Webhook] Procesando evento de feed: ${topic}, FeedID: ${feedId}`);

  const eventId = buildFalabellaEventId(payload, `feeds/${feedId}`, topic);
  const eventResult = await createFalabellaWebhookEvent(
    payload,
    topic,
    `feeds/${feedId}`,
    eventId,
    feedId,
    getFalabellaSellerId(payload)
  );

  if (!eventResult.created) {
    logger.info(`[FB Webhook] Duplicado ignorado: feed/${feedId}`);
    return;
  }

  const event = eventResult.record;

  try {
    let credential = await resolveFalabellaCredential(payload);
    
    if (!credential || !credential.seller_email || !credential.api_key) {
      // Intentar buscar la tarea directamente por feed_id
      const task = await ProductPublishingTaskRepository.findLatestByFeedId(null, String(feedId));

      if (!task) {
        await MarketplaceWebhookEventRepository.updateById(event.id, {
          status: "error",
          error_message: "credential_not_found_and_task_not_found",
          processed_at: new Date()
        });
        logger.warn(`[FB Webhook] No se encontró credencial ni tarea para feed ${feedId}`);
        return;
      }

      const taskCredential = await MarketplaceCredentialRepository.findById(task.credential_id);
      
      if (!taskCredential || !taskCredential.seller_email || !taskCredential.api_key) {
        await MarketplaceWebhookEventRepository.updateById(event.id, {
          status: "error",
          error_message: "credential_not_found_for_task",
          processed_at: new Date()
        });
        return;
      }

      await processFeedWithCredential(taskCredential, feedId, topic, event);
      return;
    }

    // ✅ 🔑 CORRECCIÓN: Para onFeedCompleted, reintentar varias veces si no encuentra la tarea
    if (topic === 'onfeedcompleted') {
      let taskFound = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const task = await ProductPublishingTaskRepository.findLatestByFeedId(
          credential.marketplace_id,
          String(feedId)
        );
        
        if (task) {
          taskFound = true;
          break;
        }
        
        if (attempt < 3) {
          logger.info(`[FB Webhook] Tarea no encontrada aún (intento ${attempt}/3), esperando 3s...`);
          await sleep(3000);
        }
      }
      
      if (!taskFound) {
        // Último recurso: buscar por external_id (SKU)
        const taskByExternalId = await ProductPublishingTaskRepository.findLatestByExternalId(
          credential.marketplace_id,
          String(feedId)
        );
        
        if (!taskByExternalId) {
          logger.warn(`[FB Webhook] No se encontró tarea asociada al feed ${feedId} después de 3 intentos`);
          await MarketplaceWebhookEventRepository.updateById(event.id, {
            status: "processed",
            error_message: "task_not_found_for_feed_after_retries",
            processed_at: new Date()
          });
          return;
        }
      }
    }

    const taskForFeed = await ProductPublishingTaskRepository.findLatestByFeedId(
      null,
      String(feedId)
    );
    credential = await resolveFalabellaCredentialForTask(taskForFeed, credential) || credential;

    await processFeedWithCredential(credential, feedId, topic, event);

  } catch (error) {
    logger.error(`[FB Webhook] Error procesando feed ${feedId}: ${error.message}`);
    await MarketplaceWebhookEventRepository.updateById(event.id, {
      status: "error",
      error_message: error.message || 'feed_processing_error',
      processed_at: new Date()
    });
  }
}

// ✅ 🔑 MÉTODO AUXILIAR COMPLETO CORREGIDO: Procesar feed con credencial específica
async function processFeedWithCredential(credential, feedId, topic, event) {
  try {    
    const task = await ProductPublishingTaskRepository.findLatestByFeedId(
      credential.marketplace_id,
      String(feedId)
    );
    const effectiveCredential = await resolveFalabellaCredentialForTask(task, credential) || credential;

    // ✅ CORRECCIÓN: Crear adapter y asignar credencial DIRECTAMENTE
    const adapter = new FalabellaAdapter(
      effectiveCredential.marketplace_id,
      null,
      null,
      null,
      effectiveCredential.id
    );
    
    // ✅ 🔑 CLAVE: Asignar la credencial directamente al adapter
    adapter.credential = effectiveCredential;
    
    // ✅ Verificar que la credencial tenga los campos necesarios
    if (!adapter.credential?.seller_email || !adapter.credential?.api_key) {
      await MarketplaceWebhookEventRepository.updateById(event.id, {
        status: "error",
        error_message: "credential_missing_required_fields",
        processed_at: new Date()
      });
      logger.error(`[FB Webhook] Credencial incompleta: seller_email=${!!adapter.credential?.seller_email}, api_key=${!!adapter.credential?.api_key}`);
      return;
    }

    if (effectiveCredential.id !== credential.id) {
      logger.warn(`[FB Webhook] Credencial del feed ${feedId} ajustada a task_id=${task?.id || 'n/a'} credential_id=${effectiveCredential.id}`);
    }

    logger.info(`[FB Webhook] Procesando feed ${feedId} con credencial ID=${effectiveCredential.id}, seller_email=${effectiveCredential.seller_email}`);

    // ✅ Consultar estado final del feed
    const feedStatus = await adapter.fetchFeedStatus(feedId);
    
    if (!feedStatus) {
      await MarketplaceWebhookEventRepository.updateById(event.id, {
        status: "error",
        error_message: "feed_status_not_found",
        processed_at: new Date()
      });
      logger.warn(`[FB Webhook] No se pudo obtener FeedStatus para ${feedId}`);
      return;
    }

    logger.info(`[FB Webhook] FeedStatus para ${feedId}: ${JSON.stringify(feedStatus)}`);

    // ✅ Buscar la tarea asociada
    if (!task) {
      const taskByRequestId = await ProductPublishingTaskRepository.findLatestByExternalId(
        effectiveCredential.marketplace_id,
        String(feedId)
      );
      
      if (!taskByRequestId) {
        logger.warn(`[FB Webhook] No se encontró tarea asociada al feed ${feedId}`);
        await MarketplaceWebhookEventRepository.updateById(event.id, {
          status: "processed",
          error_message: "task_not_found_for_feed",
          processed_at: new Date()
        });
        return;
      }
      
      await processFeedResultForTask(taskByRequestId, adapter, feedStatus, feedId, topic);
    } else {
      await processFeedResultForTask(task, adapter, feedStatus, feedId, topic);
    }

    await MarketplaceWebhookEventRepository.updateById(event.id, {
      status: "processed",
      processed_at: new Date(),
      error_message: null
    });

  } catch (error) {
    logger.error(`[FB Webhook] Error en processFeedWithCredential: ${error.message}`, error.stack);
    await MarketplaceWebhookEventRepository.updateById(event.id, {
      status: "error",
      error_message: error.message || 'feed_processing_error',
      processed_at: new Date()
    });
  }
}

function extractFalabellaFeedStatusError(feedStatus) {
  if (!feedStatus || typeof feedStatus !== 'object') return null;

  if (feedStatus.response_type === 'ErrorResponse' || feedStatus.ok === false) {
    const errorCode = feedStatus.error_code || null;
    const errorMessage = feedStatus.error_message || null;
    const isInvalidFeedId =
      String(errorCode || '').trim().toUpperCase() === 'E012'
      || /invalid feed id/i.test(String(errorMessage || ''))
      || /feed id.*invalid/i.test(String(errorMessage || ''));

    return {
      request_action: feedStatus.request_action || 'FeedStatus',
      error_type: feedStatus.error_type || null,
      error_code: errorCode,
      error_message: errorMessage,
      is_invalid_feed_id: isInvalidFeedId,
      raw: feedStatus.raw || feedStatus
    };
  }

  const rawError = feedStatus?.raw?.ErrorResponse || feedStatus?.raw?.errorResponse || null;
  const head = rawError?.Head || rawError?.head || null;

  if (!head) return null;

  return {
    request_action: head.RequestAction || head.request_action || 'FeedStatus',
    error_type: head.ErrorType || head.error_type || null,
    error_code: head.ErrorCode || head.error_code || null,
    error_message: head.ErrorMessage || head.error_message || null,
    is_invalid_feed_id:
      String(head.ErrorCode || head.error_code || '').trim().toUpperCase() === 'E012'
      || /invalid feed id/i.test(String(head.ErrorMessage || head.error_message || '')),
    raw: feedStatus.raw || feedStatus
  };
}

function isFalabellaFeedSyncIssue(feedStatus) {
  const marketplaceError = extractFalabellaFeedStatusError(feedStatus);
  return Boolean(
    marketplaceError?.is_invalid_feed_id
    || feedStatus?.response_type === 'UnrecognizedResponse'
  );
}

async function persistFalabellaFeedReconciliationState({ task, feedId, feedStatus, topic }) {
  const currentDetails = normalizeFalabellaDetailObject(task?.error_details);
  const marketplaceError = extractFalabellaFeedStatusError(feedStatus);

  await ProductPublishingTaskRepository.updateTask(task, {
    status: task.status === 'failed' || task.status === 'deleted' ? task.status : 'processing',
    error_message: task.error_message || null,
    error_details: {
      ...currentDetails,
      feed_id: feedId,
      feed_status: feedStatus,
      marketplace_error: marketplaceError,
      feed_sync_state: 'awaiting_webhook_confirmation',
      source: 'feed_webhook',
      updated_by_webhook: topic || 'onFeedCompleted',
      falabella_raw_response: feedStatus?.raw || feedStatus
    },
    api_response: {
      feed: feedStatus
    }
  });
}

async function finalizeFalabellaTaskFromFeedError({ task, credential, feedId, feedStatus, topic, marketplaceError = null }) {
  const resolvedMarketplaceError = marketplaceError || extractFalabellaFeedStatusError(feedStatus);
  const errorMessage = resolvedMarketplaceError?.error_message || null;
  const currentDetails = normalizeFalabellaDetailObject(task?.error_details);

  await ProductPublishingTaskRepository.updateTask(task, {
    status: 'failed',
    error_message: errorMessage,
    error_details: {
      ...currentDetails,
      feed_id: feedId,
      feed_status: feedStatus,
      marketplace_error: resolvedMarketplaceError,
      source: 'feed_webhook',
      updated_by_webhook: topic || 'onFeedCompleted',
      falabella_raw_response: feedStatus?.raw || feedStatus
    },
    api_response: {
      feed: feedStatus
    }
  });

  if (task?.job?.id && task.product_id && task.marketplace_id) {
    const jobProduct = await JobProductRepository.findByProductAndMarketplace(
      task.job.id,
      task.product_id,
      task.marketplace_id,
      task.credential_id || credential?.id || null
    );

    if (jobProduct) {
      const currentJobDetails = normalizeFalabellaDetailObject(jobProduct.error_details);

      await JobProductRepository.update(jobProduct, {
        status: 'error',
        error_message: errorMessage,
        error_details: {
          ...currentJobDetails,
          feed_id: feedId,
          feed_status: feedStatus,
          marketplace_error: resolvedMarketplaceError,
          source: 'feed_webhook',
          updated_by_webhook: topic || 'onFeedCompleted',
          falabella_raw_response: feedStatus?.raw || feedStatus
        },
        task_id: task.id
      });
    }
  }

  await recalculateJobProgressFromTask(task);

  if (task.external_id) {
    let link = await ProductMarketplaceLinkRepository.findByMarketplaceExternalId(
      task.marketplace_id,
      task.external_id,
      task.company_id,
      task.branch_id,
      task.credential_id || credential?.id || null,
      task.user_id || null
    );

    if (!link && (task.company_id != null || task.branch_id != null)) {
      try {
        link = await ProductMarketplaceLinkRepository.upsert({
          product_id: task.product_id,
          marketplace_id: task.marketplace_id,
          credential_id: task.credential_id || credential?.id || null,
          user_id: task.user_id || null,
          company_id: task.company_id != null ? task.company_id : null,
          branch_id: task.branch_id != null ? task.branch_id : null,
          status: 'failed',
          external_id: task.external_id,
          external_url: null,
          published_stock: null,
          published_payload: null,
          last_synced_at: new Date()
        });
      } catch (linkError) {
        logger.warn(`[FB Webhook] No se pudo crear link fallback para task ${task.id} en error feed: ${linkError.message}`);
      }
    }

    if (link) {
      await link.update({
        status: 'failed',
        last_synced_at: new Date()
      });
    }
  }

  logger.error(
    `[FB Webhook] Falabella devolvió error terminal para feed ${feedId}: ${errorMessage || 'sin mensaje'}`
  );
}

async function processFeedResultForTask(task, adapter, feedStatus, feedId, topic) {
  const latestTask = await ProductPublishingTaskRepository.findById(task.id);
  if (latestTask && ['failed', 'deleted'].includes(latestTask.status)) {
    logger.info(`[FB Webhook] Tarea ${task.id} ya está en estado final (${latestTask.status}), no se procesa el feed ${feedId}`);
    return;
  }

  task = latestTask || task;
  const taskDetails = normalizeFalabellaDetailObject(task?.error_details);
  const imageSyncAlreadySucceeded = Boolean(
    taskDetails?.image_upload?.success === true ||
    taskDetails?.image_sync?.success === true
  );
  const imageSyncInProgress = Boolean(taskDetails?.image_sync?.in_progress === true);

  const feedStatusLower = String(feedStatus.Status || '').toLowerCase();
  const failedRecords = parseInt(feedStatus.FailedRecords || '0', 10);
  const processedRecords = parseInt(feedStatus.ProcessedRecords || '0', 10);
  const totalRecords = parseInt(feedStatus.TotalRecords || '0', 10);
  
  // ✅ NORMALIZAR ERRORES REALES DEL FEED
  const feedErrors = normalizeFeedErrors(feedStatus.FeedErrors || []);
  const feedWarnings = normalizeFeedErrors(feedStatus.FeedWarnings || []);

  if (feedStatus.response_type === 'ErrorResponse') {
    const marketplaceError = extractFalabellaFeedStatusError(feedStatus);

    if (marketplaceError?.is_invalid_feed_id) {
      logger.warn(`[FB Webhook] FeedStatus devolvió invalid feed id para ${feedId}; se conserva como reconciliación pendiente para evitar cierre prematuro.`);
      await persistFalabellaFeedReconciliationState({
        task,
        feedId,
        feedStatus,
        topic
      });
      return;
    }

    await finalizeFalabellaTaskFromFeedError({
      task,
      credential: adapter?.credential || null,
      feedId,
      feedStatus,
      topic,
      marketplaceError
    });
    return;
  }

  if (feedStatus.response_type === 'UnrecognizedResponse') {
    await persistFalabellaFeedReconciliationState({
      task,
      feedId,
      feedStatus,
      topic
    });

    logger.warn(`[FB Webhook] FeedStatus de Falabella no reconocido para ${feedId}; se conserva la respuesta cruda sin inferir un estado terminal.`);
    return;
  }

  const taskPayload = normalizeTaskPayload(task?.payload);
  const sellerSku = taskPayload?.sku || taskPayload?.SellerSku || task.external_id || null;

  if (!sellerSku) {
    logger.warn(`[FB Webhook] No se pudo extraer SellerSku de la tarea ${task.id}`);
    return;
  }

  if (
    (feedStatusLower !== 'finished' || processedRecords <= 0)
    && feedStatusLower !== 'error'
    && feedStatusLower !== 'canceled'
    && failedRecords <= 0
  ) {
    logger.info(`[FB Webhook] Feed ${feedId}: estado ${feedStatusLower} con ${processedRecords}/${totalRecords} procesados; se evalúa subida temprana de imágenes para ${sellerSku}`);

    const taskImages = extractFalabellaTaskImages(
      task,
      { images: taskPayload?.images, images_with_version: taskPayload?.images_with_version },
      sellerSku,
      adapter
    );
    logger.info(`[FB Webhook] Feed ${feedId}: imágenes recuperadas para ${sellerSku}: ${taskImages.length}`);

    let currentStatus = await fetchFalabellaProductStatusWithRetry(adapter, sellerSku, { attempts: 2, delayMs: 1500 });
    let imageUploadResult = null;
    const taskDetails = normalizeFalabellaDetailObject(task?.error_details);
    const imageSyncAlreadySucceeded = Boolean(
      taskDetails?.image_upload?.success === true ||
      taskDetails?.image_sync?.success === true
    );
    const imageSyncInProgress = Boolean(taskDetails?.image_sync?.in_progress === true);

    logger.info(`[FB Webhook] Feed ${feedId}: pre-check imágenes para ${sellerSku}: ${JSON.stringify({
      task_status: task.status,
      product_found: currentStatus?.found,
      has_image: currentStatus?.has_image,
      images_found: taskImages.length,
      image_sync_already_succeeded: imageSyncAlreadySucceeded
    })}`);

    if (shouldAttemptFalabellaImageSync({
      productStatus: currentStatus,
      taskImages,
      imageSyncAlreadySucceeded,
      imageSyncInProgress
    })) {
      const imageSyncLock = await acquireFalabellaImageSyncLock(task, topic || 'feed_webhook');

      if (imageSyncLock.acquired) {
        logger.info(`[FB Webhook] Feed ${feedId}: SKU ${sellerSku} sin imagen, asociando ${taskImages.length} imagen(es) via Action=Image`);
        const imageUploadResult = await adapter.uploadProductImages(sellerSku, taskImages);
        logger.info(`[FB Webhook] Feed ${feedId}: Resultado Action=Image para ${sellerSku}: ${JSON.stringify(imageUploadResult)}`);

        await finalizeFalabellaImageSyncState(
          imageSyncLock.task,
          imageSyncLock.taskDetails,
          imageUploadResult,
          topic || 'feed_webhook'
        );
      } else if (imageSyncLock.alreadySucceeded) {
        logger.info(`[FB Webhook] Feed ${feedId}: SKU ${sellerSku} ya tenía sincronización de imágenes confirmada; se omite Action=Image`);
      } else {
        logger.info(`[FB Webhook] Feed ${feedId}: SKU ${sellerSku} ya tiene sincronización de imágenes en progreso; se omite Action=Image`);
      }
    } else {
      logger.info(`[FB Webhook] Feed ${feedId}: SKU ${sellerSku}: no se ejecuta Action=Image porque ${JSON.stringify({
        found: currentStatus?.found ?? null,
        has_image: currentStatus?.has_image ?? null,
        images_found: taskImages.length,
        image_sync_already_succeeded: imageSyncAlreadySucceeded,
        image_sync_in_progress: imageSyncInProgress,
        terminal_status: currentStatus?.status || null
      })}`);
    }

    await persistFalabellaFeedReconciliationState({
      task,
      feedId,
      feedStatus,
      topic
    });

    return;
  }

  // ✅ Si el feed terminó con errores, guardar errores REALES
  if (feedStatusLower === 'error' || feedStatusLower === 'canceled' || failedRecords > 0) {
    // ✅ Construir mensaje con errores REALES
    const realErrorMessage = feedErrors.length > 0
      ? feedErrors.map(e => {
          const field = e.field ? `${e.field}: ` : '';
          return `${field}${e.message}`;
        }).join(' | ')
      : null;

    logger.error(`[FB Webhook] Feed ${feedId} falló: ${realErrorMessage}`);

    await ProductPublishingTaskRepository.updateTask(task, {
      status: 'failed',
      error_message: realErrorMessage, // ✅ GUARDAR ERROR REAL
      error_details: {
        feed_id: feedId,
        feed_status: feedStatus,
        feed_errors: feedErrors, // ✅ GUARDAR ERRORES REALES ESTRUCTURADOS
        feed_warnings: feedWarnings,
        failed_records: failedRecords,
        processed_records: processedRecords,
        total_records: totalRecords,
        marketplace_error: extractFalabellaFeedStatusError(feedStatus),
        source: 'feed_webhook',
        // ✅ GUARDAR RESPONSE COMPLETO DE FALABELLA
        falabella_raw_response: feedStatus
      },
      api_response: feedStatus
    });
    await recalculateJobProgressFromTask(task);

    if (task.external_id) {
      let link = await ProductMarketplaceLinkRepository.findByMarketplaceExternalId(
        task.marketplace_id,
        task.external_id,
        task.company_id,
        task.branch_id,
        task.credential_id || credential?.id || null,
        task.user_id || null
      );

      if (!link && (task.company_id != null || task.branch_id != null)) {
        try {
          link = await ProductMarketplaceLinkRepository.upsert({
            product_id: task.product_id,
            marketplace_id: task.marketplace_id,
            credential_id: task.credential_id || credential?.id || null,
            user_id: task.user_id || null,
            company_id: task.company_id != null ? task.company_id : null,
            branch_id: task.branch_id != null ? task.branch_id : null,
            status: 'failed',
            external_id: task.external_id,
            external_url: null,
            published_stock: null,
            published_payload: null,
            last_synced_at: new Date()
          });
        } catch (linkError) {
          logger.warn(`[FB Webhook] No se pudo crear link fallback para task ${task.id} en error feed: ${linkError.message}`);
        }
      }

      if (link) {
        await link.update({
          status: 'failed',
          last_synced_at: new Date()
        });
      }
    }

    return;
  }

  // ✅ Si el feed terminó exitosamente, consultar estado REAL del producto
  if (feedStatusLower === 'finished' && processedRecords > 0) {
    // ✅ Consultar estado REAL del producto en Falabella
    let productStatus = await fetchFalabellaProductStatusWithRetry(adapter, sellerSku);
    
    logger.info(`[FB Webhook] Estado REAL del producto ${sellerSku}: ${JSON.stringify(productStatus)}`);

    // ✅ EXTRAER ERRORES REALES del raw response
    let realErrors = FalabellaAdapter.extractRealFalabellaErrors(productStatus.raw || {});
    const taskImages = extractFalabellaTaskImages(task, { images: taskPayload?.images, images_with_version: taskPayload?.images_with_version }, sellerSku, adapter);
    logger.info(`[FB Webhook] Feed ${feedId}: imágenes recuperadas para ${sellerSku}: ${taskImages.length}`);
    let imageUploadResult = null;
    let hasImage = productStatus.has_image !== false;

    logger.info(`[FB Webhook] Feed ${feedId}: pre-check imágenes para ${sellerSku}: ${JSON.stringify({
      task_status: task.status,
      product_found: productStatus.found,
      has_image: productStatus.has_image,
      images_found: taskImages.length,
      image_sync_already_succeeded: imageSyncAlreadySucceeded
    })}`);

    if (shouldAttemptFalabellaImageSync({
      productStatus,
      taskImages,
      imageSyncAlreadySucceeded,
      imageSyncInProgress
    })) {
      const imageSyncLock = await acquireFalabellaImageSyncLock(task, topic || 'feed_webhook');

      if (imageSyncLock.acquired) {
        logger.info(`[FB Webhook] Feed ${feedId}: SKU ${sellerSku} sin imagen, asociando ${taskImages.length} imagen(es) via Action=Image`);
        imageUploadResult = await adapter.uploadProductImages(sellerSku, taskImages);
        logger.info(`[FB Webhook] Feed ${feedId}: Resultado Action=Image para ${sellerSku}: ${JSON.stringify(imageUploadResult)}`);

        await finalizeFalabellaImageSyncState(
          imageSyncLock.task,
          imageSyncLock.taskDetails,
          imageUploadResult,
          topic || 'feed_webhook'
        );

        if (imageUploadResult?.success) {
          await sleep(2000);
          productStatus = await fetchFalabellaProductStatusWithRetry(adapter, sellerSku, { attempts: 2, delayMs: 2000 });
          realErrors = FalabellaAdapter.extractRealFalabellaErrors(productStatus.raw || {});
          hasImage = productStatus.has_image !== false;
        }
      } else if (imageSyncLock.alreadySucceeded) {
        logger.info(`[FB Webhook] Feed ${feedId}: SKU ${sellerSku} ya tenía sincronización de imágenes confirmada; se omite Action=Image`);
      } else {
        logger.info(`[FB Webhook] Feed ${feedId}: SKU ${sellerSku} ya tiene sincronización de imágenes en progreso; se omite Action=Image`);
      }
    } else if (!imageSyncAlreadySucceeded && productStatus.found && productStatus.has_image === false) {
      logger.warn(`[FB Webhook] Feed ${feedId}: SKU ${sellerSku} sin imagen, pero no hay imágenes guardadas en la tarea ${task.id}`);
    }
    
    const lifecycle = determineFalabellaTaskLifecycle(productStatus, {
      realErrors,
      hasImage
    });
    const finalStatus = lifecycle.status;
    const realErrorMessage = lifecycle.errorMessage;

    // ✅ Preparar datos de actualización con errores REALES
    const updateData = {
      status: finalStatus,
      error_message: realErrorMessage, // ✅ GUARDAR ERROR REAL
      error_details: {
        feed_id: feedId,
        feed_status: feedStatus,
        product_status: productStatus,
        image_upload: imageUploadResult,
        feed_warnings: feedWarnings,
        source: 'feed_webhook',
        qc_status: productStatus.qc_status,
        qc_reason: productStatus.qc_reason || null,
        marketplace_status: productStatus.status,
        is_published: productStatus.is_published,
        has_image: hasImage,
        image_sync: imageUploadResult?.success
          ? {
              attempted: true,
              success: true,
              request_id: imageUploadResult.request_id || null,
              images_count: imageUploadResult.images_count || taskImages.length
            }
          : (imageSyncAlreadySucceeded ? taskDetails?.image_sync || { attempted: true, success: true } : null),
        // ✅ GUARDAR ERRORES REALES EXTRAÍDOS
        real_errors: realErrors,
        product_errors: productStatus.product_errors || [],
        // ✅ GUARDAR RESPONSE COMPLETO DE FALABELLA
        falabella_raw_response: productStatus.raw
      },
      api_response: {
        feed: feedStatus,
        product: productStatus
      }
    };

    if (productStatus.url) {
      updateData.external_url = productStatus.url;
    }

    await ProductPublishingTaskRepository.updateTask(task, updateData);
    await recalculateJobProgressFromTask(task);

    if (task.external_id) {
      let link = await ProductMarketplaceLinkRepository.findByMarketplaceExternalId(
        task.marketplace_id,
        task.external_id,
        task.company_id,
        task.branch_id,
        task.credential_id || credential?.id || null,
        task.user_id || null
      );

      if (!link && (task.company_id != null || task.branch_id != null)) {
        try {
          link = await ProductMarketplaceLinkRepository.upsert({
            product_id: task.product_id,
            marketplace_id: task.marketplace_id,
            credential_id: task.credential_id || credential?.id || null,
            user_id: task.user_id || null,
            company_id: task.company_id != null ? task.company_id : null,
            branch_id: task.branch_id != null ? task.branch_id : null,
            status: finalStatus === 'published' ? 'active' : finalStatus,
            external_id: task.external_id,
            external_url: productStatus.url || null,
            published_stock: productStatus.stock ?? null,
            published_payload: productStatus.raw || null,
            last_synced_at: new Date()
          });
        } catch (linkError) {
          logger.warn(`[FB Webhook] No se pudo crear link fallback para task ${task.id}: ${linkError.message}`);
        }
      }

      if (link) {
        await link.update({
          status: finalStatus === 'published' ? 'active' : finalStatus,
          external_url: productStatus.url || link.external_url,
          published_stock: productStatus.stock ?? link.published_stock,
          published_payload: productStatus.raw || link.published_payload,
          last_synced_at: new Date()
        });
      }
    }

    logger.info(`[FB Webhook] ✅ Tarea ${task.id} actualizada: ${finalStatus} - ${realErrorMessage || 'Sin errores'}`);
  }
}

// ✅ NUEVA FUNCIÓN: Normalizar errores del feed
function normalizeFeedErrors(errors) {
  if (!errors) return [];
  
  // Manejar diferentes estructuras de errores
  let errorList = [];
  
  if (Array.isArray(errors)) {
    errorList = errors;
  } else if (errors.Error) {
    errorList = Array.isArray(errors.Error) ? errors.Error : [errors.Error];
  } else if (errors.Warning) {
    errorList = Array.isArray(errors.Warning) ? errors.Warning : [errors.Warning];
  } else if (typeof errors === 'object') {
    errorList = [errors];
  }
  
  return errorList.map(err => {
    if (typeof err === 'string') {
      return { message: err, code: null, field: null };
    }
    
    return {
      code: err.Code || err.code || null,
      message: err.Message || err.message || err.error || String(err),
      field: err.Field || err.field || err.Attribute || err.attribute || null,
      sku: err.SellerSku || err.sku || null
    };
  });
}

async function processFalabellaOrderWebhook(payload, options = {}) {
  const orderId = extractFalabellaOrderId(payload);
  if (!orderId) {
    logger.warn(`[FB Webhook] No se pudo extraer OrderId del payload`);
    return;
  }

  const resource = payload?.resource || `orders/${orderId}`;
  const topic = payload?.event || payload?.event_type || payload?.topic || payload?.type || "onOrderCreated";

  const eventId = buildFalabellaEventId(payload, resource, topic);
  const eventResult = await createFalabellaWebhookEvent(
    payload,
    topic,
    resource,
    eventId,
    orderId,
    getFalabellaSellerId(payload)
  );

  if (!eventResult.created) {
    logger.info(`[FB Webhook] Duplicado ignorado: ${resource}`);
    return;
  }

  const event = eventResult.record;

  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : FB_WEBHOOK_TIMEOUT_MS;

  const processPromise = processFalabellaEvent({ event, payload, orderId });

  try {
    await withTimeout(processPromise, timeoutMs);
  } catch (error) {
    const isTimeout = error?.message === "timeout";
    await MarketplaceWebhookEventRepository.updateById(event.id, {
      status: isTimeout ? "timeout" : "error",
      error_message: isTimeout
        ? `timeout:${timeoutMs}ms`
        : `processing_error:${error?.message || "unknown"}`,
      processed_at: new Date()
    });
    logger.error(
      `[FB Webhook] ${isTimeout ? "Timeout" : "Error"} procesando evento: ${error.message}`
    );
  }
}

async function processFalabellaProductWebhook(payload, options = {}) {
  const sellerSku = extractFalabellaSellerSku(payload);
  if (!sellerSku) {
    logger.warn(`[FB Webhook] No se pudo extraer SellerSku del payload de producto`);
    return;
  }

  const resource = payload?.resource || `products/${sellerSku}`;
  const topic = payload?.event || payload?.event_type || payload?.topic || payload?.type || "onProductUpdated";
  const normalizedTopic = normalizeFalabellaTopicName(topic);
  const eventId = buildFalabellaEventId(payload, resource, topic);
  const eventResult = await createFalabellaWebhookEvent(
    payload,
    topic,
    resource,
    eventId,
    sellerSku,
    getFalabellaSellerId(payload)
  );

  if (!eventResult.created) {
    logger.info(`[FB Webhook] Duplicado ignorado: ${resource}`);
    return;
  }

  const event = eventResult.record;
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : FB_WEBHOOK_TIMEOUT_MS;

  try {
    let credential = await resolveFalabellaCredential(payload);
    if (!credential || !credential.seller_email || !credential.api_key) {
      await MarketplaceWebhookEventRepository.updateById(event.id, {
        status: "error",
        error_message: "credential_not_found",
        processed_at: new Date()
      });
      logger.warn(`[FB Webhook] Credencial Falabella no encontrada para producto ${sellerSku}`);
      return;
    }

    const taskForSku = await ProductPublishingTaskRepository.findLatestByExternalIdAndContext({
      marketplaceId: credential.marketplace_id || null,
      externalId: String(sellerSku),
      credentialId: credential.id || null,
      companyId: credential.company_id || null,
      branchId: credential.branch_id || null
    }) || await ProductPublishingTaskRepository.findLatestByExternalId(
      credential.marketplace_id || null,
      String(sellerSku)
    );
    credential = await resolveFalabellaCredentialForTask(taskForSku, credential) || credential;

    // ✅ 🔑 CORRECCIÓN: Esperar un poco antes de consultar el producto
    // Falabella necesita tiempo para procesar el producto después del feed
    if (normalizedTopic === 'onproductupdated' || normalizedTopic === 'onproductqcstatuschanged') {
      logger.info(`[FB Webhook] ${normalizedTopic} recibido para SKU ${sellerSku}, esperando 3s antes de consultar...`);
      await sleep(3000);
    }

    const adapter = new FalabellaAdapter(
      credential.marketplace_id,
      null,
      null,
      null,
      credential.id
    );
    adapter.credential = credential;

    const taskImages = extractFalabellaTaskImages(taskForSku, payload, sellerSku, adapter);
    logger.info(`[FB Webhook] Producto ${sellerSku}: imágenes recuperadas desde tarea/payload: ${taskImages.length}`);

    const fetchProduct = normalizedTopic === 'onproductcreated'
      ? fetchFalabellaProduct
      : fetchFalabellaProductWithRetry;
    const fetchPromise = fetchProduct(sellerSku, credential);
    let product = await withTimeout(fetchPromise, timeoutMs);

    if (!product) {
      await MarketplaceWebhookEventRepository.updateById(event.id, {
        status: "processed",
        error_message: null,
        processed_at: new Date()
      });
      logger.info(`[FB Webhook] Producto ${sellerSku} aún no visible en GetProducts tras ${normalizedTopic}; se deja sin acción de imagen`);
      return;
    }

    let effectiveProduct = product.__falabella_not_found
      ? {
          SellerSku: sellerSku,
          BusinessUnits: {
            BusinessUnit: {
              Status: "deleted",
              Stock: 0,
              Price: 0
            }
          }
        }
      : product;

    let imageUploadResult = null;
    let currentStatus = normalizedTopic === 'onproductcreated'
      ? await adapter.fetchProductStatus(sellerSku)
      : (!effectiveProduct.__falabella_not_found
        ? await fetchFalabellaProductStatusWithRetry(adapter, sellerSku)
        : null);

    if (normalizedTopic === 'onproductcreated' && !currentStatus?.found) {
      await MarketplaceWebhookEventRepository.updateById(event.id, {
        status: "processed",
        error_message: null,
        processed_at: new Date()
      });
      logger.info(`[FB Webhook] onProductCreated recibido para ${sellerSku} pero GetProducts aún no lo expone; se pospone Action=Image hasta un evento posterior`);
      return;
    }

    const taskDetails = normalizeFalabellaDetailObject(taskForSku?.error_details);
    const imageSyncAlreadySucceeded = Boolean(
      taskDetails?.image_upload?.success === true ||
      taskDetails?.image_sync?.success === true
    );
    const imageSyncInProgress = Boolean(taskDetails?.image_sync?.in_progress === true);
    logger.info(`[FB Webhook] SKU ${sellerSku}: contexto imagen=${JSON.stringify({
      task_id: taskForSku?.id || null,
      task_status: taskForSku?.status || null,
      task_credential_id: taskForSku?.credential_id || null,
      task_credential_email: taskForSku?.credential?.seller_email || null,
      current_credential_id: credential?.id || null,
      current_credential_email: credential?.seller_email || null,
      product_found: !!taskForSku,
      images_found: taskImages.length,
      has_image: currentStatus?.has_image,
      should_attempt: shouldAttemptFalabellaImageSync({
        productStatus: currentStatus,
        taskImages,
        imageSyncAlreadySucceeded,
        imageSyncInProgress
      })
    })}`);

    if (shouldAttemptFalabellaImageSync({
      productStatus: currentStatus,
      taskImages,
      imageSyncAlreadySucceeded,
      imageSyncInProgress
    })) {
      const imageSyncLock = await acquireFalabellaImageSyncLock(taskForSku, normalizedTopic || topic);

      if (imageSyncLock.acquired) {
        logger.info(`[FB Webhook] SKU ${sellerSku} sin imagen en Falabella, asociando ${taskImages.length} imagen(es) via Action=Image`);
        imageUploadResult = await adapter.uploadProductImages(sellerSku, taskImages);
        logger.info(`[FB Webhook] Resultado Action=Image para ${sellerSku}: ${JSON.stringify(imageUploadResult)}`);

        await finalizeFalabellaImageSyncState(
          imageSyncLock.task,
          imageSyncLock.taskDetails,
          imageUploadResult,
          normalizedTopic || topic
        );

        if (imageUploadResult?.success) {
          await sleep(2000);
          currentStatus = await fetchFalabellaProductStatusWithRetry(adapter, sellerSku, { attempts: 2, delayMs: 2000 });
          if (currentStatus?.raw) {
            effectiveProduct = currentStatus.raw;
          }
        }
      } else if (imageSyncLock.alreadySucceeded) {
        logger.info(`[FB Webhook] SKU ${sellerSku} ya tenía sincronización de imágenes confirmada; se omite Action=Image`);
      } else {
        logger.info(`[FB Webhook] SKU ${sellerSku} ya tiene sincronización de imágenes en progreso; se omite Action=Image`);
      }
    } else {
      logger.info(`[FB Webhook] SKU ${sellerSku}: no se ejecuta Action=Image porque ${JSON.stringify({
        found: currentStatus?.found ?? null,
        has_image: currentStatus?.has_image ?? null,
        images_found: taskImages.length,
        image_sync_already_succeeded: imageSyncAlreadySucceeded,
        image_sync_in_progress: imageSyncInProgress,
        terminal_status: currentStatus?.status || null
      })}`);
    }

    if (currentStatus?.raw) {
      effectiveProduct = currentStatus.raw;
    }

    const persistResult = await persistFalabellaProductState({
      credential,
      sellerSku,
      product: effectiveProduct,
      payload,
      imageUploadResult,
      task: taskForSku
    });

    // ✅ 🔑 NUEVO: Si se encontró la tarea, actualizarla con el estado real del producto
    if (persistResult.taskUpdated && persistResult.taskId) {
      const task = await ProductPublishingTaskRepository.findById(persistResult.taskId);
      if (task && ['pending', 'processing', 'published_with_warnings', 'published'].includes(task.status)) {
        const snapshot = persistResult.snapshot || {};
        const qcStatus = snapshot.qc_status || null;
        const productStatus = snapshot.status || null;
        const lifecycle = determineFalabellaTaskLifecycle(snapshot, {
          realErrors: Array.isArray(snapshot.product_errors) ? snapshot.product_errors : [],
          hasImage: snapshot.has_image !== false
        });

        const nextStatus = task.status === 'published' && lifecycle.status === 'processing'
          ? 'published'
          : lifecycle.status;
        let statusMessage = lifecycle.errorMessage;

        if (!statusMessage) {
          if (nextStatus === 'published') {
            statusMessage = 'Producto aprobado y activo';
          } else if (nextStatus === 'failed' && qcStatus) {
            statusMessage = `Producto rechazado o desactivado: ${qcStatus}`;
          } else if (nextStatus === 'processing' && qcStatus) {
            statusMessage = `Producto pendiente de aprobación QC: ${qcStatus}`;
          }
        }

        await ProductPublishingTaskRepository.updateTask(task, {
          status: nextStatus,
          error_message: statusMessage,
          error_details: {
            ...normalizeFalabellaDetailObject(task.error_details),
            qc_status: qcStatus,
            qc_reason: snapshot.qc_reason || null,
            marketplace_status: productStatus,
            has_image: snapshot.has_image !== false,
            product_errors: snapshot.product_errors || [],
            updated_by_webhook: normalizedTopic || topic,
            updated_at: new Date().toISOString()
          }
        });

        // ✅ Actualizar link
    if (task.external_id) {
      let link = await ProductMarketplaceLinkRepository.findByMarketplaceExternalId(
        task.marketplace_id,
        task.external_id,
        task.company_id,
        task.branch_id,
        task.credential_id || credential?.id || null,
        task.user_id || null
      );

      if (!link && (task.company_id != null || task.branch_id != null)) {
        try {
          link = await ProductMarketplaceLinkRepository.upsert({
            product_id: task.product_id,
            marketplace_id: task.marketplace_id,
            credential_id: task.credential_id || credential?.id || null,
            user_id: task.user_id || null,
          company_id: task.company_id != null ? task.company_id : null,
          branch_id: task.branch_id != null ? task.branch_id : null,
            status: nextStatus === 'published' ? 'active' : nextStatus,
            external_id: task.external_id,
            external_url: snapshot.url || null,
            published_stock: snapshot.stock ?? null,
            published_payload: snapshot.raw || null,
            last_synced_at: new Date()
          });
        } catch (linkError) {
          logger.warn(`[FB Webhook] No se pudo crear link fallback para task ${task.id}: ${linkError.message}`);
        }
      }
      if (link) {
        await link.update({
          status: nextStatus === 'published' ? 'active' : nextStatus,
          external_url: snapshot.url || link.external_url,
          published_stock: snapshot.stock ?? link.published_stock,
          published_payload: snapshot.raw || link.published_payload,
          last_synced_at: new Date()
        });
      }
    }

        logger.info(`[FB Webhook] ✅ Tarea ${task.id} actualizada por webhook ${normalizedTopic || topic}: ${nextStatus} - ${statusMessage}`);
      }
    }

    await MarketplaceWebhookEventRepository.updateById(event.id, {
      status: "processed",
      processed_at: new Date(),
      error_message: null
    });

    logger.info(
      `[FB Webhook] Producto ${sellerSku} sincronizado: ${persistResult.snapshot.status || 'unknown'}${persistResult.snapshot.qc_status ? ` (${persistResult.snapshot.qc_status})` : ''}`
    );
  } catch (error) {
    const isTimeout = error?.message === "timeout";
    await MarketplaceWebhookEventRepository.updateById(event.id, {
      status: isTimeout ? "timeout" : "error",
      error_message: isTimeout
        ? `timeout:${timeoutMs}ms`
        : `processing_error:${error?.message || "unknown"}`,
      processed_at: new Date()
    });
    logger.error(
      `[FB Webhook] ${isTimeout ? "Timeout" : "Error"} procesando producto ${sellerSku}: ${error.message}`
    );
  }
}

async function processFalabellaEvent({ event, payload, orderId }) {
  const existingOrderRecord = await MarketplaceOrderRepository.findByMarketplaceOrderId(
    FB_MARKETPLACE_KEY,
    String(orderId)
  );

  let credential = null;
  if (existingOrderRecord?.marketplace_credential_id) {
    credential = await MarketplaceCredentialRepository.findById(existingOrderRecord.marketplace_credential_id);
  }

  if (!credential || !credential.seller_email || !credential.api_key) {
    credential = await resolveFalabellaCredential(payload);
  }

  if (!credential || !credential.seller_email || !credential.api_key) {
    await MarketplaceWebhookEventRepository.updateById(event.id, {
      status: "error",
      error_message: "credential_not_found",
      processed_at: new Date()
    });
    logger.warn(`[FB Webhook] Credencial Falabella no encontrada`);
    return;
  }

  const orderData = await fetchFalabellaOrderWithRetry(orderId, credential);
  if (!orderData) {
    await MarketplaceWebhookEventRepository.updateById(event.id, {
      status: "error",
      error_message: "order_fetch_failed",
      processed_at: new Date()
    });
    return;
  }

  // ✅ PARSEAR DATOS DE LA ORDEN COMPLETA
  const orderInfo = parseFalabellaOrderInfo(orderData);
  const items = parseFalabellaOrderItems(orderData);

  if (items.length === 0) {
    await MarketplaceWebhookEventRepository.updateById(event.id, {
      status: "processed_with_errors",
      error_message: "order_items_empty",
      processed_at: new Date()
    });
    return;
  }

  // ✅ RESOLVER COMPAÑÍA DESDE EL PRIMER SKU DE LA ORDEN
  // Las credenciales son globales, el company_id viene del producto/link
  const firstSku = items[0]?.sku;
  const companyInfo = await resolveCompanyFromListing(FB_MARKETPLACE_KEY, firstSku);
  const companyId = companyInfo?.company_id || null;
  const branchId = companyInfo?.branch_id || null;
  const publicationUserId = companyInfo?.user_id || credential.user_id || null;
  const existingOrder = await MarketplaceOrderRepository.findByMarketplaceOrderId(
    FB_MARKETPLACE_KEY,
    String(orderId)
  );
  const customerSnapshot = buildFalabellaCustomerSnapshot({
    orderData,
    orderInfo,
    orderId
  });

  // ✅ GUARDAR ORDEN EN marketplace_orders
  const orderDataToSave = {
    marketplace: FB_MARKETPLACE_KEY,
    marketplace_order_id: String(orderId),
    marketplace_credential_id: credential.id,
    user_id: publicationUserId,
    company_id: companyId,
    branch_id: branchId,
    order_status: mapFalabellaOrderStatus(orderInfo.status),
    payment_status: 'pending', // Falabella no expone estado de pago directamente
    subtotal: orderInfo.subtotal || 0,
    shipping_total: orderInfo.shippingTotal || 0,
    discount_total: orderInfo.discountTotal || 0,
    tax_total: orderInfo.taxTotal || 0,
    total_amount: orderInfo.totalAmount || 0,
    currency: 'CLP',
    buyer_id: customerSnapshot.marketplace_customer_id || null,
    buyer_name: customerSnapshot.full_name || orderInfo.buyerName || null,
    buyer_email: customerSnapshot.email || null,
    buyer_document: customerSnapshot.document_number || null,
    shipping_address:
      buildAddressLine([
        customerSnapshot.shipping_address_line,
        customerSnapshot.shipping_address_line_2,
        customerSnapshot.shipping_reference
      ]) || orderInfo.shippingAddress || null,
    shipping_city: customerSnapshot.shipping_city || orderInfo.shippingCity || null,
    shipping_region: customerSnapshot.shipping_state || orderInfo.shippingRegion || null,
    raw_payload: orderData
  };

  let savedOrder;
  let orderCreated = false;
  let previousOrderStatus = existingOrder?.order_status || null;
  
  try {
    const result = await MarketplaceOrderRepository.upsert(orderDataToSave);
    savedOrder = await MarketplaceOrderRepository.findById(result.record.id);
    orderCreated = result.created;
  } catch (error) {
    logger.error(`[FB Webhook] Error guardando orden ${orderId}: ${error.message}`);
    await MarketplaceWebhookEventRepository.updateById(event.id, {
      status: "error",
      error_message: `order_save_failed: ${error.message}`,
      processed_at: new Date()
    });
    return;
  }

  const currentOrderStatus = savedOrder?.order_status || orderDataToSave.order_status;
  const currentPaymentStatus = savedOrder?.payment_status || orderDataToSave.payment_status;
  const stockState = await getMarketplaceOrderStockState(
    FB_MARKETPLACE_KEY,
    savedOrder.id
  );
  const lifecycle = getMarketplaceOrderLifecycleDecision({
    orderStatus: currentOrderStatus,
    paymentStatus: currentPaymentStatus
  });
  const shouldDeductStock = lifecycle.shouldDeduct && !stockState.hasDeduction && !stockState.hasReversal;
  const shouldReverseStock = lifecycle.shouldReverse && stockState.hasDeduction && stockState.pendingReversalCount > 0;
  const statusChanged = previousOrderStatus !== currentOrderStatus;

  // ✅ GUARDAR EVENTOS DE ESTADO
  if (orderCreated) {
    await MarketplaceOrderEventRepository.createStatusChange(
      savedOrder.id,
      'created',
      null,
      currentOrderStatus,
      orderData,
      { company_id: companyId }
    );
  } else if (statusChanged) {
    await MarketplaceOrderEventRepository.createStatusChange(
      savedOrder.id,
      currentOrderStatus,
      previousOrderStatus,
      currentOrderStatus,
      orderData,
      { company_id: companyId }
    );
  }

  await persistMarketplaceOrderCustomerSnapshot(savedOrder, customerSnapshot, "FB Webhook");

  const errors = [];
  const savedItems = [];

  if (shouldDeductStock) {
    // ✅ PROCESAR CADA ITEM SOLO EN PRIMERA VENTA PAGADA
    for (const item of items) {
      try {
        const itemResult = await processFalabellaOrderItem(item, {
          orderId,
          marketplaceId: credential.marketplace_id,
          companyId,
          branchId,
          orderIdLocal: savedOrder.id,
          itemData: item // Pasar datos completos del item
        });
        
        if (itemResult) {
          savedItems.push(itemResult);
        }
      } catch (error) {
        errors.push(error.message);
        logger.error(`[FB Webhook] Item error order=${orderId}: ${error.message}`);
      }
    }

    // ✅ GUARDAR FEES TOTALES DE LA ORDEN (comisiones)
    if (savedOrder && orderInfo.commission > 0) {
      try {
        await MarketplaceOrderFeeRepository.create({
          order_id: savedOrder.id,
          company_id: companyId,
          fee_type: 'commission',
          amount: orderInfo.commission,
          percentage: orderInfo.totalAmount > 0 ? (orderInfo.commission / orderInfo.totalAmount) * 100 : 0,
          status: 'pending',
          description: `Comisión Falabella - Orden ${orderId}`,
          raw_data: { commission: orderInfo.commission }
        });
      } catch (error) {
        logger.error(`[FB Webhook] Error guardando fees de orden ${orderId}: ${error.message}`);
      }
    }

    await MarketplaceOrderEventRepository.create({
      order_id: savedOrder.id,
      event_type: STOCK_DEDUCT_EVENT_TYPE,
      previous_status: previousOrderStatus,
      new_status: currentOrderStatus,
      raw_payload: orderData,
      notes: `Stock debitado por orden Falabella ${orderId}`,
      company_id: companyId
    });
  }

  if (shouldReverseStock) {
    const reversalResult = await reverseMarketplaceOrderStock({
      order: savedOrder,
      marketplaceKey: FB_MARKETPLACE_KEY,
      orderId,
      reason: 'falabella_reversal',
      payload: orderData,
      sourceMarketplaceId: credential.marketplace_id,
      includeSourceMarketplace: true
    });

    if (reversalResult.errors.length > 0) {
      errors.push(...reversalResult.errors);
    }

    if (reversalResult.completed) {
      await MarketplaceOrderEventRepository.create({
        order_id: savedOrder.id,
        event_type: STOCK_REVERSE_EVENT_TYPE,
        previous_status: previousOrderStatus,
        new_status: currentOrderStatus,
        raw_payload: orderData,
        notes: `Stock revertido por estado ${currentOrderStatus} en orden Falabella ${orderId}`,
        company_id: companyId
      });
    }
  }

  await MarketplaceWebhookEventRepository.updateById(event.id, {
    status: errors.length > 0 ? "processed_with_errors" : "processed",
    error_message: errors.length > 0 ? errors.slice(0, 5).join(" | ") : null,
    processed_at: new Date()
  });
}

async function resolveFalabellaCredential(payload) {
  const sellerId = getFalabellaSellerId(payload);
  const sellerEmail =
    payload?.seller_email ||
    payload?.sellerEmail ||
    payload?.UserID ||
    payload?.user_id ||
    payload?.userId ||
    null;

  const byIdOrEmail = await MarketplaceCredentialRepository.findActiveFalabellaBySellerIdOrEmail({
    sellerId: sellerId || null,
    sellerEmail: sellerEmail || null
  });
  if (byIdOrEmail) return byIdOrEmail;

  return await MarketplaceCredentialRepository.findSingleActiveFalabella();
}

async function resolveFalabellaCredentialForTask(task, fallbackCredential = null) {
  const taskCredentialId = task?.credential_id || task?.credential?.id || null;

  if (taskCredentialId) {
    const taskCredential = await MarketplaceCredentialRepository.findById(taskCredentialId);

    if (taskCredential?.seller_email && taskCredential?.api_key) {
      return taskCredential;
    }
  }

  return fallbackCredential;
}

async function fetchFalabellaOrderWithRetry(orderId, credential) {
  let lastError = null;

  for (let attempt = 1; attempt <= FB_FETCH_RETRY_MAX; attempt++) {
    try {
      const response = await fetchFalabellaOrder(orderId, credential);
      if (response) return response;
      lastError = new Error("empty_response");
    } catch (error) {
      lastError = error;
    }

    if (attempt < FB_FETCH_RETRY_MAX) {
      const delayMs = Math.min(
        FB_FETCH_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1),
        FB_FETCH_RETRY_MAX_DELAY_MS
      );
      logger.warn(
        `[FB Webhook] Intento ${attempt}/${FB_FETCH_RETRY_MAX} fallido para orden ${orderId}. Reintentando en ${delayMs}ms...`
      );
      await sleep(delayMs);
    }
  }

  logger.error(
    `[FB Webhook] Error obteniendo orden ${orderId} despues de ${FB_FETCH_RETRY_MAX} intentos: ${lastError?.message || "unknown"}`
  );
  return null;
}

async function fetchFalabellaOrder(orderId, credential) {
  try {
    const timestamp = timestampMinus03();
    const params = {
      Action: "GetOrder",
      Format: "JSON",
      OrderId: String(orderId),
      Timestamp: timestamp,
      UserID: credential.seller_email.trim(),
      Version: FB_API_VERSION
    };

    const url = buildFalabellaSignedUrl(params, credential.api_key);
    const response = await axios.get(url, {
      timeout: 15000,
      headers: {
        "User-Agent": FB_USER_AGENT
      }
    });

    if (typeof response.data === "string") {
      try {
        return JSON.parse(response.data);
      } catch (e) {
        logger.error(`[FB Webhook] Respuesta no JSON para OrderId ${orderId}`);
        return null;
      }
    }

    return response.data;
  } catch (error) {
    logger.error(`[FB Webhook] Error obteniendo orden ${orderId}: ${error.message}`);
    return null;
  }
}

async function fetchFalabellaProductWithRetry(sellerSku, credential) {
  let lastError = null;

  for (let attempt = 1; attempt <= FB_FETCH_RETRY_MAX; attempt++) {
    try {
      const response = await fetchFalabellaProduct(sellerSku, credential);
      if (response) return response;
      lastError = new Error("empty_response");
    } catch (error) {
      lastError = error;
    }

    if (attempt < FB_FETCH_RETRY_MAX) {
      const delayMs = Math.min(
        FB_FETCH_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1),
        FB_FETCH_RETRY_MAX_DELAY_MS
      );
      logger.warn(
        `[FB Webhook] Intento ${attempt}/${FB_FETCH_RETRY_MAX} fallido para SKU ${sellerSku}. Reintentando en ${delayMs}ms...`
      );
      await sleep(delayMs);
    }
  }

  logger.error(
    `[FB Webhook] Error obteniendo producto ${sellerSku} despues de ${FB_FETCH_RETRY_MAX} intentos: ${lastError?.message || "unknown"}`
  );
  return null;
}

async function fetchFalabellaProductStatusWithRetry(adapter, sellerSku, options = {}) {
  const attempts = Number(options.attempts || 4);
  const delayMs = Number(options.delayMs || 2000);
  let lastStatus = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    lastStatus = await adapter.fetchProductStatus(sellerSku);
    const statusKnown = lastStatus?.found && (lastStatus.status || lastStatus.qc_status || lastStatus.raw);
    if (statusKnown || attempt === attempts) {
      return lastStatus;
    }

    logger.info(`[FB Webhook] GetProducts aún no refleja estado completo para ${sellerSku}; reintento ${attempt + 1}/${attempts} en ${delayMs}ms`);
    await sleep(delayMs);
  }

  return lastStatus;
}

async function fetchFalabellaProduct(sellerSku, credential) {
  try {
    const timestamp = timestampMinus03();
    const params = {
      Action: "GetProducts",
      Format: "JSON",
      SellerSku: String(sellerSku),
      Timestamp: timestamp,
      UserID: credential.seller_email.trim(),
      Version: FB_API_VERSION
    };

    const url = buildFalabellaSignedUrl(params, credential.api_key);
    const response = await axios.get(url, {
      timeout: 15000,
      headers: {
        "User-Agent": FB_USER_AGENT
      }
    });

    const data = response.data;
    if (typeof data === "string") {
      try {
        return JSON.parse(data);
      } catch (error) {
        logger.error(`[FB Webhook] Respuesta no JSON para SKU ${sellerSku}`);
        return null;
      }
    }

    return data;
  } catch (error) {
    if (error?.response?.status === 404) {
      return { __falabella_not_found: true, seller_sku: String(sellerSku) };
    }

    logger.error(`[FB Webhook] Error obteniendo producto ${sellerSku}: ${error.message}`);
    return null;
  }
}

function extractFalabellaSellerSku(payload) {
  // ✅ 🔑 CORRECCIÓN: Soportar SellerSkus (array) y SellerSku (singular)
  const candidates = [
    // ✅ NUEVO: Soportar array de SellerSkus (onProductCreated, onProductQcStatusChanged)
    ...(Array.isArray(payload?.payload?.SellerSkus) ? payload.payload.SellerSkus : []),
    ...(Array.isArray(payload?.SellerSkus) ? payload.SellerSkus : []),
    ...(Array.isArray(payload?.data?.SellerSkus) ? payload.data.SellerSkus : []),
    // Singular
    payload?.SellerSku,
    payload?.seller_sku,
    payload?.sellerSku,
    payload?.SKU,
    payload?.sku,
    payload?.payload?.SellerSku,
    payload?.payload?.seller_sku,
    payload?.payload?.sellerSku,
    payload?.payload?.SKU,
    payload?.payload?.sku,
    payload?.data?.SellerSku,
    payload?.data?.seller_sku,
    payload?.data?.sellerSku,
    payload?.data?.SKU,
    payload?.data?.sku,
    payload?.product?.SellerSku,
    payload?.product?.seller_sku,
    payload?.product?.sku
  ];

  for (const candidate of candidates) {
    const normalized = String(candidate || "").trim();
    if (normalized) return normalized;
  }

  const resource = String(payload?.resource || "").trim();
  const resourceMatch = resource.match(/\/products\/([^/?#]+)/i);
  if (resourceMatch?.[1]) {
    return resourceMatch[1];
  }

  return null;
}

function normalizeFalabellaProductStatusValue(status) {
  const normalized = String(status || "").trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "live") return "active";
  return normalized;
}

function buildFalabellaProductStateSnapshot({ product, payload, source = "webhook" }) {
  const businessUnit = Array.isArray(product?.BusinessUnits?.BusinessUnit)
    ? product.BusinessUnits.BusinessUnit[0]
    : product?.BusinessUnits?.BusinessUnit || {};
  const parseBoolean = (value) => {
    if (value === true || value === false) return value;
    if (value === 1 || value === 0) return value === 1;
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) return null;
    if (['1', 'true', 'yes', 'y', 'si', 'sí', 'active', 'published'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'n', 'inactive', 'draft', 'unpublished'].includes(normalized)) return false;
    return null;
  };
  const status = normalizeFalabellaProductStatusValue(
    businessUnit?.Status || product?.Status || product?.status || null
  );
  const qcStatus = normalizeFalabellaProductStatusValue(
    product?.QCStatus || product?.qc_status || businessUnit?.QCStatus || businessUnit?.qc_status || null
  );
  const qcReason = [
    product?.QCMessage,
    product?.qc_message,
    product?.QCReason,
    product?.qc_reason,
    product?.Reason,
    product?.reason,
    product?.ErrorMessage,
    product?.error_message,
    businessUnit?.QCMessage,
    businessUnit?.qc_message,
    businessUnit?.QCReason,
    businessUnit?.qc_reason,
    businessUnit?.Reason,
    businessUnit?.reason,
    businessUnit?.ErrorMessage,
    businessUnit?.error_message
  ].find((value) => typeof value === 'string' && value.trim()) || null;
  const productErrors = FalabellaAdapter.extractRealFalabellaErrors(product || {});
  const hasImage = product?.has_image === true
    || product?.image_upload?.success === true
    || FalabellaAdapter.hasFalabellaImage(product || {});

  const extractFalabellaNumericValue = (candidates) => {
    for (const candidate of candidates) {
      if (candidate === undefined || candidate === null || candidate === '') continue;
      const parsed = Number(candidate);
      if (Number.isFinite(parsed) && parsed >= 0) {
        return parsed;
      }
    }
    return null;
  };

  const stock = extractFalabellaNumericValue([
    businessUnit?.Stock,
    product?.Stock,
    product?.stock
  ]);

  const price = extractFalabellaNumericValue([
    businessUnit?.Price,
    product?.Price,
    product?.price
  ]);

  return {
    marketplace: FB_MARKETPLACE_KEY,
    status,
    qc_status: qcStatus,
    qc_status_text: qcStatus,
    is_published: parseBoolean(
      product?.IsPublished || product?.is_published || businessUnit?.IsPublished || businessUnit?.is_published || null
    ),
    has_image: hasImage,
    stock,
    price,
    url: product?.Url || product?.url || null,
    shop_sku: product?.ShopSku || product?.shop_sku || null,
    raw: product || null,
    qc_reason: qcReason,
    product_errors: productErrors,
    verified: true,
    item_found: true,
    note: source,
    updated_at: new Date().toISOString(),
    webhook: {
      topic: payload?.topic || payload?.event || payload?.event_type || null,
      resource: payload?.resource || null,
      event_id: payload?.event_id || payload?.EventId || payload?.eventId || null
    }
  };
}

function mergeFalabellaPublishedPayload(basePayload, incomingPayload) {
  const base = normalizeTaskPayload(basePayload);
  const incoming = normalizeTaskPayload(incomingPayload);
  const baseHasContent = base && Object.keys(base).length > 0;
  const incomingHasContent = incoming && Object.keys(incoming).length > 0;

  if (!baseHasContent && !incomingHasContent) return null;
  if (!baseHasContent) return incoming;
  if (!incomingHasContent) return base;

  const preferIncoming = (incomingValue, baseValue) => {
    if (incomingValue === undefined || incomingValue === null || incomingValue === '') {
      return baseValue;
    }
    return incomingValue;
  };

  const merged = {
    ...base,
    ...incoming
  };

  const baseBusinessUnit = Array.isArray(base?.BusinessUnits?.BusinessUnit)
    ? base.BusinessUnits.BusinessUnit[0]
    : base?.BusinessUnits?.BusinessUnit || {};
  const incomingBusinessUnit = Array.isArray(incoming?.BusinessUnits?.BusinessUnit)
    ? incoming.BusinessUnits.BusinessUnit[0]
    : incoming?.BusinessUnits?.BusinessUnit || {};

  if (Object.keys(baseBusinessUnit).length > 0 || Object.keys(incomingBusinessUnit).length > 0) {
    const mergedBusinessUnit = {
      ...baseBusinessUnit,
      ...incomingBusinessUnit
    };

    mergedBusinessUnit.Stock = preferIncoming(
      incomingBusinessUnit.Stock ?? incomingBusinessUnit.stock,
      baseBusinessUnit.Stock ?? baseBusinessUnit.stock
    );
    mergedBusinessUnit.Price = preferIncoming(
      incomingBusinessUnit.Price ?? incomingBusinessUnit.price,
      baseBusinessUnit.Price ?? baseBusinessUnit.price
    );

    merged.BusinessUnits = {
      ...base.BusinessUnits,
      ...incoming.BusinessUnits,
      BusinessUnit: mergedBusinessUnit
    };
  }

  merged.Stock = preferIncoming(incoming.Stock ?? incoming.stock, base.Stock ?? base.stock);
  merged.Price = preferIncoming(incoming.Price ?? incoming.price, base.Price ?? base.price);
  merged.stock = preferIncoming(incoming.stock ?? incoming.Stock, base.stock ?? base.Stock);
  merged.price = preferIncoming(incoming.price ?? incoming.Price, base.price ?? base.Price);

  return merged;
}

function normalizeTaskPayload(payload) {
  if (!payload) return {};
  if (typeof payload === 'object') return payload;
  if (typeof payload === 'string') {
    try {
      const parsed = JSON.parse(payload);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
      return {};
    }
  }
  return {};
}

function normalizeFalabellaDetailObject(details) {
  return normalizeTaskPayload(details);
}

function extractFalabellaPublishedNumericState(payload) {
  const normalized = normalizeTaskPayload(payload);
  if (!normalized || typeof normalized !== 'object') {
    return { stock: null, price: null };
  }

  const businessUnit = Array.isArray(normalized?.BusinessUnits?.BusinessUnit)
    ? normalized.BusinessUnits.BusinessUnit[0]
    : normalized?.BusinessUnits?.BusinessUnit || null;

  const extractNumericValue = (candidates) => {
    for (const candidate of candidates) {
      if (candidate === undefined || candidate === null || candidate === '') continue;
      const parsed = Number(candidate);
      if (Number.isFinite(parsed) && parsed >= 0) {
        return parsed;
      }
    }
    return null;
  };

  return {
    stock: extractNumericValue([
      businessUnit?.Stock,
      businessUnit?.stock,
      normalized.Stock,
      normalized.stock
    ]),
    price: extractNumericValue([
      businessUnit?.Price,
      businessUnit?.price,
      normalized.Price,
      normalized.price
    ])
  };
}

function extractFalabellaPublishedState(payload) {
  const normalized = normalizeTaskPayload(payload);
  if (!normalized || typeof normalized !== 'object') {
    return {
      status: null,
      qc_status: null,
      is_published: null,
      stock: null,
      price: null
    };
  }

  const status = normalizeFalabellaProductStatusValue(
    normalized.status || normalized.raw_status || normalized.marketplace_status || null
  );
  const qcStatus = normalizeFalabellaProductStatusValue(
    normalized.qc_status || normalized.QCStatus || null
  );
  const isPublished = normalized.is_published !== undefined && normalized.is_published !== null
    ? toBoolean(normalized.is_published)
    : null;

  return {
    status,
    qc_status: qcStatus,
    is_published: isPublished,
    ...extractFalabellaPublishedNumericState(normalized)
  };
}

function applyFalabellaNumericState(payload, { stock = null, price = null } = {}) {
  const merged = normalizeTaskPayload(payload);
  const target = merged && typeof merged === 'object' ? { ...merged } : {};
  const businessUnits = target.BusinessUnits && typeof target.BusinessUnits === 'object'
    ? { ...target.BusinessUnits }
    : null;
  const businessUnit = businessUnits
    ? (Array.isArray(businessUnits.BusinessUnit)
      ? { ...(businessUnits.BusinessUnit[0] || {}) }
      : { ...(businessUnits.BusinessUnit || {}) })
    : {};

  if (stock !== null && stock !== undefined) {
    businessUnit.Stock = stock;
    target.Stock = stock;
    target.stock = stock;
  }

  if (price !== null && price !== undefined) {
    businessUnit.Price = price;
    target.Price = price;
    target.price = price;
  }

  if (businessUnits) {
    businessUnits.BusinessUnit = Array.isArray(businessUnits.BusinessUnit)
      ? [businessUnit]
      : businessUnit;
    target.BusinessUnits = businessUnits;
  } else if (Object.keys(businessUnit).length > 0) {
    target.BusinessUnits = { BusinessUnit: businessUnit };
  }

  return target;
}

function extractFalabellaTaskImages(task, payload, sellerSku, adapter) {
  const taskPayload = normalizeTaskPayload(task?.payload || task?.job?.config);
  const productImages = normalizeTaskPayload(task?.product)?.images || task?.product?.images || [];
  const candidateSources = [
    taskPayload?.images_with_version,
    taskPayload?.images,
    taskPayload?.MainImage,
    taskPayload?.product?.images_with_version,
    taskPayload?.product?.images,
    taskPayload?.product?.MainImage,
    taskPayload?.variants?.flatMap?.(variant => variant?.images || []) || [],
    productImages,
    payload?.images_with_version,
    payload?.images,
    payload?.MainImage
  ];

  const flattened = adapter.normalizeFalabellaImages(candidateSources)
    .map(toPublicFalabellaImageUrl)
    .filter(Boolean);
  if (flattened.length > 0) {
    return [...new Set(flattened)];
  }

  const fallback = adapter.normalizeFalabellaImages([
    taskPayload?.product?.image,
    taskPayload?.image,
    taskPayload?.MainImage,
    task?.product?.image,
    task?.product?.MainImage,
    payload?.image,
    payload?.MainImage
  ]).map(toPublicFalabellaImageUrl).filter(Boolean);

  return [...new Set(fallback)];
}

function toPublicFalabellaImageUrl(imageUrl) {
  const value = String(imageUrl || '').trim();
  if (!value) return null;

  if ((value.startsWith('[') && value.endsWith(']')) || (value.startsWith('{') && value.endsWith('}'))) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return toPublicFalabellaImageUrl(parsed[0]);
      }
      if (parsed && typeof parsed === 'object') {
        return toPublicFalabellaImageUrl(parsed.fullUrl || parsed.url || parsed.src || parsed.image || parsed.path || '');
      }
    } catch (error) {
      // Ignorar y seguir con el valor crudo si no es JSON válido
    }
  }

  if (value.includes('[') || value.includes(']') || value.includes('{') || value.includes('}')) {
    return null;
  }

  if (/^https:\/\//i.test(value)) return value;
  if (/^http:\/\//i.test(value)) return value.replace(/^http:\/\//i, 'https://');

  const baseUrl = String(process.env.APP_URL || 'https://spree.api.klint.cl/api').replace(/\/+$/, '');
  if (value.startsWith('/images/')) {
    return `${baseUrl}${value}`;
  }
  if (value.startsWith('images/')) {
    return `${baseUrl}/${value}`;
  }
  if (/^(products|warehouses|certificates)\//i.test(value)) {
    return `${baseUrl}/images/${value}`;
  }

  return `${baseUrl}/images/${value.replace(/^\/+/, '')}`;
}

function isFalabellaTerminalProductState(status) {
  const normalized = String(status || '').trim().toLowerCase();
  return ['inactive', 'deleted'].includes(normalized);
}

function isFalabellaConfirmedPublishedState(productStatus) {
  if (!productStatus || typeof productStatus !== 'object') {
    return false;
  }

  if (productStatus.found === false) {
    return false;
  }

  const status = String(productStatus.status || '').trim().toLowerCase();
  const qcStatus = String(productStatus.qc_status || '').trim().toLowerCase();
  const isPublished = productStatus.is_published;
  const productErrors = Array.isArray(productStatus.product_errors) ? productStatus.product_errors : [];
  const hasPublicUrl = typeof productStatus.url === 'string' && productStatus.url.trim().length > 0;
  const hasShopSku = typeof productStatus.shop_sku === 'string' && productStatus.shop_sku.trim().length > 0;

  return ['active', 'live'].includes(status)
    && productErrors.length === 0
    && (hasPublicUrl || hasShopSku || isPublished === true || qcStatus === 'pending' || qcStatus === 'approved' || qcStatus === 'active' || qcStatus === 'live' || qcStatus === null || qcStatus === '');
}

function resolveFalabellaMarketplaceDisplayStatus(productStatus, { taskStatus = null } = {}) {
  if (!productStatus || typeof productStatus !== 'object') {
    return 'processing';
  }

  if (productStatus.found === false) {
    return 'pending';
  }

  const status = String(productStatus.status || '').trim().toLowerCase();
  const qcStatus = String(productStatus.qc_status || '').trim().toLowerCase();
  const isPublished = productStatus.is_published;
  const productErrors = Array.isArray(productStatus.product_errors) ? productStatus.product_errors : [];

  if (['active', 'live'].includes(status) && productErrors.length === 0) {
    return 'active';
  }

  if (qcStatus === 'pending') {
    return 'under_review';
  }

  if (qcStatus === 'rejected') {
    return 'rejected';
  }

  if (['inactive', 'deleted'].includes(status)) {
    return status;
  }

  if (status === 'active' && isPublished === false) {
    return 'not_published';
  }

  if (taskStatus === 'pending') {
    return 'pending';
  }

  if (taskStatus === 'processing') {
    return 'processing';
  }

  return status || 'processing';
}

function determineFalabellaTaskLifecycle(productStatus, { realErrors = [], hasImage = true } = {}) {
  const status = String(productStatus?.status || '').trim().toLowerCase();
  const qcStatus = String(productStatus?.qc_status || '').trim().toLowerCase();

  if (!productStatus || productStatus.found === false) {
    return { status: 'pending', isFinal: false, errorMessage: null };
  }

  if (realErrors.length > 0) {
    return {
      status: 'failed',
      isFinal: true,
      errorMessage: realErrors.map(err => {
        const field = err.field ? `${err.field}: ` : '';
        return `${field}${err.message}`;
      }).join(' | ')
    };
  }

  if (qcStatus === 'rejected' || ['inactive', 'deleted'].includes(status)) {
    return {
      status: 'failed',
      isFinal: true,
      errorMessage: qcStatus === 'rejected'
        ? `qc_status: ${qcStatus}`
        : `status: ${status || 'unknown'}`
    };
  }

  if (['active', 'live'].includes(status)) {
    if (hasImage === false) {
      return { status: 'processing', isFinal: false, errorMessage: null };
    }

    return { status: 'published', isFinal: true, errorMessage: null };
  }

  return { status: 'processing', isFinal: false, errorMessage: null };
}

function shouldAttemptFalabellaImageSync({ productStatus, taskImages, imageSyncAlreadySucceeded, imageSyncInProgress }) {
  if (imageSyncAlreadySucceeded) return false;
  if (imageSyncInProgress) return false;
  if (!productStatus?.found) return false;
  if (productStatus.has_image !== false) return false;
  if (!Array.isArray(taskImages) || taskImages.length === 0) return false;
  if (isFalabellaTerminalProductState(productStatus.status)) return false;
  return true;
}

async function acquireFalabellaImageSyncLock(task, requestedBy = null) {
  if (!task?.id) {
    return { acquired: false, task: null, taskDetails: {} };
  }

  return await sequelize.transaction(async (transaction) => {
    const lockedTask = await ProductPublishingTask.findByPk(task.id, {
      transaction,
      lock: transaction.LOCK.UPDATE
    });

    if (!lockedTask) {
      return { acquired: false, task: null, taskDetails: {} };
    }

    const taskDetails = normalizeFalabellaDetailObject(lockedTask.error_details);
    const alreadySucceeded = Boolean(
      taskDetails?.image_upload?.success === true ||
      taskDetails?.image_sync?.success === true
    );
    const inProgress = Boolean(taskDetails?.image_sync?.in_progress === true);

    if (alreadySucceeded || inProgress) {
      return {
        acquired: false,
        task: lockedTask,
        taskDetails,
        alreadySucceeded,
        inProgress
      };
    }

    const startedAt = new Date().toISOString();
    const nextDetails = {
      ...taskDetails,
      image_sync: {
        attempted: true,
        success: false,
        in_progress: true,
        requested_by_webhook: requestedBy || null,
        started_at: startedAt
      }
    };

    await lockedTask.update(
      { error_details: nextDetails },
      { transaction }
    );

    return {
      acquired: true,
      task: lockedTask,
      taskDetails: nextDetails,
      startedAt
    };
  });
}

async function finalizeFalabellaImageSyncState(task, taskDetails, imageUploadResult, requestedBy = null) {
  if (!task?.id) {
    return null;
  }

  const baseDetails = normalizeFalabellaDetailObject(taskDetails);
  const previousImageSync = baseDetails?.image_sync || {};
  const nextImageSync = {
    ...previousImageSync,
    attempted: true,
    success: Boolean(imageUploadResult?.success),
    in_progress: false,
    requested_by_webhook: requestedBy || previousImageSync.requested_by_webhook || null,
    started_at: previousImageSync.started_at || null,
    finished_at: new Date().toISOString(),
    request_id: imageUploadResult?.request_id || previousImageSync.request_id || null,
    images_count: imageUploadResult?.images_count || previousImageSync.images_count || null,
    error_message: imageUploadResult?.success ? null : (imageUploadResult?.error || previousImageSync.error_message || null),
    error_code: imageUploadResult?.success ? null : (imageUploadResult?.error_code || previousImageSync.error_code || null)
  };

  const nextDetails = {
    ...baseDetails,
    image_sync: nextImageSync
  };

  await ProductPublishingTaskRepository.updateTask(task, {
    error_details: nextDetails
  });

  return nextDetails;
}

async function persistFalabellaProductState({ credential, sellerSku, product, payload, imageUploadResult = null, task: sourceTask = null }) {
  const marketplaceId = credential?.marketplace_id || null;
  const existingPublishedPayload = normalizeTaskPayload(sourceTask?.payload)
    || normalizeTaskPayload(sourceTask?.job?.config)
    || normalizeTaskPayload(sourceTask?.api_response)
    || null;
  const productForSnapshot = mergeFalabellaPublishedPayload(existingPublishedPayload, product || null);
  const snapshot = buildFalabellaProductStateSnapshot({ product: productForSnapshot, payload });
  if (imageUploadResult?.success) {
    snapshot.has_image = true;
  }
  const previousPublishedState = extractFalabellaPublishedState(
    normalizeFalabellaDetailObject(sourceTask?.error_details)?.marketplace_item_state
      || normalizeTaskPayload(sourceTask?.api_response)
      || normalizeTaskPayload(sourceTask?.payload)
      || normalizeTaskPayload(sourceTask?.job?.config)
  );
  const isActive = snapshot.status === "active";
  const isDeleted = snapshot.status === "deleted";
  const marketplaceDisplayStatus = resolveFalabellaMarketplaceDisplayStatus(snapshot, {
    taskStatus: sourceTask?.status || null,
    hasImage: snapshot.has_image !== false
  });
  const lifecycle = determineFalabellaTaskLifecycle(snapshot, {
    realErrors: Array.isArray(snapshot.product_errors) ? snapshot.product_errors : [],
    hasImage: snapshot.has_image !== false
  });
  const resolvedStatus = isDeleted ? "deleted" : lifecycle.status;

  if ((snapshot.stock === null || snapshot.stock === undefined) && previousPublishedState.stock !== null) {
    snapshot.stock = previousPublishedState.stock;
  }

  if ((snapshot.price === null || snapshot.price === undefined) && previousPublishedState.price !== null) {
    snapshot.price = previousPublishedState.price;
  }

  if (
    (snapshot.status === null || snapshot.status === 'unknown' || snapshot.status === 'processing') &&
    previousPublishedState.status &&
    ['published', 'published_with_warnings', 'active', 'live'].includes(previousPublishedState.status)
  ) {
    snapshot.status = previousPublishedState.status === 'active' || previousPublishedState.status === 'live'
      ? 'active'
      : previousPublishedState.status;
  }

  if ((snapshot.qc_status === null || snapshot.qc_status === 'unknown') && previousPublishedState.qc_status) {
    snapshot.qc_status = previousPublishedState.qc_status;
  }

  if (snapshot.is_published === null && previousPublishedState.is_published !== null) {
    snapshot.is_published = previousPublishedState.is_published;
  }

  logger.info(
    `[FB Webhook] Producto ${sellerSku} verificado: ${JSON.stringify({
      topic: payload?.topic || null,
      resource: payload?.resource || null,
      snapshot: {
        sku: sellerSku,
        status: snapshot.status,
        qc_status: snapshot.qc_status,
        has_image: snapshot.has_image,
        stock: snapshot.stock,
        price: snapshot.price
      }
    })}`
  );

  let link = await ProductMarketplaceLinkRepository.findByExternalIdAndCredential(
    marketplaceId,
    String(sellerSku),
    credential?.id || null,
    payload?.user_id != null ? String(payload.user_id) : null
  );

  if (!link) {
    link = await ProductMarketplaceLinkRepository.findByMarketplaceExternalId(
      marketplaceId,
      String(sellerSku),
      null,
      null,
      credential?.id || null,
      payload?.user_id != null ? String(payload.user_id) : null
    );
  }

  const existingPublishedPayloadForLink = normalizeTaskPayload(link?.published_payload)
    || existingPublishedPayload
    || null;
  const mergedPublishedPayload = mergeFalabellaPublishedPayload(
    existingPublishedPayloadForLink,
    snapshot.raw || product || null
  );
  const persistedPublishedPayload = applyFalabellaNumericState(
    mergedPublishedPayload || snapshot.raw || product || null,
    {
      stock: snapshot.stock,
      price: snapshot.price
    }
  );
  const confirmedPublishedStock = snapshot.stock !== null && snapshot.stock !== undefined
    ? snapshot.stock
    : (link?.published_stock !== undefined && link?.published_stock !== null
      ? link.published_stock
      : null);
  const linkStatus = marketplaceDisplayStatus === 'active'
    ? 'active'
    : marketplaceDisplayStatus;

  if (!link && sourceTask && (sourceTask.company_id != null || sourceTask.branch_id != null)) {
    try {
      link = await ProductMarketplaceLinkRepository.upsert({
        product_id: sourceTask.product_id,
        marketplace_id: sourceTask.marketplace_id,
        credential_id: sourceTask.credential_id || credential?.id || null,
        user_id: sourceTask.user_id || null,
        company_id: sourceTask.company_id != null ? sourceTask.company_id : null,
        branch_id: sourceTask.branch_id != null ? sourceTask.branch_id : null,
        status: linkStatus,
        external_id: String(sellerSku),
        external_url: snapshot.url || null,
        published_stock: confirmedPublishedStock,
        published_payload: persistedPublishedPayload,
        last_synced_at: new Date()
      });
      logger.info(`[FB Webhook] Link creado por fallback para SKU ${sellerSku}: task_id=${sourceTask.id}, link_id=${link?.id || 'n/a'}`);
    } catch (linkError) {
      logger.warn(`[FB Webhook] No se pudo crear link fallback para SKU ${sellerSku}: ${linkError.message}`);
    }
  }

  let latestTask = await ProductPublishingTaskRepository.findLatestByExternalIdAndContext({
    marketplaceId,
    externalId: String(sellerSku),
    companyId: link?.company_id || sourceTask?.company_id || null,
    branchId: link?.branch_id || sourceTask?.branch_id || null,
    credentialId: credential?.id || sourceTask?.credential_id || link?.credential_id || null
  });

  if (!latestTask) {
    latestTask = await ProductPublishingTaskRepository.findLatestByExternalId(
      marketplaceId,
      String(sellerSku)
    );
  }

  const updatePayload = {
    status: linkStatus,
    external_url: snapshot.url || link?.external_url || null,
    published_stock: confirmedPublishedStock,
    published_payload: persistedPublishedPayload,
    last_synced_at: new Date()
  };

  if (link) {
    await link.update(updatePayload);
  }

  if (latestTask) {
    const currentDetails = normalizeFalabellaDetailObject(latestTask.error_details);
    const mergedDetails = {
      ...currentDetails,
      marketplace_item_state: snapshot,
      marketplace_display_status: marketplaceDisplayStatus,
      image_upload: imageUploadResult || null,
      terminal_state: isDeleted ? "deleted" : null
    };

    const taskErrorMessage = lifecycle.isFinal
      ? (lifecycle.status === 'published' ? null : lifecycle.errorMessage)
      : (isActive
        ? null
        : (isDeleted
          ? "Falabella item eliminado"
          : `Falabella item status: ${snapshot.status}${snapshot.qc_status ? ` (${snapshot.qc_status})` : ''}`));

    const taskUpdate = {
      status: resolvedStatus,
      api_response: mergedPublishedPayload || product || latestTask.api_response || null,
      error_message: taskErrorMessage,
      error_details: lifecycle.isFinal && lifecycle.status === 'published' ? null : mergedDetails
    };

    if (lifecycle.isFinal) {
      taskUpdate.error_message = lifecycle.errorMessage;
      taskUpdate.error_details = lifecycle.status === 'published' ? null : mergedDetails;
    }

    await latestTask.update(taskUpdate);
    await recalculateJobProgressFromTask(latestTask);
  }

  return {
    snapshot,
    linkUpdated: !!link,
    taskUpdated: !!latestTask,
    linkId: link?.id || null,
    taskId: latestTask?.id || null
  };
}

async function fetchFalabellaOrdersV2({
  credential,
  createdAfter,
  createdBefore,
  offset = 0,
  limit = 100,
  status = null
}) {
  const timestamp = timestampMinus03();
  const params = {
    Action: "GetOrders",
    Format: "JSON",
    CreatedAfter: createdAfter,
    CreatedBefore: createdBefore,
    Offset: String(offset),
    Limit: String(limit),
    Timestamp: timestamp,
    UserID: credential.seller_email.trim(),
    Version: FB_API_VERSION
  };

  if (status) {
    params.Status = status;
  }

  const url = buildFalabellaSignedUrl(params, credential.api_key);
  try {
    const response = await axios.get(url, {
      timeout: 20000,
      headers: {
        "User-Agent": FB_USER_AGENT
      }
    });

    if (typeof response.data === "string") {
      try {
        return JSON.parse(response.data);
      } catch (e) {
        logger.error("[FB Reconcile] Respuesta no JSON en GetOrders");
        return null;
      }
    }

    return response.data;
  } catch (error) {
    logger.error(`[FB Reconcile] Error GetOrders: ${error.message}`);
    return null;
  }
}

function parseFalabellaOrderIds(orderData) {
  const orders =
    orderData?.SuccessResponse?.Body?.Orders?.Order ||
    orderData?.SuccessResponse?.Body?.Order ||
    null;

  const list = Array.isArray(orders) ? orders : orders ? [orders] : [];

  return list
    .map((order) => order?.OrderId || order?.OrderID || order?.order_id || order?.orderId || null)
    .filter((id) => id != null)
    .map((id) => String(id));
}

function parseFalabellaOrderItems(orderData) {
  const order =
    orderData?.SuccessResponse?.Body?.Order ||
    orderData?.SuccessResponse?.Body?.Orders?.Order ||
    null;

  const rawItems =
    order?.OrderItems?.OrderItem ||
    orderData?.SuccessResponse?.Body?.OrderItems?.OrderItem ||
    null;

  const items = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];

  return items.map((item) => ({
    sku:
      item?.SellerSku ||
      item?.SellerSKU ||
      item?.Sku ||
      item?.sku ||
      null,
    quantity: parseInt(item?.Quantity || item?.quantity || item?.Qty, 10) || 0,
    // ✅ NUEVO: Datos financieros del item
    unitPrice: parseFloat(item?.Price || item?.price || item?.UnitPrice || 0) || 0,
    totalPrice: parseFloat(item?.TotalPrice || item?.total_price || item?.Amount || 0) || 0,
    discount: parseFloat(item?.Discount || item?.discount || 0) || 0,
    commission: parseFloat(item?.Commission || item?.commission || 0) || 0,
    shippingFee: parseFloat(item?.ShippingFee || item?.shipping_fee || item?.ShippingCost || 0) || 0,
    tax: parseFloat(item?.Tax || item?.tax || item?.TaxAmount || 0) || 0
  }));
}

/**
 * Parsea información general de una orden de Falabella
 */
function parseFalabellaOrderInfo(orderData) {
  const order = extractFalabellaOrderRoot(orderData);

  if (!order) return {};

  // Calcular totales sumando los items
  const rawItems =
    order?.OrderItems?.OrderItem ||
    orderData?.SuccessResponse?.Body?.OrderItems?.OrderItem ||
    [];
  
  const items = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];
  
  const subtotal = items.reduce((sum, item) => {
    const price = parseFloat(item?.Price || item?.UnitPrice || 0) || 0;
    const qty = parseInt(item?.Quantity || item?.Qty || 1, 10) || 1;
    return sum + (price * qty);
  }, 0);

  const shippingTotal = items.reduce((sum, item) => {
    return sum + (parseFloat(item?.ShippingFee || item?.ShippingCost || 0) || 0);
  }, 0);

  const discountTotal = items.reduce((sum, item) => {
    return sum + (parseFloat(item?.Discount || 0) || 0);
  }, 0);

  const commissionTotal = items.reduce((sum, item) => {
    return sum + (parseFloat(item?.Commission || 0) || 0);
  }, 0);

  const taxTotal = items.reduce((sum, item) => {
    return sum + (parseFloat(item?.Tax || item?.TaxAmount || 0) || 0);
  }, 0);

  const totalAmount = subtotal + shippingTotal - discountTotal + taxTotal;

  // Información del comprador
  const customer = order?.Customer || order?.Buyer || {};
  const buyerName = buildFullName(
    customer?.FirstName || order?.CustomerFirstName,
    customer?.LastName || order?.CustomerLastName
  );

  // Dirección de envío
  const shippingAddress = extractFalabellaShippingAddress(order);
  const addressParts = [
    pickString(
      shippingAddress?.Street,
      shippingAddress?.Address1,
      shippingAddress?.address1
    ),
    pickString(
      shippingAddress?.Address2,
      shippingAddress?.address2
    ),
    pickString(shippingAddress?.City, shippingAddress?.city),
    pickString(
      shippingAddress?.State,
      shippingAddress?.Region,
      shippingAddress?.region
    ),
    pickString(
      shippingAddress?.ZipCode,
      shippingAddress?.PostCode,
      shippingAddress?.postcode
    )
  ];

  return {
    status: order?.OrderStatus || order?.Status || 'pending',
    subtotal,
    shippingTotal,
    discountTotal,
    taxTotal,
    commission: commissionTotal,
    totalAmount,
    buyerName,
    shippingAddress: buildAddressLine(addressParts),
    shippingCity: pickString(shippingAddress?.City, shippingAddress?.city),
    shippingRegion: pickString(
      shippingAddress?.State,
      shippingAddress?.Region,
      shippingAddress?.region
    ),
    createdAt: order?.CreatedDate || order?.CreatedAt || null
  };
}

async function persistMarketplaceOrderCustomerSnapshot(savedOrder, snapshot, logPrefix) {
  if (!savedOrder?.id || !snapshot) {
    return;
  }

  if (!hasMeaningfulCustomerSnapshot(snapshot)) {
    logger.info(`[${logPrefix}] Snapshot comprador omitido por falta de datos. order_id=${savedOrder.id}`);
    return;
  }

  try {
    await MarketplaceOrderCustomerRepository.upsertByOrderId(savedOrder.id, snapshot);
  } catch (error) {
    logger.warn(
      `[${logPrefix}] Error guardando snapshot comprador para order_id=${savedOrder.id}: ${error.message}`
    );
  }
}

function buildMercadoLibreCustomerSnapshot({ order, shipment, billingInfo }) {
  const buyer = order?.buyer || billingInfo?.buyer || {};
  const billing = billingInfo?.billing_info || billingInfo?.billingInfo || billingInfo || {};
  const billingAddress = billing?.address || {};
  const billingIdentification = billing?.identification || {};
  const billingAttributes = billing?.attributes || {};
  const shippingAddress = shipment?.receiver_address || order?.shipping?.receiver_address || {};
  const shipmentReceiver = shipment?.receiver || order?.shipping?.receiver || {};
  const receiverName = pickString(
    shipment?.receiver_name,
    shipmentReceiver?.name,
    shippingAddress?.receiver_name
  );
  const fullName = buildFullName(
    pickString(billing?.name, buyer?.first_name),
    pickString(billing?.last_name, buyer?.last_name)
  ) || pickString(billing?.business_name, buyer?.nickname);
  const documentParts = splitDocumentNumber(billingIdentification?.number || billing?.doc_number);
  const customerType = normalizeCustomerType(
    billingAttributes?.cust_type === 'BU'
      ? 'business'
      : billingAttributes?.cust_type === 'CO'
        ? 'person'
        : null,
    billing?.business_name
  );

  return finalizeCustomerSnapshot({
    marketplace: ML_MARKETPLACE_KEY,
    marketplace_customer_id: stringOrNull(buyer?.cust_id || buyer?.id),
    first_name: pickString(billing?.name, buyer?.first_name),
    last_name: pickString(billing?.last_name, buyer?.last_name),
    full_name: fullName,
    email: pickString(
      billing?.email,
      buyer?.email,
      buyer?.contact?.email
    ),
    phone: pickString(
      buyer?.phone?.number,
      shipmentReceiver?.phone,
      shipment?.receiver_phone
    ),
    phone_secondary: pickString(buyer?.alternative_phone?.number),
    document_type: stringOrNull(billingIdentification?.type),
    document_number: documentParts.number,
    document_verifier: documentParts.verifier,
    customer_type: customerType,
    legal_name: pickString(billing?.business_name, fullName),
    receiver_name: receiverName,
    invoice_required: null,
    billing_address_line: pickString(
      billingAddress?.address_line,
      buildStreetAddress(billingAddress?.street_name, billingAddress?.street_number)
    ),
    billing_address_line_2: pickString(billingAddress?.comment),
    billing_city: pickString(billingAddress?.city_name),
    billing_municipality: pickString(billingAddress?.municipality_name),
    billing_state: pickString(billingAddress?.state?.name, billingAddress?.state_name),
    billing_state_code: pickString(billingAddress?.state?.code),
    billing_zip_code: pickString(billingAddress?.zip_code),
    billing_country_code: pickString(billingAddress?.country_id, billingAddress?.country_code),
    billing_comment: pickString(billingAddress?.comment),
    shipping_address_line: pickString(
      shippingAddress?.address_line,
      buildStreetAddress(shippingAddress?.street_name, shippingAddress?.street_number)
    ),
    shipping_address_line_2: pickString(shippingAddress?.comment),
    shipping_city: pickString(shippingAddress?.city?.name, shippingAddress?.city_name),
    shipping_municipality: pickString(shippingAddress?.municipality_name),
    shipping_state: pickString(shippingAddress?.state?.name, shippingAddress?.state_name),
    shipping_state_code: pickString(shippingAddress?.state?.id, shippingAddress?.state_code),
    shipping_zip_code: pickString(shippingAddress?.zip_code),
    shipping_country_code: pickString(
      shippingAddress?.country?.id,
      shippingAddress?.country?.name,
      shippingAddress?.country_id
    ),
    shipping_comment: pickString(shippingAddress?.comment),
    shipping_reference: pickString(order?.shipping?.shipping_option?.name, shippingAddress?.comment),
    source_updated_at: parseDateOrNull(order?.last_updated || order?.date_created || shipment?.last_updated),
    raw_order_payload: order || null,
    raw_billing_payload: billingInfo || null,
    raw_shipping_payload: shipment || null
  });
}

function buildFalabellaCustomerSnapshot({ orderData, orderInfo }) {
  const order = extractFalabellaOrderRoot(orderData);
  const customer = order?.Customer || order?.Buyer || {};
  const billingAddress = extractFalabellaBillingAddress(order);
  const shippingAddress = extractFalabellaShippingAddress(order);
  const extraBilling = normalizeFalabellaAttributes(
    order?.ExtraBillingAttributes ||
    order?.extraBillingAttributes ||
    order?.BillingExtraAttributes
  );
  const extra = normalizeFalabellaAttributes(
    order?.ExtraAttributes ||
    order?.extraAttributes
  );
  const firstName = pickString(customer?.FirstName, order?.CustomerFirstName, extra.CustomerFirstName);
  const lastName = pickString(customer?.LastName, order?.CustomerLastName, extra.CustomerLastName);
  const fullName = buildFullName(firstName, lastName) || orderInfo?.buyerName;
  const documentParts = splitDocumentNumber(
    extraBilling.LegalId ||
    order?.NationalRegistrationNumber ||
    extra.NationalRegistrationNumber
  );
  const invoiceRequired = toBoolean(order?.InvoiceRequired);
  const legalName = pickString(
    extraBilling.ReceiverLegalName,
    extra.ReceiverLegalName,
    fullName
  );

  return finalizeCustomerSnapshot({
    marketplace: FB_MARKETPLACE_KEY,
    marketplace_customer_id: stringOrNull(
      customer?.CustomerID ||
      customer?.CustomerId ||
      order?.CustomerId ||
      order?.BuyerId
    ),
    first_name: firstName,
    last_name: lastName,
    full_name: fullName,
    email: pickString(
      customer?.Email,
      order?.CustomerEmail,
      billingAddress?.Email,
      shippingAddress?.Email
    ),
    phone: pickString(
      customer?.Phone,
      billingAddress?.Phone,
      shippingAddress?.Phone
    ),
    phone_secondary: pickString(
      billingAddress?.Phone2,
      shippingAddress?.Phone2
    ),
    document_type: pickString(extraBilling.DocumentType, extra.DocumentType),
    document_number: documentParts.number,
    document_verifier: pickString(extraBilling.CustomerVerifierDigit, documentParts.verifier),
    customer_type: normalizeCustomerType(
      invoiceRequired ? 'business' : null,
      legalName
    ),
    legal_name: legalName,
    receiver_name: pickString(
      shippingAddress?.FirstName && shippingAddress?.LastName
        ? `${shippingAddress.FirstName} ${shippingAddress.LastName}`
        : null,
      fullName
    ),
    invoice_required: invoiceRequired,
    billing_address_line: pickString(billingAddress?.Address1, billingAddress?.Street),
    billing_address_line_2: pickString(billingAddress?.Address2),
    billing_city: pickString(
      extraBilling.ReceiverMunicipality,
      billingAddress?.City
    ),
    billing_municipality: pickString(
      extraBilling.ReceiverMunicipality,
      billingAddress?.City
    ),
    billing_state: pickString(
      extraBilling.ReceiverRegion,
      billingAddress?.Region,
      billingAddress?.State
    ),
    billing_state_code: null,
    billing_zip_code: pickString(
      extraBilling.ReceiverPostcode,
      billingAddress?.PostCode,
      billingAddress?.ZipCode
    ),
    billing_country_code: pickString(billingAddress?.Country),
    billing_comment: pickString(order?.Remarks, extra.Remarks),
    shipping_address_line: pickString(shippingAddress?.Address1, shippingAddress?.Street),
    shipping_address_line_2: pickString(shippingAddress?.Address2),
    shipping_city: pickString(shippingAddress?.City),
    shipping_municipality: pickString(shippingAddress?.City),
    shipping_state: pickString(shippingAddress?.Region, shippingAddress?.State),
    shipping_state_code: null,
    shipping_zip_code: pickString(shippingAddress?.PostCode, shippingAddress?.ZipCode),
    shipping_country_code: pickString(shippingAddress?.Country),
    shipping_comment: pickString(order?.Remarks),
    shipping_reference: pickString(order?.DeliveryInfo, extra.DeliveryInfo),
    source_updated_at: parseDateOrNull(order?.UpdatedAt || order?.CreatedAt || orderInfo?.createdAt),
    raw_order_payload: orderData || null,
    raw_billing_payload: {
      billing_address: billingAddress || null,
      extra_billing_attributes: extraBilling
    },
    raw_shipping_payload: shippingAddress || null
  });
}

function finalizeCustomerSnapshot(snapshot) {
  const normalized = {
    marketplace: snapshot.marketplace,
    marketplace_customer_id: stringOrNull(snapshot.marketplace_customer_id),
    first_name: stringOrNull(snapshot.first_name),
    last_name: stringOrNull(snapshot.last_name),
    full_name: stringOrNull(snapshot.full_name),
    email: stringOrNull(snapshot.email),
    phone: stringOrNull(snapshot.phone),
    phone_secondary: stringOrNull(snapshot.phone_secondary),
    document_type: stringOrNull(snapshot.document_type),
    document_number: stringOrNull(snapshot.document_number),
    document_verifier: stringOrNull(snapshot.document_verifier),
    customer_type: stringOrNull(snapshot.customer_type),
    legal_name: stringOrNull(snapshot.legal_name),
    receiver_name: stringOrNull(snapshot.receiver_name),
    invoice_required:
      typeof snapshot.invoice_required === 'boolean' ? snapshot.invoice_required : null,
    billing_address_line: stringOrNull(snapshot.billing_address_line),
    billing_address_line_2: stringOrNull(snapshot.billing_address_line_2),
    billing_city: stringOrNull(snapshot.billing_city),
    billing_municipality: stringOrNull(snapshot.billing_municipality),
    billing_state: stringOrNull(snapshot.billing_state),
    billing_state_code: stringOrNull(snapshot.billing_state_code),
    billing_zip_code: stringOrNull(snapshot.billing_zip_code),
    billing_country_code: stringOrNull(snapshot.billing_country_code),
    billing_comment: stringOrNull(snapshot.billing_comment),
    shipping_address_line: stringOrNull(snapshot.shipping_address_line),
    shipping_address_line_2: stringOrNull(snapshot.shipping_address_line_2),
    shipping_city: stringOrNull(snapshot.shipping_city),
    shipping_municipality: stringOrNull(snapshot.shipping_municipality),
    shipping_state: stringOrNull(snapshot.shipping_state),
    shipping_state_code: stringOrNull(snapshot.shipping_state_code),
    shipping_zip_code: stringOrNull(snapshot.shipping_zip_code),
    shipping_country_code: stringOrNull(snapshot.shipping_country_code),
    shipping_comment: stringOrNull(snapshot.shipping_comment),
    shipping_reference: stringOrNull(snapshot.shipping_reference),
    source_updated_at: snapshot.source_updated_at || null,
    raw_order_payload: snapshot.raw_order_payload || null,
    raw_billing_payload: snapshot.raw_billing_payload || null,
    raw_shipping_payload: snapshot.raw_shipping_payload || null
  };

  normalized.data_completeness = calculateCustomerDataCompleteness(normalized);
  return normalized;
}

function calculateCustomerDataCompleteness(snapshot) {
  const keys = [
    snapshot.full_name,
    snapshot.email,
    snapshot.phone,
    snapshot.document_number,
    snapshot.billing_address_line,
    snapshot.billing_city,
    snapshot.shipping_address_line,
    snapshot.shipping_city,
    snapshot.shipping_state,
    snapshot.shipping_zip_code
  ];
  const count = keys.filter(Boolean).length;
  if (count >= 8) return 'full';
  if (count >= 4) return 'medium';
  return 'partial';
}

function hasMeaningfulCustomerSnapshot(snapshot) {
  return Boolean(
    snapshot?.marketplace_customer_id ||
    snapshot?.full_name ||
    snapshot?.email ||
    snapshot?.phone ||
    snapshot?.document_number ||
    snapshot?.billing_address_line ||
    snapshot?.shipping_address_line ||
    snapshot?.raw_order_payload
  );
}

function extractFalabellaOrderRoot(orderData) {
  return (
    orderData?.SuccessResponse?.Body?.Order ||
    orderData?.SuccessResponse?.Body?.Orders?.Order ||
    null
  );
}

function extractFalabellaBillingAddress(order) {
  return (
    order?.AddressBilling ||
    order?.BillingAddress ||
    order?.Billing?.Address ||
    {}
  );
}

function extractFalabellaShippingAddress(order) {
  return (
    order?.AddressShipping ||
    order?.ShippingAddress ||
    order?.Shipping?.Address ||
    {}
  );
}

function normalizeFalabellaAttributes(attributes) {
  if (!attributes) return {};
  if (Array.isArray(attributes)) {
    return attributes.reduce((acc, entry) => {
      const key = pickString(entry?.Name, entry?.name, entry?.Key, entry?.key);
      const value = pickString(entry?.Value, entry?.value, entry?.Text, entry?.text);
      if (key) acc[key] = value;
      return acc;
    }, {});
  }
  if (typeof attributes === 'string') {
    try {
      const parsed = JSON.parse(attributes);
      return normalizeFalabellaAttributes(parsed);
    } catch (error) {
      return {};
    }
  }
  if (typeof attributes === 'object') {
    return attributes;
  }
  return {};
}

function buildFullName(firstName, lastName) {
  const fullName = [stringOrNull(firstName), stringOrNull(lastName)]
    .filter(Boolean)
    .join(' ')
    .trim();
  return fullName || null;
}

function buildStreetAddress(streetName, streetNumber) {
  return buildAddressLine([streetName, streetNumber]);
}

function buildAddressLine(parts) {
  if (!Array.isArray(parts)) return null;
  const line = parts
    .map((part) => stringOrNull(part))
    .filter(Boolean)
    .join(', ')
    .trim();
  return line || null;
}

function pickString(...values) {
  for (const value of values) {
    const normalized = stringOrNull(value);
    if (normalized) return normalized;
  }
  return null;
}

function stringOrNull(value) {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

function splitDocumentNumber(value) {
  const normalized = stringOrNull(value);
  if (!normalized) {
    return { number: null, verifier: null };
  }

  const clean = normalized.replace(/\s+/g, '');
  const parts = clean.split('-');
  if (parts.length >= 2) {
    return {
      number: parts.slice(0, -1).join('-') || clean,
      verifier: parts[parts.length - 1] || null
    };
  }

  return { number: clean, verifier: null };
}

function parseDateOrNull(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toBoolean(value) {
  if (typeof value === 'boolean') return value;
  const normalized = stringOrNull(value);
  if (!normalized) return null;
  if (['true', '1', 'yes', 'si', 'sí'].includes(normalized.toLowerCase())) return true;
  if (['false', '0', 'no'].includes(normalized.toLowerCase())) return false;
  return null;
}

function normalizeCustomerType(initialType) {
  const normalized = stringOrNull(initialType);
  return normalized || null;
}

async function processFalabellaOrderItem(item, ctx) {
  const quantity = Number(item?.quantity || 0);
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error("invalid_quantity");
  }

  const sku = item?.sku;
  if (!sku) {
    throw new Error("sku_not_found");
  }

  // ✅ DATOS FINANCIEROS DEL ITEM
  const unitPrice = parseFloat(item?.unitPrice || 0);
  const totalPrice = parseFloat(item?.totalPrice || (unitPrice * quantity)) || (unitPrice * quantity);
  const commission = parseFloat(item?.commission || 0);
  const shippingFee = parseFloat(item?.shippingFee || 0);
  const discount = parseFloat(item?.discount || 0);
  const tax = parseFloat(item?.tax || 0);

  let link = await ProductMarketplaceLinkRepository.findByMarketplaceExternalId(
    ctx.marketplaceId,
    sku
  );

  let productId = link?.product_id || null;
  if (!productId) {
    const variantBySku = await ProductVariantRepository.findBySku(sku);
    productId = variantBySku?.product_id || null;
  }

  if (!productId) {
    throw new Error(`product_not_found:${sku}`);
  }

  const variant = await resolveVariant(productId, sku);
  if (!variant) {
    throw new Error(`variant_not_found:${sku}`);
  }

  const warehouseIds = await resolveWarehouseCandidates({
    marketplaceId: ctx.marketplaceId,
    externalId: sku,
    productId,
    companyId: link?.company_id || ctx.companyId,
    branchId: link?.branch_id || null
  });

  if (!warehouseIds || warehouseIds.length === 0) {
    throw new Error("warehouse_not_found");
  }

  const allocation = await planWarehouseAllocation({
    productId,
    variantId: variant.id,
    warehouseIds,
    quantity
  });

  if (!allocation.ok) {
    throw new Error(`insufficient_stock_total:${allocation.totalAvailable}`);
  }

  // ✅ CALCULAR COSTO Y GANANCIA
  const totalCost = allocation.plan.reduce((sum, entry) => {
    return sum + (entry.deduct || 0) * (entry.costPrice || 0);
  }, 0);

  const costPrice = quantity > 0 ? totalCost / quantity : 0;
  const grossProfit = totalPrice - commission - shippingFee - totalCost;
  const marginPercentage = totalPrice > 0 ? (grossProfit / totalPrice) * 100 : 0;

  const exitResults = await applyStockExitByPlan({
    productId,
    variantId: variant.id,
    allocation,
    orderId: ctx.orderId,
    listingId: sku,
    marketplaceKey: FB_MARKETPLACE_KEY,
    referencePrefix: "fb",
    reason: "falabella_sale",
    financialData: {
      unit_price: unitPrice,
      total_price: totalPrice,
      sale_fee: commission,
      shipping_cost: shippingFee,
      cost_price: costPrice,
      total_cost: totalCost,
      gross_profit: grossProfit,
      margin_percentage: Math.round(marginPercentage * 100) / 100,
      discount: discount,
      tax: tax,
      calculated_at: new Date().toISOString()
    }
  });

  // ✅ GUARDAR ITEM EN marketplace_order_items
  let savedItem = null;
  const itemCompanyId = link?.company_id || ctx.companyId;
  const itemBranchId = link?.branch_id || ctx.branchId;
  if (ctx.orderIdLocal && exitResults.length > 0) {
    try {
      const inventoryMovementId = exitResults[0]?.inventoryMovementId || null;

      savedItem = await MarketplaceOrderItemRepository.create({
        order_id: ctx.orderIdLocal,
        marketplace_item_id: null, // Falabella no devuelve item_id
        listing_id: sku,
        sku: sku,
        product_id: productId,
        variant_id: variant.id,
        company_id: itemCompanyId,
        branch_id: itemBranchId,
        quantity: quantity,
        unit_price: unitPrice,
        total_price: totalPrice,
        discount_amount: discount,
        tax_amount: tax,
        cost_price: costPrice,
        total_cost: totalCost,
        inventory_movement_id: inventoryMovementId
      });

      // ✅ GUARDAR FEE DEL ITEM (commission)
      if (commission > 0) {
        await MarketplaceOrderFeeRepository.create({
          order_id: ctx.orderIdLocal,
          order_item_id: savedItem.id,
          company_id: itemCompanyId,
          fee_type: 'commission',
          amount: commission,
          percentage: unitPrice > 0 ? (commission / unitPrice) * 100 : 0,
          status: 'pending',
          description: `Comisión Falabella - Item ${sku}`,
          raw_data: { commission: commission }
        });
      }
    } catch (error) {
      logger.error(`[FB Webhook] Error guardando item ${sku}: ${error.message}`);
    }
  }

  // ✅ ENCULAR SYNC DE STOCK
  for (const result of exitResults) {
    await queueStockSync({
      productId,
      variantId: variant.id,
      warehouseId: result.warehouseId,
      stock: result.stockAfter,
      sourceMarketplaceId: ctx.marketplaceId,
      companyId: itemCompanyId,
      branchId: itemBranchId,
      logPrefix: "FB Webhook"
    });
  }

  return savedItem;
}

async function processOrderItem(orderItem, ctx) {
  const quantity = Number(orderItem?.quantity || 0);
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error("invalid_quantity");
  }

  const unitPrice = Number(orderItem?.unit_price || 0);
  const saleFee = Number(orderItem?.sale_fee || 0);
  const totalPrice = unitPrice * quantity;

  const listingId = getListingId(orderItem);
  if (!listingId) {
    throw new Error("listing_id_not_found");
  }

  const link = await ProductMarketplaceLinkRepository.findByMarketplaceExternalId(
    ctx.marketplaceId,
    listingId
  );
  if (!link) {
    throw new Error(`product_link_not_found:${listingId}`);
  }

  const productId = link.product_id;
  const sku = getSkuFromOrderItem(orderItem);

  const variant = await resolveVariant(productId, sku);
  if (!variant) {
    throw new Error(`variant_not_found:${sku || "no_sku"}`);
  }

  const warehouseIds = await resolveWarehouseCandidates({
    marketplaceId: ctx.marketplaceId,
    externalId: listingId,
    productId,
    companyId: link.company_id || ctx.companyId,
    branchId: link.branch_id || ctx.branchId
  });

  if (!warehouseIds || warehouseIds.length === 0) {
    throw new Error("warehouse_not_found");
  }

  const allocation = await planWarehouseAllocation({
    productId,
    variantId: variant.id,
    warehouseIds,
    quantity
  });

  if (!allocation.ok) {
    throw new Error(`insufficient_stock_total:${allocation.totalAvailable}`);
  }

  let shippingCostForItem = 0;
  const orderSellerShippingCost = Number(ctx.sellerShippingCost || 0);
  if (orderSellerShippingCost > 0) {
    const denominator = Number(ctx.totalQuantity || 0) > 0
      ? Number(ctx.totalQuantity)
      : Number(ctx.totalItems || 1);
    const weight = Number(ctx.totalQuantity || 0) > 0 ? quantity : 1;
    shippingCostForItem = (orderSellerShippingCost * weight) / denominator;
  }

  const totalCost = allocation.plan.reduce((sum, entry) => {
    return sum + (entry.deduct || 0) * (entry.costPrice || 0);
  }, 0);

  const costPrice = quantity > 0 ? totalCost / quantity : 0;
  const grossProfit = totalPrice - saleFee - shippingCostForItem - totalCost;
  const marginPercentage = totalPrice > 0 ? (grossProfit / totalPrice) * 100 : 0;

  logger.info(`[ML Webhook] Cálculo financiero - Order: ${ctx.orderId}, Item: ${listingId}`, {
    unit_price: unitPrice,
    quantity: quantity,
    total_price: totalPrice,
    sale_fee: saleFee,
    shipping_cost_item: Math.round(shippingCostForItem),
    shipping_cost_order_seller: Math.round(orderSellerShippingCost),
    shipping_cost_order_buyer: Math.round(Number(ctx.buyerShippingCost || 0)),
    shipping_cost_order_gross: Math.round(Number(ctx.shippingGrossAmount || 0)),
    shipping_subsidy_order: Math.round(Number(ctx.shippingSubsidy || 0)),
    cost_price: costPrice,
    total_cost: totalCost,
    gross_profit: Math.round(grossProfit),
    margin_percentage: Math.round(marginPercentage * 100) / 100
  });

  const exitResults = await applyStockExitByPlan({
    productId,
    variantId: variant.id,
    allocation,
    orderId: ctx.orderId,
    listingId,
    marketplaceKey: ML_MARKETPLACE_KEY,
    referencePrefix: "ml",
    reason: "mercadolibre_sale",
    financialData: {
      unit_price: unitPrice,
      total_price: totalPrice,
      sale_fee: saleFee,
      shipping_cost: Math.round(shippingCostForItem),
      cost_price: costPrice,
      total_cost: totalCost,
      gross_profit: Math.round(grossProfit),
      margin_percentage: Math.round(marginPercentage * 100) / 100,
      logistic_type: ctx.logisticType,
      shipping_cost_order_seller: Math.round(orderSellerShippingCost),
      shipping_cost_order_buyer: Math.round(Number(ctx.buyerShippingCost || 0)),
      shipping_cost_order_gross: Math.round(Number(ctx.shippingGrossAmount || 0)),
      shipping_subsidy_order: Math.round(Number(ctx.shippingSubsidy || 0)),
      shipping_free: ctx.freeShipping,
      shipping_who_pays: ctx.shippingWhoPays,
      calculated_at: new Date().toISOString()
    }
  });

  // ✅ GUARDAR ITEM EN marketplace_order_items
  let savedItem = null;
  const itemCompanyId = link.company_id || ctx.companyId;
  const itemBranchId = link.branch_id || ctx.branchId;
  if (ctx.orderIdLocal && exitResults.length > 0) {
    try {
      const inventoryMovementId = exitResults[0]?.inventoryMovementId || null;
      
      savedItem = await MarketplaceOrderItemRepository.create({
        order_id: ctx.orderIdLocal,
        marketplace_item_id: orderItem.id?.toString() || null,
        listing_id: listingId,
        sku: sku,
        product_id: productId,
        variant_id: variant.id,
        company_id: itemCompanyId,
        branch_id: itemBranchId,
        quantity: quantity,
        unit_price: unitPrice,
        total_price: totalPrice,
        discount_amount: 0,
        tax_amount: 0,
        cost_price: costPrice,
        total_cost: totalCost,
        inventory_movement_id: inventoryMovementId
      });

      // ✅ GUARDAR FEE DEL ITEM (commission)
      if (saleFee > 0) {
        await MarketplaceOrderFeeRepository.create({
          order_id: ctx.orderIdLocal,
          order_item_id: savedItem.id,
          company_id: itemCompanyId,
          fee_type: 'commission',
          amount: saleFee,
          percentage: unitPrice > 0 ? (saleFee / unitPrice) * 100 : 0,
          status: 'pending',
          description: `Comisión ML - Item ${listingId}`,
          raw_data: { sale_fee: saleFee }
        });
      }
    } catch (error) {
      logger.error(`[ML Webhook] Error guardando item ${listingId}: ${error.message}`);
    }
  }

  // ✅ ENCULAR SYNC DE STOCK
  for (const result of exitResults) {
    await queueStockSync({
      productId,
      variantId: variant.id,
      warehouseId: result.warehouseId,
      stock: result.stockAfter,
      sourceMarketplaceId: ctx.marketplaceId,
      companyId: itemCompanyId,
      branchId: itemBranchId,
      logPrefix: "ML Webhook"
    });
  }

  return savedItem;
}

async function resolveVariant(productId, sku) {
  if (sku) {
    const bySku = await ProductVariantRepository.findBySku(sku);
    if (bySku && Number(bySku.product_id) === Number(productId)) {
      return bySku;
    }
  }

  const variants = await ProductVariantRepository.findByProductId(productId);
  if (variants.length === 1) {
    return variants[0];
  }

  return null;
}

async function resolveWarehouseCandidates({ marketplaceId, externalId, productId, companyId, branchId }) {
  const lastTask = await ProductPublishingTaskRepository.findLatestByExternalId(
    marketplaceId,
    externalId
  );
  const poolWarehouseIds = extractPoolWarehouseIds(lastTask?.job?.config?.pool);
  if (poolWarehouseIds.length > 0) {
    return poolWarehouseIds;
  }

  if (lastTask?.warehouse_id) {
    return [lastTask.warehouse_id];
  }

  let finalCompanyId = companyId;
  let finalBranchId = branchId;

  if (!finalCompanyId && productId) {
    const product = await ProductRepository.findById(productId);
    finalCompanyId = product?.company_id || null;
  }

  if (!finalCompanyId && !finalBranchId) {
    return [];
  }

  const warehouses = await WarehouseRepository.findWarehousesByCompanyOrBranch(
    finalCompanyId,
    finalBranchId
  );

  if (!warehouses || warehouses.length === 0) {
    return [];
  }

  const active = warehouses.find((w) => w.status === "activo") || warehouses[0];
  return active?.id ? [active.id] : [];
}

async function resolveWarehouseId({ marketplaceId, externalId, productId, companyId, branchId }) {
  const candidates = await resolveWarehouseCandidates({
    marketplaceId,
    externalId,
    productId,
    companyId,
    branchId
  });
  return candidates[0] || null;
}

function extractPoolWarehouseIds(pool) {
  if (!pool) return [];

  const warehouses = Array.isArray(pool.warehouses) ? pool.warehouses : [];
  const primary =
    pool.primary_warehouse ||
    warehouses.find((w) => w?.is_primary) ||
    null;

  let ordered = [];
  if (primary) {
    ordered.push(primary);
  }

  const primaryId = primary?.warehouse_id ?? primary?.id ?? null;
  const others = warehouses.filter((w) => {
    const id = w?.warehouse_id ?? w?.id ?? null;
    if (!id) return false;
    return primaryId == null || id !== primaryId;
  });

  others.sort((a, b) => {
    const posA = Number.isFinite(a?.position) ? a.position : 0;
    const posB = Number.isFinite(b?.position) ? b.position : 0;
    return posA - posB;
  });

  if (!primary && others.length > 0) {
    ordered = others;
  } else {
    ordered = ordered.concat(others);
  }

  const ids = ordered
    .map((w) => w?.warehouse_id ?? w?.id ?? null)
    .filter((id) => id != null);

  return [...new Set(ids)];
}

async function planWarehouseAllocation({ productId, variantId, warehouseIds, quantity }) {
  const plan = [];
  let totalAvailable = 0;

  for (const warehouseId of warehouseIds) {
    const stockInfo = await getWarehouseStockAndCost(productId, variantId, warehouseId);
    totalAvailable += stockInfo.available;
    plan.push({
      warehouseId,
      available: stockInfo.available,
      costPrice: stockInfo.costPrice
    });
  }

  if (totalAvailable < quantity) {
    return { ok: false, totalAvailable, plan };
  }

  let remaining = quantity;
  for (const entry of plan) {
    if (remaining <= 0) {
      entry.deduct = 0;
      continue;
    }
    const toDeduct = Math.min(entry.available, remaining);
    entry.deduct = toDeduct;
    remaining -= toDeduct;
  }

  return { ok: true, totalAvailable, plan };
}

async function getWarehouseStockAndCost(productId, variantId, warehouseId) {
  const warehouseProduct = await WarehouseProductRepository.findByWarehouseAndProduct(
    warehouseId,
    productId
  );
  if (!warehouseProduct) {
    return { available: 0, costPrice: 0 };
  }

  const wpVariant = await WarehouseProductVariantRepository.findByVariantAndWarehouseProduct(
    variantId,
    warehouseProduct.id
  );
  if (!wpVariant) {
    return { available: 0, costPrice: 0 };
  }

  return {
    available: parseInt(wpVariant.stock, 10) || 0,
    costPrice: parseFloat(wpVariant.purchase_price || wpVariant.price || 0)
  };
}

async function applyStockExitByPlan({
  productId,
  variantId,
  allocation,
  orderId,
  listingId,
  marketplaceKey,
  referencePrefix,
  reason,
  financialData
}) {
  const results = [];
  let firstInventoryMovementId = null;

  for (const entry of allocation.plan) {
    const qty = Number(entry.deduct || 0);
    if (qty <= 0) continue;

    const exitResult = await applyStockExit({
      productId,
      variantId,
      warehouseId: entry.warehouseId,
      quantity: qty,
      orderId,
      listingId,
      marketplaceKey,
      referencePrefix,
      reason,
      financial_data: financialData
    });

    if (!firstInventoryMovementId && exitResult?.inventoryMovementId) {
      firstInventoryMovementId = exitResult.inventoryMovementId;
    }

    results.push({ 
      warehouseId: entry.warehouseId, 
      stockAfter: exitResult?.stockAfter,
      inventoryMovementId: exitResult?.inventoryMovementId || null
    });
  }

  return results;
}

async function applyStockExit({
  productId,
  variantId,
  warehouseId,
  quantity,
  orderId,
  listingId,
  marketplaceKey,
  referencePrefix,
  reason,
  financial_data = null  // ✅ NUEVO: Datos financieros opcionales
}) {
  const finalMarketplaceKey = marketplaceKey || "marketplace";
  const finalReferencePrefix = referencePrefix || finalMarketplaceKey;
  const transaction = await sequelize.transaction();

  try {
    const warehouseProduct = await WarehouseProductRepository.findByWarehouseAndProduct(
      warehouseId,
      productId
    );

    if (!warehouseProduct) {
      throw new Error("warehouse_product_not_found");
    }

    const wpVariant = await WarehouseProductVariantRepository.findByVariantAndWarehouseProduct(
      variantId,
      warehouseProduct.id
    );

    if (!wpVariant) {
      throw new Error("warehouse_product_variant_not_found");
    }

    const stockBefore = parseInt(wpVariant.stock, 10) || 0;
    if (stockBefore < quantity) {
      throw new Error(`insufficient_stock:${stockBefore}`);
    }

    const stockAfter = stockBefore - quantity;
    const updateData = { stock: stockAfter };

    if (stockAfter === 0) {
      updateData.price = null;
      updateData.promotional_price = null;
      updateData.local_sku = null;
      updateData.active = false;
      updateData.published = false;
    }

    await WarehouseProductVariantRepository.update(wpVariant, updateData, { transaction });

    let companyId = warehouseProduct.company_id || null;
    let branchId = warehouseProduct.branch_id || null;
    if (!companyId && !branchId) {
      const warehouse = await WarehouseRepository.findById(warehouseId);
      companyId = warehouse?.company_id || null;
      branchId = warehouse?.branch_id || null;
    }

    // ✅ PREPARAR METADATOS CON INFORMACIÓN FINANCIERA
    const meta = {
      order_id: orderId,
      listing_id: listingId,
      marketplace: finalMarketplaceKey,
      pre_sale_state: {
        price: wpVariant.price ?? null,
        promotional_price: wpVariant.promotional_price ?? null,
        local_sku: wpVariant.local_sku ?? null,
        active: wpVariant.active ?? null,
        published: wpVariant.published ?? null
      }
    };

    // Agregar datos financieros si existen
    if (financial_data) {
      meta.financial_data = financial_data;
      meta.calculated_at = financial_data.calculated_at || new Date().toISOString();
    }

    const movement = await InventoryMovementRepository.create({
      warehouse_id: warehouseId,
      product_id: productId,
      variant_id: variantId,
      company_id: companyId,
      branch_id: branchId,
      movement_type: "exit",
      quantity,
      stock_before: stockBefore,
      stock_after: stockAfter,
      unit_price: wpVariant.price || null,
      total_value: wpVariant.price ? wpVariant.price * quantity : null,
      reference_type: finalMarketplaceKey,
      reference_id: `${finalReferencePrefix}:${orderId}:${listingId}`,
      reason: reason || `${finalMarketplaceKey}_sale`,
      notes: `order:${orderId}`,
      user_id: null,
      meta: meta  // ✅ GUARDAR METADATOS CON DATOS FINANCIEROS
    }, { transaction });

    await transaction.commit();
    return { 
      stockAfter,
      inventoryMovementId: movement?.id || null
    };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

async function queueStockSync({
  productId,
  variantId,
  warehouseId,
  stock,
  sourceMarketplaceId,
  companyId,
  branchId,
  logPrefix,
  includeSourceMarketplace = false
}) {
  try {
    const job = await MarketplaceStockSyncService.enqueueStockSync({
      productId,
      variantId,
      warehouseId,
      stock,
      sourceMarketplaceId,
      companyId,
      branchId,
      includeSourceMarketplace
    });

    if (!job) return;

    const prefix = logPrefix || "Webhook";
    logger.info(`[${prefix}] Job de sync creado: ${job.id}`);
  } catch (error) {
    const prefix = logPrefix || "Webhook";
    logger.warn(`[${prefix}] Error preparando sync: ${error.message}`);
  }
}

function extractOrderId(resource) {
  if (!resource || typeof resource !== "string") return null;
  const match = resource.match(/\/?orders\/(\d+)/);
  if (match && match[1]) return match[1];
  const parts = resource.split("/");
  return parts.length > 0 ? parts[parts.length - 1] : null;
}

function validateMercadoLibrePayload(payload) {
  if (!payload || typeof payload !== "object") {
    return { ok: false, reason: "payload_not_object" };
  }

  if (!payload.topic) {
    return { ok: false, reason: "topic_missing" };
  }

  if (!payload.resource) {
    return { ok: false, reason: "resource_missing" };
  }

  if (payload.user_id == null) {
    return { ok: false, reason: "user_id_missing" };
  }

  return { ok: true };
}

function buildMercadoLibreEventId(payload, resource) {
  const eventId = payload?._id != null ? String(payload._id) : null;
  if (eventId) return eventId;

  const sent = payload?.sent ? String(payload.sent) : null;
  if (sent) return `sent:${resource}:${sent}`;

  const received = payload?.received ? String(payload.received) : null;
  if (received) return `received:${resource}:${received}`;

  return `resource:${resource}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout(promise, timeoutMs) {
  let timerId = null;
  const timeoutPromise = new Promise((_, reject) => {
    timerId = setTimeout(() => {
      reject(new Error("timeout"));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timerId) clearTimeout(timerId);
  }
}

function getListingId(orderItem) {
  return (
    orderItem?.item?.id ||
    orderItem?.item_id ||
    orderItem?.id ||
    null
  );
}

function getSkuFromOrderItem(orderItem) {
  return (
    orderItem?.item?.seller_custom_field ||
    orderItem?.item?.seller_sku ||
    orderItem?.seller_custom_field ||
    orderItem?.seller_sku ||
    null
  );
}

function extractFalabellaOrderId(payload) {
  return (
    payload?.OrderId ||
    payload?.order_id ||
    payload?.orderId ||
    payload?.data?.OrderId ||
    payload?.data?.order_id ||
    payload?.data?.orderId ||
    null
  );
}

function getFalabellaSellerId(payload) {
  return (
    payload?.seller_id ||
    payload?.sellerId ||
    payload?.SellerId ||
    payload?.SellerID ||
    payload?.user_id ||
    payload?.userId ||
    payload?.UserID ||
    null
  );
}

function validateFalabellaPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return { ok: false, reason: "payload_not_object" };
  }

  const topicRaw =
    payload?.event ||
    payload?.event_type ||
    payload?.topic ||
    payload?.type ||
    null;

  if (!topicRaw) {
    return { ok: false, reason: "topic_missing" };
  }

  return { ok: true };
}

function normalizeFalabellaTopicName(topic) {
  return topic ? String(topic).trim().toLowerCase() : null;
}

function buildFalabellaEventId(payload, resource, topic = null) {
  const topicPart = normalizeFalabellaTopicName(
    topic || payload?.event || payload?.event_type || payload?.topic || payload?.type || ''
  );
  const eventId =
    payload?.event_id ||
    payload?.EventId ||
    payload?.eventId ||
    payload?.payload?.event_id ||
    payload?.payload?.EventId ||
    payload?.payload?.eventId ||
    payload?.data?.event_id ||
    null;
  if (eventId) {
    return topicPart ? `${topicPart}:${String(eventId)}` : String(eventId);
  }

  const timestamp =
    payload?.timestamp ||
    payload?.created_at ||
    payload?.createdAt ||
    payload?.data?.created_at ||
    null;
  if (timestamp) {
    return topicPart ? `ts:${topicPart}:${resource}:${timestamp}` : `ts:${resource}:${timestamp}`;
  }

  if (!FB_ENABLE_PRODUCT_EVENT_RECONCILIATION && /^products\//i.test(String(resource || ''))) {
    return null;
  }

  // Falabella no dio identificador confiable ni timestamp: no convertir esto en
  // una identidad permanente. Se usa un receipt efimero para registrar y reconciliar.
  const receiptId = crypto.randomUUID();
  return topicPart ? `receipt:${topicPart}:${resource}:${receiptId}` : `receipt:${resource}:${receiptId}`;
}

function rfc3986Encode(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => {
    return `%${c.charCodeAt(0).toString(16).toUpperCase()}`;
  });
}

function timestampMinus03(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}-03:00`
  );
}

function buildFalabellaSignedUrl(params, apiKey) {
  const sortedKeys = Object.keys(params).sort();
  const canonicalQuery = sortedKeys
    .map((k) => `${rfc3986Encode(k)}=${rfc3986Encode(String(params[k]))}`)
    .join("&");

  const signatureHex = crypto
    .createHmac("sha256", apiKey.trim())
    .update(canonicalQuery, "utf8")
    .digest("hex");

  const signatureEncoded = rfc3986Encode(signatureHex);
  const urlQueryString = `${canonicalQuery}&Signature=${signatureEncoded}`;

  return `https://sellercenter-api.falabella.com?${urlQueryString}`;
}

/**
 * Mapea el estado de orden de Falabella a estado interno
 */
function mapFalabellaOrderStatus(fbStatus) {
  if (!fbStatus) return 'pending';
  
  const statusMap = {
    'confirmed': 'paid',
    'confirmed by seller': 'paid',
    'shipped': 'shipped',
    'delivered': 'delivered',
    'cancelled': 'cancelled',
    'returned': 'returned',
    'pending': 'pending',
    'on order created': 'pending',
    'order created': 'pending'
  };
  
  return statusMap[fbStatus.toLowerCase()] || 'pending';
}

// ==========================================
// FUNCIONES AUXILIARES PARA MARKETPLACE ORDERS
// ==========================================

/**
 * Resuelve compañía, sucursal y usuario operativo desde un listing/producto.
 * Usa ProductMarketplaceLink como fuente canónica.
 * @param {String} marketplace - Nombre del marketplace
 * @param {String} listingId - ID del listing en el marketplace
 * @returns {Promise<Object|null>} { company_id, branch_id, user_id }
 */
async function resolveCompanyFromListing(marketplace, listingId) {
  try {
    if (!marketplace || !listingId) return null;
    
    // Buscar el link producto-marketplace por listing_id
    const link = await ProductMarketplaceLinkRepository.findByMarketplaceExternalId(
      marketplace === ML_MARKETPLACE_KEY ? 'mercadolibre' : 'falabella',
      listingId
    );
    
    if (link) {
      return {
        company_id: link.company_id || null,
        user_id: link.user_id || null,
        branch_id: link.branch_id || null
      };
    }
    
    return null;
  } catch (error) {
    logger.error(`[resolveCompanyFromListing] Error: ${error.message}`);
    return null;
  }
}

/**
 * Resuelve compañía desde un producto
 * @param {Number} productId - ID del producto
 * @returns {Promise<Object|null>} { company_id, user_id }
 */
async function resolveCompanyFromProduct(productId) {
  try {
    if (!productId) return null;
    
    const product = await ProductRepository.findById(productId);
    if (product && product.company_id) {
      return {
        company_id: product.company_id,
        user_id: null
      };
    }
    
    return null;
  } catch (error) {
    logger.error(`[resolveCompanyFromProduct] Error: ${error.message}`);
    return null;
  }
}

/**
 * Mapea el estado de orden de Mercado Libre a estado interno
 */
function mapMercadoLibreOrderStatus(mlStatus) {
  if (!mlStatus) return 'pending';
  
  const statusMap = {
    'paid': 'paid',
    'confirmed': 'paid',
    'shipped': 'shipped',
    'delivered': 'delivered',
    'cancelled': 'cancelled',
    'refunded': 'returned',
    'pending': 'pending',
    'processing': 'pending'
  };
  
  return statusMap[mlStatus.toLowerCase()] || 'pending';
}

/**
 * Mapea el estado de pago de Mercado Libre a estado interno
 */
function mapMercadoLibrePaymentStatus(mlStatus) {
  if (!mlStatus) return 'pending';
  
  const statusMap = {
    'paid': 'paid',
    'pending': 'pending',
    'authorized': 'authorized',
    'in_process': 'processing',
    'in_mediation': 'mediation',
    'cancelled': 'cancelled',
    'refunded': 'refunded',
    'charged_back': 'charged_back'
  };
  
  return statusMap[mlStatus.toLowerCase()] || 'pending';
}

/**
 * Construye dirección de envío desde datos de Mercado Libre
 */
function buildShippingAddress(shipping) {
  if (!shipping) return null;
  
  const address = shipping.receiver_address || {};
  const parts = [];
  
  if (address.street_name) parts.push(`${address.street_name} ${address.street_number || ''}`);
  if (address.city_name) parts.push(address.city_name);
  if (address.state_name) parts.push(address.state_name);
  if (address.country_name) parts.push(address.country_name);
  if (address.zip_code) parts.push(address.zip_code);
  
  return parts.join(', ') || null;
}

/**
 * Calcula el porcentaje promedio de comisión
 */
function calculateAverageCommissionPercentage(totalFees, totalAmount) {
  if (!totalAmount || totalAmount <= 0) return 0;
  return parseFloat(((totalFees / totalAmount) * 100).toFixed(2));
}

function getMarketplaceOrderReferencePrefix(marketplaceKey) {
  if (marketplaceKey === ML_MARKETPLACE_KEY) return "ml";
  if (marketplaceKey === FB_MARKETPLACE_KEY) return "fb";
  return String(marketplaceKey || "marketplace");
}

function getMarketplaceOrderLifecycleDecision({ orderStatus, paymentStatus }) {
  const normalizedOrderStatus = stringOrNull(orderStatus)?.toLowerCase() || null;
  const normalizedPaymentStatus = stringOrNull(paymentStatus)?.toLowerCase() || null;

  const shouldReverse =
    Boolean(normalizedOrderStatus && STOCK_REVERSE_ORDER_STATUSES.has(normalizedOrderStatus)) ||
    Boolean(normalizedPaymentStatus && STOCK_REVERSE_PAYMENT_STATUSES.has(normalizedPaymentStatus));

  const shouldDeduct =
    !shouldReverse && (
      Boolean(normalizedOrderStatus && STOCK_SALE_STATUSES.has(normalizedOrderStatus)) ||
      ["paid", "authorized", "processing", "confirmed", "in_process"].includes(normalizedPaymentStatus)
    );

  return {
    orderStatus: normalizedOrderStatus,
    paymentStatus: normalizedPaymentStatus,
    shouldDeduct,
    shouldReverse
  };
}

async function getMarketplaceOrderStockState(marketplaceKey, orderId) {
  const referencePrefix = getMarketplaceOrderReferencePrefix(marketplaceKey);
  const movements = await InventoryMovementRepository.findByReferencePrefix(
    `${referencePrefix}:${orderId}:`
  );
  const reversalMovements = await InventoryMovementRepository.findByReferencePrefix(
    `${referencePrefix}:reversal:`
  );
  const reversedMovementIds = new Set(
    reversalMovements
      .map((movement) => {
        const referenceId = String(movement.reference_id || "");
        const parts = referenceId.split(":");
        return parts.length >= 3 ? parts[2] : null;
      })
      .filter(Boolean)
  );
  const exitMovements = movements.filter(
    (movement) => String(movement.movement_type || "").toLowerCase() === "exit"
  );
  const events = await MarketplaceOrderEventRepository.findByOrderId(orderId);
  const pendingReversalCount = exitMovements.filter(
    (movement) => !reversedMovementIds.has(String(movement.id))
  ).length;

  return {
    movements,
    events,
    pendingReversalCount,
    hasDeduction:
      movements.some((movement) => String(movement.movement_type || "").toLowerCase() === "exit") ||
      events.some((event) => event.event_type === STOCK_DEDUCT_EVENT_TYPE),
    hasReversal: pendingReversalCount === 0 && exitMovements.length > 0 && reversedMovementIds.size > 0
  };
}

function normalizeInventoryMovementMeta(meta) {
  if (!meta) return {};
  if (typeof meta === "object") return meta;
  if (typeof meta !== "string") return {};

  try {
    const parsed = JSON.parse(meta);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    return {};
  }
}

async function reverseMarketplaceOrderStock({
  order,
  marketplaceKey,
  orderId,
  reason,
  payload = null,
  sourceMarketplaceId = null,
  includeSourceMarketplace = true
}) {
  const referencePrefix = getMarketplaceOrderReferencePrefix(marketplaceKey);
  const movements = await InventoryMovementRepository.findByReferencePrefix(
    `${referencePrefix}:${orderId}:`
  );
  const reversalMovements = await InventoryMovementRepository.findByReferencePrefix(
    `${referencePrefix}:reversal:`
  );
  const reversedMovementIds = new Set(
    reversalMovements
      .map((movement) => {
        const referenceId = String(movement.reference_id || "");
        const parts = referenceId.split(":");
        return parts.length >= 3 ? parts[2] : null;
      })
      .filter(Boolean)
  );
  const exitMovements = movements.filter(
    (movement) => String(movement.movement_type || "").toLowerCase() === "exit"
  );
  const pendingMovements = exitMovements.filter(
    (movement) => !reversedMovementIds.has(String(movement.id))
  );

  if (pendingMovements.length === 0) {
    return { reversed: false, errors: [], results: [] };
  }

  const results = [];
  const errors = [];

  for (const movement of pendingMovements) {
    const transaction = await sequelize.transaction();

    try {
      const warehouseId = movement.warehouse_id || null;
      const productId = movement.product_id || null;
      const variantId = movement.variant_id || null;

      if (!warehouseId || !productId || !variantId) {
        throw new Error("movement_context_missing");
      }

      const warehouseProduct = await WarehouseProductRepository.findByWarehouseAndProduct(
        warehouseId,
        productId
      );
      if (!warehouseProduct) {
        throw new Error("warehouse_product_not_found");
      }

      const wpVariant = await WarehouseProductVariantRepository.findByVariantAndWarehouseProduct(
        variantId,
        warehouseProduct.id
      );
      if (!wpVariant) {
        throw new Error("warehouse_product_variant_not_found");
      }

      const quantity = parseInt(movement.quantity, 10) || 0;
      if (quantity <= 0) {
        throw new Error("invalid_reversal_quantity");
      }

      const stockBefore = parseInt(wpVariant.stock, 10) || 0;
      const stockAfter = stockBefore + quantity;
      const movementMeta = normalizeInventoryMovementMeta(movement.meta);
      const preSaleState = movementMeta.pre_sale_state || {};
      const updateData = { stock: stockAfter };

      if (preSaleState && Object.keys(preSaleState).length > 0) {
        if (preSaleState.price !== undefined) updateData.price = preSaleState.price;
        if (preSaleState.promotional_price !== undefined) updateData.promotional_price = preSaleState.promotional_price;
        if (preSaleState.local_sku !== undefined) updateData.local_sku = preSaleState.local_sku;
        if (preSaleState.active !== undefined) updateData.active = preSaleState.active;
        if (preSaleState.published !== undefined) updateData.published = preSaleState.published;
      } else if (stockAfter > 0) {
        updateData.active = true;
        updateData.published = true;
      }

      await WarehouseProductVariantRepository.update(wpVariant, updateData, { transaction });

      let companyId = movement.company_id || warehouseProduct.company_id || null;
      let branchId = movement.branch_id || warehouseProduct.branch_id || null;
      if (!companyId && !branchId) {
        const warehouse = await WarehouseRepository.findById(warehouseId);
        companyId = warehouse?.company_id || null;
        branchId = warehouse?.branch_id || null;
      }

      const reversalMovement = await InventoryMovementRepository.create({
        warehouse_id: warehouseId,
        product_id: productId,
        variant_id: variantId,
        company_id: companyId,
        branch_id: branchId,
        movement_type: "entry",
        quantity,
        stock_before: stockBefore,
        stock_after: stockAfter,
        unit_price: movement.unit_price || null,
        total_value: movement.total_value || null,
        reference_type: referencePrefix,
        reference_id: `${referencePrefix}:reversal:${movement.id}`,
        reason: reason || `${referencePrefix}_reversal`,
        notes: `reversal_of:${movement.reference_id}`,
        user_id: null,
        meta: {
          order_id: orderId,
          marketplace: marketplaceKey,
          original_movement_id: movement.id,
          original_reference_id: movement.reference_id,
          reverse_reason: reason || null,
          payload: payload || null
        }
      }, { transaction });

      await transaction.commit();

      results.push({
        warehouseId,
        productId,
        variantId,
        stockAfter,
        inventoryMovementId: reversalMovement?.id || null
      });
    } catch (error) {
      await transaction.rollback();
      errors.push(error.message);
      logger.error(`[${marketplaceKey.toUpperCase()} Webhook] Error revirtiendo stock de orden ${orderId}: ${error.message}`);
    }
  }

  if (results.length > 0) {
    for (const result of results) {
      try {
        await queueStockSync({
          productId: result.productId,
          variantId: result.variantId,
          warehouseId: result.warehouseId,
          stock: result.stockAfter,
          sourceMarketplaceId,
          companyId: order?.company_id || null,
          branchId: order?.branch_id || null,
          logPrefix: `${marketplaceKey.toUpperCase()} Reversal`,
          includeSourceMarketplace
        });
      } catch (error) {
        errors.push(error.message);
        logger.warn(`[${marketplaceKey.toUpperCase()} Webhook] Error encola sync reversa orden ${orderId}: ${error.message}`);
      }
    }
  }

  return {
    reversed: results.length > 0,
    completed: pendingMovements.length === results.length && errors.length === 0,
    errors,
    results
  };
}

/**
 * Actualiza applyStockExitByPlan para devolver el inventoryMovementId
 */
const originalApplyStockExitByPlan = global.applyStockExitByPlan;

// ==========================================

module.exports = MarketplaceWebhookController;
MarketplaceWebhookController._processFalabellaEvent = processFalabellaEvent;
MarketplaceWebhookController._fetchFalabellaOrdersV2 = fetchFalabellaOrdersV2;
MarketplaceWebhookController._parseFalabellaOrderIds = parseFalabellaOrderIds;
