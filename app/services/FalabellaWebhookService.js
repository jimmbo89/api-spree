const axios = require('axios');
const crypto = require('crypto');
const { Builder, parseStringPromise } = require('xml2js');
const { MarketplaceCredentialRepository } = require('../repositories');

const FALABELLA_API_URL = 'https://sellercenter-api.falabella.com/';
const FALABELLA_WEBHOOK_API_VERSION = process.env.FALABELLA_WEBHOOK_API_VERSION || '1.0';
const FALABELLA_WEBHOOK_USER_AGENT = process.env.FALABELLA_WEBHOOK_USER_AGENT || process.env.FB_USER_AGENT || 'Spree/1.0';
const DEFAULT_CALLBACK_URL = 'https://spree.api.klint.cl/api/webhooks-falabella';
const REQUIRED_ORDER_EVENTS = Object.freeze([
  'onOrderCreated',
  'onOrderItemsStatusChanged'
]);

function rfc3986Encode(value) {
  return encodeURIComponent(String(value))
    .replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function timestampMinus03(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}-03:00`
  );
}

function buildSignedUrl(params, apiKey) {
  if (!apiKey) throw new Error('falabella_api_key_missing');

  const canonicalQuery = Object.keys(params)
    .sort()
    .map((key) => `${rfc3986Encode(key)}=${rfc3986Encode(params[key])}`)
    .join('&');
  const signature = crypto
    .createHmac('sha256', String(apiKey).trim())
    .update(canonicalQuery, 'utf8')
    .digest('hex');

  return `${FALABELLA_API_URL}?${canonicalQuery}&Signature=${rfc3986Encode(signature)}`;
}

function normalizeCallbackUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '').toLowerCase();
}

function resolveCallbackUrl(value = null) {
  const callbackUrl = value || process.env.FALABELLA_WEBHOOK_CALLBACK_URL || DEFAULT_CALLBACK_URL;
  return String(callbackUrl).trim().replace(/\/+$/, '');
}

function toArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function unwrapXmlValue(value) {
  if (value && typeof value === 'object' && '_' in value) return value._;
  return value;
}

function extractResponseBody(data) {
  return data?.SuccessResponse?.Body || data?.successResponse?.Body || data?.Body || data?.body || data;
}

function normalizeWebhookEvents(webhook) {
  const eventsNode = webhook?.Events?.Event ??
    webhook?.Events?.event ??
    webhook?.events?.Event ??
    webhook?.events?.event ??
    webhook?.events ??
    [];

  return toArray(eventsNode)
    .map((event) => unwrapXmlValue(event))
    .map((event) => typeof event === 'object' ? (event.Event || event.event || event.name || '') : event)
    .map((event) => String(event || '').trim())
    .filter(Boolean);
}

function normalizeWebhook(webhook) {
  if (!webhook || typeof webhook !== 'object') return null;

  return {
    webhook_id: unwrapXmlValue(webhook.WebhookId ?? webhook.WebhookID ?? webhook.id ?? webhook.Id) || null,
    callback_url: unwrapXmlValue(webhook.CallbackUrl ?? webhook.callback_url ?? webhook.callbackUrl) || null,
    webhook_source: unwrapXmlValue(webhook.WebhookSource ?? webhook.webhook_source ?? webhook.source) || null,
    events: normalizeWebhookEvents(webhook),
    raw: webhook
  };
}

function normalizeWebhookList(data) {
  const body = extractResponseBody(data);
  const webhooksNode = body?.Webhooks?.Webhook ??
    body?.Webhooks?.webhook ??
    body?.webhooks?.Webhook ??
    body?.webhooks?.webhook ??
    body?.Webhook ??
    body?.webhook ??
    [];

  return toArray(webhooksNode).map(normalizeWebhook).filter(Boolean);
}

function hasRequiredOrderEvents(webhook, requiredEvents = REQUIRED_ORDER_EVENTS) {
  const available = new Set((webhook?.events || []).map((event) => String(event).toLowerCase()));
  return requiredEvents.every((event) => available.has(String(event).toLowerCase()));
}

function buildCreateWebhookXml(callbackUrl, events = REQUIRED_ORDER_EVENTS) {
  const builder = new Builder({ renderOpts: { pretty: false } });
  return builder.buildObject({
    Request: {
      Webhook: {
        CallbackUrl: callbackUrl,
        Events: {
          Event: events
        }
      }
    }
  });
}

function buildDeleteWebhookXml(webhookId) {
  const builder = new Builder({ renderOpts: { pretty: false } });
  return builder.buildObject({
    Request: {
      Webhook: String(webhookId)
    }
  });
}

function getApiError(data) {
  const error = data?.ErrorResponse || data?.errorResponse || data?.error;
  if (!error) return null;

  const head = error.Head || error.head || {};
  const body = error.Body || error.body || {};
  const message = body?.Error?.Message || body?.ErrorMessage || error.message || head.ErrorMessage;
  const code = body?.Error?.Code || body?.ErrorCode || head.ErrorCode;
  return [code, message].filter(Boolean).join(': ') || 'falabella_api_error';
}

async function parseResponseData(data) {
  if (typeof data !== 'string') return data;

  const trimmed = data.trim();
  if (!trimmed) return {};

  try {
    return JSON.parse(trimmed);
  } catch (jsonError) {
    if (!trimmed.startsWith('<')) return data;
    return await parseStringPromise(trimmed, { explicitArray: false });
  }
}

async function callFalabellaApi({ action, credential, method = 'GET', body = null, extraParams = {}, timeoutMs = 20000 }) {
  if (!credential?.seller_email) throw new Error('falabella_seller_email_missing');
  if (!credential?.api_key) throw new Error('falabella_api_key_missing');

  const params = {
    Action: action,
    Format: 'JSON',
    Timestamp: timestampMinus03(),
    UserID: String(credential.seller_email).trim(),
    Version: FALABELLA_WEBHOOK_API_VERSION,
    ...extraParams
  };
  const url = buildSignedUrl(params, credential.api_key);
  const response = await axios.request({
    method,
    url,
    data: body,
    timeout: timeoutMs,
    headers: {
      'User-Agent': FALABELLA_WEBHOOK_USER_AGENT,
      ...(body ? { 'Content-Type': 'application/xml', Accept: 'application/json' } : {})
    }
  });
  const data = await parseResponseData(response.data);
  const apiError = getApiError(data);

  if (response.status >= 400) {
    throw new Error(`falabella_http_${response.status}`);
  }
  if (apiError) {
    throw new Error(apiError);
  }

  return { data, status: response.status, headers: response.headers };
}

async function getWebhooks(credential, options = {}) {
  const webhookIds = Array.isArray(options.webhookIds) && options.webhookIds.length > 0
    ? `[${options.webhookIds.join(',')}]`
    : null;
  const response = await callFalabellaApi({
    action: 'GetWebhooks',
    credential,
    extraParams: webhookIds ? { WebhookIds: webhookIds } : {},
    timeoutMs: options.timeoutMs || 20000
  });

  return {
    ...response,
    webhooks: normalizeWebhookList(response.data)
  };
}

async function createWebhook(credential, callbackUrl, events = REQUIRED_ORDER_EVENTS, options = {}) {
  const response = await callFalabellaApi({
    action: 'CreateWebhook',
    credential,
    method: 'POST',
    body: buildCreateWebhookXml(callbackUrl, events),
    timeoutMs: options.timeoutMs || 20000
  });
  const body = extractResponseBody(response.data);
  const webhook = body?.Webhook || body?.webhook || body || {};

  return {
    ...response,
    webhook_id: unwrapXmlValue(webhook.WebhookId ?? webhook.WebhookID ?? webhook.id ?? webhook.Id) || null
  };
}

async function deleteWebhook(credential, webhookId, options = {}) {
  if (!webhookId) throw new Error('falabella_webhook_id_missing');

  return await callFalabellaApi({
    action: 'DeleteWebhook',
    credential,
    method: 'POST',
    body: buildDeleteWebhookXml(webhookId),
    timeoutMs: options.timeoutMs || 20000
  });
}

async function resolveCredential(credentialOrId) {
  if (credentialOrId && typeof credentialOrId === 'object') {
    if (credentialOrId.id) {
      return await MarketplaceCredentialRepository.findById(credentialOrId.id) || credentialOrId;
    }
    return credentialOrId;
  }

  return await MarketplaceCredentialRepository.findById(credentialOrId);
}

function getReplaceCallbackUrls(options = {}) {
  const configured = options.replaceCallbackUrls ?? process.env.FALABELLA_WEBHOOK_REPLACE_CALLBACK_URLS ?? '';
  const values = Array.isArray(configured) ? configured : String(configured).split(',');
  return values.map(normalizeCallbackUrl).filter(Boolean);
}

async function inspectCredentialWebhook(credentialOrId, options = {}) {
  const credential = await resolveCredential(credentialOrId);
  if (!credential) throw new Error('falabella_credential_not_found');

  const callbackUrl = resolveCallbackUrl(options.callbackUrl);
  const response = await getWebhooks(credential, options);
  const targetWebhooks = response.webhooks.filter((webhook) => (
    normalizeCallbackUrl(webhook.callback_url) === normalizeCallbackUrl(callbackUrl)
  ));

  return {
    credential,
    callback_url: callbackUrl,
    required_events: [...REQUIRED_ORDER_EVENTS],
    webhooks: response.webhooks,
    target_webhooks: targetWebhooks,
    valid_webhooks: targetWebhooks.filter((webhook) => hasRequiredOrderEvents(webhook)),
    replaceable_webhooks: response.webhooks.filter((webhook) => (
      getReplaceCallbackUrls(options).includes(normalizeCallbackUrl(webhook.callback_url))
    )),
    raw_response: response.data
  };
}

async function ensureCredentialWebhook(credentialOrId, options = {}) {
  const credential = await resolveCredential(credentialOrId);
  if (!credential) throw new Error('falabella_credential_not_found');

  if (credential.active === false || Number(credential.active) === 0) {
    return {
      status: 'skipped',
      reason: 'credential_inactive',
      credential_id: credential.id,
      callback_url: resolveCallbackUrl(options.callbackUrl)
    };
  }

  if (!credential.seller_email || !credential.api_key) {
    return {
      status: 'skipped',
      reason: 'credentials_incomplete',
      credential_id: credential.id,
      callback_url: resolveCallbackUrl(options.callbackUrl)
    };
  }

  const inspected = await inspectCredentialWebhook(credential, options);

  const deletedWebhookIds = [];
  const validWebhook = inspected.valid_webhooks[0] || null;

  if (validWebhook) {
    for (const duplicate of inspected.target_webhooks) {
      if (duplicate.webhook_id && duplicate.webhook_id !== validWebhook.webhook_id) {
        await deleteWebhook(credential, duplicate.webhook_id, options);
        deletedWebhookIds.push(String(duplicate.webhook_id));
      }
    }

    return {
      status: deletedWebhookIds.length > 0 ? 'duplicates_removed' : 'already_configured',
      credential_id: credential.id,
      callback_url: inspected.callback_url,
      webhook_id: validWebhook.webhook_id,
      deleted_webhook_ids: deletedWebhookIds,
      events: validWebhook.events
    };
  }

  for (const current of inspected.target_webhooks) {
    if (!current.webhook_id) throw new Error('falabella_target_webhook_id_missing');
    await deleteWebhook(credential, current.webhook_id, options);
    deletedWebhookIds.push(String(current.webhook_id));
  }

  for (const stale of inspected.replaceable_webhooks) {
    if (stale.webhook_id && !deletedWebhookIds.includes(String(stale.webhook_id))) {
      await deleteWebhook(credential, stale.webhook_id, options);
      deletedWebhookIds.push(String(stale.webhook_id));
    }
  }

  const created = await createWebhook(
    credential,
    inspected.callback_url,
    REQUIRED_ORDER_EVENTS,
    options
  );

  return {
    status: 'created',
    credential_id: credential.id,
    callback_url: inspected.callback_url,
    webhook_id: created.webhook_id,
    deleted_webhook_ids: deletedWebhookIds,
    events: [...REQUIRED_ORDER_EVENTS]
  };
}

async function disableCredentialWebhook(credentialOrId, options = {}) {
  const credential = await resolveCredential(credentialOrId);
  if (!credential) throw new Error('falabella_credential_not_found');

  const callbackUrl = resolveCallbackUrl(options.callbackUrl);
  if (!credential.seller_email || !credential.api_key) {
    return {
      status: 'skipped',
      reason: 'credentials_incomplete',
      credential_id: credential.id,
      callback_url: callbackUrl,
      deleted_webhook_ids: []
    };
  }

  const inspected = await inspectCredentialWebhook(credential, options);
  const deletedWebhookIds = [];

  for (const webhook of inspected.target_webhooks) {
    if (!webhook.webhook_id) throw new Error('falabella_target_webhook_id_missing');
    await deleteWebhook(credential, webhook.webhook_id, options);
    deletedWebhookIds.push(String(webhook.webhook_id));
  }

  return {
    status: deletedWebhookIds.length > 0 ? 'disabled' : 'already_disabled',
    credential_id: credential.id,
    callback_url: callbackUrl,
    deleted_webhook_ids: deletedWebhookIds
  };
}

const FalabellaWebhookService = {
  getWebhooks,
  createWebhook,
  deleteWebhook,
  inspectCredentialWebhook,
  ensureCredentialWebhook,
  ensureCredentialWebhookById: ensureCredentialWebhook,
  disableCredentialWebhook,
  REQUIRED_ORDER_EVENTS,
  DEFAULT_CALLBACK_URL,
  _private: {
    buildSignedUrl,
    buildCreateWebhookXml,
    buildDeleteWebhookXml,
    normalizeWebhookList,
    normalizeWebhookEvents,
    hasRequiredOrderEvents,
    getApiError,
    resolveCallbackUrl,
    timestampMinus03
  }
};

module.exports = FalabellaWebhookService;
