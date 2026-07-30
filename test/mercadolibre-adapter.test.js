const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

const MercadoLibreAdapter = require('../app/services/adapters/MercadoLibreAdapter');
const { resolveExistingItemModel } = require('../app/services/MarketplaceItemVerificationService');

function createAdapter(overrides = {}) {
  const credential = {
    access_token: 'test-token',
    marketplace: { domain: 'mercadolibre.cl' }
  };

  const adapter = new MercadoLibreAdapter(1, null, null, null, credential);
  adapter.credential = credential;
  Object.assign(adapter, overrides);
  return adapter;
}

test('resolveExistingItemModel clasifica User Products por evidencia real', () => {
  const result = resolveExistingItemModel({
    id: 'MLC123',
    family_name: 'Familia 1',
    user_product_id: 'MLU999',
    tags: ['user_product_listing'],
    variations: []
  });

  assert.equal(result.model, 'user_product');
  assert.equal(result.hasClassicVariations, false);
  assert.equal(result.evidence.user_product_id, 'MLU999');
});

test('publish de User Products no depende de categoryInfo implícito y no envía title ni variations', async (t) => {
  const originalPost = axios.post;
  const calls = [];
  axios.post = async (url, body) => {
    calls.push({ url, body });
    return { data: { id: 'MLA-test-1' } };
  };

  t.after(() => {
    axios.post = originalPost;
  });

  const adapter = createAdapter({
    ensureValidCredentials: async () => ({ valid: true }),
    getMercadoLibreSellerProfile: async () => ({ user_product_seller: true, seller_id: 123 }),
    loadMercadoLibreMetadata: async () => ({
      category: { settings: { max_title_length: 120 } },
      attributes: [],
      sale_term_ids: [],
      shippingPreferences: { user: { modes: ['me2'] }, category: { logistics: [] } }
    }),
    validateMercadoLibrePayload: async () => ({ valid: true, validation: { status: 200, valid: true } }),
    logPublishPayloadMarker: () => undefined,
    createMercadoLibreDescription: async () => true
  });

  const result = await adapter.publish({
    id: 43,
    category_id: 'MLC440259',
    family_name: 'Familia de prueba',
    name: 'Familia de prueba',
    price: 1000,
    currency_id: 'CLP',
    listing_type_id: 'gold_special',
    buying_mode: 'buy_it_now',
    condition: 'new',
    available_quantity: 2,
    pictures: [{ source: 'https://example.com/1.jpg' }],
    attributes: [],
    sale_terms: [],
    description: '',
    variations: [],
    sku: 'SKU-001'
  });

  assert.equal(result.success, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.family_name, 'Familia de prueba');
  assert.equal(calls[0].body.title, undefined);
  assert.equal(calls[0].body.variations, undefined);
});

test('buildMercadoLibreUserProductItemPayload bloquea family_name que excede max_title_length', () => {
  const adapter = createAdapter();
  const payload = adapter.buildMercadoLibreUserProductItemPayload(
    {
      category_id: 'MLC440259',
      family_name: 'X'.repeat(121),
      currency_id: 'CLP',
      price: 1000,
      available_quantity: 1,
      attributes: []
    },
    { sku: 'SKU-001' },
    { category: { settings: { max_title_length: 120 } }, attributes: [] }
  );

  assert.ok(payload.__blocked_error);
  assert.equal(payload.__blocked_error.code, 'family_name_too_long');
});

test('updateItem User Products usa user_product_id para stock y no envía stock en PUT /items', async (t) => {
  const originalGet = axios.get;
  const originalPut = axios.put;
  const putCalls = [];

  axios.get = async (url) => {
    if (String(url).includes('/items/MLC2098657781')) {
      return {
        status: 200,
        statusText: 'OK',
        data: {
          id: 'MLC2098657781',
          status: 'active',
          user_product_id: 'MLU123456',
          family_name: 'Pack de gorras',
          tags: ['user_product_listing'],
          variations: []
        }
      };
    }

    if (String(url).includes('/user-products/MLU123456/stock')) {
      return {
        headers: { 'x-version': '7' },
        data: {
          locations: [
            { type: 'selling_address', quantity: 1 }
          ]
        }
      };
    }

    throw new Error(`Unexpected axios.get: ${url}`);
  };

  axios.put = async (url, body, options = {}) => {
    putCalls.push({ url, body, headers: options.headers || {} });
    return { data: { id: String(url).includes('/items/') ? 'MLC2098657781' : 'MLU123456' } };
  };

  t.after(() => {
    axios.get = originalGet;
    axios.put = originalPut;
  });

  const adapter = createAdapter({
    ensureValidCredentials: async () => ({ valid: true })
  });

  const result = await adapter.updateItem({
    itemId: 'MLC2098657781',
    price: 15990,
    available_quantity: 2
  });

  assert.equal(result.success, true);
  assert.deepEqual(result.requested_changes, { price: 15990, available_quantity: 2 });
  assert.equal(result.data.available_quantity, 2);
  assert.equal(result.stock_update.user_product_id, 'MLU123456');
  assert.equal(putCalls.length, 2);
  assert.equal(putCalls[0].url, 'https://api.mercadolibre.com/user-products/MLU123456/stock/type/selling_address');
  assert.deepEqual(putCalls[0].body, { quantity: 2 });
  assert.equal(putCalls[0].headers['x-version'], '7');
  assert.equal(putCalls[1].url, 'https://api.mercadolibre.com/items/MLC2098657781');
  assert.deepEqual(putCalls[1].body, { price: 15990 });
});
