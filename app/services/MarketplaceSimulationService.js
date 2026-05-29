const { getMercadoLibreSiteId } = require('../util/marketplaceUtil');
const ProductMarketplaceLinkRepository = require('../repositories/ProductMarketplaceLinkRepository');

function toFiniteNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function buildMercadoLibreExternalId(productId, credentialId, siteId) {
  const numericSuffix = 900000000 + (toFiniteNumber(productId) * 100) + toFiniteNumber(credentialId);
  const suffix = String(Math.trunc(numericSuffix)).padStart(9, '0').slice(-9);
  return `${siteId}${suffix}`;
}

function buildMercadoLibrePermalink(siteId, externalId) {
  const numeric = String(externalId || '').replace(/^[A-Z]+/, '');
  return `https://articulo.mercadolibre.cl/${siteId}-${numeric}`;
}

function normalizePublishedStock(productData) {
  const directFields = [
    productData?.available_quantity,
    productData?.stock,
    productData?.publishStock,
    productData?.initial_quantity,
    productData?.totalPublishingStock,
    productData?.totalStock
  ];

  for (const value of directFields) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.round(parsed);
    }
  }

  const variants = Array.isArray(productData?.variants) ? productData.variants : [];
  if (variants.length === 0) return null;

  const totals = variants
    .map((variant) => {
      const value = variant?.publishStock ?? variant?.stock ?? variant?.totalStock ?? variant?.available_quantity ?? variant?.quantity;
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
    })
    .filter((value) => value !== null);

  if (totals.length === 0) return null;
  return totals.reduce((sum, value) => sum + value, 0);
}

function resolveTitle(productData) {
  return String(
    productData?.name ||
    productData?.title ||
    productData?.family_name ||
    `Producto ${productData?.id || 'sin-id'}`
  ).trim();
}

function resolvePrice(productData) {
  return toFiniteNumber(
    productData?.sale_price ??
    productData?.price ??
    productData?.purchase_price ??
    0,
    0
  );
}

function resolveQuantity(productData) {
  const variantStocks = Array.isArray(productData?.variants)
    ? productData.variants.map(v => toFiniteNumber(v?.publishStock ?? v?.stock ?? v?.totalStock ?? 0)).filter(n => n > 0)
    : [];

  if (variantStocks.length > 0) {
    return variantStocks.reduce((acc, value) => acc + value, 0);
  }

  const direct = toFiniteNumber(
    productData?.totalStock ??
    productData?.stock ??
    productData?.available_quantity ??
    1,
    1
  );

  return Math.max(1, direct);
}

function buildPictures(productData, externalId) {
  const images = Array.isArray(productData?.images) ? productData.images : [];

  if (images.length === 0) {
    return [{
      id: `${externalId}-1`,
      url: `https://spree.local/assets/products/${productData?.id || 'placeholder'}.jpg`,
      secure_url: `https://spree.local/assets/products/${productData?.id || 'placeholder'}.jpg`
    }];
  }

  return images.map((image, index) => {
    const url = typeof image === 'string'
      ? image
      : image?.url || image?.secure_url || `https://spree.local/assets/products/${productData?.id || 'placeholder'}.jpg`;

    return {
      id: `${externalId}-${index + 1}`,
      url,
      secure_url: image?.secure_url || url
    };
  });
}

function buildMercadoLibreItem({ productData, marketplace, credential, warehouse, externalId, siteId }) {
  const now = new Date().toISOString();
  const title = resolveTitle(productData);
  const price = resolvePrice(productData);
  const availableQuantity = resolveQuantity(productData);
  const sellerId = toFiniteNumber(
    credential?.seller_id ||
    credential?.additional_data?.ml_user_id ||
    marketplace?.seller_id ||
    0,
    0
  ) || 806466768;

  return {
    id: externalId,
    site_id: siteId,
    title,
    subtitle: null,
    seller_id: sellerId,
    category_id: String(productData?.category_id || 'MLC-UNCLASSIFIED_PRODUCTS'),
    official_store_id: null,
    price,
    base_price: price,
    original_price: null,
    currency_id: 'CLP',
    initial_quantity: availableQuantity,
    available_quantity: availableQuantity,
    sold_quantity: 0,
    buying_mode: 'buy_it_now',
    listing_type_id: 'gold_special',
    start_time: now,
    stop_time: null,
    condition: String(productData?.condition || 'new').toLowerCase(),
    permalink: buildMercadoLibrePermalink(siteId, externalId),
    pictures: buildPictures(productData, externalId),
    video_id: null,
    descriptive_sale_terms: [],
    non_mercado_pago_payment_methods: [],
    shipping: {
      mode: 'me2',
      local_pick_up: true,
      free_shipping: false,
      logistic_type: 'drop_off',
      store_pick_up: false
    },
    international_delivery_mode: 'none',
    seller_address: null,
    seller_contact: null,
    location: null,
    coverage_areas: [],
    attributes: [],
    warnings: [],
    status: 'active',
    tags: [
      'test_item',
      'immediate_payment',
      'local_pick_up'
    ],
    warranty: productData?.warranty_text || null,
    catalog_product_id: null,
    domain_id: null,
    warehouse_id: warehouse?.id || null,
    company_id: warehouse?.company_id || null,
    branch_id: warehouse?.branch_id || null,
    credential_id: credential?.id || null,
    marketplace_id: marketplace?.marketplace_id || marketplace?.id || null
  };
}

async function persistMercadoLibreSimulationLink({ productData, marketplace, credential, warehouse, externalId, externalUrl, data }) {
  if (!productData?.id || !marketplace?.marketplace_id || !credential?.id) {
    return null;
  }

  const publishedStock = normalizePublishedStock(data || productData);

  return await ProductMarketplaceLinkRepository.upsert({
    product_id: productData.id,
    marketplace_id: marketplace.marketplace_id,
    credential_id: credential.id,
    company_id: warehouse?.company_id || productData?.company_id || null,
    branch_id: warehouse?.branch_id || productData?.branch_id || null,
    status: 'published',
    external_id: externalId,
    external_url: externalUrl,
    published_stock: publishedStock,
    published_payload: data,
    last_synced_at: new Date()
  });
}

async function buildMercadoLibreSimulationResponse({ productData, marketplace, credential, warehouse, persist_link = true }) {
  const siteId = getMercadoLibreSiteId(
    credential?.country || marketplace?.country || null,
    marketplace?.domain || marketplace?.marketplace?.domain || null
  );
  const externalId = buildMercadoLibreExternalId(productData?.id, credential?.id, siteId);
  const data = buildMercadoLibreItem({
    productData,
    marketplace,
    credential,
    warehouse,
    externalId,
    siteId
  });

  if (persist_link) {
    await persistMercadoLibreSimulationLink({
      productData,
      marketplace,
      credential,
      warehouse,
      externalId,
      externalUrl: data.permalink,
      data
    });
  }

  return {
    success: true,
    external_id: externalId,
    external_url: data.permalink,
    data,
    published_stock: normalizePublishedStock(data),
    published_payload: data,
    simulated: true
  };
}

module.exports = {
  buildMercadoLibreSimulationResponse,
  persistMercadoLibreSimulationLink
};
