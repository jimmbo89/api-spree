const axios = require('axios');
const logger = require('../../config/logger');
const FalabellaOrderSyncService = require('./FalabellaOrderSyncService');
const {
  MarketplaceOrderRepository,
  MarketplaceCredentialRepository,
  MarketplaceOrderCustomerRepository
} = require('../repositories');

const ML_MARKETPLACE_KEY = 'mercadolibre';
const ML_FETCH_RETRY_MAX = 3;
const ML_FETCH_RETRY_BASE_DELAY_MS = 1000;
const ML_FETCH_RETRY_MAX_DELAY_MS = 8000;

const MarketplaceOrderSyncService = {
  async refreshById(orderId) {
    const order = await MarketplaceOrderRepository.findById(orderId);
    if (!order) throw new Error('order_not_found');

    const marketplace = String(order.marketplace || '').toLowerCase();
    if (marketplace === 'falabella') {
      return await FalabellaOrderSyncService.refreshById(orderId);
    }

    if (marketplace !== ML_MARKETPLACE_KEY) {
      throw new Error('unsupported_marketplace');
    }

    const fallbackOrder = (error) => ({
      order: serializeOrderForResponse(order),
      refreshed_at: new Date().toISOString(),
      source: 'local_fallback',
      error: error || null
    });

    try {
      const credential = await MarketplaceCredentialRepository.findById(order.marketplace_credential_id);
      if (!credential || !credential.access_token) {
        logger.warn(`[ML Refresh] Credencial ausente para orden ${orderId}; devolviendo snapshot local`);
        return fallbackOrder('credential_not_found');
      }

      const remoteOrder = await fetchMercadoLibreOrderWithRetry(
        order.marketplace_order_id,
        credential.access_token
      );
      if (!remoteOrder) {
        logger.warn(`[ML Refresh] Mercado Libre no respondió para orden ${orderId}; devolviendo snapshot local`);
        return fallbackOrder('order_fetch_failed');
      }

      const shipmentId = remoteOrder?.shipping?.id || null;
      const [shipmentData, shipmentCostsData, billingInfoData, discountsData, messagesData] = await Promise.all([
        shipmentId
          ? fetchMercadoLibreShipmentWithRetry(shipmentId, credential.access_token)
          : Promise.resolve(null),
        shipmentId
          ? fetchMercadoLibreShipmentCostsWithRetry(shipmentId, credential.access_token)
          : Promise.resolve(null),
        fetchMercadoLibreBillingInfoWithRetry(remoteOrder, credential.access_token),
        fetchMercadoLibreOrderDiscountsWithRetry(order.marketplace_order_id, credential.access_token),
        fetchMercadoLibreMessagesWithRetry({
          orderId: order.marketplace_order_id,
          order: remoteOrder,
          accessToken: credential.access_token,
          sellerId: getMercadoLibreSellerId(credential, remoteOrder)
        })
      ]);

      const shippingFinancials = normalizeMercadoLibreShipmentCosts(
        shipmentCostsData,
        remoteOrder,
        shipmentData
      );
      const discountFinancials = normalizeMercadoLibreOrderDiscounts(discountsData);

      const customerSnapshot = buildMercadoLibreCustomerSnapshot({
        order: remoteOrder,
        shipment: shipmentData,
        billingInfo: billingInfoData
      });

      const orderData = {
        order_status: mapMercadoLibreOrderStatus(resolveMercadoLibreOrderStatus(remoteOrder)),
        payment_status: mapMercadoLibrePaymentStatus(resolveMercadoLibrePaymentStatus(remoteOrder)),
        subtotal: remoteOrder.total_amount || 0,
        shipping_total: shippingFinancials.seller_cost,
        discount_total: discountFinancials.seller_amount + shippingFinancials.shipping_subsidy,
        tax_total: 0,
        total_amount: remoteOrder.total_amount || 0,
        currency: remoteOrder.currency_id || 'CLP',
        buyer_id: customerSnapshot.marketplace_customer_id || remoteOrder?.buyer?.id?.toString() || null,
        buyer_name: customerSnapshot.full_name || remoteOrder?.buyer?.nickname || null,
        buyer_email: customerSnapshot.email || null,
        buyer_document: customerSnapshot.document_number || null,
        payment_method: remoteOrder?.payments?.[0]?.payment_type || null,
        payment_date: remoteOrder?.payments?.[0]?.date_created || null,
        shipping_address:
          buildAddressLine([
            customerSnapshot.shipping_address_line,
            customerSnapshot.shipping_address_line_2,
            customerSnapshot.shipping_reference
          ]) || buildShippingAddress(remoteOrder.shipping),
        shipping_city: customerSnapshot.shipping_city || remoteOrder?.shipping?.receiver_address?.city_name || null,
        shipping_region: customerSnapshot.shipping_state || remoteOrder?.shipping?.receiver_address?.state_name || null,
        messages_snapshot: buildMercadoLibreMessagesSnapshot(messagesData),
        raw_payload: {
          order: remoteOrder,
          shipment: shipmentData,
          shipment_costs: shipmentCostsData,
          billing_info: billingInfoData,
          discounts: discountsData,
          messages: messagesData,
          shipping_financials: shippingFinancials,
          discount_financials: discountFinancials
        }
      };

      await MarketplaceOrderRepository.updateById(order.id, orderData);
      await persistMarketplaceOrderCustomerSnapshot(order.id, customerSnapshot);

      const refreshedOrder = await MarketplaceOrderRepository.findById(order.id);
      return {
        order: serializeOrderForResponse(refreshedOrder),
        refreshed_at: new Date().toISOString(),
        source: 'mercadolibre'
      };
    } catch (error) {
      logger.error(`[ML Refresh] Error refrescando orden ${orderId}: ${error.message}`);
      return fallbackOrder(error.message || 'refresh_failed');
    }
  }
};

function serializeOrderForResponse(orderRecord) {
  if (!orderRecord) return null;

  const order = typeof orderRecord.get === 'function'
    ? orderRecord.get({ plain: true })
    : { ...orderRecord };

  const messages = normalizeMessagesForResponse(order.messages_snapshot, order);
  const notes = normalizeNotesForResponse(order.notes_snapshot);

  delete order.raw_payload;

  order.messages_snapshot = messages;
  order.messages = messages;
  order.notes_snapshot = notes;

  if (Array.isArray(order.events)) {
    order.events = order.events.map((event) => {
      const cleanEvent = { ...event };
      delete cleanEvent.raw_payload;
      return cleanEvent;
    });
  }

  if (order.customerSnapshot) {
    const cleanCustomer = { ...order.customerSnapshot };
    delete cleanCustomer.raw_order_payload;
    delete cleanCustomer.raw_billing_payload;
    delete cleanCustomer.raw_shipping_payload;
    order.customerSnapshot = cleanCustomer;
  }

  return order;
}

function normalizeMessagesForResponse(messagesSnapshot, order = {}) {
  const messages = parseJsonMaybe(messagesSnapshot);
  const list = Array.isArray(messages) ? messages : [];
  const sellerId = resolveSellerIdFromOrderSnapshot(order);
  const buyerName = order.buyer_name || order.customerSnapshot?.full_name || null;
  const sellerName = order.credential?.name || order.credential?.seller_email || null;

  return list
    .map((message) => {
      const raw = parseJsonMaybe(message?.raw_payload) || {};
      const senderUserId = message?.sender_user_id || raw?.from?.user_id || raw?.from?.id || null;
      const receiverUserId = message?.receiver_user_id || raw?.to?.user_id || raw?.to?.id || null;
      const receivedAt =
        message?.received_at ||
        raw?.message_date?.received ||
        raw?.message_date?.created ||
        raw?.created_at ||
        raw?.date_created ||
        null;
      const direction = sellerId && String(senderUserId) === String(sellerId) ? 'outbound' : 'inbound';
      const spreeSender = normalizeSpreeSender(message?.spree_sender || raw?.spree_sender || null);
      const marketplaceSender = {
        user_id: senderUserId != null ? String(senderUserId) : null,
        type: direction === 'outbound' ? 'seller' : 'buyer',
        name: direction === 'outbound'
          ? (sellerName || 'Cuenta Mercado Libre')
          : buyerName
      };
      const displaySender = spreeSender
        ? {
            source: 'spree',
            user_id: spreeSender.user_id,
            name: spreeSender.name || spreeSender.email || `Usuario ${spreeSender.user_id}`
          }
        : {
            source: 'marketplace',
            user_id: marketplaceSender.user_id,
            name: marketplaceSender.name || marketplaceSender.user_id || null
          };

      return {
        message_id: message?.message_id || raw?.id || null,
        text: message?.text || raw?.text || '',
        received_at: receivedAt,
        sender_user_id: senderUserId != null ? String(senderUserId) : null,
        receiver_user_id: receiverUserId != null ? String(receiverUserId) : null,
        direction,
        marketplace_sender: marketplaceSender,
        spree_sender: spreeSender,
        display_sender: displaySender,
        status: message?.status || raw?.status || null,
        read_at: message?.read_at || raw?.message_date?.read || null
      };
    })
    .filter((message) => message.message_id || message.text)
    .sort((a, b) => (a.received_at ? new Date(a.received_at).getTime() : 0) - (b.received_at ? new Date(b.received_at).getTime() : 0));
}

function normalizeSpreeSender(sender) {
  if (!sender || typeof sender !== 'object') return null;

  const userId = sender.user_id ?? sender.id ?? null;
  if (userId == null) return null;

  return {
    user_id: Number(userId),
    name: sender.name || sender.user || sender.full_name || null,
    email: sender.email || null
  };
}

function normalizeNotesForResponse(notesSnapshot) {
  const notes = parseJsonMaybe(notesSnapshot);
  const list = Array.isArray(notes) ? notes : [];

  return list
    .map((note) => {
      const text = typeof note?.text === 'string' ? note.text.trim() : '';
      if (!text) return null;

      return {
        note_id: note?.note_id || null,
        text,
        created_at: note?.created_at || null,
        created_by_user_id: note?.created_by_user_id ?? null,
        created_by_user_name: note?.created_by_user_name ?? null
      };
    })
    .filter(Boolean);
}

function resolveSellerIdFromOrderSnapshot(order = {}) {
  const rawPayload = parseJsonMaybe(order.raw_payload) || {};
  return (
    rawPayload?.order?.seller?.id ||
    rawPayload?.order?.seller_id ||
    rawPayload?.messages?.conversation_status?.path?.match(/\/sellers\/([^/]+)/)?.[1] ||
    null
  );
}

function parseJsonMaybe(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;

  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
}

async function persistMarketplaceOrderCustomerSnapshot(orderId, customerSnapshot) {
  if (!customerSnapshot) return null;
  return await MarketplaceOrderCustomerRepository.upsertByOrderId(orderId, customerSnapshot);
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
    extraHeaders: { 'x-format-new': 'true' }
  });
}

async function fetchMercadoLibreBillingInfoWithRetry(orderOrId, accessToken) {
  const order = orderOrId && typeof orderOrId === 'object' ? orderOrId : null;
  const orderId = order?.id || orderOrId;
  const billingInfoId = order?.buyer?.billing_info?.id || order?.billing_info?.id || null;
  const siteId = order?.context?.site || order?.site_id || order?.site || null;

  if (billingInfoId && siteId) {
    const billingInfo = await fetchMercadoLibreResourceWithRetry({
      resourcePath: `orders/billing-info/${siteId}/${billingInfoId}`,
      accessToken,
      resourceLabel: `billing_info ${orderId}`,
      allowNotFound: true
    });

    if (billingInfo) return billingInfo;
  }

  return await fetchMercadoLibreResourceWithRetry({
    resourcePath: `orders/${orderId}/billing_info`,
    accessToken,
    resourceLabel: `billing_info ${orderId}`,
    allowNotFound: true,
    extraHeaders: { 'x-version': '2' }
  });
}

async function fetchMercadoLibreOrderDiscountsWithRetry(orderId, accessToken) {
  return await fetchMercadoLibreResourceWithRetry({
    resourcePath: `orders/${orderId}/discounts`,
    accessToken,
    resourceLabel: `discounts ${orderId}`,
    allowNotFound: true
  });
}

async function fetchMercadoLibreMessagesWithRetry({ orderId, order, accessToken, sellerId }) {
  const packId = order?.pack_id || orderId;
  const finalSellerId = sellerId || order?.seller?.id || order?.seller_id || null;

  if (!packId || !finalSellerId) return null;

  return await fetchMercadoLibreResourceWithRetry({
    resourcePath: `messages/packs/${packId}/sellers/${finalSellerId}?tag=post_sale&mark_as_read=false`,
    accessToken,
    resourceLabel: `messages pack ${packId}`,
    allowNotFound: true
  });
}

async function fetchMercadoLibreResourceWithRetry({ resourcePath, accessToken, resourceLabel, allowNotFound = false, extraHeaders = {} }) {
  let lastError = null;
  const safeLabel = resourceLabel || resourcePath;

  for (let attempt = 1; attempt <= ML_FETCH_RETRY_MAX; attempt++) {
    try {
      const response = await axios.get(`https://api.mercadolibre.com/${resourcePath}`, {
        headers: { Authorization: `Bearer ${accessToken}`, ...extraHeaders },
        timeout: 10000
      });
      return response.data;
    } catch (error) {
      lastError = error;
      const status = error?.response?.status;

      if (status === 404) {
        const level = allowNotFound ? 'info' : 'warn';
        logger[level](`[ML Refresh] Recurso ${safeLabel} no encontrado (404)`);
        return null;
      }

      if (status === 401 || status === 403) {
        logger.error(`[ML Refresh] Error autenticacion ${status} para ${safeLabel}`, {
          resource_path: resourcePath,
          response: error?.response?.data || null,
          request_id:
            error?.response?.headers?.['x-request-id'] ||
            error?.response?.headers?.['x-correlation-id'] ||
            error?.response?.headers?.['x-meli-request-id'] ||
            null
        });
        return null;
      }

      if (attempt < ML_FETCH_RETRY_MAX) {
        const delayMs = Math.min(
          ML_FETCH_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1),
          ML_FETCH_RETRY_MAX_DELAY_MS
        );
        logger.warn(`[ML Refresh] Intento ${attempt}/${ML_FETCH_RETRY_MAX} fallido para ${safeLabel}. Reintentando en ${delayMs}ms...`);
        await sleep(delayMs);
      }
    }
  }

  logger.error(`[ML Refresh] Error obteniendo ${safeLabel} despues de ${ML_FETCH_RETRY_MAX} intentos: ${lastError?.message || 'unknown'}`);
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
      if (!discount || typeof discount !== 'object') return sum;
      const amount = Number(discount.promoted_amount ?? discount.amount ?? discount.value ?? 0);
      return sum + (Number.isFinite(amount) ? amount : 0);
    }, 0);
  };

  const senders = Array.isArray(shipmentCosts?.senders) ? shipmentCosts.senders : [];
  const receiver = shipmentCosts?.receiver || {};
  const grossAmount = toAmount(shipmentCosts?.gross_amount ?? order?.shipping?.shipping_cost ?? 0);
  const sellerCost = senders.reduce((sum, sender) => sum + toAmount(sender?.cost), 0);
  const sellerDiscount = senders.reduce((sum, sender) => sum + sumDiscounts(sender?.discounts) + sumDiscounts(sender?.discount), 0);
  const buyerCost = toAmount(receiver?.cost);
  const shippingSubsidy = Math.max(sellerDiscount, grossAmount > 0 ? grossAmount - sellerCost - buyerCost : 0);
  const freeShipping = typeof shipment?.free_shipping === 'boolean'
    ? shipment.free_shipping
    : (typeof order?.shipping?.free_shipping === 'boolean' ? order.shipping.free_shipping : null);

  let whoPays = 'unknown';
  if (buyerCost > 0 && sellerCost > 0) whoPays = 'shared';
  else if (buyerCost > 0) whoPays = 'buyer';
  else if (sellerCost > 0) whoPays = 'seller';

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

function normalizeMercadoLibreOrderDiscounts(discountsData) {
  const amounts = {
    total_amount: 0,
    seller_amount: 0,
    marketplace_amount: 0,
    raw: discountsData || null
  };

  const details = Array.isArray(discountsData?.details)
    ? discountsData.details
    : Array.isArray(discountsData)
      ? discountsData
      : [];

  for (const detail of details) {
    const items = Array.isArray(detail?.items) ? detail.items : [];
    for (const item of items) {
      const itemAmounts = item?.amounts || {};
      amounts.total_amount += Number(itemAmounts.total || 0) || 0;
      amounts.seller_amount += Number(itemAmounts.seller || 0) || 0;
      amounts.marketplace_amount += Number(itemAmounts.meli || itemAmounts.marketplace || 0) || 0;
    }
  }

  return amounts;
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
        text: message?.text || '',
        conversation_status: message?.conversation_status || null,
        received_at: receivedAt,
        sender: message?.from?.role || message?.sender || message?.author || null,
        raw_payload: message
      };
    })
    .filter((message) => message.message_id || message.text)
    .sort((a, b) => (a.received_at ? new Date(a.received_at).getTime() : 0) - (b.received_at ? new Date(b.received_at).getTime() : 0));
}

function getMercadoLibreSellerId(credential, order) {
  return (
    credential?.seller_id ||
    credential?.additional_data?.ml_user_id ||
    order?.seller?.id ||
    order?.seller_id ||
    null
  );
}

function buildMercadoLibreCustomerSnapshot({ order, shipment, billingInfo }) {
  const buyer = order?.buyer || {};
  const billing = billingInfo?.billing_info || billingInfo?.billingInfo || billingInfo || {};
  const address = shipment?.receiver_address || order?.shipping?.receiver_address || {};

  return {
    marketplace_customer_id: buyer?.id?.toString() || null,
    full_name: buyer?.nickname || buyer?.name || [address?.first_name, address?.last_name].filter(Boolean).join(' ') || null,
    email: billing?.email || order?.buyer?.email || order?.buyer?.email_address || order?.buyer?.alternate_email || null,
    phone: address?.phone || billing?.phone || null,
    document_number: billing?.doc_number || billing?.document_number || billing?.document || order?.buyer?.identification?.number || null,
    shipping_address_line: buildAddressLine([
      address?.address_line,
      address?.street_name ? `${address.street_name} ${address.street_number || ''}` : null
    ]),
    shipping_address_line_2: address?.comment || address?.reference || null,
    shipping_reference: address?.reference || null,
    shipping_city: address?.city_name || address?.city || null,
    shipping_state: address?.state_name || address?.state || null,
    shipping_country: address?.country_name || address?.country || null,
    raw: { buyer, billing_info: billingInfo, receiver_address: address }
  };
}

function buildAddressLine(parts = []) {
  return parts.flat().filter(Boolean).map((part) => String(part).trim()).filter(Boolean).join(', ') || null;
}

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

function mapMercadoLibreOrderStatus(mlStatus) {
  if (!mlStatus) return 'pending';
  const statusMap = {
    paid: 'paid',
    confirmed: 'paid',
    shipped: 'shipped',
    delivered: 'delivered',
    cancelled: 'cancelled',
    refunded: 'returned',
    pending: 'pending',
    processing: 'pending'
  };
  return statusMap[String(mlStatus).toLowerCase()] || 'pending';
}

function resolveMercadoLibreOrderStatus(order) {
  return order?.status || order?.order_status || null;
}

function resolveMercadoLibrePaymentStatus(order) {
  const payments = Array.isArray(order?.payments) ? order.payments : [];
  const approved = payments.find((payment) => {
    return ['approved', 'paid', 'authorized'].includes(
      String(payment?.status || '').toLowerCase()
    );
  });

  return approved?.status || order?.payment_status || payments[0]?.status || null;
}

function mapMercadoLibrePaymentStatus(mlStatus) {
  if (!mlStatus) return 'pending';
  const statusMap = {
    paid: 'paid',
    approved: 'paid',
    pending: 'pending',
    authorized: 'authorized',
    in_process: 'processing',
    in_mediation: 'mediation',
    cancelled: 'cancelled',
    refunded: 'refunded',
    charged_back: 'charged_back'
  };
  return statusMap[String(mlStatus).toLowerCase()] || 'pending';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = MarketplaceOrderSyncService;
