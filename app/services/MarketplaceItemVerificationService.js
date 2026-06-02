const axios = require('axios');
const logger = require('../../config/logger');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isMercadoLibreMarketplace(marketplace) {
  const domain = String(marketplace?.domain || '').toLowerCase();
  const name = String(marketplace?.name || '').toLowerCase();
  return domain.includes('mercadolibre') || name.includes('mercado libre') || name.includes('mercadolibre');
}

function normalizeItemStatus(status) {
  return String(status || '').trim().toLowerCase();
}

function getStatusOutcome(status) {
  const normalized = normalizeItemStatus(status);
  if (!normalized) {
    return {
      verified: false,
      status: null,
      note: 'missing_status'
    };
  }

  if (normalized === 'active') {
    return {
      verified: true,
      status: normalized,
      note: 'active'
    };
  }

  return {
    verified: true,
    status: normalized,
    note: `non_active:${normalized}`
  };
}

async function fetchMercadoLibreItem(itemId, accessToken, timeoutMs = 10000) {
  const response = await axios.get(`https://api.mercadolibre.com/items/${itemId}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    },
    timeout: timeoutMs
  });

  return response.data;
}

async function verifyMercadoLibreItem({
  itemId,
  accessToken,
  maxAttempts = 4,
  baseDelayMs = 1200,
  timeoutMs = 10000
}) {
  if (!itemId || !accessToken) {
    return {
      ok: false,
      verified: false,
      item_found: false,
      status: null,
      attempts: 0,
      error: 'missing_item_id_or_token'
    };
  }

  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const item = await fetchMercadoLibreItem(itemId, accessToken, timeoutMs);
      const outcome = getStatusOutcome(item?.status);

      return {
        ok: true,
        verified: outcome.verified,
        item_found: true,
        status: outcome.status,
        item,
        attempts: attempt,
        note: outcome.note,
        error: null
      };
    } catch (error) {
      lastError = error;
      const statusCode = error?.response?.status || null;
      const retryable = statusCode === 404 || statusCode === 409 || !statusCode;

      logger.warn(
        `[ML Verify] Intento ${attempt}/${maxAttempts} falló para ${itemId}: ${error.message}${statusCode ? ` (status ${statusCode})` : ''}`
      );

      if (!retryable || attempt === maxAttempts) {
        break;
      }

      const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
      await sleep(delayMs);
    }
  }

  return {
    ok: false,
    verified: false,
    item_found: false,
    status: null,
    attempts: maxAttempts,
    error: lastError?.response?.data?.message || lastError?.message || 'verification_failed'
  };
}

module.exports = {
  isMercadoLibreMarketplace,
  verifyMercadoLibreItem
};
