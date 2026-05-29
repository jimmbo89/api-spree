const axios = require('axios');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const logger = require('../../config/logger');
const PublishingAdapterFactory = require('./adapters/PublishingAdapterFactory');
const {
  JobRepository,
  JobProductRepository,
  ProductMarketplaceLinkRepository,
  ProductPublishingTaskRepository,
  MarketplaceRepository,
  MarketplaceCredentialRepository,
  WarehouseRepository,
  WarehouseProductRepository,
  WarehouseProductVariantRepository,
  ProductVariantRepository
} = require('../repositories');

class MarketplaceStockSyncService {
  static async enqueueStockSync({
    productId,
    variantId,
    warehouseId,
    stock,
    sourceMarketplaceId,
    companyId,
    branchId
  }) {
    const links = await ProductMarketplaceLinkRepository.findByProduct(
      productId,
      companyId,
      branchId
    );

    const targets = (links || []).filter(
      (l) => Number(l.marketplace_id) !== Number(sourceMarketplaceId)
    );

    if (targets.length === 0) return null;

    let finalCompanyId = companyId || null;
    let finalBranchId = branchId || null;

    if (!finalCompanyId && warehouseId) {
      const warehouse = await WarehouseRepository.findById(warehouseId);
      finalCompanyId = warehouse?.company_id || null;
      finalBranchId = warehouse?.branch_id || null;
    }

    if (!finalCompanyId) {
      logger.warn('[StockSync] No company_id disponible, no se crea job');
      return null;
    }

    const stockValue = await this._resolveStock({
      productId,
      variantId,
      warehouseId,
      stock
    });

    const sku = await this._resolveSku(variantId);
    const jobProductsData = [];

    for (const link of targets) {
      const latestTask = await ProductPublishingTaskRepository.findLatestPublishedByProductMarketplaceAndCredential(
        productId,
        link.marketplace_id,
        link.credential_id
      );

      const credentialId = link.credential_id || latestTask?.credential_id || null;
      const externalId = link.external_id || latestTask?.external_id || null;
      const publishedPayload = link.published_payload || latestTask?.payload || null;
      let publishedStockLimit = this._resolvePublishedStockLimit(publishedPayload, sku);
      if (publishedStockLimit == null && link.published_stock != null) {
        publishedStockLimit = this._toNonNegativeInteger(link.published_stock);
      }
      const effectiveStock = this._capStockByPublishedLimit(stockValue, publishedStockLimit);

      if (!credentialId || !externalId) {
        logger.warn('[StockSync] Sin credential_id o external_id, se omite', {
          productId,
          marketplace_id: link.marketplace_id,
          credentialId,
          externalId
        });
        continue;
      }

      jobProductsData.push({
        product_id: productId,
        marketplace_id: link.marketplace_id,
        credential_id: credentialId,
        external_id: externalId,
        product_payload: {
          product_id: productId,
          variant_id: variantId,
          warehouse_id: warehouseId,
          stock: effectiveStock,
          source_stock: stockValue,
          published_stock_limit: publishedStockLimit,
          sku,
          external_id: externalId
        },
        marketplace_payload: {
          marketplace_id: link.marketplace_id,
          external_id: externalId
        },
        status: 'pending',
        attempt_count: 0
      });
    }

    if (jobProductsData.length === 0) {
      return null;
    }

    const job = await JobRepository.create({
      user_id: null,
      company_id: finalCompanyId,
      job_type: 'sync',
      status: 'pending',
      batch_id: uuidv4(),
      config: {
        source_marketplace_id: sourceMarketplaceId,
        warehouse_id: warehouseId,
        variant_id: variantId,
        stock: stockValue,
        company_id: finalCompanyId,
        branch_id: finalBranchId
      }
    });

    for (const data of jobProductsData) {
      await JobProductRepository.create({
        job_id: job.id,
        ...data
      });
    }

    return job;
  }

  static async processJobProduct(jobProduct, job) {
    const productPayload = jobProduct.product_payload || {};
    const marketplacePayload = jobProduct.marketplace_payload || {};

    const stock = Number(productPayload.stock);
    if (!Number.isInteger(stock) || stock < 0) {
      throw new Error('invalid_stock');
    }

    const externalId =
      productPayload.external_id ||
      jobProduct.external_id ||
      marketplacePayload.external_id;

    if (!externalId) {
      throw new Error('external_id_not_found');
    }

    const marketplace = await MarketplaceRepository.findById(jobProduct.marketplace_id);
    if (!marketplace) {
      throw new Error('marketplace_not_found');
    }

    const credential = await MarketplaceCredentialRepository.findById(jobProduct.credential_id);
    if (!credential) {
      throw new Error('credential_not_found');
    }

    const domain = marketplace.domain || '';
    if (domain.includes('mercadolibre')) {
      return await this._updateMercadoLibreStock({
        externalId,
        stock,
        sku: productPayload.sku || null,
        marketplace,
        credential,
        jobUserId: job?.user_id || null,
        jobConfig: job?.config || {}
      });
    }

    if (domain.includes('falabella')) {
      return await this._updateFalabellaStock({
        sku: productPayload.sku || externalId,
        stock,
        marketplace,
        credential
      });
    }

    throw new Error('marketplace_not_supported');
  }

  static async _updateMercadoLibreStock({
    externalId,
    stock,
    sku,
    marketplace,
    credential,
    jobUserId,
    jobConfig
  }) {
    const adapter = PublishingAdapterFactory.getAdapter(
      marketplace,
      jobConfig.company_id || null,
      jobConfig.branch_id || null,
      jobUserId,
      credential
    );

    if (!adapter || typeof adapter.ensureValidCredentials !== 'function') {
      throw new Error('adapter_not_found');
    }

    const status = await adapter.ensureValidCredentials();
    if (!status?.valid) {
      throw new Error('auth_required');
    }

    const accessToken = adapter.credential?.access_token;
    if (!accessToken) throw new Error('access_token_missing');

    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    };

    const itemRes = await axios.get(
      `https://api.mercadolibre.com/items/${externalId}`,
      { headers, timeout: 10000 }
    );

    const variations = Array.isArray(itemRes.data?.variations)
      ? itemRes.data.variations
      : [];

    if (variations.length > 0) {
      const updatedVariations = variations.map((v) => {
        const matchSku =
          sku &&
          (String(v.seller_custom_field || v.seller_sku || '') === String(sku));
        return {
          id: v.id,
          available_quantity: matchSku ? stock : v.available_quantity
        };
      });

      await axios.put(
        `https://api.mercadolibre.com/items/${externalId}`,
        { variations: updatedVariations },
        { headers, timeout: 10000 }
      );
      return { success: true };
    }

    await axios.put(
      `https://api.mercadolibre.com/items/${externalId}`,
      { available_quantity: stock },
      { headers, timeout: 10000 }
    );

    return { success: true };
  }

  static async _updateFalabellaStock({ sku, stock, marketplace, credential }) {
    const operatorCode = this._resolveFalabellaOperatorCode(
      credential?.country,
      marketplace?.domain
    );

    const timestamp = this._timestampMinus03();
    const params = {
      Action: 'ProductUpdate',
      Format: 'XML',
      Timestamp: timestamp,
      UserID: credential.seller_email.trim(),
      Version: '1.0'
    };

    const url = this._buildFalabellaSignedUrl(params, credential.api_key);

    const xmlPayload = `<?xml version="1.0" encoding="UTF-8"?>
<Request>
  <Product>
    <SellerSku>${this._escapeXml(String(sku))}</SellerSku>
    <BusinessUnits>
      <BusinessUnit>
        <OperatorCode>${this._escapeXml(operatorCode)}</OperatorCode>
        <Stock>${stock}</Stock>
      </BusinessUnit>
    </BusinessUnits>
    <ProductData />
  </Product>
</Request>`;

    const headers = {
      'Content-Type': 'application/xml; charset=UTF-8',
      'User-Agent': `${credential.seller_id || 'SC'}/Node/${process.versions.node}/STOCK_SYNC`
    };

    const response = await axios.post(url, xmlPayload, { headers, timeout: 15000 });

    const body = response.data || '';
    if (typeof body === 'string') {
      if (body.includes('<ErrorResponse>')) {
        throw new Error('falabella_update_failed');
      }
    }

    return { success: true };
  }

  static _resolveFalabellaOperatorCode(country, domain) {
    const code = (country || '').toLowerCase();
    if (code === 'pe') return 'fape';
    if (code === 'co') return 'faco';
    if (code === 'mx') return 'fame';
    if (domain && domain.includes('falabella.com.pe')) return 'fape';
    if (domain && domain.includes('falabella.com.co')) return 'faco';
    return 'facl';
  }

  static _timestampMinus03(date = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return (
      `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
      `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}-03:00`
    );
  }

  static _rfc3986Encode(str) {
    return encodeURIComponent(str).replace(/[!'()*]/g, (c) => {
      return `%${c.charCodeAt(0).toString(16).toUpperCase()}`;
    });
  }

  static _buildFalabellaSignedUrl(params, apiKey) {
    const sortedKeys = Object.keys(params).sort();
    const canonicalQuery = sortedKeys
      .map((k) => `${this._rfc3986Encode(k)}=${this._rfc3986Encode(String(params[k]))}`)
      .join('&');

    const signatureHex = crypto
      .createHmac('sha256', apiKey.trim())
      .update(canonicalQuery, 'utf8')
      .digest('hex');

    const signatureEncoded = this._rfc3986Encode(signatureHex);
    const urlQueryString = `${canonicalQuery}&Signature=${signatureEncoded}`;

    return `https://sellercenter-api.falabella.com/?${urlQueryString}`;
  }

  static _escapeXml(str) {
    if (typeof str !== 'string') return String(str || '');
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  static async _resolveStock({ productId, variantId, warehouseId, stock }) {
    if (Number.isInteger(stock) && stock >= 0) return stock;

    if (!warehouseId) return 0;

    const wp = await WarehouseProductRepository.findByWarehouseAndProduct(
      warehouseId,
      productId
    );
    if (!wp) return 0;

    const wv = await WarehouseProductVariantRepository.findByVariantAndWarehouseProduct(
      variantId,
      wp.id
    );
    return parseInt(wv?.stock || 0, 10) || 0;
  }

  static async _resolveSku(variantId) {
    if (!variantId) return null;
    const variant = await ProductVariantRepository.findById(variantId);
    return variant?.sku || null;
  }

  static _capStockByPublishedLimit(stock, publishedLimit) {
    const baseStock = Number(stock);
    if (!Number.isFinite(baseStock) || baseStock < 0) return 0;

    const limit = Number(publishedLimit);
    if (!Number.isFinite(limit) || limit < 0) {
      return Math.max(0, Math.round(baseStock));
    }

    return Math.max(0, Math.min(Math.round(baseStock), Math.round(limit)));
  }

  static _resolvePublishedStockLimit(payload, sku = null) {
    const source = this._normalizePayload(payload);
    if (!source) return null;

    const directFields = [
      source.publishStock,
      source.available_quantity,
      source.stock,
      source.initial_quantity,
      source.totalPublishingStock,
      source.totalStock
    ];

    for (const value of directFields) {
      const parsed = this._toNonNegativeInteger(value);
      if (parsed !== null) return parsed;
    }

    const variations = Array.isArray(source.variations)
      ? source.variations
      : Array.isArray(source.Variations)
        ? source.Variations
        : Array.isArray(source.items)
          ? source.items
          : [];

    if (variations.length === 0) {
      return null;
    }

    const normalizeSku = (value) => String(value || '').trim().toLowerCase();
    const normalizedSku = normalizeSku(sku);

    let matchingVariation = null;
    if (normalizedSku) {
      matchingVariation = variations.find((variation) => {
        const variationSku = normalizeSku(
          variation?.seller_custom_field ||
          variation?.seller_sku ||
          variation?.sellerSku ||
          variation?.sku ||
          variation?.SellerSku ||
          variation?.sellerSkuCode
        );
        return variationSku && variationSku === normalizedSku;
      }) || null;
    }

    if (!matchingVariation && variations.length === 1) {
      matchingVariation = variations[0];
    }

    if (!matchingVariation) {
      return null;
    }

    const variationFields = [
      matchingVariation.available_quantity,
      matchingVariation.stock,
      matchingVariation.publishStock,
      matchingVariation.initial_quantity,
      matchingVariation.totalStock,
      matchingVariation.quantity
    ];

    for (const value of variationFields) {
      const parsed = this._toNonNegativeInteger(value);
      if (parsed !== null) return parsed;
    }

    return null;
  }

  static _normalizePayload(payload) {
    if (!payload) return null;

    if (typeof payload === 'string') {
      try {
        return JSON.parse(payload);
      } catch (error) {
        return null;
      }
    }

    if (payload && typeof payload === 'object' && payload.payload && typeof payload.payload === 'object') {
      return payload.payload;
    }

    return payload && typeof payload === 'object' ? payload : null;
  }

  static _toNonNegativeInteger(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return null;
    return Math.round(parsed);
  }
}

module.exports = MarketplaceStockSyncService;
