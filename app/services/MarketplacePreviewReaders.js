'use strict';

const axios = require('axios');
const logger = require('../../config/logger');
const PublishingAdapterFactory = require('./adapters/PublishingAdapterFactory');

const ML_API = 'https://api.mercadolibre.com';
const FALABELLA_API = 'https://sellercenter-api.falabella.com';
const DEFAULT_TIMEOUT = 30000;

const sleep = (milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds));

function errorData(error) {
  return {
    code: error?.code || null,
    status: error?.response?.status || null,
    message: error?.response?.data?.message || error?.message || 'Error de marketplace'
  };
}

async function requestWithRetry(request, { retries = 2 } = {}) {
  let attempt = 0;

  while (true) {
    try {
      return await request();
    } catch (error) {
      const status = Number(error?.response?.status);
      const retryable = status === 429 || [500, 502, 503, 504].includes(status)
        || ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN'].includes(error?.code);

      if (!retryable || attempt >= retries) throw error;

      const retryAfter = Number(error?.response?.headers?.['retry-after']);
      const waitMs = Number.isFinite(retryAfter)
        ? Math.min(retryAfter * 1000, 10000)
        : Math.min(500 * (2 ** attempt), 5000);

      await sleep(waitMs);
      attempt += 1;
    }
  }
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const result = new Array(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, values.length || 1)) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      result[index] = await mapper(values[index], index);
    }
  });

  await Promise.all(workers);
  return result;
}

function asArray(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstValue(...values) {
  return values.find(value => value !== undefined && value !== null && value !== '');
}

function readSku(attributes) {
  const skuAttribute = asArray(attributes).find(attribute => {
    const id = String(attribute?.id || attribute?.name || '').trim().toUpperCase();
    return id === 'SELLER_SKU' || id === 'SELLER SKU';
  });

  return String(firstValue(
    skuAttribute?.value_name,
    skuAttribute?.value_id,
    skuAttribute?.value
  ) || '').trim() || null;
}

function mapMercadoLibreVariation(variation) {
  const attributes = variation?.attributes || [];
  return {
    id: variation?.id != null ? String(variation.id) : null,
    sku: readSku(attributes),
    attributes,
    available_quantity: numberOrNull(variation?.available_quantity),
    inventory_id: variation?.inventory_id || null,
    user_product_id: variation?.user_product_id || null,
    price: numberOrNull(variation?.price)
  };
}

function findRecursiveCollection(value, names) {
  if (!value || typeof value !== 'object') return null;
  for (const name of names) {
    if (value[name] !== undefined) {
      const candidate = value[name];
      if (Array.isArray(candidate)) return candidate;
      if (candidate && typeof candidate === 'object') return [candidate];
    }
  }

  for (const child of Object.values(value)) {
    const found = findRecursiveCollection(child, names);
    if (found) return found;
  }
  return null;
}

function collectRecursiveCollections(value, names, result = []) {
  if (!value || typeof value !== 'object') return result;
  for (const name of names) {
    if (value[name] !== undefined) {
      const candidate = value[name];
      if (Array.isArray(candidate)) result.push(...candidate);
      else if (candidate && typeof candidate === 'object') result.push(candidate);
    }
  }
  for (const child of Object.values(value)) {
    collectRecursiveCollections(child, names, result);
  }
  return result;
}

function falabellaTimestampUtc() {
  return new Date().toISOString();
}

function falabellaBody(payload) {
  return payload?.SuccessResponse?.Body
    || payload?.successResponse?.Body
    || payload?.Body
    || payload?.body
    || payload;
}

function logEnrichmentResponse(marketplace, endpoint, response) {
  logger.info(`[MarketplacePreview][${marketplace}] Respuesta de enriquecimiento`, {
    endpoint,
    response
  });
}

class MercadoLibrePreviewReader {
  constructor({ credential, companyId, userId }) {
    this.credential = credential;
    this.companyId = companyId;
    this.userId = userId;
    this.adapter = null;
    this.sellerId = null;
    this.siteId = null;
    this.itemCache = new Map();
    this.descriptionCache = new Map();
    this.pricesCache = new Map();
    this.salePriceCache = new Map();
    this.userProductCache = new Map();
    this.familyCache = new Map();
    this.familyMembersCache = new Map();
    this.stockCache = new Map();
    this.fulfillmentCache = new Map();
    this.logEnrichmentResponses = false;
  }

  async initialize() {
    this.adapter = PublishingAdapterFactory.getAdapter(
      this.credential.marketplace,
      this.companyId,
      null,
      this.userId,
      this.credential
    );
    const validation = await this.adapter.ensureValidCredentials();
    if (!validation?.valid) {
      const error = new Error(validation?.message || 'La credencial de Mercado Libre requiere autorización');
      error.code = validation?.error || 'mercadolibre_auth_required';
      throw error;
    }

    this.credential = this.adapter.credential || this.credential;
    this.siteId = this.resolveSiteId();

    const currentUser = await this.request('/users/me');
    this.sellerId = String(currentUser?.id || this.credential.seller_id || '').trim();
    if (!this.sellerId) throw new Error('mercadolibre_seller_id_missing');
  }

  resolveSiteId() {
    const configured = this.credential?.additional_data?.site_id;
    if (configured) return String(configured).trim().toUpperCase();

    const domain = String(this.credential?.marketplace?.domain || '').toLowerCase();
    const country = String(this.credential?.country || '').toLowerCase();
    const map = {
      'mercadolibre.cl': 'MLC',
      'mercadolibre.com.ar': 'MLA',
      'mercadolibre.com.mx': 'MLM',
      'mercadolibre.com.co': 'MCO',
      'mercadolibre.com.br': 'MLB',
      cl: 'MLC',
      ar: 'MLA',
      mx: 'MLM',
      co: 'MCO',
      br: 'MLB'
    };

    return Object.entries(map).find(([key]) => domain.includes(key))?.[1] || map[country] || null;
  }

  async request(path, params = {}) {
    const responseData = await requestWithRetry(async () => {
      const response = await axios.get(`${ML_API}${path}`, {
        params,
        headers: {
          Authorization: `Bearer ${this.credential.access_token}`,
          Accept: 'application/json'
        },
        timeout: DEFAULT_TIMEOUT
      });
      return response.data;
    });

    if (this.logEnrichmentResponses) {
      logEnrichmentResponse('mercado_libre', path, responseData);
    }

    return responseData;
  }

  async *enumerate({ pageSize = 100 } = {}) {
    if (!this.siteId) throw new Error('mercadolibre_site_id_missing');

    const limit = Math.min(Math.max(Number(pageSize) || 100, 1), 100);
    const firstPage = await this.request(`/users/${this.sellerId}/items/search`, {
      limit,
      offset: 0
    });
    const total = numberOrNull(firstPage?.paging?.total);
    const firstResults = asArray(firstPage?.results);

    if (total !== null && total > 1000) {
      const scanPage = await this.request(`/users/${this.sellerId}/items/search`, {
        search_type: 'scan',
        limit
      });
      const scanResults = [...new Set(asArray(scanPage?.results).map(String).filter(Boolean))];
      let scrollId = scanPage?.scroll_id || null;
      let noProgress = scanResults.length ? 0 : 1;
      const seen = new Set(scanResults);
      const allIds = [...scanResults];

      while (scrollId && noProgress < 2) {
        const page = await this.request(`/users/${this.sellerId}/items/search`, {
          search_type: 'scan',
          limit,
          scroll_id: scrollId
        });
        const ids = asArray(page?.results).map(String);
        const newIds = ids.filter(id => !seen.has(id));
        newIds.forEach(id => seen.add(id));
        noProgress = newIds.length ? 0 : noProgress + 1;
        allIds.push(...newIds);
        scrollId = page?.scroll_id || null;
      }

      // El scroll_id de ML expira; se termina la enumeración antes de iniciar
      // las llamadas costosas de descripción, precios, familias y stock.
      for (let index = 0; index < allIds.length; index += limit) {
        const ids = allIds.slice(index, index + limit);
        yield {
          items: await this.getBulkItems(ids),
          total,
          checkpoint: { mode: 'scan', offset: index + ids.length, completed: index + ids.length >= allIds.length }
        };
      }
      return;
    }

    let offset = 0;
    let page = firstPage;
    const seenIds = new Set();
    while (true) {
      const ids = asArray(page?.results).map(String);
      if (!ids.length) return;
      const newIds = ids.filter(id => !seenIds.has(id));
      newIds.forEach(id => seenIds.add(id));
      if (!newIds.length) return;

      yield {
        items: await this.getBulkItems(newIds),
        total,
        checkpoint: { mode: 'offset', offset: offset + ids.length }
      };

      offset += ids.length;
      if ((total !== null && offset >= total) || ids.length < limit) return;

      page = await this.request(`/users/${this.sellerId}/items/search`, {
        limit,
        offset
      });
    }
  }

  async getBulkItems(ids) {
    const uniqueIds = [...new Set(ids.map(String).filter(Boolean))];
    const result = [];

    for (let index = 0; index < uniqueIds.length; index += 20) {
      const chunk = uniqueIds.slice(index, index + 20);
      const response = await this.request('/items/bulk', {
        ids: chunk.join(','),
        attributes: 'body.id,body.title,body.subtitle,body.price,body.currency_id,body.available_quantity,body.status,body.permalink,body.pictures,body.attributes,body.variations,body.listing_type_id,body.condition,body.category_id,body.seller_id,body.user_product_id,body.inventory_id,body.shipping,body.tags'
      });
      for (const entry of asArray(response)) {
        if (entry?.body && entry?.status_code >= 400) {
          result.push({ id: entry.id, _bulk_error: { status: entry.status_code, body: entry.body } });
        } else if (entry?.body) {
          result.push(entry.body);
        } else if (entry?.id) {
          result.push(entry);
        }
      }
    }

    return result;
  }

  async cached(cache, key, loader) {
    if (!key) return null;
    if (!cache.has(key)) cache.set(key, loader());
    try {
      return await cache.get(key);
    } catch (error) {
      cache.delete(key);
      throw error;
    }
  }

  async getItemDetail(id) {
    return this.cached(this.itemCache, id, () => this.request(`/items/${id}`, { include_attributes: 'all' }));
  }

  async getDescription(id) {
    return this.cached(this.descriptionCache, id, () => this.request(`/items/${id}/description`));
  }

  async getPrices(id) {
    return this.cached(this.pricesCache, id, () => this.request(`/items/${id}/prices`));
  }

  async getSalePrice(id) {
    return this.cached(this.salePriceCache, id, () => this.request(`/items/${id}/sale_price`, {
      context: 'channel_marketplace'
    }));
  }

  async getUserProduct(id) {
    return this.cached(this.userProductCache, id, () => this.request(`/user-products/${id}`));
  }

  async getFamily(id) {
    return this.cached(this.familyCache, id, () => this.request(`/user-products-families/${id}`));
  }

  async getFamilyMembers(id) {
    return this.cached(this.familyMembersCache, id, () => this.request(`/user-products-families/${id}/user-products`));
  }

  async getUserProductStock(id) {
    return this.cached(this.stockCache, id, () => this.request(`/user-products/${id}/stock`));
  }

  async getFulfillmentStock(id) {
    return this.cached(this.fulfillmentCache, id, () => this.request(`/inventories/${id}/stock/fulfillment`));
  }

  normalizeItem(item) {
    const variations = asArray(item?.variations).map(mapMercadoLibreVariation);
    const sku = readSku(item?.attributes) || variations.find(variation => variation.sku)?.sku || null;
    const images = asArray(item?.pictures).map(picture => ({
      id: picture?.id || null,
      url: picture?.secure_url || picture?.url || null
    })).filter(image => image.url);

    return {
      external_id: item?.id ? String(item.id) : null,
      external_variant_id: null,
      sku,
      name: item?.title || null,
      description: null,
      images,
      attributes: item?.attributes || [],
      price: numberOrNull(item?.price),
      stock: numberOrNull(item?.available_quantity),
      status: item?.status || null,
      permalink: item?.permalink || null,
      condition: item?.condition || null,
      category_id: item?.category_id || null,
      listing_type_id: item?.listing_type_id || null,
      inventory_id: item?.inventory_id || null,
      user_product_id: item?.user_product_id || null,
      variations,
      composition: {
        status: item?.is_kit === true || item?.kit || Array.isArray(item?.components) ? 'explicit_composite' : 'unknown',
        evidence: item?.is_kit === true || item?.kit || Array.isArray(item?.components)
          ? { is_kit: item?.is_kit === true, has_kit: Boolean(item?.kit), has_components: Array.isArray(item?.components) }
          : null
      },
      enrichment: {},
      source_payload: item,
      source: 'mercado_libre'
    };
  }

  readBaseItems(rawItems) {
    return rawItems.map(raw => this.normalizeItem(raw));
  }

  async safe(label, loader, errors) {
    try {
      return await loader();
    } catch (error) {
      errors.push({ source: label, ...errorData(error) });
      return null;
    }
  }

  async enrichItems(rawItems, options = {}) {
    const concurrency = Number(options.request_concurrency) || 2;
    this.logEnrichmentResponses = true;
    try {
      return await mapWithConcurrency(rawItems, concurrency, async (raw) => {
        const errors = [];
        const item = this.normalizeItem(raw);
        const itemId = item.external_id;

        if (!itemId) {
          item.errors = [{ source: 'item', code: 'external_id_missing', status: null, message: 'La publicación no tiene ID externo' }];
          return item;
        }

        if (item.variations.length > 0) {
          const detail = await this.safe('item_detail', () => this.getItemDetail(itemId), errors);
          if (detail) {
            Object.assign(item, this.normalizeItem(detail));
            item.external_id = itemId;
          }
        }

        const [description, prices, salePrice] = await Promise.all([
          options.include_descriptions === false ? null : this.safe('description', () => this.getDescription(itemId), errors),
          options.include_prices === false ? null : this.safe('prices', () => this.getPrices(itemId), errors),
          options.include_sale_price === false ? null : this.safe('sale_price', () => this.getSalePrice(itemId), errors)
        ]);

        item.description = description?.plain_text || description?.text || description?.description || null;
        item.enrichment.description = description;
        item.enrichment.prices = prices;
        item.enrichment.sale_price = salePrice;

        const userProductId = firstValue(
          raw?.user_product_id,
          item.user_product_id,
          item.variations.find(variation => variation.user_product_id)?.user_product_id
        );

        if (options.include_user_products !== false && userProductId) {
          const userProduct = await this.safe('user_product', () => this.getUserProduct(String(userProductId)), errors);
          item.enrichment.user_product = userProduct;

          const familyId = userProduct?.family_id || userProduct?.family?.id || null;
          if (options.include_family !== false && familyId) {
            item.enrichment.family = await this.safe('user_product_family', () => this.getFamily(String(familyId)), errors);
            if (options.include_family_members !== false) {
              item.enrichment.family_members = await this.safe(
                'user_product_family_members',
                () => this.getFamilyMembers(String(familyId)),
                errors
              );
            }
          }

          if (options.include_stock !== false) {
            item.enrichment.user_product_stock = await this.safe(
              'user_product_stock',
              () => this.getUserProductStock(String(userProductId)),
              errors
            );
          }
        }

        if (options.include_fulfillment !== false) {
          const inventoryIds = [...new Set([
            item.inventory_id,
            ...item.variations.map(variation => variation.inventory_id)
          ].filter(Boolean))];
          item.enrichment.fulfillment_stock = {};
          for (const inventoryId of inventoryIds) {
            const fulfillment = await this.safe(
              `fulfillment_stock:${inventoryId}`,
              () => this.getFulfillmentStock(String(inventoryId)),
              errors
            );
            item.enrichment.fulfillment_stock[inventoryId] = fulfillment;
          }
        }

        if (errors.length) item.errors = errors;
        return item;
      });
    } finally {
      this.logEnrichmentResponses = false;
    }
  }
}

class FalabellaPreviewReader {
  constructor({ credential, companyId, userId }) {
    this.credential = credential;
    this.companyId = companyId;
    this.userId = userId;
    this.adapter = null;
    this.contextPromise = null;
    this.logEnrichmentResponses = false;
  }

  async initialize() {
    this.adapter = PublishingAdapterFactory.getAdapter(
      this.credential.marketplace,
      this.companyId,
      null,
      this.userId,
      this.credential
    );
    const validation = await this.adapter.ensureValidCredentials();
    if (!validation?.valid) {
      const error = new Error(validation?.message || 'La credencial de Falabella está incompleta');
      error.code = 'falabella_auth_required';
      throw error;
    }
    this.credential = this.adapter.credential || this.credential;
  }

  async request(action, extraParams = {}) {
    const params = {
      Action: action,
      Format: 'JSON',
      Timestamp: falabellaTimestampUtc(),
      UserID: String(this.credential.seller_email).trim(),
      Version: '1.0',
      ...extraParams
    };
    const { canonicalQuery, signatureEncoded } = this.adapter.buildSignedQuery(params);
    const url = `${FALABELLA_API}?${canonicalQuery}&Signature=${signatureEncoded}`;

    const responseData = await requestWithRetry(async () => {
      const response = await axios.get(url, { timeout: DEFAULT_TIMEOUT, headers: { Accept: 'application/json' } });
      return response.data;
    });

    if (this.logEnrichmentResponses) {
      logEnrichmentResponse('falabella', action, responseData);
    }

    return responseData;
  }

  async getProductsPage({ limit, offset }) {
    const response = await this.request('GetProducts', {
      Filter: 'all',
      Limit: limit,
      Offset: offset
    });
    const body = falabellaBody(response);
    const products = findRecursiveCollection(body, ['Product', 'product']);
    return {
      products: products || [],
      total: numberOrNull(body?.TotalProducts || body?.totalProducts || body?.Total || body?.total)
    };
  }

  async *enumerate({ pageSize = 100 } = {}) {
    const limit = Math.min(Math.max(Number(pageSize) || 100, 1), 100);
    let offset = 0;
    let noProgress = 0;
    const seenIds = new Set();

    while (true) {
      const page = await this.getProductsPage({ limit, offset });
      if (!page.products.length) return;
      const pageIds = page.products.map(product => String(product?.ShopSku || product?.SellerSku || product?.ProductId || product?.sku || ''));
      const newProducts = page.products.filter((product, index) => {
        const id = pageIds[index];
        if (!id) return true;
        if (seenIds.has(id)) return false;
        seenIds.add(id);
        return true;
      });
      noProgress = newProducts.length ? 0 : noProgress + 1;
      if (noProgress >= 2) return;

      yield {
        items: newProducts,
        total: page.total,
        checkpoint: { mode: 'offset', offset: offset + page.products.length }
      };

      offset += page.products.length;
      if ((page.total !== null && offset >= page.total) || page.products.length < limit) return;
    }
  }

  async getWarehousePage({ limit, offset }) {
    const response = await this.request('GetWarehouse', { Limit: limit, Offset: offset });
    const body = falabellaBody(response);
    return {
      warehouses: findRecursiveCollection(body, ['Warehouse', 'warehouse']) || [],
      total: numberOrNull(body?.Total || body?.total || body?.TotalWarehouses || body?.totalWarehouses)
    };
  }

  async getWarehouses() {
    const rows = [];
    const limit = 100;
    let offset = 0;
    let noProgress = 0;
    const seenIds = new Set();
    while (true) {
      const page = await this.getWarehousePage({ limit, offset });
      if (!page.warehouses.length) break;
      const pageIds = page.warehouses.map(warehouse => String(warehouse?.sellerWarehouseId || warehouse?.SellerWarehouseId || warehouse?.nodeID || warehouse?.NodeID || ''));
      const newCount = pageIds.filter(id => id && !seenIds.has(id)).length;
      pageIds.filter(Boolean).forEach(id => seenIds.add(id));
      noProgress = newCount ? 0 : noProgress + 1;
      if (noProgress >= 2) break;
      rows.push(...page.warehouses);
      offset += page.warehouses.length;
      if ((page.total !== null && offset >= page.total) || page.warehouses.length < limit) break;
    }
    return rows;
  }

  async getStockPage({ limit, offset }) {
    const response = await this.request('GetStock', { Limit: limit, Offset: offset });
    const body = falabellaBody(response);
    return {
      stock: collectRecursiveCollections(body, ['Warehouse', 'warehouse']),
      total: numberOrNull(body?.Total || body?.total || body?.TotalStock || body?.totalStock)
    };
  }

  async getAllStock() {
    const rows = [];
    const limit = Number(process.env.FALABELLA_PREVIEW_STOCK_PAGE_SIZE) || 100;
    let offset = 0;
    let noProgress = 0;
    const seenKeys = new Set();
    while (true) {
      const page = await this.getStockPage({ limit, offset });
      if (!page.stock.length) break;
      const pageKeys = page.stock.map(stock => String(
        `${firstValue(stock?.SellerSku, stock?.sellerSku, stock?.SKU, stock?.sku) || ''}:` +
        `${firstValue(stock?.SellerWarehouseId, stock?.sellerWarehouseId, stock?.WarehouseId, stock?.warehouseId, stock?.FacilityId, stock?.facilityId) || ''}`
      ));
      const newCount = pageKeys.filter(key => key && !seenKeys.has(key)).length;
      pageKeys.filter(Boolean).forEach(key => seenKeys.add(key));
      noProgress = newCount ? 0 : noProgress + 1;
      if (noProgress >= 2) break;
      rows.push(...page.stock);
      offset += page.stock.length;
      if ((page.total !== null && offset >= page.total) || page.stock.length < limit) break;
    }
    return rows;
  }

  async loadContext() {
    if (!this.contextPromise) {
      this.contextPromise = Promise.allSettled([this.getWarehouses(), this.getAllStock()]).then(([warehouses, stock]) => ({
        warehouses: warehouses.status === 'fulfilled' ? warehouses.value : [],
        stock: stock.status === 'fulfilled' ? stock.value : [],
        errors: [warehouses, stock]
          .filter(result => result.status === 'rejected')
          .map(result => errorData(result.reason))
      }));
    }
    return this.contextPromise;
  }

  normalizeItem(product, context = { warehouses: [], stock: [] }) {
    const businessUnits = asArray(product?.BusinessUnits?.BusinessUnit || product?.businessUnits?.businessUnit);
    const variations = asArray(product?.Variations?.Variation || product?.variations?.variation).map(variation => ({
      id: firstValue(variation?.VariationId, variation?.variationId, variation?.Id, variation?.id) || null,
      sku: String(firstValue(variation?.SellerSku, variation?.sellerSku, variation?.SKU, variation?.sku) || '').trim() || null,
      attributes: variation?.Attributes || variation?.attributes || variation,
      price: numberOrNull(firstValue(variation?.Price, variation?.price)),
      stock: numberOrNull(firstValue(variation?.Stock, variation?.stock))
    }));
    const sellerSku = String(firstValue(product?.SellerSku, product?.sellerSku, product?.SKU, product?.sku) || '').trim() || null;
    const stockBySku = asArray(context.stock).filter(stock => {
      const sku = String(firstValue(stock?.SellerSku, stock?.sellerSku, stock?.SKU, stock?.sku) || '').trim();
      return sku === sellerSku;
    });
    const mainImage = firstValue(product?.MainImage, product?.mainImage);
    const images = asArray(
      product?.Images?.Image
      || product?.images?.image
      || product?.Images
      || product?.images
    )
      .map(image => typeof image === 'string' ? image : firstValue(image?.Url, image?.URL, image?.url, image?.MainImage))
      .concat(mainImage ? [mainImage] : [])
      .filter(Boolean)
      .filter((url, index, values) => values.indexOf(url) === index)
      .map(url => ({ url }));

    const selectedBusinessUnit = businessUnits[0] || {};
    return {
      external_id: String(firstValue(product?.ShopSku, product?.shopSku, product?.ProductId, product?.productId) || '').trim() || null,
      external_variant_id: null,
      sku: sellerSku,
      name: product?.Name || product?.name || null,
      description: product?.Description || product?.description || null,
      images,
      attributes: product?.ProductData || product?.productData || product?.Variation || product?.variation || {},
      price: numberOrNull(firstValue(selectedBusinessUnit?.Price, selectedBusinessUnit?.price, product?.Price, product?.price)),
      sale_price: numberOrNull(firstValue(
        selectedBusinessUnit?.SpecialPrice,
        selectedBusinessUnit?.specialPrice,
        selectedBusinessUnit?.SalePrice,
        selectedBusinessUnit?.salePrice,
        product?.SpecialPrice,
        product?.specialPrice,
        product?.SalePrice,
        product?.salePrice
      )),
      sale_start_date: firstValue(
        selectedBusinessUnit?.SaleStartDate,
        selectedBusinessUnit?.saleStartDate,
        selectedBusinessUnit?.SpecialFromDate,
        selectedBusinessUnit?.specialFromDate,
        product?.SaleStartDate,
        product?.saleStartDate
      ) || null,
      sale_end_date: firstValue(
        selectedBusinessUnit?.SaleEndDate,
        selectedBusinessUnit?.saleEndDate,
        selectedBusinessUnit?.SpecialToDate,
        selectedBusinessUnit?.specialToDate,
        product?.SaleEndDate,
        product?.saleEndDate
      ) || null,
      stock: numberOrNull(firstValue(selectedBusinessUnit?.Stock, selectedBusinessUnit?.stock, stockBySku[0]?.Quantity, stockBySku[0]?.quantity)),
      status: firstValue(selectedBusinessUnit?.Status, selectedBusinessUnit?.status, product?.Status, product?.status) || null,
      brand: product?.Brand || product?.brand || null,
      tax_class: firstValue(product?.TaxClass, product?.taxClass) || null,
      shop_sku: firstValue(product?.ShopSku, product?.shopSku) || null,
      seller_sku: sellerSku,
      product_id: firstValue(product?.ProductId, product?.productId) || null,
      primary_category: firstValue(product?.PrimaryCategory, product?.primaryCategory) || null,
      categories: firstValue(product?.Categories, product?.categories) || null,
      qc_status: firstValue(product?.QCStatus, product?.qcStatus) || null,
      is_published: numberOrNull(firstValue(
        selectedBusinessUnit?.IsPublished,
        selectedBusinessUnit?.isPublished,
        product?.isPublished,
        product?.IsPublished,
        product?.published
      )),
      content_score: numberOrNull(firstValue(product?.ContentScore, product?.contentScore)),
      operator_code: firstValue(selectedBusinessUnit?.OperatorCode, selectedBusinessUnit?.operatorCode) || null,
      available_to_sell: firstValue(selectedBusinessUnit?.AvailableToSell, selectedBusinessUnit?.availableToSell) || null,
      main_image: mainImage || null,
      url: product?.URL || product?.Url || product?.url || null,
      variations,
      business_units: businessUnits,
      stock_by_warehouse: stockBySku,
      warehouses: context.warehouses,
      composition: {
        status: product?.IsKit === true || product?.Kit || Array.isArray(product?.Components) ? 'explicit_composite' : 'unknown',
        evidence: product?.IsKit === true || product?.Kit || Array.isArray(product?.Components)
          ? { is_kit: product?.IsKit === true, has_kit: Boolean(product?.Kit), has_components: Array.isArray(product?.Components) }
          : null
      },
      enrichment: {
        warehouse_catalog: context.warehouses,
        stock_catalog: stockBySku
      },
      source_payload: product,
      source: 'falabella'
    };
  }

  readBaseItems(rawItems) {
    return rawItems.map(raw => this.normalizeItem(raw));
  }

  async enrichItems(rawItems) {
    this.logEnrichmentResponses = true;
    try {
      const context = await this.loadContext();
      return rawItems.map(raw => {
        const item = this.normalizeItem(raw, context);
        if (context.errors.length) item.errors = context.errors.map((error) => ({ source: 'falabella_stock_or_warehouse', ...error }));
        return item;
      });
    } finally {
      this.logEnrichmentResponses = false;
    }
  }
}

module.exports = {
  MercadoLibrePreviewReader,
  FalabellaPreviewReader,
  errorData
};
