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

test('buildMercadoLibreUserProductItemPayload normaliza family_name que excede max_title_length', () => {
  const adapter = createAdapter();
  const payload = adapter.buildMercadoLibreUserProductItemPayload(
    {
      category_id: 'MLC440259',
      family_name: 'X'.repeat(121),
      currency_id: 'CLP',
      price: 1000,
      available_quantity: 1,
      listing_type_id: 'gold_special',
      buying_mode: 'buy_it_now',
      condition: 'new',
      pictures: [{ source: 'https://example.com/1.jpg' }],
      attributes: []
    },
    { sku: 'SKU-001' },
    { category: { settings: { max_title_length: 120 } }, attributes: [] }
  );

  assert.equal(payload.__blocked_error, undefined);
  assert.equal(payload.family_name, 'X'.repeat(120));
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

test('publish update User Products omite title y variations residuales', async (t) => {
  const originalGet = axios.get;
  const originalPut = axios.put;
  const putCalls = [];

  axios.get = async (url) => {
    if (String(url).includes('/items/MLC-existing-up')) {
      return {
        status: 200,
        statusText: 'OK',
        data: {
          id: 'MLC-existing-up',
          status: 'active',
          user_product_id: 'MLU-existing-up',
          family_name: 'Pack de gorras',
          tags: ['user_product_listing'],
          variations: []
        }
      };
    }

    throw new Error(`Unexpected axios.get: ${url}`);
  };

  axios.put = async (url, body) => {
    putCalls.push({ url, body });
    return { data: { id: 'MLC-existing-up' } };
  };

  t.after(() => {
    axios.get = originalGet;
    axios.put = originalPut;
  });

  const adapter = createAdapter({
    ensureValidCredentials: async () => ({ valid: true }),
    getMercadoLibreSellerProfile: async () => ({ user_product_seller: true, seller_id: 123 }),
    loadMercadoLibreMetadata: async () => ({
      category: { settings: { max_title_length: 200 } },
      attributes: [],
      sale_term_ids: [],
      shippingPreferences: { user: { modes: ['me2'] }, category: { logistics: [] } }
    }),
    logPublishPayloadMarker: () => undefined
  });

  const result = await adapter.publish({
    __ml_existing_item_id: 'MLC-existing-up',
    category_id: 'MLC437579',
    title: 'Pack de gorras',
    family_name: 'Pack de gorras',
    name: 'Pack de gorras',
    price: 29900,
    available_quantity: 2,
    currency_id: 'CLP',
    listing_type_id: 'gold_special',
    buying_mode: 'buy_it_now',
    condition: 'new',
    pictures: [{ source: 'https://example.com/1.jpg' }],
    attributes: [],
    variations: [{ id: 123, price: 29900, available_quantity: 1 }]
  });

  assert.equal(result.success, true);
  assert.equal(result.error, undefined);
  assert.equal(putCalls.length, 1);
  assert.equal(putCalls[0].url, 'https://api.mercadolibre.com/items/MLC-existing-up');
  assert.deepEqual(putCalls[0].body, {
    price: 29900,
    available_quantity: 2,
    pictures: [{ source: 'https://example.com/1.jpg' }]
  });
});

test('buildMercadoLibreUserProductItemPayload no bloquea Child PK no requerido', () => {
  const adapter = createAdapter();
  const payload = adapter.buildMercadoLibreUserProductItemPayload(
    {
      category_id: 'MLC10871',
      family_name: 'Tinta Canon GI-190 PGBK Negra 135 ml',
      currency_id: 'CLP',
      price: 17880,
      available_quantity: 1,
      listing_type_id: 'gold_special',
      buying_mode: 'buy_it_now',
      condition: 'new',
      pictures: [{ source: 'https://example.com/1.jpg' }],
      attributes: [
        { id: 'BRAND', value_name: 'Canon' },
        { id: 'MODEL', value_name: 'GI-190 PGBK' },
        { id: 'SALE_FORMAT', value_name: 'Unidad', value_id: '1359391' },
        { id: 'UNITS_PER_PACK', value_name: '1' },
        { id: 'UNIT_VOLUME', value_name: '135 mL' }
      ]
    },
    {
      sku: '0667C001AB-NEGRO',
      variant_values: [{ name: 'Negro', definition: { name: 'Color' } }]
    },
    {
      category: { settings: { max_title_length: 60 } },
      attributes: [
        { id: 'BRAND', name: 'Marca', hierarchy: 'PARENT_PK', tags: { required: true } },
        { id: 'MODEL', name: 'Modelo', hierarchy: 'PARENT_PK', tags: { required: true } },
        { id: 'INK_COLOR', name: 'Color de la tinta', hierarchy: 'CHILD_PK', tags: { allow_variations: true } },
        { id: 'SALE_FORMAT', name: 'Formato de venta', hierarchy: 'CHILD_PK', tags: {} },
        { id: 'UNITS_PER_PACK', name: 'Unidades por pack', hierarchy: 'CHILD_PK', tags: { conditional_required: true } },
        { id: 'PACKS_NUMBER', name: 'Cantidad de packs', hierarchy: 'CHILD_PK', tags: { required: true } },
        { id: 'UNIT_VOLUME', name: 'Volumen de la unidad', hierarchy: 'CHILD_PK', tags: { unit_yield: true } }
      ]
    }
  );

  assert.equal(payload.__blocked_error, undefined);
  assert.equal(payload.family_name, 'Tinta Canon GI-190 PGBK Negra 135 ml');
});

test('enrichMercadoLibreParentAttributes genera GTIN cuando la categoria lo exige condicionalmente', () => {
  const adapter = createAdapter();
  const attributes = adapter.enrichMercadoLibreParentAttributes(
    [{ id: 'BRAND', value_name: 'Canon' }],
    { id: 32, sku: '0667C001AB', name: 'Tinta Canon GI-190 PGBK Negra 135 ml' },
    [
      { id: 'BRAND', tags: { required: true } },
      {
        id: 'GTIN',
        type: 'product_identifier',
        tags: { conditional_required: true, variation_attribute: true, validate: true }
      }
    ]
  );

  const gtin = attributes.find((attr) => attr.id === 'GTIN')?.value_name;
  assert.equal(gtin, '06670016');
  assert.equal(adapter.isValidGTIN(gtin), true);
});

test('buildValidMercadoLibreVariations propaga GTIN de marketplace a cada variante', () => {
  const adapter = createAdapter();
  const variations = adapter.buildValidMercadoLibreVariations(
    [
      {
        sku: '0667C001AB-NEGRO',
        publish: true,
        price: 17880,
        publishStock: 1,
        variant_values: [{ name: 'Negro', definition: { name: 'Color de la tinta' } }]
      },
      {
        sku: '0667C001AB-CIAN',
        publish: true,
        price: 17880,
        publishStock: 1,
        variant_values: [{ name: 'Cian', definition: { name: 'Color de la tinta' } }]
      }
    ],
    [
      {
        id: 'INK_COLOR',
        name: 'Color de la tinta',
        tags: { allow_variations: true },
        values: [
          { id: '52049', name: 'Negro' },
          { id: '52053', name: 'Cian' }
        ]
      },
      {
        id: 'GTIN',
        name: 'Codigo universal de producto',
        type: 'product_identifier',
        tags: { variation_attribute: true, conditional_required: true, validate: true }
      }
    ],
    17880,
    [{ source: 'https://example.com/1.jpg' }],
    [{ id: 'GTIN', value_name: '06670016' }]
  );

  assert.equal(variations.length, 2);
  assert.equal(variations[0].attributes.some((attr) => attr.id === 'GTIN' && attr.value_name === '06670016'), true);
  assert.equal(variations[1].attributes.some((attr) => attr.id === 'GTIN' && attr.value_name === '06670016'), true);
});
