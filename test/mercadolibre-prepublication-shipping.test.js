const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

const OAuthController = require('../app/controllers/OAuthController');

test('shipping prepublicación usa dimensiones y origen de ML sin item_id ni destino comprador', async (t) => {
  const originalGet = axios.get;
  const calls = [];

  axios.get = async (url, options = {}) => {
    calls.push({ url, params: options.params || null });

    if (String(url).endsWith('/addresses')) {
      return {
        data: [{
          id: 77,
          status: 'active',
          types: ['shipping'],
          zip_code: '8320000',
          city: { id: 'CITY-1' },
          state: { id: 'STATE-1' }
        }]
      };
    }

    if (String(url).includes('/shipping_options/free')) {
      return {
        data: {
          coverage: {
            all_country: {
              cost: 123,
              list_cost: 123,
              currency_id: 'CLP',
              billable_weight: 400
            }
          },
          tags: []
        }
      };
    }

    throw new Error(`Unexpected axios.get: ${url}`);
  };

  t.after(() => {
    axios.get = originalGet;
  });

  const result = await OAuthController.calculateMercadoLibreShippingCosts(
    {
      id: 987654323,
      access_token: 'test-token',
      additional_data: { ml_user_id: 123456 }
    },
    {
      id: 1,
      price: 1000,
      package: {
        weight: { value: 400, unit: 'g' },
        dimensions: {
          height: { value: 10, unit: 'cm' },
          width: { value: 10, unit: 'cm' },
          length: { value: 10, unit: 'cm' }
        }
      }
    },
    'MLC123',
    'MLC',
    'gold_special',
    'drop_off',
    'me2',
    { bypassCache: true }
  );

  const prepublicationCalls = calls.filter(call => String(call.url).includes('/shipping_options/free'));

  assert.equal(calls.filter(call => String(call.url).endsWith('/addresses')).length, 1);
  assert.equal(calls.some(call => String(call.url).includes('/items/')), false);
  assert.equal(prepublicationCalls.length, 2);
  assert.equal(prepublicationCalls[0].params.dimensions, '10x10x10,400');
  assert.equal(prepublicationCalls[0].params.zip_code, '8320000');
  assert.equal(prepublicationCalls[0].params.city_id, 'CITY-1');
  assert.equal(prepublicationCalls[0].params.state_id, 'STATE-1');
  assert.equal(result.buyer_pays.cost, null);
  assert.equal(result.seller_pays.cost, 123);
  assert.equal(result.buyer_quote_status, 'not_available_prepublication');
  assert.equal(result.seller_origin_zip_code_used, '8320000');
  assert.equal(result.warning, null);
});

test('shipping prepublicación aplica el escenario obligatorio cuando ML devuelve descuento mandatory', async (t) => {
  const originalGet = axios.get;

  axios.get = async (url) => {
    if (String(url).endsWith('/addresses')) {
      return { data: [{ id: 88, status: 'active', types: ['shipping'], zip_code: '8320000' }] };
    }

    if (String(url).includes('/shipping_options/free')) {
      return {
        data: {
          coverage: {
            all_country: {
              cost: null,
              list_cost: 3600,
              currency_id: 'CLP',
              discount: { rate: 0.5, type: 'mandatory', promoted_amount: 7200 }
            }
          },
          tags: []
        }
      };
    }

    throw new Error(`Unexpected axios.get: ${url}`);
  };

  t.after(() => {
    axios.get = originalGet;
  });

  const result = await OAuthController.calculateMercadoLibreShippingCosts(
    {
      id: 987654324,
      access_token: 'test-token',
      additional_data: { ml_user_id: 123457 }
    },
    {
      id: 52,
      price: 49990,
      condition: 'new',
      free_shipping: false,
      package: {
        weight: { value: 2000, unit: 'g' },
        dimensions: {
          height: { value: 10, unit: 'cm' },
          width: { value: 20, unit: 'cm' },
          length: { value: 20, unit: 'cm' }
        }
      }
    },
    'MLC457377',
    'MLC',
    'gold_special',
    'xd_drop_off',
    'me2',
    {
      bypassCache: true,
      shipping_resolution_state: 'resolved',
      shipping_complexity: 'automated'
    }
  );

  assert.equal(result.mandatory_free_shipping_detected, true);
  assert.equal(result.mandatory_free_shipping_status, 'confirmed');
  assert.equal(result.selected_scenario_key, 'subsidized_shipping');
  assert.equal(result.shipping_summary.free_shipping, true);
  assert.equal(result.shipping_summary.mandatory_free_shipping, true);
  assert.equal(result.shipping_summary.seller_shipping_cost, 3600);
  assert.equal(result.shipping_summary.shipping_subsidy, 7200);
  assert.equal(result.shipping_summary.shipping_resolution_state, 'resolved');
  assert.equal(result.shipping_summary.shipping_complexity, 'automated');
});
