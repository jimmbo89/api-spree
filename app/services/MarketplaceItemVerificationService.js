const axios = require('axios');
const logger = require('../../config/logger');

const TRANSIENT_ITEM_STATUSES = new Set(['under_review']);
const TRANSIENT_PAUSED_SUBSTATUSES = new Set([
  'picture_download_pending',
  'waiting_for_patch'
]);

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

function normalizeSubStatusList(subStatus) {
  if (Array.isArray(subStatus)) {
    return subStatus
      .map((value) => String(value || '').trim().toLowerCase())
      .filter(Boolean);
  }

  if (!subStatus) return [];
  return [String(subStatus).trim().toLowerCase()].filter(Boolean);
}

function getTransientItemReason(item) {
  const normalizedStatus = normalizeItemStatus(item?.status);
  const normalizedSubStatus = normalizeSubStatusList(item?.sub_status);

  if (TRANSIENT_ITEM_STATUSES.has(normalizedStatus)) {
    return normalizedStatus;
  }

  if (
    normalizedStatus === 'paused' &&
    normalizedSubStatus.some((value) => TRANSIENT_PAUSED_SUBSTATUSES.has(value))
  ) {
    return `paused:${normalizedSubStatus.join(',')}`;
  }

  return null;
}

function getStatusOutcome(itemOrStatus) {
  const item =
    itemOrStatus && typeof itemOrStatus === 'object'
      ? itemOrStatus
      : { status: itemOrStatus };
  const normalized = normalizeItemStatus(item?.status);
  if (!normalized) {
    return {
      verified: false,
      status: null,
      note: 'missing_status',
      is_transient: false
    };
  }

  if (normalized === 'active') {
    return {
      verified: true,
      status: normalized,
      note: 'active',
      is_transient: false
    };
  }

  const transientReason = getTransientItemReason(item);
  if (transientReason) {
    return {
      verified: true,
      status: normalized,
      note: `transient:${transientReason}`,
      is_transient: true
    };
  }

  return {
    verified: true,
    status: normalized,
    note: `non_active:${normalized}`,
    is_transient: false
  };
}

function buildMercadoLibreItemSnapshot(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }

  const subStatus = Array.isArray(item.sub_status)
    ? item.sub_status
    : item.sub_status
      ? [item.sub_status]
      : [];

  return {
    id: item.id || null,
    title: item.title || null,
    status: item.status || null,
    sub_status: subStatus,
    sub_status_text: subStatus.length > 0 ? subStatus.join(', ') : null,
    category_id: item.category_id || null,
    domain_id: item.domain_id || null,
    price: item.price ?? null,
    available_quantity: item.available_quantity ?? null,
    permalink: item.permalink || null,
    last_updated: item.last_updated || null
  };
}

async function fetchMercadoLibreItem(itemId, accessToken, timeoutMs = 10000) {
  const response = await axios.get(`https://api.mercadolibre.com/items/${itemId}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    },
    timeout: timeoutMs
  });

  logger.info(`[ML Verify] Respuesta item ${itemId}: ${JSON.stringify({
    http_status: response.status,
    http_status_text: response.statusText,
    snapshot: buildMercadoLibreItemSnapshot(response.data)
  })}`);

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
      const outcome = getStatusOutcome(item);

      if (outcome.is_transient && attempt < maxAttempts) {
        const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
        logger.info(
          `[ML Verify] Item ${itemId} en estado transitorio ${outcome.status} ` +
          `(${buildMercadoLibreItemSnapshot(item)?.sub_status_text || 'sin sub_status'}), ` +
          `reintentando en ${delayMs}ms (intento ${attempt}/${maxAttempts})`
        );
        await sleep(delayMs);
        continue;
      }

      return {
        ok: true,
        verified: outcome.verified,
        item_found: true,
        status: outcome.status,
        item,
        attempts: attempt,
        note: outcome.note,
        is_transient: outcome.is_transient,
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
