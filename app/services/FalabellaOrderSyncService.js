const axios = require('axios');
const logger = require('../../config/logger');
const {
  MarketplaceOrderRepository,
  MarketplaceCredentialRepository,
  MarketplaceOrderCustomerRepository
} = require('../repositories');

const FB_API_VERSION = process.env.FB_API_VERSION || '2.0';
const FB_USER_AGENT = process.env.FB_USER_AGENT || 'Spree/1.0';
const FB_FETCH_RETRY_MAX = 3;
const FB_FETCH_RETRY_BASE_DELAY_MS = 1500;
const FB_FETCH_RETRY_MAX_DELAY_MS = 8000;

const FalabellaOrderSyncService = {
  async refreshById(orderId) {
    const order = await MarketplaceOrderRepository.findById(orderId);
    if (!order) throw new Error('order_not_found');

    if (String(order.marketplace || '').toLowerCase() !== 'falabella') {
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
      if (!credential || !credential.api_key || !credential.seller_email) {
        logger.warn(`[FB Refresh] Credencial ausente para orden ${orderId}; devolviendo snapshot local`);
        return fallbackOrder('credential_not_found');
      }

      const remoteOrder = await fetchFalabellaOrderWithRetry(order.marketplace_order_id, credential);
      if (!remoteOrder) {
        logger.warn(`[FB Refresh] Falabella no respondió para orden ${orderId}; devolviendo snapshot local`);
        return fallbackOrder('order_fetch_failed');
      }

      const orderInfo = parseFalabellaOrderInfo(remoteOrder);
      const customerSnapshot = buildFalabellaCustomerSnapshot(remoteOrder, orderInfo);
      const orderData = {
        order_status: mapFalabellaOrderStatus(orderInfo.status),
        payment_status: order.payment_status || 'pending',
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
        payment_method: orderInfo.paymentMethod || order.payment_method || null,
        payment_date: orderInfo.createdAt || order.payment_date || null,
        shipping_address:
          buildAddressLine([
            customerSnapshot.shipping_address_line,
            customerSnapshot.shipping_address_line_2,
            customerSnapshot.shipping_reference
          ]) || orderInfo.shippingAddress || order.shipping_address || null,
        shipping_city: customerSnapshot.shipping_city || orderInfo.shippingCity || order.shipping_city || null,
        shipping_region: customerSnapshot.shipping_state || orderInfo.shippingRegion || order.shipping_region || null,
        raw_payload: remoteOrder
      };

      await MarketplaceOrderRepository.updateById(order.id, orderData);
      await persistMarketplaceOrderCustomerSnapshot(order.id, customerSnapshot);

      const refreshedOrder = await MarketplaceOrderRepository.findById(order.id);
      return {
        order: serializeOrderForResponse(refreshedOrder),
        refreshed_at: new Date().toISOString(),
        source: 'falabella'
      };
    } catch (error) {
      logger.error(`[FB Refresh] Error refrescando orden ${orderId}: ${error.message}`);
      return fallbackOrder(error.message || 'refresh_failed');
    }
  }
};

function serializeOrderForResponse(orderRecord) {
  if (!orderRecord) return null;

  const order = typeof orderRecord.get === 'function'
    ? orderRecord.get({ plain: true })
    : { ...orderRecord };

  delete order.raw_payload;
  order.notes_snapshot = normalizeNotesForResponse(order.notes_snapshot);
  return order;
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

async function fetchFalabellaOrderWithRetry(orderId, credential) {
  let lastError = null;

  for (let attempt = 1; attempt <= FB_FETCH_RETRY_MAX; attempt++) {
    try {
      const response = await fetchFalabellaOrder(orderId, credential);
      if (response) return response;
      lastError = new Error('empty_response');
    } catch (error) {
      lastError = error;
    }

    if (attempt < FB_FETCH_RETRY_MAX) {
      const delayMs = Math.min(
        FB_FETCH_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1),
        FB_FETCH_RETRY_MAX_DELAY_MS
      );
      logger.warn(
        `[FB Refresh] Intento ${attempt}/${FB_FETCH_RETRY_MAX} fallido para orden ${orderId}. Reintentando en ${delayMs}ms...`
      );
      await sleep(delayMs);
    }
  }

  logger.error(
    `[FB Refresh] Error obteniendo orden ${orderId} despues de ${FB_FETCH_RETRY_MAX} intentos: ${lastError?.message || 'unknown'}`
  );
  return null;
}

async function fetchFalabellaOrder(orderId, credential) {
  try {
    const timestamp = timestampMinus03();
    const params = {
      Action: 'GetOrder',
      Format: 'JSON',
      OrderId: String(orderId),
      Timestamp: timestamp,
      UserID: credential.seller_email.trim(),
      Version: FB_API_VERSION
    };

    const url = buildFalabellaSignedUrl(params, credential.api_key);
    const response = await axios.get(url, {
      timeout: 15000,
      headers: { 'User-Agent': FB_USER_AGENT }
    });

    if (typeof response.data === 'string') {
      try {
        return JSON.parse(response.data);
      } catch (error) {
        logger.error(`[FB Refresh] Respuesta no JSON para OrderId ${orderId}`);
        return null;
      }
    }

    return response.data;
  } catch (error) {
    logger.error(`[FB Refresh] Error obteniendo orden ${orderId}: ${error.message}`);
    return null;
  }
}

function parseFalabellaOrderInfo(orderData) {
  const order = extractFalabellaOrderRoot(orderData);
  if (!order) return {};

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

  const shippingTotal = items.reduce((sum, item) => sum + (parseFloat(item?.ShippingFee || item?.ShippingCost || 0) || 0), 0);
  const discountTotal = items.reduce((sum, item) => sum + (parseFloat(item?.Discount || 0) || 0), 0);
  const commissionTotal = items.reduce((sum, item) => sum + (parseFloat(item?.Commission || 0) || 0), 0);
  const taxTotal = items.reduce((sum, item) => sum + (parseFloat(item?.Tax || item?.TaxAmount || 0) || 0), 0);
  const totalAmount = subtotal + shippingTotal - discountTotal + taxTotal;

  const customer = order?.Customer || order?.Buyer || {};
  const buyerName = buildFullName(
    customer?.FirstName || order?.CustomerFirstName,
    customer?.LastName || order?.CustomerLastName
  );

  const shippingAddress = extractFalabellaShippingAddress(order);

  return {
    status: order?.OrderStatus || order?.Status || 'pending',
    paymentMethod: order?.PaymentMethod || order?.payment_method || null,
    subtotal,
    shippingTotal,
    discountTotal,
    taxTotal,
    commission: commissionTotal,
    totalAmount,
    buyerName,
    shippingAddress: buildAddressLine([
      pickString(shippingAddress?.Street, shippingAddress?.Address1, shippingAddress?.address1),
      pickString(shippingAddress?.Address2, shippingAddress?.address2),
      pickString(shippingAddress?.City, shippingAddress?.city),
      pickString(shippingAddress?.State, shippingAddress?.Region, shippingAddress?.region),
      pickString(shippingAddress?.ZipCode, shippingAddress?.PostCode, shippingAddress?.postcode)
    ]),
    shippingCity: pickString(shippingAddress?.City, shippingAddress?.city),
    shippingRegion: pickString(shippingAddress?.State, shippingAddress?.Region, shippingAddress?.region),
    createdAt: order?.CreatedAt || order?.CreatedDate || null,
    updatedAt: order?.UpdatedAt || order?.UpdatedDate || null,
    raw: order
  };
}

function buildFalabellaCustomerSnapshot(orderData, orderInfo) {
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

  return {
    marketplace_customer_id: stringOrNull(customer?.CustomerID || customer?.CustomerId || order?.CustomerId || order?.BuyerId),
    first_name: firstName,
    last_name: lastName,
    full_name: fullName,
    email: pickString(customer?.Email, order?.CustomerEmail, billingAddress?.Email, shippingAddress?.Email),
    phone: pickString(customer?.Phone, billingAddress?.Phone, shippingAddress?.Phone),
    phone_secondary: pickString(billingAddress?.Phone2, shippingAddress?.Phone2),
    document_type: null,
    document_number: documentParts.number,
    document_verifier: documentParts.verifier,
    customer_type: null,
    legal_name: legalName,
    receiver_name: pickString(order?.DeliveryInfo, shippingAddress?.ReceiverName, shippingAddress?.Name),
    invoice_required: invoiceRequired,
    billing_address_line: pickString(billingAddress?.Address1, buildStreetAddress(billingAddress?.StreetName, billingAddress?.StreetNumber)),
    billing_address_line_2: pickString(billingAddress?.Address2),
    billing_city: pickString(billingAddress?.City),
    billing_municipality: pickString(billingAddress?.Municipality, billingAddress?.MunicipalityName),
    billing_state: pickString(billingAddress?.State, billingAddress?.Region),
    billing_state_code: pickString(billingAddress?.StateCode),
    billing_zip_code: pickString(billingAddress?.PostCode, billingAddress?.ZipCode),
    billing_country_code: pickString(billingAddress?.Country, billingAddress?.CountryCode),
    billing_comment: pickString(order?.Remarks),
    shipping_address_line: pickString(shippingAddress?.Address1, buildStreetAddress(shippingAddress?.StreetName, shippingAddress?.StreetNumber)),
    shipping_address_line_2: pickString(shippingAddress?.Address2),
    shipping_city: pickString(shippingAddress?.City),
    shipping_municipality: pickString(shippingAddress?.Municipality, shippingAddress?.MunicipalityName),
    shipping_state: pickString(shippingAddress?.State, shippingAddress?.Region),
    shipping_state_code: pickString(shippingAddress?.StateCode),
    shipping_zip_code: pickString(shippingAddress?.PostCode, shippingAddress?.ZipCode),
    shipping_country_code: pickString(shippingAddress?.Country, shippingAddress?.CountryCode),
    shipping_comment: pickString(order?.Remarks),
    shipping_reference: pickString(order?.DeliveryInfo),
    source_updated_at: parseDateOrNull(orderInfo?.updatedAt || orderInfo?.createdAt),
    raw_order_payload: order || null,
    raw_shipping_payload: shippingAddress || null,
    raw_billing_payload: billingAddress || null
  };
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
      return normalizeFalabellaAttributes(JSON.parse(attributes));
    } catch (error) {
      return {};
    }
  }
  if (typeof attributes === 'object') return attributes;
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
  if (!normalized) return { number: null, verifier: null };

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

function mapFalabellaOrderStatus(status) {
  if (!status) return 'pending';
  const map = {
    pending: 'pending',
    confirmed: 'paid',
    shipped: 'shipped',
    delivered: 'delivered',
    cancelled: 'cancelled',
    returned: 'returned',
    'ready to ship': 'shipped',
    'ready_to_ship': 'shipped',
    'on order created': 'pending',
    'order created': 'pending'
  };
  return map[String(status).toLowerCase()] || 'pending';
}

function timestampMinus03(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}-03:00`
  );
}

function rfc3986Encode(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function buildFalabellaSignedUrl(params, apiKey) {
  const sortedKeys = Object.keys(params).sort();
  const canonicalQuery = sortedKeys
    .map((k) => `${rfc3986Encode(k)}=${rfc3986Encode(String(params[k]))}`)
    .join('&');

  const signatureHex = require('crypto')
    .createHmac('sha256', apiKey.trim())
    .update(canonicalQuery, 'utf8')
    .digest('hex');

  const signatureEncoded = rfc3986Encode(signatureHex);
  return `https://sellercenter-api.falabella.com/?${canonicalQuery}&Signature=${signatureEncoded}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = FalabellaOrderSyncService;
