const assert = require('node:assert/strict');
const axios = require('axios');
const MercadoLibreAdapter = require('../app/services/adapters/MercadoLibreAdapter');
const { resolveExistingItemModel } = require('../app/services/MarketplaceItemVerificationService');

function createAdapter({ userProductSeller = false } = {}) {
  const credential = {
    access_token: 'test-token',
    marketplace: { domain: 'mercadolibre.cl' }
  };

  const adapter = new MercadoLibreAdapter(1, null, null, null, credential);
  adapter.credential = credential;
  adapter.ensureValidCredentials = async () => ({ valid: true });
  adapter.getMercadoLibreSellerProfile = async () => ({
    user_product_seller: userProductSeller,
    seller_id: 123
  });
  adapter.loadMercadoLibreMetadata = async () => ({
    category: { settings: { max_title_length: 120 } },
    attributes: [],
    sale_term_ids: [],
    shippingPreferences: { user: { modes: ['me2'] }, category: { logistics: [] } }
  });
  adapter.validateMercadoLibrePayload = async () => ({ valid: true, validation: { status: 200, valid: true } });
  adapter.logPublishPayloadMarker = () => undefined;
  adapter.getMercadoLibreUserProductStock = async () => ({ type: 'selling_address', version: 1 });
  return adapter;
}

function installAxiosMock(router) {
  const originals = {
    get: axios.get,
    post: axios.post,
    put: axios.put,
    request: axios.request,
    delete: axios.delete,
    head: axios.head
  };

  axios.get = async (url, options = {}) => {
    if (router.get) return router.get(url, options);
    throw new Error(`Unexpected axios.get: ${url}`);
  };

  axios.post = async (url, body, options = {}) => {
    if (router.post) return router.post(url, body, options);
    throw new Error(`Unexpected axios.post: ${url}`);
  };

  axios.put = async (url, body, options = {}) => {
    if (router.put) return router.put(url, body, options);
    throw new Error(`Unexpected axios.put: ${url}`);
  };

  axios.request = async (config = {}) => {
    const method = String(config.method || 'get').toLowerCase();
    if (method === 'get') return axios.get(config.url, config);
    if (method === 'post') return axios.post(config.url, config.data, config);
    if (method === 'put') return axios.put(config.url, config.data, config);
    throw new Error(`Unexpected axios.request: ${method.toUpperCase()} ${config.url}`);
  };

  axios.delete = async (url) => {
    if (router.delete) return router.delete(url);
    throw new Error(`Unexpected axios.delete: ${url}`);
  };

  axios.head = async (url) => {
    if (router.head) return router.head(url);
    throw new Error(`Unexpected axios.head: ${url}`);
  };

  return () => {
    axios.get = originals.get;
    axios.post = originals.post;
    axios.put = originals.put;
    axios.request = originals.request;
    axios.delete = originals.delete;
    axios.head = originals.head;
  };
}

async function runCase(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
    return true;
  } catch (error) {
    console.error(`not ok - ${name}`);
    console.error(error);
    return false;
  }
}

async function main() {
  const results = [];

  results.push(await runCase('Clásico simple con SKU', async () => {
    const restore = installAxiosMock({
      post: async (url, body) => {
        if (String(url).includes('/items')) return { data: { id: 'MLA-1' } };
        throw new Error(`Unexpected axios.post: ${url}`);
      }
    });
    const adapter = createAdapter({ userProductSeller: false });
    const captured = [];
    adapter.validateMercadoLibrePayload = async (payload) => {
      captured.push(payload);
      return { valid: true, validation: { status: 200, valid: true } };
    };

    const result = await adapter.publish({
      category_id: 'MLC440259',
      title: 'Producto clásico',
      name: 'Producto clásico',
      price: 1000,
      currency_id: 'CLP',
      buying_mode: 'buy_it_now',
      listing_type_id: 'gold_special',
      condition: 'new',
      available_quantity: 2,
      pictures: [{ source: 'https://example.com/main.jpg' }],
      attributes: [{ id: 'SELLER_SKU', value_name: 'SKU-1' }],
      sale_terms: [],
      description: '',
      sku: 'SKU-1'
    });

    assert.equal(result.success, true);
    assert.equal(captured[0].title, 'Producto clásico');
    restore();
  }));

  results.push(await runCase('Clásico con dos variaciones válidas', async () => {
    const restore = installAxiosMock({
      post: async (url, body) => {
        if (String(url).includes('/items')) return { data: { id: 'MLA-2' } };
        throw new Error(`Unexpected axios.post: ${url}`);
      }
    });
    const adapter = createAdapter();
    adapter.buildValidMercadoLibreVariations = () => ([
      { id: 'v1', attribute_combinations: [{ id: 'COLOR', value_name: 'Rojo' }], picture_ids: ['https://example.com/r1.jpg'], price: 1000, available_quantity: 1, attributes: [] },
      { id: 'v2', attribute_combinations: [{ id: 'COLOR', value_name: 'Azul' }], picture_ids: ['https://example.com/b1.jpg'], price: 1000, available_quantity: 1, attributes: [] }
    ]);

    const result = await adapter.publish({
      category_id: 'MLC440259',
      title: 'Con variantes',
      name: 'Con variantes',
      price: 1000,
      currency_id: 'CLP',
      buying_mode: 'buy_it_now',
      listing_type_id: 'gold_special',
      condition: 'new',
      available_quantity: 2,
      pictures: [
        { source: 'https://example.com/main.jpg' },
        { source: 'https://example.com/r1.jpg' },
        { source: 'https://example.com/b1.jpg' }
      ],
      attributes: [],
      sale_terms: [],
      description: '',
      variations: [
        { publish: true, price: 1000, sku: 'SKU-R', pictures: [{ source: 'https://example.com/r1.jpg' }] },
        { publish: true, price: 1000, sku: 'SKU-A', pictures: [{ source: 'https://example.com/b1.jpg' }] }
      ]
    });

    assert.equal(result.success, true);
    restore();
  }));

  results.push(await runCase('Variaciones inválidas bloqueadas', async () => {
    const restore = installAxiosMock({});
    const adapter = createAdapter();
    adapter.buildValidMercadoLibreVariations = () => null;

    const result = await adapter.publish({
      category_id: 'MLC440259',
      title: 'Inválidas',
      name: 'Inválidas',
      price: 1000,
      currency_id: 'CLP',
      buying_mode: 'buy_it_now',
      listing_type_id: 'gold_special',
      condition: 'new',
      available_quantity: 2,
      pictures: [{ source: 'https://example.com/main.jpg' }],
      attributes: [],
      sale_terms: [],
      description: '',
      variations: [
        { publish: true, price: 1000, sku: 'SKU-1' },
        { publish: true, price: 1000, sku: 'SKU-2' }
      ]
    });

    assert.equal(result.success, false);
    restore();
  }));

  results.push(await runCase('Imágenes de variante ausentes del arreglo raíz', async () => {
    const restore = installAxiosMock({});
    const adapter = createAdapter();
    adapter.loadMercadoLibreMetadata = async () => ({
      category: { settings: { max_title_length: 120 } },
      attributes: [
        { id: 'COLOR', name: 'Color', tags: { allow_variations: true } }
      ],
      sale_term_ids: [],
      shippingPreferences: { user: { modes: ['me2'] }, category: { logistics: [{ mode: 'me2', types: ['xd_drop_off'] }] } }
    });
    adapter.buildValidMercadoLibreVariations = () => ([
      { id: 'v1', attribute_combinations: [{ id: 'COLOR', value_name: 'Rojo' }], picture_ids: ['https://example.com/missing.jpg'], price: 1000, available_quantity: 1, attributes: [] },
      { id: 'v2', attribute_combinations: [{ id: 'COLOR', value_name: 'Azul' }], picture_ids: ['https://example.com/other.jpg'], price: 1000, available_quantity: 1, attributes: [] }
    ]);

    const result = await adapter.publish({
      category_id: 'MLC440259',
      title: 'Imágenes',
      name: 'Imágenes',
      price: 1000,
      currency_id: 'CLP',
      buying_mode: 'buy_it_now',
      listing_type_id: 'gold_special',
      condition: 'new',
      available_quantity: 2,
      pictures: [{ source: 'https://example.com/root.jpg' }],
      attributes: [],
      sale_terms: [],
      description: '',
      variations: [
        { publish: true, price: 1000, sku: 'SKU-1', pictures: [{ source: 'https://example.com/missing.jpg' }] },
        { publish: true, price: 1000, sku: 'SKU-2', pictures: [{ source: 'https://example.com/other.jpg' }] }
      ]
    });

    assert.equal(result.success, false);
    assert.equal(result.error, 'variation_pictures_not_in_root');
    restore();
  }));

  results.push(await runCase('User Product simple', async () => {
    const captured = [];
    const restore = installAxiosMock({
      post: async (url, body) => {
        if (String(url).includes('/items')) {
          captured.push(body);
          return { data: { id: 'UP-1' } };
        }
        throw new Error(`Unexpected axios.post: ${url}`);
      }
    });
    const adapter = createAdapter({ userProductSeller: true });

    const result = await adapter.publish({
      category_id: 'MLC440259',
      family_name: 'Familia UP',
      name: 'Familia UP',
      price: 1000,
      currency_id: 'CLP',
      buying_mode: 'buy_it_now',
      listing_type_id: 'gold_special',
      condition: 'new',
      available_quantity: 1,
      pictures: [{ source: 'https://example.com/main.jpg' }],
      attributes: [],
      sale_terms: [],
      description: ''
    });

    assert.equal(result.success, true);
    assert.equal(captured[0].family_name, 'Familia UP');
    assert.equal(captured[0].title, undefined);
    assert.equal(captured[0].variations, undefined);
    restore();
  }));

  results.push(await runCase('Dos User Products de la misma familia', async () => {
    const bodies = [];
    const restore = installAxiosMock({
      post: async (url, body) => {
        if (String(url).includes('/items')) {
          bodies.push(body);
          return { data: { id: `UP-${bodies.length}` } };
        }
        throw new Error(`Unexpected axios.post: ${url}`);
      }
    });
    const adapter = createAdapter({ userProductSeller: true });

    const result = await adapter.publish({
      category_id: 'MLC440259',
      family_name: 'Familia común',
      name: 'Familia común',
      price: 1000,
      currency_id: 'CLP',
      buying_mode: 'buy_it_now',
      listing_type_id: 'gold_special',
      condition: 'new',
      available_quantity: 2,
      pictures: [{ source: 'https://example.com/main.jpg' }],
      attributes: [],
      sale_terms: [],
      description: '',
      variations: [
        { publish: true, price: 1000, sku: 'SKU-1', pictures: [{ source: 'https://example.com/1.jpg' }] },
        { publish: true, price: 1000, sku: 'SKU-2', pictures: [{ source: 'https://example.com/2.jpg' }] }
      ]
    });

    assert.equal(result.success, true);
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].family_name, 'Familia común');
    assert.equal(bodies[1].family_name, 'Familia común');
    restore();
  }));

  results.push(await runCase('User Products sin Child PK obligatorio', async () => {
    const adapter = createAdapter({ userProductSeller: true });
    const payload = adapter.buildMercadoLibreUserProductItemPayload(
      {
        category_id: 'MLC440259',
        family_name: 'Familia',
        price: 1000,
        currency_id: 'CLP',
        listing_type_id: 'gold_special',
        attributes: []
      },
      { sku: 'SKU-1', color: 'Rojo' },
      {
        category: { settings: { max_title_length: 120 } },
        attributes: [{ id: 'COLOR', name: 'Color', required: true, tags: { child_pk: true } }]
      }
    );

    assert.ok(payload.__blocked_error);
    assert.equal(payload.__blocked_error.code, 'missing_child_pk');
  }));

  results.push(await runCase('Update clásico simple', async () => {
    const calls = [];
    const restore = installAxiosMock({
      get: async (url) => {
        if (String(url).includes('/items/MLA-1')) {
          return { data: { id: 'MLA-1', status: 'active', sold_quantity: 0 } };
        }
        throw new Error(`Unexpected axios.get: ${url}`);
      },
      put: async (url, body) => {
        calls.push({ url, body });
        return { data: { id: 'MLA-1', status: 'active' } };
      }
    });
    const adapter = createAdapter();
    const result = await adapter.updateItem({ itemId: 'MLA-1', status: 'paused', price: 1500, available_quantity: 4, title: 'Nuevo título' });
    assert.equal(result.success, true);
    assert.equal(calls[0].body.title, 'Nuevo título');
    assert.equal(calls[0].body.price, 1500);
    restore();
  }));

  results.push(await runCase('Update clásico con variaciones', async () => {
    const calls = [];
    const restore = installAxiosMock({
      get: async (url) => {
        if (String(url).includes('/items/MLA-2')) {
          return { data: { id: 'MLA-2', status: 'active', sold_quantity: 0, variations: [{ id: 'var-1' }] } };
        }
        throw new Error(`Unexpected axios.get: ${url}`);
      },
      put: async (url, body) => {
        calls.push({ url, body });
        return { data: { id: 'MLA-2', status: 'active' } };
      }
    });
    const adapter = createAdapter();
    const result = await adapter.updateItem({
      itemId: 'MLA-2',
      price: 2000,
      variations: [{ id: 'var-1', price: 2000, available_quantity: 1 }]
    });
    assert.equal(result.success, true);
    assert.equal(Array.isArray(calls[0].body.variations), true);
    restore();
  }));

  results.push(await runCase('Update de User Product sin title ni variations', async () => {
    const calls = [];
    const restore = installAxiosMock({
      get: async (url) => {
        if (String(url).includes('/items/UP-1')) {
          return { data: { id: 'UP-1', status: 'active', user_product_id: 'UP-ROOT' } };
        }
        if (String(url).includes('/user-products/UP-1/stock')) {
          return { data: { type: 'selling_address', version: 1 } };
        }
        throw new Error(`Unexpected axios.get: ${url}`);
      },
      put: async (url, body) => {
        calls.push({ url, body });
        return { data: { id: 'UP-1', status: 'active' } };
      }
    });
    const adapter = createAdapter({ userProductSeller: true });
    const result = await adapter.updateItem({
      itemId: 'UP-1',
      price: 2500,
      available_quantity: 6,
      family_name: 'Nueva familia',
      description: 'Nueva descripción'
    });
    assert.equal(result.success, true);
    assert.equal(calls.some((call) => String(call.url).includes('/family_name')), true);
    assert.equal(calls.some((call) => String(call.url).includes('/description')), true);
    assert.equal(calls.every((call) => !Object.prototype.hasOwnProperty.call(call.body || {}, 'title')), true);
    assert.equal(calls.every((call) => !Object.prototype.hasOwnProperty.call(call.body || {}, 'variations')), true);
    restore();
  }));

  results.push(await runCase('Descripción nueva mediante POST', async () => {
    const calls = [];
    const restore = installAxiosMock({
      post: async (url, body) => {
        calls.push({ url, body });
        return { data: { id: 'desc-1' } };
      }
    });
    const adapter = createAdapter();
    await adapter.createMercadoLibreDescription('MLA-1', 'Descripción');
    assert.equal(String(calls[0].url).includes('/description'), true);
    restore();
  }));

  results.push(await runCase('Descripción existente mediante PUT', async () => {
    const calls = [];
    const restore = installAxiosMock({
      put: async (url, body) => {
        calls.push({ url, body });
        return { data: { id: 'desc-1' } };
      }
    });
    const adapter = createAdapter();
    await adapter.updateMercadoLibreDescription('MLA-1', 'Descripción actualizada');
    assert.equal(String(calls[0].url).includes('/description?api_version=2'), true);
    restore();
  }));

  results.push(await runCase('Relist clásico simple', async () => {
    const calls = [];
    const restore = installAxiosMock({
      get: async (url) => {
        if (String(url).includes('/items/MLA-closed')) {
          return { data: { id: 'MLA-closed', status: 'closed', sold_quantity: 0 } };
        }
        throw new Error(`Unexpected axios.get: ${url}`);
      },
      post: async (url, body) => {
        calls.push({ url, body });
        return { data: { id: 'MLA-relisted' } };
      }
    });
    const adapter = createAdapter();
    const result = await adapter.publish({
      __ml_existing_item_id: 'MLA-closed',
      category_id: 'MLC440259',
      title: 'Relist',
      name: 'Relist',
      price: 1000,
      currency_id: 'CLP',
      buying_mode: 'buy_it_now',
      listing_type_id: 'gold_special',
      condition: 'new',
      available_quantity: 4,
      pictures: [{ source: 'https://example.com/main.jpg' }],
      attributes: [],
      sale_terms: [],
      description: ''
    });
    assert.equal(result.success, true);
    assert.equal(calls[0].body.price, 1000);
    assert.equal(calls[0].body.quantity, 4);
    restore();
  }));

  results.push(await runCase('Relist clásico con variaciones', async () => {
    const calls = [];
    const restore = installAxiosMock({
      get: async (url) => {
        if (String(url).includes('/items/MLA-closed-var')) {
          return { data: { id: 'MLA-closed-var', status: 'closed', sold_quantity: 0, variations: [{ id: 'var-1' }] } };
        }
        throw new Error(`Unexpected axios.get: ${url}`);
      },
      post: async (url, body) => {
        calls.push({ url, body });
        return { data: { id: 'MLA-relisted-var' } };
      }
    });
    const adapter = createAdapter();
    const result = await adapter.publish({
      __ml_existing_item_id: 'MLA-closed-var',
      category_id: 'MLC440259',
      title: 'Relist variaciones',
      name: 'Relist variaciones',
      price: 1000,
      currency_id: 'CLP',
      buying_mode: 'buy_it_now',
      listing_type_id: 'gold_special',
      condition: 'new',
      available_quantity: 4,
      pictures: [{ source: 'https://example.com/main.jpg' }],
      attributes: [],
      sale_terms: [],
      description: '',
      variations: [{ id: 'var-1', price: 1000, available_quantity: 1, publish: true }]
    });
    assert.equal(result.success, true);
    assert.equal(Array.isArray(calls[0].body.variations), true);
    restore();
  }));

  results.push(await runCase('Relist de User Product bloqueado', async () => {
    const restore = installAxiosMock({
      get: async (url) => {
        if (String(url).includes('/items/UP-closed')) {
          return { data: { id: 'UP-closed', status: 'closed', user_product_id: 'UP-ROOT' } };
        }
        throw new Error(`Unexpected axios.get: ${url}`);
      }
    });
    const adapter = createAdapter({ userProductSeller: true });
    const result = await adapter.publish({
      __ml_existing_item_id: 'UP-closed',
      category_id: 'MLC440259',
      family_name: 'Familia',
      name: 'Familia',
      price: 1000,
      currency_id: 'CLP',
      buying_mode: 'buy_it_now',
      listing_type_id: 'gold_special',
      condition: 'new',
      available_quantity: 1,
      pictures: [{ source: 'https://example.com/main.jpg' }],
      attributes: [],
      sale_terms: [],
      description: ''
    });
    assert.equal(result.success, false);
    restore();
  }));

  results.push(await runCase('Shipping no habilitado', async () => {
    const restore = installAxiosMock({});
    const adapter = createAdapter();
    adapter.loadMercadoLibreMetadata = async () => ({
      category: { settings: { max_title_length: 120 } },
      attributes: [],
      sale_term_ids: [],
      shippingPreferences: { user: null, category: null }
    });
    const result = await adapter.publish({
      category_id: 'MLC440259',
      title: 'Sin shipping',
      name: 'Sin shipping',
      price: 1000,
      currency_id: 'CLP',
      buying_mode: 'buy_it_now',
      listing_type_id: 'gold_special',
      condition: 'new',
      available_quantity: 1,
      pictures: [{ source: 'https://example.com/main.jpg' }],
      attributes: [],
      sale_terms: [],
      description: ''
    });
    assert.equal(result.success, false);
    assert.equal(result.error, 'shipping_not_available');
    restore();
  }));

  results.push(await runCase('Coexistencia de ítem clásico y User Product en el mismo seller', async () => {
    const classic = resolveExistingItemModel({ id: '1', tags: [], variations: [] });
    const up = resolveExistingItemModel({ id: '2', user_product_id: 'UP-2', tags: ['user_product_listing'], variations: [] });
    assert.equal(classic.model, 'classic');
    assert.equal(up.model, 'user_product');
  }));

  const failed = results.filter((value) => !value).length;
  if (failed > 0) {
    console.error(`Mercado Libre suite failed: ${failed} case(s)`);
    process.exitCode = 1;
    return;
  }

  console.log(`Mercado Libre suite passed: ${results.length} cases`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
