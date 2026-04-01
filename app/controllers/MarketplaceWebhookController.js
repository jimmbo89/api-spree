const logger = require("../../config/logger");
const axios = require("axios");
const crypto = require("crypto");
const { sequelize } = require("../models");
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
  CompanyRepository,
  UserCompanyRepository
} = require("../repositories");
const MarketplaceStockSyncService = require("../services/MarketplaceStockSyncService");

const ML_MARKETPLACE_KEY = "mercadolibre";
const FB_MARKETPLACE_KEY = "falabella";
const ML_ORDERS_TOPIC = "orders_v2";
const ML_WEBHOOK_TIMEOUT_MS = 30000;
const ML_FETCH_RETRY_MAX = 3;
const ML_FETCH_RETRY_BASE_DELAY_MS = 1000;
const ML_FETCH_RETRY_MAX_DELAY_MS = 8000;
const FB_WEBHOOK_TIMEOUT_MS = 30000;
const FB_FETCH_RETRY_MAX = 3;
const FB_FETCH_RETRY_BASE_DELAY_MS = 1500;
const FB_FETCH_RETRY_MAX_DELAY_MS = 8000;
const FB_ORDER_TOPICS = new Set(["onordercreated", "ordercreated", "onorderitemsstatuschanged"]);
const FB_API_VERSION = process.env.FB_API_VERSION || "2.0";
const FB_USER_AGENT = process.env.FB_USER_AGENT || "Spree/1.0";

const MarketplaceWebhookController = {
  async mercadoLibre(req, res) {
    const payload = req.body || {};

    res.status(200).json({ success: true });

    setImmediate(() => {
      processMercadoLibreWebhook(payload, { timeoutMs: ML_WEBHOOK_TIMEOUT_MS }).catch((err) => {
        logger.error(`[ML Webhook] Error en procesamiento async: ${err.message}`);
      });
    });
  },

  async falabella(req, res) {
    const payload = req.body || {};

    res.status(200).json({ success: true });

    setImmediate(() => {
      processFalabellaWebhook(payload, { timeoutMs: FB_WEBHOOK_TIMEOUT_MS }).catch((err) => {
        logger.error(`[FB Webhook] Error en procesamiento async: ${err.message}`);
      });
    });
  }
};

async function processMercadoLibreWebhook(payload, options = {}) {
  const validation = validateMercadoLibrePayload(payload);
  if (!validation.ok) {
    logger.warn(`[ML Webhook] Payload invalido: ${validation.reason}`);
    return;
  }

  const { resource, topic, user_id } = payload;

  if (topic !== ML_ORDERS_TOPIC) {
    logger.info(`[ML Webhook] Ignorado topic: ${topic}`);
    return;
  }

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

  // ✅ GUARDAR ORDEN EN marketplace_orders
  const orderData = {
    marketplace: ML_MARKETPLACE_KEY,
    marketplace_order_id: String(order.id),
    marketplace_credential_id: credential.id,
    company_id: companyId,
    branch_id: branchId,
    order_status: mapMercadoLibreOrderStatus(order.order_status),
    payment_status: mapMercadoLibrePaymentStatus(order.payment_status),
    subtotal: order.total_amount || 0,
    shipping_total: order?.shipping?.shipping_cost || 0,
    discount_total: order?.shipping?.shipping_discount || 0,
    tax_total: 0, // ML no devuelve impuestos separados
    total_amount: order.total_amount || 0,
    currency: order.currency_id || 'CLP',
    buyer_id: order?.buyer?.id?.toString() || null,
    buyer_name: order?.buyer?.nickname || null,
    buyer_email: null, // ML no expone email completo
    payment_method: order?.payments?.[0]?.payment_type || null,
    payment_date: order?.payments?.[0]?.date_created || null,
    shipping_address: buildShippingAddress(order.shipping),
    shipping_city: order?.shipping?.receiver_address?.city_name || null,
    shipping_region: order?.shipping?.receiver_address?.state_name || null,
    raw_payload: order
  };

  let savedOrder;
  let orderCreated = false;
  
  try {
    const result = await MarketplaceOrderRepository.upsert(orderData);
    savedOrder = result.record;
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

  // ✅ GUARDAR EVENTO DE CREACIÓN DE ORDEN
  if (orderCreated) {
    await MarketplaceOrderEventRepository.createStatusChange(
      savedOrder.id,
      'created',
      null,
      orderData.order_status,
      order,
      { company_id: companyId }
    );
  }

  // ✅ DATOS DE SHIPPING PARA TODA LA ORDEN
  const shippingData = {
    shippingCost: order?.shipping?.shipping_cost || 0,
    logisticType: order?.shipping?.logistic_type || null,
    shippingDiscount: order?.shipping?.shipping_discount || 0,
    shippingOption: order?.shipping?.shipping_option || null
  };

  const errors = [];
  const savedItems = [];

  // ✅ PROCESAR CADA ITEM
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
        shippingCost: shippingData.shippingCost,
        logisticType: shippingData.logisticType,
        shippingDiscount: shippingData.shippingDiscount,
        totalItems: items.length
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

  await MarketplaceWebhookEventRepository.updateById(event.id, {
    status: errors.length > 0 ? "processed_with_errors" : "processed",
    error_message: errors.length > 0 ? errors.slice(0, 5).join(" | ") : null,
    processed_at: new Date()
  });
}

async function fetchMercadoLibreOrderWithRetry(orderId, accessToken) {
  let lastError = null;

  for (let attempt = 1; attempt <= ML_FETCH_RETRY_MAX; attempt++) {
    try {
      const response = await axios.get(
        `https://api.mercadolibre.com/orders/${orderId}`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: 10000
        }
      );
      return response.data;
    } catch (error) {
      lastError = error;
      const status = error?.response?.status;

      if (status === 404) {
        logger.warn(`[ML Webhook] Orden ${orderId} no encontrada (404)`);
        return null;
      }

      if (status === 401 || status === 403) {
        logger.error(`[ML Webhook] Error de autenticacion ${status} para orden ${orderId}`);
        return null;
      }

      if (attempt < ML_FETCH_RETRY_MAX) {
        const delayMs = Math.min(
          ML_FETCH_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1),
          ML_FETCH_RETRY_MAX_DELAY_MS
        );
        logger.warn(
          `[ML Webhook] Intento ${attempt}/${ML_FETCH_RETRY_MAX} fallido para orden ${orderId}. Reintentando en ${delayMs}ms...`
        );
        await sleep(delayMs);
      }
    }
  }

  logger.error(
    `[ML Webhook] Error obteniendo orden ${orderId} despues de ${ML_FETCH_RETRY_MAX} intentos: ${lastError?.message || "unknown"}`
  );
  return null;
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
  if (normalizedTopic && !FB_ORDER_TOPICS.has(normalizedTopic)) {
    logger.info(`[FB Webhook] Ignorado topic: ${topicRaw}`);
    return;
  }

  const orderId = extractFalabellaOrderId(payload);
  if (!orderId) {
    logger.warn(`[FB Webhook] No se pudo extraer OrderId del payload`);
    return;
  }

  const resource = payload?.resource || `orders/${orderId}`;
  const topic = topicRaw || "onOrderCreated";

  const eventResult = await MarketplaceWebhookEventRepository.createUnique({
    marketplace: FB_MARKETPLACE_KEY,
    topic,
    resource,
    event_id: buildFalabellaEventId(payload, resource),
    external_id: String(orderId),
    marketplace_user_id: getFalabellaSellerId(payload),
    status: "received",
    payload
  });

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

async function processFalabellaEvent({ event, payload, orderId }) {
  const credential = await resolveFalabellaCredential(payload);
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

  // ✅ RESOLVER COMPAÑÍA DESDE EL PRIMER SKU DE LA ORDEN
  // Las credenciales son globales, el company_id viene del producto/link
  const firstSku = items[0]?.sku;
  const companyInfo = await resolveCompanyFromListing(FB_MARKETPLACE_KEY, firstSku);
  const companyId = companyInfo?.company_id || null;
  const branchId = companyInfo?.branch_id || null;

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

  // ✅ GUARDAR ORDEN EN marketplace_orders
  const orderDataToSave = {
    marketplace: FB_MARKETPLACE_KEY,
    marketplace_order_id: String(orderId),
    marketplace_credential_id: credential.id,
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
    buyer_name: orderInfo.buyerName || null,
    buyer_email: null,
    shipping_address: orderInfo.shippingAddress || null,
    shipping_city: orderInfo.shippingCity || null,
    shipping_region: orderInfo.shippingRegion || null,
    raw_payload: orderData
  };

  let savedOrder;
  let orderCreated = false;
  
  try {
    const result = await MarketplaceOrderRepository.upsert(orderDataToSave);
    savedOrder = result.record;
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

  // ✅ GUARDAR EVENTO DE CREACIÓN DE ORDEN
  if (orderCreated) {
    await MarketplaceOrderEventRepository.createStatusChange(
      savedOrder.id,
      'created',
      null,
      orderDataToSave.order_status,
      orderData,
      { company_id: companyId }
    );
  }

  const errors = [];
  const savedItems = [];

  // ✅ PROCESAR CADA ITEM
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
  const order =
    orderData?.SuccessResponse?.Body?.Order ||
    orderData?.SuccessResponse?.Body?.Orders?.Order ||
    null;

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
  const buyerName = [
    customer?.FirstName,
    customer?.LastName
  ].filter(Boolean).join(' ') || null;

  // Dirección de envío
  const shippingAddress = order?.ShippingAddress || {};
  const addressParts = [];
  if (shippingAddress?.Street) addressParts.push(shippingAddress.Street);
  if (shippingAddress?.City) addressParts.push(shippingAddress.City);
  if (shippingAddress?.State || shippingAddress?.Region) addressParts.push(shippingAddress.State || shippingAddress.Region);
  if (shippingAddress?.ZipCode) addressParts.push(shippingAddress.ZipCode);

  return {
    status: order?.OrderStatus || order?.Status || 'pending',
    subtotal,
    shippingTotal,
    discountTotal,
    taxTotal,
    commission: commissionTotal,
    totalAmount,
    buyerName,
    shippingAddress: addressParts.join(', ') || null,
    shippingCity: shippingAddress?.City || null,
    shippingRegion: shippingAddress?.State || shippingAddress?.Region || null,
    createdAt: order?.CreatedDate || order?.CreatedAt || null
  };
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
  if (ctx.orderIdLocal && exitResults.length > 0) {
    try {
      const inventoryMovementId = exitResults[0]?.inventoryMovementId || null;
      const itemCompanyId = link?.company_id || ctx.companyId;
      const itemBranchId = link?.branch_id || ctx.branchId;

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
  if (ctx.logisticType === 'dropoff' && !ctx.shippingDiscount) {
    shippingCostForItem = (ctx.shippingCost || 0) / (ctx.totalItems || 1);
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
      calculated_at: new Date().toISOString()
    }
  });

  // ✅ GUARDAR ITEM EN marketplace_order_items
  let savedItem = null;
  if (ctx.orderIdLocal && exitResults.length > 0) {
    try {
      const inventoryMovementId = exitResults[0]?.inventoryMovementId || null;
      const itemCompanyId = link.company_id || ctx.companyId;
      const itemBranchId = link.branch_id || ctx.branchId;
      
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
      marketplace: finalMarketplaceKey
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
  logPrefix
}) {
  try {
    const job = await MarketplaceStockSyncService.enqueueStockSync({
      productId,
      variantId,
      warehouseId,
      stock,
      sourceMarketplaceId,
      companyId,
      branchId
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

  const orderId = extractFalabellaOrderId(payload);
  if (!orderId) {
    return { ok: false, reason: "order_id_missing" };
  }

  return { ok: true };
}

function buildFalabellaEventId(payload, resource) {
  const eventId =
    payload?.event_id ||
    payload?.EventId ||
    payload?.eventId ||
    payload?.data?.event_id ||
    null;
  if (eventId) return String(eventId);

  const timestamp =
    payload?.timestamp ||
    payload?.created_at ||
    payload?.createdAt ||
    payload?.data?.created_at ||
    null;
  if (timestamp) return `ts:${resource}:${timestamp}`;

  return `resource:${resource}`;
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
 * Resuelve compañía y usuario desde un listing/producto
 * Usa ProductMarketplaceLink que sí tiene company_id
 * @param {String} marketplace - Nombre del marketplace
 * @param {String} listingId - ID del listing en el marketplace
 * @returns {Promise<Object|null>} { company_id, user_id }
 */
async function resolveCompanyFromListing(marketplace, listingId) {
  try {
    if (!marketplace || !listingId) return null;
    
    // Buscar el link producto-marketplace por listing_id
    const link = await ProductMarketplaceLinkRepository.findByMarketplaceExternalId(
      marketplace === ML_MARKETPLACE_KEY ? 'mercadolibre' : 'falabella',
      listingId
    );
    
    if (link && link.company_id) {
      return {
        company_id: link.company_id,
        user_id: null, // El link no tiene user_id directo
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

/**
 * Actualiza applyStockExitByPlan para devolver el inventoryMovementId
 */
const originalApplyStockExitByPlan = global.applyStockExitByPlan;

// ==========================================

module.exports = MarketplaceWebhookController;
MarketplaceWebhookController._processFalabellaEvent = processFalabellaEvent;
MarketplaceWebhookController._fetchFalabellaOrdersV2 = fetchFalabellaOrdersV2;
MarketplaceWebhookController._parseFalabellaOrderIds = parseFalabellaOrderIds;


