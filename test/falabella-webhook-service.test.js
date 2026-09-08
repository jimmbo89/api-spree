const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

const FalabellaWebhookService = require('../app/services/FalabellaWebhookService');
const { MarketplaceCredentialRepository } = require('../app/repositories');

const helpers = FalabellaWebhookService._private;

test('FalabellaWebhookService: reconoce webhooks y eventos oficiales', () => {
  const webhooks = helpers.normalizeWebhookList({
    SuccessResponse: {
      Body: {
        Webhooks: {
          Webhook: [
            {
              WebhookId: 'valid-1',
              CallbackUrl: 'https://spree.api.klint.cl/api/webhooks-falabella',
              WebhookSource: 'api',
              Events: {
                Event: ['onOrderCreated', 'onOrderItemsStatusChanged']
              }
            },
            {
              WebhookId: 'wrong-1',
              CallbackUrl: 'https://www.shop.com/webhook',
              Events: { Event: 'onProductCreated' }
            }
          ]
        }
      }
    }
  });

  assert.equal(webhooks.length, 2);
  assert.equal(helpers.hasRequiredOrderEvents(webhooks[0]), true);
  assert.equal(helpers.hasRequiredOrderEvents(webhooks[1]), false);
});

test('FalabellaWebhookService: genera XML con callback y eventos de órdenes', () => {
  const xml = helpers.buildCreateWebhookXml(
    'https://spree.api.klint.cl/api/webhooks-falabella',
    FalabellaWebhookService.REQUIRED_ORDER_EVENTS
  );

  assert.match(xml, /<CallbackUrl>https:\/\/spree\.api\.klint\.cl\/api\/webhooks-falabella<\/CallbackUrl>/);
  assert.match(xml, /<Event>onOrderCreated<\/Event>/);
  assert.match(xml, /<Event>onOrderItemsStatusChanged<\/Event>/);
  assert.doesNotMatch(xml, /onProductCreated/);
});

test('FalabellaWebhookService: firma la consulta sin exponer la API key en la URL', () => {
  const url = helpers.buildSignedUrl({
    Action: 'GetWebhooks',
    Format: 'JSON',
    Timestamp: '2026-09-08T12:49:23-03:00',
    UserID: 'seller@example.com',
    Version: '1.0'
  }, 'secret-key');

  assert.match(url, /Action=GetWebhooks/);
  assert.match(url, /Version=1\.0/);
  assert.match(url, /Signature=[a-f0-9]+/);
  assert.doesNotMatch(url, /secret-key/);
});

test('FalabellaWebhookService: no duplica un webhook válido', async () => {
  const originalFindById = MarketplaceCredentialRepository.findById;
  const originalRequest = axios.request;
  const calls = [];

  MarketplaceCredentialRepository.findById = async () => ({
    id: 10,
    active: true,
    seller_email: 'seller@example.com',
    api_key: 'secret-key'
  });
  axios.request = async (config) => {
    calls.push(config);
    return {
      status: 200,
      headers: {},
      data: {
        SuccessResponse: {
          Body: {
            Webhooks: {
              Webhook: {
                WebhookId: 'valid-1',
                CallbackUrl: 'https://spree.api.klint.cl/api/webhooks-falabella',
                Events: { Event: ['onOrderCreated', 'onOrderItemsStatusChanged'] }
              }
            }
          }
        }
      }
    };
  };

  try {
    const result = await FalabellaWebhookService.ensureCredentialWebhookById(10);
    assert.equal(result.status, 'already_configured');
    assert.equal(calls.length, 1);
    assert.equal(new URL(calls[0].url).searchParams.get('Action'), 'GetWebhooks');
  } finally {
    MarketplaceCredentialRepository.findById = originalFindById;
    axios.request = originalRequest;
  }
});

test('FalabellaWebhookService: crea el webhook correcto cuando no existe', async () => {
  const originalFindById = MarketplaceCredentialRepository.findById;
  const originalRequest = axios.request;
  const calls = [];

  MarketplaceCredentialRepository.findById = async () => ({
    id: 11,
    active: true,
    seller_email: 'seller@example.com',
    api_key: 'secret-key'
  });
  axios.request = async (config) => {
    calls.push(config);
    const action = new URL(config.url).searchParams.get('Action');
    if (action === 'GetWebhooks') {
      return { status: 200, headers: {}, data: { SuccessResponse: { Body: { Webhooks: { Webhook: [] } } } } };
    }
    return {
      status: 200,
      headers: {},
      data: { SuccessResponse: { Body: { Webhook: { WebhookId: 'created-1' } } } }
    };
  };

  try {
    const result = await FalabellaWebhookService.ensureCredentialWebhookById(11);
    assert.equal(result.status, 'created');
    assert.equal(result.webhook_id, 'created-1');
    assert.equal(calls.length, 2);
    assert.equal(new URL(calls[1].url).searchParams.get('Action'), 'CreateWebhook');
    assert.match(calls[1].data, /onOrderCreated/);
    assert.match(calls[1].data, /onOrderItemsStatusChanged/);
  } finally {
    MarketplaceCredentialRepository.findById = originalFindById;
    axios.request = originalRequest;
  }
});

test('FalabellaWebhookService: extrae WebhookId de la respuesta JSON oficial', async () => {
  const originalFindById = MarketplaceCredentialRepository.findById;
  const originalRequest = axios.request;
  const calls = [];

  MarketplaceCredentialRepository.findById = async () => ({
    id: 13,
    active: true,
    seller_email: 'seller@example.com',
    api_key: 'secret-key'
  });
  axios.request = async (config) => {
    calls.push(config);
    return {
      status: 200,
      headers: {},
      data: {
        SuccessResponse: {
          Body: {
            WebhookId: 'created-json-1',
            CreatedAt: '2026-09-08T12:49:23-0300'
          }
        }
      }
    };
  };

  try {
    const result = await FalabellaWebhookService.createWebhook(
      { seller_email: 'seller@example.com', api_key: 'secret-key' },
      'https://spree.api.klint.cl/api/webhooks-falabella'
    );
    assert.equal(result.webhook_id, 'created-json-1');
    assert.equal(calls.length, 1);
  } finally {
    MarketplaceCredentialRepository.findById = originalFindById;
    axios.request = originalRequest;
  }
});

test('FalabellaWebhookService: reemplaza un webhook objetivo incompleto', async () => {
  const originalFindById = MarketplaceCredentialRepository.findById;
  const originalRequest = axios.request;
  const calls = [];

  MarketplaceCredentialRepository.findById = async () => ({
    id: 12,
    active: true,
    seller_email: 'seller@example.com',
    api_key: 'secret-key'
  });
  axios.request = async (config) => {
    calls.push(config);
    const action = new URL(config.url).searchParams.get('Action');
    if (action === 'GetWebhooks') {
      return {
        status: 200,
        headers: {},
        data: {
          SuccessResponse: {
            Body: {
              Webhooks: {
                Webhook: {
                  WebhookId: 'incomplete-1',
                  CallbackUrl: 'https://spree.api.klint.cl/api/webhooks-falabella',
                  Events: { Event: ['onOrderCreated'] }
                }
              }
            }
          }
        }
      };
    }
    if (action === 'DeleteWebhook') {
      return { status: 200, headers: {}, data: { SuccessResponse: { Body: {} } } };
    }
    return {
      status: 200,
      headers: {},
      data: { SuccessResponse: { Body: { Webhook: { WebhookId: 'created-2' } } } }
    };
  };

  try {
    const result = await FalabellaWebhookService.ensureCredentialWebhookById(12);
    assert.equal(result.status, 'created');
    assert.deepEqual(result.deleted_webhook_ids, ['incomplete-1']);
    assert.deepEqual(
      calls.map((call) => new URL(call.url).searchParams.get('Action')),
      ['GetWebhooks', 'DeleteWebhook', 'CreateWebhook']
    );
  } finally {
    MarketplaceCredentialRepository.findById = originalFindById;
    axios.request = originalRequest;
  }
});

test('FalabellaWebhookService: deshabilita solo el callback administrado por Spree', async () => {
  const originalFindById = MarketplaceCredentialRepository.findById;
  const originalRequest = axios.request;
  const calls = [];

  MarketplaceCredentialRepository.findById = async () => ({
    id: 14,
    active: true,
    seller_email: 'seller@example.com',
    api_key: 'secret-key'
  });
  axios.request = async (config) => {
    calls.push(config);
    const action = new URL(config.url).searchParams.get('Action');
    if (action === 'GetWebhooks') {
      return {
        status: 200,
        headers: {},
        data: {
          SuccessResponse: {
            Body: {
              Webhooks: {
                Webhook: [
                  {
                    WebhookId: 'spree-1',
                    CallbackUrl: 'https://spree.api.klint.cl/api/webhooks-falabella',
                    Events: { Event: ['onOrderCreated'] }
                  },
                  {
                    WebhookId: 'external-1',
                    CallbackUrl: 'https://external.example/webhook',
                    Events: { Event: ['onProductCreated'] }
                  }
                ]
              }
            }
          }
        }
      };
    }
    return { status: 200, headers: {}, data: { SuccessResponse: { Body: {} } } };
  };

  try {
    const result = await FalabellaWebhookService.disableCredentialWebhook(14);
    assert.equal(result.status, 'disabled');
    assert.deepEqual(result.deleted_webhook_ids, ['spree-1']);
    assert.deepEqual(
      calls.map((call) => new URL(call.url).searchParams.get('Action')),
      ['GetWebhooks', 'DeleteWebhook']
    );
    assert.match(calls[1].data, /spree-1/);
    assert.doesNotMatch(calls[1].data, /external-1/);
  } finally {
    MarketplaceCredentialRepository.findById = originalFindById;
    axios.request = originalRequest;
  }
});
