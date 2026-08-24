const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

const FalabellaAdapter = require('../app/services/adapters/FalabellaAdapter');
const MarketplaceTransformerFalabella = require('../app/services/MarketplaceTransformerFalabella');
const { MarketplaceRepository } = require('../app/repositories');

function createAdapter(overrides = {}) {
  const credential = {
    seller_email: 'seller@example.com',
    api_key: 'secret-key',
    seller_id: 'SELLER-1',
    additional_data: {
      falabella: {
        operator_code: 'facl'
      }
    },
    ...overrides
  };

  const adapter = new FalabellaAdapter(4, 1, null, 1, credential);
  adapter.credential = credential;
  adapter.marketplace = { domain: 'falabella.cl' };
  return adapter;
}

test('FalabellaAdapter: ProductId interno no se reutiliza', () => {
  const adapter = createAdapter();

  const resolved = adapter.resolveMarketplaceProductId({
    ProductId: 'INT-9999',
    productId: 'INT-9999',
    productIdentifier: 'EAN-12345678',
    ean: 'EAN-12345678'
  });

  assert.equal(resolved, 'EAN-12345678');
  assert.notEqual(resolved, 'INT-9999');
});

test('FalabellaAdapter: capacidad multivariante se resuelve con metadata oficial', () => {
  const adapter = createAdapter();

  const simpleOnly = adapter.resolveFalabellaVariationCapability([
    { feed_name: 'Variation', is_global_attribute: false, group_name: 'Variation' }
  ]);
  assert.equal(simpleOnly.supportsMultiVariation, false);
  assert.ok(simpleOnly.simpleVariationAttribute);

  const multi = adapter.resolveFalabellaVariationCapability([
    { feed_name: 'Color', is_global_attribute: false, group_name: 'Variation' },
    { feed_name: 'Size', is_global_attribute: 0, group_name: 'Variation' }
  ]);
  assert.equal(multi.supportsMultiVariation, true);
  assert.equal(multi.multiVariationAttributes.length, 2);
});

test('FalabellaAdapter: package measurements no inventan valores', () => {
  const adapter = createAdapter();
  const measurements = adapter.resolvePackageMeasurements({});

  assert.equal(measurements.package_height, null);
  assert.equal(measurements.package_width, null);
  assert.equal(measurements.package_length, null);
  assert.equal(measurements.package_weight, null);
});

test('FalabellaAdapter: validateProduct bloquea metadata faltante', () => {
  const adapter = createAdapter({
    additional_data: {}
  });

  const result = adapter.validateProduct({
    sku: 'SKU-1',
    productName: 'Producto',
    brand: 'Marca',
    price: 1000,
    stock: 1,
    PrimaryCategory: '1234',
    description: 'Descripción real',
    images: ['https://example.com/image.jpg'],
    attributes: []
  });

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('package_height')));
  assert.ok(result.errors.some((error) => error.includes('package_width')));
  assert.ok(result.errors.some((error) => error.includes('package_length')));
  assert.ok(result.errors.some((error) => error.includes('package_weight')));
  assert.ok(result.errors.some((error) => error.includes('ConditionType')));
  assert.ok(!result.errors.some((error) => error.includes('OperatorCode')));
});

test('FalabellaAdapter: buildFalabellaUpdateXml es parcial y no inventa defaults', () => {
  const adapter = createAdapter();
  const xml = adapter.buildFalabellaUpdateXml({
    sellerSku: 'SKU-1',
    price: 14990,
    available_quantity: 3,
    status: 'active'
  });

  assert.ok(xml.includes('<SellerSku>SKU-1</SellerSku>'));
  assert.ok(xml.includes('<Price>14990.00</Price>'));
  assert.ok(xml.includes('<Stock>3</Stock>'));
  assert.ok(!xml.includes('<ProductId>'));
  assert.ok(!xml.includes('<Name>'));
  assert.ok(!xml.includes('<Description>'));
});

test('FalabellaAdapter: buildFalabellaProductNodeXml no usa ProductId interno', () => {
  const adapter = createAdapter();
  const node = adapter.buildFalabellaProductNodeXml({
    sku: 'SKU-1',
    productName: 'Producto',
    brand: 'Marca',
    price: 1000,
    stock: 1,
    PrimaryCategory: '1234',
    description: 'Descripción real',
    productId: 'INT-LOCAL-1',
    attributes: [
      { id: 'ConditionType', value_name: 'Nuevo', value: 'Nuevo' }
    ],
    package_height: 10,
    package_width: 10,
    package_length: 10,
    package_weight: 1,
    images: ['https://example.com/image.jpg']
  });

  assert.equal(node.ProductId, undefined);
});

test('FalabellaAdapter: oferta Falabella se envia en BusinessUnit con campos oficiales', () => {
  const adapter = createAdapter();
  const node = adapter.buildFalabellaProductNodeXml({
    sku: 'SKU-1',
    productName: 'Producto',
    brand: 'Marca',
    price: 1000,
    stock: 1,
    PrimaryCategory: '1234',
    description: 'Descripcion real',
    attributes: [
      { id: 'ConditionType', value_name: 'Nuevo', value: 'Nuevo' },
      { id: 'SalePriceFalabella', value: 2500 },
      { id: 'SaleStartDateFalabella', value: '13-08-2026' },
      { id: 'SaleEndDateFalabella', value: '13/08/2030' }
    ],
    package_height: 10,
    package_width: 10,
    package_length: 10,
    package_weight: 1,
    images: ['https://example.com/image.jpg']
  });

  assert.equal(node.BusinessUnits.BusinessUnit.Price, '1000.00');
  assert.equal(node.BusinessUnits.BusinessUnit.SpecialPrice, undefined);
  assert.equal(node.ProductData.SalePriceFalabella, undefined);
  assert.equal(node.ProductData.SaleStartDateFalabella, undefined);
  assert.equal(node.ProductData.SaleEndDateFalabella, undefined);
});

test('FalabellaAdapter: oferta valida queda como SpecialPrice y fechas DateTime oficiales', () => {
  const adapter = createAdapter();
  const node = adapter.buildFalabellaProductNodeXml({
    sku: 'SKU-1',
    productName: 'Producto',
    brand: 'Marca',
    price: 19990,
    stock: 1,
    PrimaryCategory: '1234',
    description: 'Descripcion real',
    attributes: [
      { id: 'ConditionType', value_name: 'Nuevo', value: 'Nuevo' },
      { id: 'SalePriceFalabella', value: 2500 },
      { id: 'SaleStartDateFalabella', value: '13-08-2026' },
      { id: 'SaleEndDateFalabella', value: '13/08/2030' }
    ],
    package_height: 10,
    package_width: 10,
    package_length: 10,
    package_weight: 1,
    images: ['https://example.com/image.jpg']
  });

  assert.equal(node.BusinessUnits.BusinessUnit.SpecialPrice, '2500.00');
  assert.equal(node.BusinessUnits.BusinessUnit.SpecialFromDate, '2026-08-13 00:00:00');
  assert.equal(node.BusinessUnits.BusinessUnit.SpecialToDate, '2030-08-13 23:59:59');
  assert.equal(node.ProductData.SalePriceFalabella, undefined);
  assert.equal(node.ProductData.SaleStartDateFalabella, undefined);
  assert.equal(node.ProductData.SaleEndDateFalabella, undefined);
});

test('FalabellaAdapter: ConditionType se normaliza al contrato oficial', () => {
  const adapter = createAdapter();
  assert.equal(adapter.normalizeFalabellaConditionType('new'), 'Nuevo');
  assert.equal(adapter.normalizeFalabellaConditionType('Nuevo'), 'Nuevo');
  assert.equal(adapter.normalizeFalabellaConditionType('reacondicionado'), 'Reacondicionado');
});

test('FalabellaAdapter: uploadProductImages envía Action=Image', async () => {
  const adapter = createAdapter();
  const originalPost = axios.post;
  let capturedUrl = null;
  let capturedXml = null;

  axios.post = async (url, xml) => {
    capturedUrl = url;
    capturedXml = xml;
    return { status: 200, data: '<SuccessResponse><Body><RequestId>R1</RequestId></Body></SuccessResponse>' };
  };

  try {
    const result = await adapter.uploadProductImages('SKU-1', ['https://example.com/1.jpg', 'https://example.com/2.jpg']);
    assert.equal(result.success, true);
    assert.ok(capturedUrl.includes('Action=Image'));
    assert.ok(capturedXml.includes('<SellerSku>SKU-1</SellerSku>'));
    assert.ok(capturedXml.includes('<Image>https://example.com/1.jpg</Image>'));
  } finally {
    axios.post = originalPost;
  }
});

test('FalabellaAdapter: publish no sube imagenes antes de confirmar ProductCreate', async () => {
  const adapter = createAdapter();
  const originalPost = axios.post;
  const postedUrls = [];

  adapter.ensureValidCredentials = async () => ({ valid: true });
  adapter.hydrateAttributesForPublish = async (product) => product;
  adapter.findExistingProductBySellerSku = async () => null;
  adapter.pollFeedStatus = async () => ({
    timedOut: true,
    feed: {
      FeedID: 'PRODUCT-FEED-1',
      Status: 'Processing',
      Action: 'ProductCreate',
      TotalRecords: '1',
      ProcessedRecords: '0',
      FailedRecords: '0'
    }
  });

  axios.post = async (url) => {
    postedUrls.push(url);
    return {
      status: 200,
      data: '<SuccessResponse><Body><RequestId>PRODUCT-FEED-1</RequestId></Body></SuccessResponse>'
    };
  };

  try {
    const result = await adapter.publish({
      sku: 'SKU-1',
      productName: 'Producto real',
      brand: 'Marca real',
      price: 14990,
      stock: 2,
      PrimaryCategory: '1234',
      description: 'Descripcion real',
      package_height: 20,
      package_width: 15,
      package_length: 30,
      package_weight: 1,
      attributes: [
        { id: 'ConditionType', value_name: 'Nuevo', value: 'Nuevo' }
      ],
      images: ['https://example.com/1.jpg']
    });

    assert.equal(result.success, true);
    assert.equal(result.data.feed_id, 'PRODUCT-FEED-1');
    assert.equal(result.data.image_upload.pending, true);
    assert.equal(postedUrls.length, 1);
    assert.ok(postedUrls[0].includes('Action=ProductCreate'));
    assert.ok(!postedUrls.some((url) => url.includes('Action=Image')));
  } finally {
    axios.post = originalPost;
  }
});

test('FalabellaAdapter: ProductCreate con warnings sube imagenes si el producto ya existe', async () => {
  const adapter = createAdapter();
  const originalPost = axios.post;
  const postedUrls = [];

  adapter.ensureValidCredentials = async () => ({ valid: true });
  adapter.hydrateAttributesForPublish = async (product) => product;
  adapter.findExistingProductBySellerSku = async () => null;
  adapter.fetchProductStatus = async () => ({
    found: true,
    sku: 'SKU-1',
    status: 'active',
    has_image: false,
    is_published: false
  });
  adapter.pollFeedStatus = async () => ({
    timedOut: false,
    feed: {
      FeedID: 'PRODUCT-FEED-WARN',
      Status: 'Finished',
      Action: 'ProductCreate',
      TotalRecords: '1',
      ProcessedRecords: '1',
      FailedRecords: '0',
      FeedWarnings: {
        Warning: {
          Message: 'Selling this brand requires an approval. Please get in contact with Falabella',
          SellerSku: 'SKU-1'
        }
      }
    }
  });

  axios.post = async (url) => {
    postedUrls.push(url);
    if (url.includes('Action=Image')) {
      return {
        status: 200,
        data: '<SuccessResponse><Body><RequestId>IMAGE-FEED-1</RequestId></Body></SuccessResponse>'
      };
    }
    return {
      status: 200,
      data: '<SuccessResponse><Body><RequestId>PRODUCT-FEED-WARN</RequestId></Body></SuccessResponse>'
    };
  };

  try {
    const result = await adapter.publish({
      sku: 'SKU-1',
      productName: 'Producto real',
      brand: 'Marca real',
      price: 14990,
      stock: 2,
      PrimaryCategory: '1234',
      description: 'Descripcion real',
      package_height: 20,
      package_width: 15,
      package_length: 30,
      package_weight: 1,
      attributes: [
        { id: 'ConditionType', value_name: 'Nuevo', value: 'Nuevo' }
      ],
      images: ['https://example.com/1.jpg']
    });

    assert.equal(result.success, true);
    assert.equal(result.has_warnings, true);
    assert.equal(result.data.feed_confirmed, true);
    assert.equal(result.data.image_upload.success, true);
    assert.equal(result.data.image_upload.request_id, 'IMAGE-FEED-1');
    assert.ok(postedUrls.some((url) => url.includes('Action=ProductCreate')));
    assert.ok(postedUrls.some((url) => url.includes('Action=Image')));
  } finally {
    axios.post = originalPost;
  }
});

test('FalabellaAdapter: ProductCreate falla si FeedStatus inmediato termina con FeedErrors', async () => {
  const adapter = createAdapter();
  const originalPost = axios.post;

  adapter.ensureValidCredentials = async () => ({ valid: true });
  adapter.hydrateAttributesForPublish = async (product) => product;
  adapter.findExistingProductBySellerSku = async () => null;
  adapter.pollFeedStatus = async () => ({
    timedOut: false,
    feed: {
      FeedID: 'PRODUCT-FEED-FAILED',
      Status: 'Finished',
      Action: 'ProductCreate',
      TotalRecords: '1',
      ProcessedRecords: '1',
      FailedRecords: '1',
      FeedErrors: {
        Error: {
          Code: '0',
          Message: 'El Peso del producto empacado (kg) debe estar entre 0.015 kg y 15 kg para esta categoría.',
          SellerSku: 'SKU-1'
        }
      }
    }
  });

  axios.post = async () => ({
    status: 200,
    data: '<SuccessResponse><Body><RequestId>PRODUCT-FEED-FAILED</RequestId></Body></SuccessResponse>'
  });

  try {
    const result = await adapter.publish({
      sku: 'SKU-1',
      productName: 'Producto real',
      brand: 'Marca real',
      price: 14990,
      stock: 2,
      PrimaryCategory: '1234',
      description: 'Descripcion real',
      package_height: 20,
      package_width: 15,
      package_length: 30,
      package_weight: 0.002,
      attributes: [
        { id: 'ConditionType', value_name: 'Nuevo', value: 'Nuevo' }
      ],
      images: ['https://example.com/1.jpg']
    });

    assert.equal(result.success, false);
    assert.equal(result.details.error_code, 'feed_failed');
    assert.equal(result.data.feed_id, 'PRODUCT-FEED-FAILED');
    assert.equal(result.data.failed_records, 1);
    assert.match(result.error, /Peso del producto empacado/);
    assert.equal(result.data.errors[0].sku, 'SKU-1');
  } finally {
    axios.post = originalPost;
  }
});

test('FalabellaAdapter: fetchFeedStatus parsea FeedStatus oficial', async () => {
  const adapter = createAdapter();
  const originalGet = axios.get;

  axios.get = async () => ({
    data: {
      SuccessResponse: {
        Body: {
          FeedDetail: {
            FeedID: 'FD-1',
            Status: 'Finished',
            Action: 'ProductCreate',
            TotalRecords: '1',
            ProcessedRecords: '1',
            FailedRecords: '0'
          }
        }
      }
    }
  });

  try {
    const feed = await adapter.fetchFeedStatus('FD-1');
    assert.equal(feed.ok, true);
    assert.equal(feed.FeedID, 'FD-1');
    assert.equal(feed.Status, 'Finished');
    assert.equal(feed.TotalRecords, '1');
  } finally {
    axios.get = originalGet;
  }
});

test('FalabellaTransformer: no inventa marca, precio, stock ni medidas', async () => {
  const originalFindMappings = MarketplaceRepository.findMappingsByMarketplace;
  MarketplaceRepository.findMappingsByMarketplace = async () => [];

  try {
    const [transformed] = await MarketplaceTransformerFalabella.transformProducts([
      {
        sku: 'SKU-1',
        name: 'Nombre real',
        title: 'Nombre real',
        price: 1234,
        stock: 2,
        category_id: '1234',
        description: 'Descripción real',
        images: ['https://example.com/image.jpg']
      }
    ], 1);

    assert.equal(transformed.brand, null);
    assert.equal(transformed.description, 'Descripción real');
    assert.equal(transformed.price, 1234);
    assert.equal(transformed.stock, 2);
    assert.equal(transformed.package_height, null);
    assert.equal(transformed.package_width, null);
    assert.equal(transformed.package_length, null);
    assert.equal(transformed.package_weight, null);
  } finally {
    MarketplaceRepository.findMappingsByMarketplace = originalFindMappings;
  }
});
