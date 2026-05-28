const logger = require('../../config/logger');
const {
  MarketplaceOrderRepository,
  MarketplaceCredentialRepository
} = require('../repositories');
const MarketplaceOrderSyncService = require('./MarketplaceOrderSyncService');

class MercadoLibreError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'MercadoLibreError';
    this.status = status;
  }
}

const ML_MESSAGE_MAX_LEN = 350;

const MarketplaceOrderMessageService = {
  async sendByOrderId(orderId, text) {
    const order = await MarketplaceOrderRepository.findById(orderId);
    if (!order) {
      throw new Error('order_not_found');
    }

    if (String(order.marketplace || '').toLowerCase() !== 'mercadolibre') {
      throw new Error('unsupported_marketplace');
    }

    const credential = await MarketplaceCredentialRepository.findById(order.marketplace_credential_id);
    if (!credential || !credential.access_token) {
      throw new Error('credential_not_found');
    }

    const sentMessage = await sendMercadoLibreOrderMessage(
      String(order.marketplace_order_id),
      text,
      credential.access_token,
      credential
    );

    const refreshed = await MarketplaceOrderSyncService.refreshById(orderId);
    logger.info(`[MarketplaceOrderMessageService] Mensaje enviado correctamente: ${sentMessage?.id || 'unknown'}`);
    return refreshed;
  }
};

async function sendMercadoLibreOrderMessage(orderId, text, accessToken, credential = null) {
  const cleanText = sanitizeMessageText(text);
  const remoteOrder = await fetchMercadoLibreOrder(orderId, accessToken);
  const packId = remoteOrder?.pack_id || orderId;
  const sellerId = resolveSellerId(remoteOrder, credential);
  const buyerId = remoteOrder?.buyer?.id || remoteOrder?.buyer_id || null;

  if (!sellerId) {
    throw new Error('SELLER_ID_NOT_FOUND');
  }

  if (!buyerId) {
    throw new Error('BUYER_ID_NOT_FOUND');
  }

  const response = await mercadolibreRequestJsonWithRetry(
    `https://api.mercadolibre.com/messages/packs/${packId}/sellers/${sellerId}?tag=post_sale`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: { user_id: sellerId },
        to: { user_id: buyerId },
        text: cleanText
      })
    }
  );

  return normalizeSentMessage(response);
}

async function fetchMercadoLibreOrder(orderId, accessToken) {
  const response = await mercadolibreRequestJsonWithRetry(
    `https://api.mercadolibre.com/orders/${orderId}`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }
  );

  return response;
}

async function mercadolibreRequestJsonWithRetry(url, init = {}) {
  const method = String(init.method || 'GET').toUpperCase();
  const max5xxRetries = 2;
  const timeoutMs = 10000;

  const makeRequest = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal
      });
      clearTimeout(timer);
      return response;
    } catch (error) {
      clearTimeout(timer);
      if (error?.name === 'AbortError' || error?.name === 'TypeError') {
        throw new MercadoLibreError(0, 'NETWORK_ERROR');
      }
      throw error;
    }
  };

  let retries5xx = 0;
  let retry429Used = false;

  while (true) {
    let response;
    try {
      response = await makeRequest();
    } catch (error) {
      if (error instanceof MercadoLibreError) throw error;
      throw new MercadoLibreError(0, 'NETWORK_ERROR');
    }

    if (response.ok) {
      if (response.status === 204) return null;
      const text = await response.text();
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }

    const status = response.status;
    const errorMessage = await readErrorMessage(response);

    if ([400, 403, 404].includes(status)) {
      throw new MercadoLibreError(status, errorMessage || `HTTP_${status}`);
    }

    if (status === 429) {
      if (retry429Used) {
        throw new MercadoLibreError(status, errorMessage || 'RATE_LIMIT');
      }

      retry429Used = true;
      const retryAfter = Number(response.headers.get('retry-after') || '1');
      await sleep(Math.max(1, retryAfter) * 1000);
      continue;
    }

    if (status >= 500 && status <= 599) {
      if (retries5xx >= max5xxRetries) {
        throw new MercadoLibreError(status, errorMessage || `HTTP_${status}`);
      }

      await sleep(retries5xx === 0 ? 1000 : 2000);
      retries5xx += 1;
      continue;
    }

    throw new MercadoLibreError(status, errorMessage || `HTTP_${status}`);
  }
}

async function readErrorMessage(response) {
  try {
    const text = await response.text();
    if (!text) return null;
    try {
      const parsed = JSON.parse(text);
      return parsed?.message || parsed?.error || parsed?.cause || text;
    } catch {
      return text;
    }
  } catch {
    return null;
  }
}

function sanitizeMessageText(text) {
  if (typeof text !== 'string') {
    throw new Error('MESSAGE_TEXT_INVALID');
  }

  const clean = text.trim().replace(/\n{4,}/g, '\n\n\n');
  if (clean.length < 1 || clean.length > ML_MESSAGE_MAX_LEN) {
    throw new Error('MESSAGE_TEXT_INVALID');
  }

  return clean;
}

function resolveSellerId(remoteOrder, credential) {
  return (
    credential?.seller_id ||
    credential?.additional_data?.ml_user_id ||
    remoteOrder?.seller?.id ||
    remoteOrder?.seller_id ||
    remoteOrder?.user_id ||
    null
  );
}

function normalizeSentMessage(message) {
  if (!message || typeof message !== 'object') {
    return null;
  }

  return {
    id: message.id != null ? String(message.id) : null,
    order_id: message.order_id != null ? String(message.order_id) : null,
    text: message.text || '',
    from: {
      id: message?.from?.id != null ? String(message.from.id) : '',
      name: message?.from?.name || ''
    },
    to: {
      id: message?.to?.id != null ? String(message.to.id) : '',
      name: message?.to?.name || ''
    },
    date_created: message.date_created || message.created_at || null
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  MarketplaceOrderMessageService,
  sendMercadoLibreOrderMessage,
  MercadoLibreError
};
