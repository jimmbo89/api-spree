// src/services/adapters/FalabellaAdapter.js
const BaseAdapter = require('./BaseAdapter');
const axios = require('axios');
const crypto = require('crypto');
const { parseStringPromise, Builder } = require('xml2js');
const logger = require('../../../config/logger');
const { MarketplaceCredentialRepository } = require('../../repositories');
const MarketplaceTransformerFalabella = require('../MarketplaceTransformerFalabella');

class FalabellaAdapter extends BaseAdapter {
  static supportsCategoryPrediction() {
    return false;
  }

  static getTransformer() {
    return MarketplaceTransformerFalabella; // 🔑 Usar transformer específico
  }

  async ensureValidCredentials() {
    if (this.credential && this.credential.seller_email && this.credential.api_key) {
      return { valid: true };
    }

    // Si hay credentialId, buscar por ID específico
    if (this.credentialId) {
      if (typeof this.credentialId === 'object' && this.credentialId !== null) {
        this.credential = this.credentialId;
      } else {
        this.credential = await MarketplaceCredentialRepository.findById(this.credentialId);
      }
    } else if (this.companyId !== undefined && this.companyId !== null) {
      this.credential = await MarketplaceCredentialRepository.findByMarketplaceAndCompany(
        this.marketplaceId,
        this.companyId
      );
    }

    if (!this.credential || !this.credential.seller_email || !this.credential.api_key) {
      return {
        valid: false,
        auth_required: true,
        message: "Se requieren credenciales de Falabella (Seller Email y API Key)"
      };
    }

    return { valid: true };
  }

  // ✅ RFC 3986 encode (igual que en GetCategorySuggestion que funcionó)
  rfc3986Encode(str) {
    return encodeURIComponent(str)
      .replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  }

  // ✅ Timestamp en formato ISO 8601 con zona horaria -03:00 (Chile)
  timestampMinus03(date = new Date()) {
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
           `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}-03:00`;
  }

  // ✅ XML escaping seguro
  escapeXml(str) {
    if (typeof str !== 'string') return String(str || '');
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  coerceNumber(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') {
      const parsed = Number(value.trim().replace(',', '.'));
      return Number.isFinite(parsed) ? parsed : null;
    }
    if (typeof value === 'object' && value !== null && 'value' in value) {
      return this.coerceNumber(value.value);
    }
    return null;
  }

  toCentimeters(measurement) {
    if (!measurement) return null;
    const value = this.coerceNumber(measurement);
    if (value === null) return null;
    const unit = String(measurement?.unit || 'cm').toLowerCase();

    switch (unit) {
      case 'm': return value * 100;
      case 'mm': return value / 10;
      case 'in': return value * 2.54;
      case 'ft': return value * 30.48;
      case 'cm':
      default: return value;
    }
  }

  toKilograms(measurement) {
    if (!measurement) return null;
    const value = this.coerceNumber(measurement);
    if (value === null) return null;
    const unit = String(measurement?.unit || 'g').toLowerCase();

    switch (unit) {
      case 'kg': return value;
      case 'g': return value / 1000;
      case 'lb': return value * 0.453592;
      case 'oz': return value * 0.0283495;
      default: return value;
    }
  }

  resolvePackageMeasurements(productData) {
    const productMeasurements = productData?.product_measurements || {};
    const dimensions = productMeasurements?.dimensions || {};

    const heightFromMeasurements = this.toCentimeters(dimensions.height);
    const widthFromMeasurements = this.toCentimeters(dimensions.width);
    const lengthFromMeasurements = this.toCentimeters(dimensions.length ?? dimensions.depth);
    const weightFromMeasurements = this.toKilograms(productMeasurements?.weight);

    const legacyHeight = this.coerceNumber(productData?.height_cm);
    const legacyWidth = this.coerceNumber(productData?.width_cm);
    const legacyLength = this.coerceNumber(productData?.length_cm);
    const legacyWeightKg = productData?.weight_grams != null
      ? this.coerceNumber(productData.weight_grams) / 1000
      : null;

    return {
      package_height: heightFromMeasurements ?? legacyHeight ?? 10,
      package_width: widthFromMeasurements ?? legacyWidth ?? 10,
      package_length: lengthFromMeasurements ?? legacyLength ?? 10,
      package_weight: weightFromMeasurements ?? legacyWeightKg ?? 0.5
    };
  }

  buildSignedQuery(params) {
    const sortedKeys = Object.keys(params).sort();
    const canonicalQuery = sortedKeys
      .map(k => `${this.rfc3986Encode(k)}=${this.rfc3986Encode(String(params[k]))}`)
      .join('&');

    const signatureHex = crypto
      .createHmac('sha256', this.credential.api_key.trim())
      .update(canonicalQuery, 'utf8')
      .digest('hex');

    return {
      canonicalQuery,
      signatureHex,
      signatureEncoded: this.rfc3986Encode(signatureHex)
    };
  }

  toArray(value) {
    if (value === null || value === undefined) return [];
    return Array.isArray(value) ? value : [value];
  }

  normalizeFalabellaImages(images = []) {
    const flattened = [];

    const visit = (value) => {
      if (value === null || value === undefined) return;
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }

      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return;

        if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
          try {
            visit(JSON.parse(trimmed));
            return;
          } catch (error) {
            // Si no parsea, caer al string raw
          }
        }

        flattened.push(trimmed);
        return;
      }

      if (typeof value === 'object') {
        if (typeof value.fullUrl === 'string') {
          visit(value.fullUrl);
          return;
        }
        if (typeof value.url === 'string') {
          visit(value.url);
          return;
        }
        if (typeof value.src === 'string') {
          visit(value.src);
          return;
        }

        Object.values(value).forEach(visit);
      }
    };

    visit(images);

    return [...new Set(flattened)];
  }

  getFirstDefined(...values) {
    for (const value of values) {
      if (value !== null && value !== undefined) {
        if (Array.isArray(value)) {
          if (value.length > 0) return value[0];
          continue;
        }
        return value;
      }
    }
    return null;
  }

  resolveMarketplaceProductId(product) {
    const attributeProductId = Array.isArray(product?.attributes)
      ? product.attributes.find(attr => this.normalizeFalabellaText(attr?.id) === 'productid')
      : null;
    const categoryAttributeProductId = Array.isArray(product?.category_attributes)
      ? product.category_attributes.find(attr => this.normalizeFalabellaText(attr?.id || attr?.FeedName || attr?.Name) === 'productid')
      : null;

    const candidates = [
      attributeProductId?.value_name,
      attributeProductId?.value,
      attributeProductId?.value_id,
      categoryAttributeProductId?.value_name,
      categoryAttributeProductId?.value,
      categoryAttributeProductId?.value_id,
      product?.ProductId,
      product?.productIdentifier,
      product?.gtin,
      product?.ean,
      product?.upc,
      product?.isbn
    ];

    for (const candidate of candidates) {
      if (candidate === null || candidate === undefined) continue;
      const normalized = String(candidate).trim();
      if (!normalized) continue;
      if (normalized === String(product?.productId || '').trim()) continue;
      if (/^[0-9A-Za-z\-]{8,32}$/.test(normalized)) {
        return normalized;
      }
    }

    return null;
  }

  extractFeedNode(body) {
    if (!body || typeof body !== 'object') return null;

    return this.getFirstDefined(
      body.FeedDetail,
      body.Feed,
      body.Feeds?.FeedDetail,
      body.Feeds?.Feed,
      body.FeedDetails?.FeedDetail,
      body.FeedDetails?.Feed
    );
  }

  unwrapFeedSection(section) {
    if (!section || typeof section !== 'object' || Array.isArray(section)) {
      return section;
    }

    if (section.Error !== undefined) return section.Error;
    if (section.Errors !== undefined) return section.Errors;
    if (section.Warning !== undefined) return section.Warning;
    if (section.Warnings !== undefined) return section.Warnings;
    if (section.FeedError !== undefined) return section.FeedError;
    if (section.FeedErrors !== undefined) return section.FeedErrors;
    if (section.FeedWarning !== undefined) return section.FeedWarning;
    if (section.FeedWarnings !== undefined) return section.FeedWarnings;
    if (section.Item !== undefined) return section.Item;

    return section;
  }

  async parseFeedStatusResponse(responseData) {
    let parsed = responseData;

    if (typeof parsed === 'string') {
      const raw = parsed.trim();
      if (raw.startsWith('<')) {
        parsed = await parseStringPromise(raw, {
          explicitArray: false,
          trim: true
        });
      } else {
        try {
          parsed = JSON.parse(raw);
        } catch (error) {
          logger.warn(`[FalabellaAdapter] FeedStatus string no es XML ni JSON válido: ${raw.substring(0, 300)}`);
          return null;
        }
      }
    }

    const errorResponse = parsed?.ErrorResponse || parsed?.errorResponse || null;
    if (errorResponse) {
      const head = errorResponse.Head || errorResponse.head || {};
      const body = errorResponse.Body || errorResponse.body || null;

      return {
        ok: false,
        response_type: 'ErrorResponse',
        request_action: head.RequestAction || head.request_action || 'FeedStatus',
        error_type: head.ErrorType || head.error_type || null,
        error_code: head.ErrorCode || head.error_code || null,
        error_message: head.ErrorMessage || head.error_message || null,
        body,
        raw: parsed
      };
    }

    const success = parsed?.SuccessResponse || parsed?.successResponse || parsed;
    const body = success?.Body || success?.body || parsed?.Body || parsed?.body;
    const feedDetail = this.extractFeedNode(body);

    if (feedDetail) {
      return {
        ok: true,
        FeedID: this.getFirstDefined(feedDetail.Feed, feedDetail.FeedID, feedDetail.FeedId),
        Status: this.getFirstDefined(feedDetail.Status, feedDetail.FeedStatus),
        Action: this.getFirstDefined(feedDetail.Action, feedDetail.RequestAction),
        CreationDate: this.getFirstDefined(feedDetail.CreationDate, feedDetail.CreatedAt),
        UpdatedDate: this.getFirstDefined(feedDetail.UpdatedDate, feedDetail.UpdatedAt),
        Source: this.getFirstDefined(feedDetail.Source, feedDetail.Channel),
        TotalRecords: this.getFirstDefined(feedDetail.TotalRecords, feedDetail.TotalRecord, feedDetail.RecordsTotal),
        ProcessedRecords: this.getFirstDefined(feedDetail.ProcessedRecords, feedDetail.ProcessedRecord, feedDetail.RecordsProcessed),
        FailedRecords: this.getFirstDefined(feedDetail.FailedRecords, feedDetail.FailedRecord, feedDetail.RecordsFailed),
        FeedErrors: this.unwrapFeedSection(feedDetail.FeedErrors || feedDetail.Errors || feedDetail.Error),
        FeedWarnings: this.unwrapFeedSection(feedDetail.FeedWarnings || feedDetail.Warnings || feedDetail.Warning),
        raw: parsed
      };
    }

    logger.warn(`[FalabellaAdapter] FeedStatus respuesta no reconocida: ${JSON.stringify(parsed).substring(0, 1000)}`);
    return {
      ok: false,
      response_type: 'UnrecognizedResponse',
      error_message: null,
      raw: parsed
    };
  }

  async fetchFeedStatus(feedId) {
    const params = {
      Action: 'FeedStatus',
      FeedID: feedId,
      Format: 'JSON',
      Timestamp: this.timestampMinus03(),
      UserID: this.credential.seller_email.trim(),
      Version: '1.0'
    };

    const { canonicalQuery, signatureEncoded } = this.buildSignedQuery(params);
    const apiUrl = `https://sellercenter-api.falabella.com?${canonicalQuery}&Signature=${signatureEncoded}`;
    const response = await axios.get(apiUrl, { timeout: 15000 });
    const rawResponse = typeof response.data === 'string'
      ? response.data
      : JSON.stringify(response.data);

    logger.info(`[FalabellaAdapter] FeedStatus raw response (${feedId}):`);
    logger.info(rawResponse);

    const parsedFeed = await this.parseFeedStatusResponse(response.data);

    logger.info(`[FalabellaAdapter] FeedStatus parsed response (${feedId}):`);
    logger.info(JSON.stringify(parsedFeed));

    return parsedFeed;
  }

  async fetchProductsBySellerSku(sellerSku) {
    const normalizedSku = String(sellerSku || '').trim();
    if (!normalizedSku) {
      return [];
    }

    const params = {
      Action: 'GetProducts',
      Filter: 'all',
      Format: 'JSON',
      SellerSku: normalizedSku,
      Timestamp: this.timestampMinus03(),
      UserID: this.credential.seller_email.trim(),
      Version: '1.0'
    };

    const { canonicalQuery, signatureEncoded } = this.buildSignedQuery(params);
    const apiUrl = `https://sellercenter-api.falabella.com?${canonicalQuery}&Signature=${signatureEncoded}`;
    const response = await axios.get(apiUrl, { timeout: 15000 });

    const data = response.data;
    const body = data?.SuccessResponse?.Body
      || data?.successResponse?.Body
      || data?.Body
      || data?.body
      || data;

    const rawProducts = body?.Products?.Product
      || body?.Product
      || body?.products?.product
      || null;

    if (!rawProducts) {
      return [];
    }

    const products = Array.isArray(rawProducts) ? rawProducts : [rawProducts];
    return products
      .filter((product) => String(product?.SellerSku || product?.SKU || '').trim() === normalizedSku)
      .map((product) => ({
        sku: String(product?.SellerSku || product?.SKU || normalizedSku).trim(),
        name: product?.Name || null,
        brand: product?.Brand || null,
        primaryCategory: product?.PrimaryCategory || null,
        productId: product?.ProductId || null,
        status: Array.isArray(product?.BusinessUnits?.BusinessUnit)
          ? product.BusinessUnits.BusinessUnit[0]?.Status || null
          : product?.BusinessUnits?.BusinessUnit?.Status || null,
        raw: product
      }));
  }

  async findExistingProductBySellerSku(sellerSku) {
    try {
      const products = await this.fetchProductsBySellerSku(sellerSku);
      return products[0] || null;
    } catch (error) {
      logger.warn(
        `[FalabellaAdapter] No se pudo verificar si el SKU ${String(sellerSku || '').trim()} ya existe: ${error.message}`
      );
      return null;
    }
  }

  normalizeFeedMessages(items) {
    if (!items) return [];

    let list = this.toArray(items);

    if (list.length === 1 && list[0] && typeof list[0] === 'object' && !Array.isArray(list[0])) {
      const nested = this.unwrapFeedSection(list[0]);
      if (nested !== list[0]) {
        list = this.toArray(nested);
      }
    }

    return list
      .filter(Boolean)
      .map(item => {
        if (typeof item === 'string') {
          return { field: null, sku: null, message: item, value: null };
        }

        return {
          field: item.Field || item.Attribute || item.Name || null,
          sku: item.SellerSku || item.SKU || item.SellerSKU || null,
          message: item.Message || item.Error || item.Warning || item.Description || item.Detail || 'Sin detalle',
          value: item.Value || item.Code || null
        };
      });
  }

  async pollFeedStatus(feedId, options = {}) {
    const maxAttempts = Number(options.maxAttempts || process.env.FALABELLA_FEED_STATUS_MAX_ATTEMPTS || 10);
    const intervalMs = Number(options.intervalMs || process.env.FALABELLA_FEED_STATUS_INTERVAL_MS || 3000);
    let lastFeed = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      lastFeed = await this.fetchFeedStatus(feedId);

      const currentStatus = String(lastFeed?.Status || '').toLowerCase();
      logger.info(`[FalabellaAdapter] Feed ${feedId} intento ${attempt}/${maxAttempts}: ${currentStatus || 'unknown'}`);

      if (['finished', 'error', 'canceled'].includes(currentStatus)) {
        return { feed: lastFeed, timedOut: false };
      }

      if (attempt < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, intervalMs));
      }
    }

    return { feed: lastFeed, timedOut: true };
  }

  buildFeedDrivenResult({ transformedProduct, requestId, feed, timedOut, action = 'ProductCreate' }) {
    const feedStatus = feed?.Status || 'unknown';
    const warnings = this.normalizeFeedMessages(feed?.FeedWarnings);
    const errors = this.normalizeFeedMessages(feed?.FeedErrors);
    const processedRecords = parseInt(feed?.ProcessedRecords || '0', 10);
    const failedRecords = parseInt(feed?.FailedRecords || '0', 10);
    const totalRecords = parseInt(feed?.TotalRecords || '0', 10);
    const feedData = {
      id: transformedProduct.sku,
      request_id: requestId,
      feed_id: feed?.FeedID || requestId,
      feed_status: feedStatus,
      action: feed?.Action || action || 'ProductCreate',
      source: feed?.Source || 'api',
      total_records: totalRecords,
      processed_records: processedRecords,
      failed_records: failedRecords,
      category_id: transformedProduct.PrimaryCategory,
      category_name: transformedProduct.categoryName,
      warnings,
      errors
    };

    if (timedOut) {
      return {
        success: false,
        error: null,
        details: {
          error_code: 'feed_status_timeout',
          pending_review: true,
          feed: feedData
        },
        status_code: 202,
        external_id: transformedProduct.sku,
        data: feedData
      };
    }

    if (String(feedStatus).toLowerCase() === 'finished') {
      logger.info(`[FalabellaAdapter] Feed ${requestId} finalizado. Totales=${totalRecords} procesados=${processedRecords} fallidos=${failedRecords} warnings=${warnings.length} errors=${errors.length}`);

      if (failedRecords > 0 || errors.length > 0) {
        const errorMessage = errors.length > 0
          ? errors.map(item => item?.message).filter(Boolean).join(' | ')
          : null;

        return {
          success: false,
          error: errorMessage,
          details: {
            error_code: 'feed_failed',
            feed: feedData
          },
          external_id: transformedProduct.sku,
          data: feedData
        };
      }

      if (warnings.length > 0) {
        logger.warn(`[FalabellaAdapter] Producto publicado con advertencias confirmadas por FeedStatus`, warnings);
        return {
          success: true,
          external_id: transformedProduct.sku,
          has_warnings: true,
          warnings,
          data: feedData
        };
      }

      logger.info(`[FalabellaAdapter] Producto publicado exitosamente según FeedStatus`);
      return {
        success: true,
        external_id: transformedProduct.sku,
        data: feedData
      };
    }

    return {
      success: false,
      error: null,
      details: {
        error_code: 'feed_not_successful',
        feed: feedData
      },
      external_id: transformedProduct.sku,
      data: feedData
    };
  }
getFalabellaConfig(productData) {
  const falabellaConfigs = productData?.falabella;
  if (!falabellaConfigs || typeof falabellaConfigs !== 'object') {
    return null;
  }

  const candidateKeys = [
    this.credentialId,
    String(this.credentialId),
    Number.isFinite(Number(this.credentialId)) ? Number(this.credentialId) : null,
    this.marketplaceId,
    String(this.marketplaceId),
    Number.isFinite(Number(this.marketplaceId)) ? Number(this.marketplaceId) : null
  ].filter(value => value !== null && value !== undefined && value !== '');

  for (const key of candidateKeys) {
    if (Object.prototype.hasOwnProperty.call(falabellaConfigs, key)) {
      return falabellaConfigs[key];
    }
  }

  const configs = Object.values(falabellaConfigs).filter(item => item && typeof item === 'object');
  return configs[0] || null;
}

// ✅ Usar categoría marketplace-específica, no categoría general de Spree
getFalabellaCategory(productData) {
  const falabellaData = this.getFalabellaConfig(productData);
  if (!falabellaData) {
    return null;
  }

  const categoryId =
    falabellaData?.category?.category_id ||
    falabellaData?.category?.id ||
    falabellaData?.category_id ||
    null;

  if (!categoryId) {
    return null;
  }

  const categoryName =
    falabellaData?.category?.category_name ||
    falabellaData?.category?.name ||
    falabellaData?.category_name ||
    '';

  return {
    id: categoryId,
    name: categoryName
  };
}

// 🔑 NUEVO MÉTODO: Transformar imágenes a formato compatible con Falabella
// 🔑 MÉTODO COMPLETO: Transformar y normalizar imágenes a formato compatible con Falabella
_transformImages(images = []) {
  // ✅ Helper interno para normalizar una URL de imagen (igual que en frontend)
  const normalizeImageUrl = (url) => {
    if (!url || typeof url !== 'string') {
      return 'https://via.placeholder.com/600x600/e74c3c/ffffff?text=Error+URL';
    }
    
    url = url.trim();
    
    // ✅ Si ya es URL absoluta, retornarla tal cual
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return url;
    }
    
    // ✅ Obtener base URL desde variables de entorno o fallback
    const baseUrl = process.env.APP_URL || 'https://spree.api.klint.cl/api';
    
    // ✅ Remover slash inicial si existe
    if (url.startsWith('/')) {
      url = url.substring(1);
    }
    
    // ✅ Si la URL ya contiene la ruta de imágenes, construirla correctamente
    if (url.includes('warehouse_products/') || url.includes('products/')) {
      return `${baseUrl}/images/${url}`;
    }
    
    // ✅ Fallback: asumir que es una ruta relativa y prefijar con /images/
    return `${baseUrl}/images/${url}`;
  };

  // ✅ Validar entrada: si no es array, retornar array vacío
  if (!Array.isArray(images)) {
    return [];
  }
  
  // ✅ Procesar cada imagen: filtrar, normalizar y deduplicar
  const processed = images
    .filter(img => {
      // ✅ Filtrar null, undefined, strings vacíos o no-string
      return img && typeof img === 'string' && img.trim() !== '';
    })
    .map(img => {
      // ✅ Normalizar URL de cada imagen
      return normalizeImageUrl(img.trim());
    })
    .filter((url, index, self) => {
      // ✅ Eliminar duplicados manteniendo el orden original
      return self.indexOf(url) === index;
    });
  
  // ✅ Retornar máximo 10 imágenes (límite típico de marketplaces)
  return processed.slice(0, 10);
}
// ✅ Preparar producto con datos específicos de Falabella - VERSIÓN CORREGIDA
  async prepareProduct(productData) {
    // Extraer categoría de Falabella usando credentialId
    const category = this.getFalabellaCategory(productData);
    
    if (!category?.id) {
      throw new Error(`Categoría de Falabella no encontrada para el producto ${productData.id}.
        Debes asignar una categoría mediante la API de sugerencias primero.`);
    }

    // Obtener primer variante con precio válido para cálculos
    const validVariant = productData.variants?.find(v => v.price > 0 && v.publish) ||
                         productData.variants?.[0] ||
                         { price: productData.price || 0, publishStock: productData.stock || 0 };

    // 🔑🔑 EXTRAER ATRIBUTOS: Priorizar falabella[credentialId].attributes
    let attributes = [];
    
    const falabellaConfig = this.getFalabellaConfig(productData);
    if (falabellaConfig?.attributes && Array.isArray(falabellaConfig.attributes) && falabellaConfig.attributes.length > 0) {
      attributes = falabellaConfig.attributes.map(attr => ({
        id: attr.id,
        name: attr.name,
        value_id: attr.value_id,
        value_name: attr.value_name,
        value: attr.value_name || attr.value_id,
        example_value: attr.example_value || null
      }));
    }
    else if (falabellaConfig?.category?.attributes && Array.isArray(falabellaConfig.category.attributes) && falabellaConfig.category.attributes.length > 0) {
      attributes = falabellaConfig.category.attributes.map(attr => ({
        id: attr.id,
        name: attr.name,
        value_id: attr.value_id,
        value_name: attr.value_name,
        value: attr.value_name || attr.value_id,
        example_value: attr.example_value || null
      }));
    }

    const categoryAttributesResponse = await this.getCategoryAttributes(category.id);
    const categoryAttributes = Array.isArray(categoryAttributesResponse?.attributes)
      ? categoryAttributesResponse.attributes
      : [];
    const categoryAttributeMap = new Map(categoryAttributes.map(attr => [attr.id, attr]));

    attributes = attributes.map(attr => {
      const metadata = categoryAttributeMap.get(attr.id);
      return metadata ? { ...metadata, ...attr } : attr;
    });

    const packageMeasurements = this.resolvePackageMeasurements(productData);

    // 🔑 🔑 🔑 CORRECCIÓN: Buscar Brand en atributos ANTES de setear el campo brand
    const brandAttr = attributes.find(a => 
      a.id === 'Brand' || 
      this.normalizeFalabellaText(a.id) === 'brand' ||
      this.normalizeFalabellaText(a.name || '') === 'marca'
    );
    
    // Prioridad: 1) Atributo Brand del usuario, 2) productData.brand, 3) Genérica
    const resolvedBrand = (
      brandAttr?.value_name || 
      brandAttr?.value || 
      brandAttr?.value_id ||
      productData.brand || 
      'Genérica'
    ).trim();

    // 🔑 🔑 🔑 CORRECCIÓN: Buscar Name en atributos
    const nameAttr = attributes.find(a => 
      a.id === 'Name' || 
      this.normalizeFalabellaText(a.id) === 'name' ||
      this.normalizeFalabellaText(a.name || '') === 'nombre'
    );
    
    const resolvedName = (
      nameAttr?.value_name || 
      nameAttr?.value || 
      productData.name?.trim() || 
      'Producto sin nombre'
    );

    // 🔑 🔑 🔑 CORRECCIÓN: Buscar Description en atributos
    const descAttr = attributes.find(a => 
      a.id === 'Description' || 
      this.normalizeFalabellaText(a.id) === 'description' ||
      this.normalizeFalabellaText(a.name || '').includes('información del producto')
    );
    
    const resolvedDescription = (
      descAttr?.value_name || 
      descAttr?.value || 
      productData.description || 
      'Producto sin descripción'
    ).trim();

    const prepared = {
      sku: productData.sku || `PROD-${productData.id}`,
      productName: resolvedName,
      brand: resolvedBrand,  // ✅ AHORA USA EL ATRIBUTO DEL USUARIO
      price: validVariant.price > 0 ? validVariant.price : (productData.price || 0),
      stock: Math.max(0, Math.round(
        productData.totalPublishingStock ??
        productData.stock ??
        productData.totalStock ??
        validVariant.publishStock ??
        0
      )),
      PrimaryCategory: category.id,
      description: resolvedDescription,  // ✅ AHORA USA EL ATRIBUTO DEL USUARIO
      package_height: packageMeasurements.package_height,
      package_width: packageMeasurements.package_width,
      package_length: packageMeasurements.package_length,
      package_weight: packageMeasurements.package_weight,
      attributes: attributes,
      images: this._transformImages(productData.images || []),
      productId: productData.id,
      categoryName: category.name,
      category_attributes: categoryAttributes
    };

    prepared.attributes = this.buildFalabellaAttributes(prepared);
    prepared.images = this.normalizeFalabellaImages(prepared.images);

    const publishableVariants = Array.isArray(productData.variants)
      ? productData.variants.filter((variant) => variant && variant.publish && Number(variant.price) > 0)
      : [];
    const hasMultipleVariants = publishableVariants.length > 1;
    const hasVariationAttributes = Array.isArray(categoryAttributes)
      && categoryAttributes.some((attr) => this.isVariationAttribute(attr));
    const hasVariationFeedName = Array.isArray(categoryAttributes)
      && categoryAttributes.some((attr) => this.normalizeFalabellaText(attr?.feed_name || attr?.FeedName || attr?.id) === 'variation');
    const supportsMultiVariant = hasVariationAttributes && !hasVariationFeedName;

    if (hasMultipleVariants && supportsMultiVariant) {
      const variantStockTotal = publishableVariants.reduce((sum, variant) => {
        const quantity = Number(variant?.publishStock ?? variant?.totalStock ?? variant?.stock ?? 0);
        return sum + (Number.isFinite(quantity) && quantity > 0 ? quantity : 0);
      }, 0);

      const falabellaProducts = this.buildFalabellaVariantProducts(
        prepared,
        publishableVariants,
        categoryAttributes
      );

      if (falabellaProducts.length >= 2) {
        prepared.falabella_products = falabellaProducts;
        prepared.sku = falabellaProducts[0].sku;
        prepared.ParentSku = falabellaProducts[0].sku;
        prepared.stock = variantStockTotal > 0 ? variantStockTotal : prepared.stock;
        logger.info(`[FalabellaAdapter] Variantes listas para publicación: ${falabellaProducts.length} productos`);
      } else {
        throw new Error('No se pudieron construir variantes válidas para Falabella');
      }
    } else if (hasMultipleVariants && !supportsMultiVariant) {
      logger.info(`[FalabellaAdapter] La categoría ${category.id} no admite multivariantes; se publicará como producto simple`);
    }

    // ✅ Ajuste de precio por configuración económica (si aplica)
    if (productData.economic_config) {
      const config = productData.economic_config;
      
      if (config.allow_price_adjustment && config.min_margin && config.commission_rate) {
        const basePrice = Number(prepared.price) || 0;
        const commissionRate = Number(config.commission_rate) || 0;
        const minMargin = Number(config.min_margin) / 100;
        
        const currentMargin = 1 - commissionRate;
        
        if (currentMargin < minMargin && basePrice > 0) {
          const adjustedPrice = basePrice / (1 - commissionRate - minMargin);
          const roundedPrice = Math.ceil(adjustedPrice / 10) * 10;
          
          prepared.price = roundedPrice;
          
          logger.info(`[Falabella Adapter] 💰 Precio ajustado: $${basePrice} → $${roundedPrice} (margen: ${(minMargin * 100)}%)`);
        }
      }
    }

    logger.info(`[FalabellaAdapter] Producto preparado para publicación:\n ${JSON.stringify(prepared)}`);

    return prepared;
  }

  normalizeFalabellaAttributeValue(attr) {
    if (!attr) return '';

  const isOptionAttr =
    ['option', 'multi_option'].includes(attr?.attribute_type) ||
    ['dropdown', 'multiselect'].includes(
      String(attr?.input_type || '').toLowerCase()
    );

  // 🔑 Falabella ProductCreate espera LABEL visible
  // NO IDs internos
  let value;

  if (isOptionAttr) {
    value =
      attr?.value_name ??
      attr?.value ??
      '';
  } else {
    value =
      attr?.value ??
      attr?.value_name ??
      '';
  }

  if (
    value === null ||
    value === undefined
  ) {
    return '';
  }

  const values =
    Array.isArray(value)
      ? value
      : [value];

    return values
      .map(v => String(v ?? '').trim())
      .filter(Boolean)
      .join(', ');
  }

  normalizeFalabellaText(value) {
    return String(value ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();
  }

  getFalabellaProductText(product) {
    return [
      product?.sku,
      product?.productName,
      product?.name,
      product?.title,
      product?.description,
      product?.brand,
      product?.model
    ]
      .filter(Boolean)
      .map((value) => String(value).trim())
      .join(' ');
  }

  extractFalabellaMeasurementHint(product) {
    const text = this.getFalabellaProductText(product);
    const match = text.match(/(\d+(?:[.,]\d+)?)\s?(ml|mililitros?|l|litros?|kg|g|gr|gramos?|oz|onzas?|cm|mm|m)\b/i);
    if (!match) return null;

    const value = Number(String(match[1]).replace(',', '.'));
    if (!Number.isFinite(value)) return null;

    return {
      value,
      unit: this.normalizeFalabellaText(match[2])
    };
  }

  extractFalabellaCompatibilityHint(product) {
    const text = [
      product?.description,
      product?.productName,
      product?.name,
      product?.title
    ]
      .filter(Boolean)
      .map((value) => String(value).trim())
      .join(' ');
    const patterns = [
      /compatible\s+con\s+([^.;]+)/i,
      /para\s+impresoras?\s+([^.;]+)/i,
      /dise[ñn]ada\s+especificamente\s+para\s+([^.;]+)/i
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match?.[1]) {
        return String(match[1])
          .replace(/\s+\d+(?:[.,]\d+)?\s?(?:ml|l|kg|g|gr|gramos?|cm|mm|m)\b.*$/i, '')
          .trim();
      }
    }

    return null;
  }

  selectFalabellaOption(options, candidates = []) {
    if (!Array.isArray(options) || options.length === 0) return null;

    const normalizedCandidates = candidates
      .filter(Boolean)
      .map((candidate) => this.normalizeFalabellaText(candidate))
      .filter(Boolean);

    if (normalizedCandidates.length === 0) return null;

    const normalizedOptions = options.map((option) => ({
      raw: option,
      id: option?.id ?? option?.value_id ?? null,
      name: String(option?.name ?? option?.label ?? option?.value_name ?? '').trim(),
      normalized: this.normalizeFalabellaText(option?.name ?? option?.label ?? option?.value_name ?? option?.id)
    }));

    for (const candidate of normalizedCandidates) {
      const exactMatch = normalizedOptions.find((option) => option.normalized === candidate);
      if (exactMatch) return exactMatch.raw;

      const partialMatch = normalizedOptions.find((option) =>
        option.normalized.includes(candidate) || candidate.includes(option.normalized)
      );
      if (partialMatch) return partialMatch.raw;
    }

    return null;
  }

  inferFalabellaAttributeValue(attr, product) {
    if (!attr || !product) return null;

    const attrId = this.normalizeFalabellaText(attr.id || attr.FeedName || attr.Name || attr.Label);
    const attrLabel = this.normalizeFalabellaText(attr.name || attr.Label || attr.Name || attr.id);
    const options = Array.isArray(attr.values) ? attr.values : [];
    const measurementHint = this.extractFalabellaMeasurementHint(product);
    const compatibilityHint = this.extractFalabellaCompatibilityHint(product);
    const productCondition = this.normalizeFalabellaText(product.condition);
    const productBrand = String(product.brand || '').trim();
    const productModel = String(product.model || '').trim();
    const productGtin = String(product.gtin || product.ean || product.upc || product.isbn || '').trim();
    const packageWeight = Number(product.package_weight);
    const packageHeight = Number(product.package_height);
    const packageWidth = Number(product.package_width);
    const packageLength = Number(product.package_length);
    const packageWeightText = Number.isFinite(packageWeight) ? packageWeight : null;

    const optionOrText = (candidates, fallbackValue) => {
      const matched = this.selectFalabellaOption(options, candidates);
      if (matched) {
        return {
          id: attr.id || attr.FeedName || attr.Name,
          name: attr.name || attr.Label || attr.Name || attr.id,
          value_id: matched.id ?? matched.value_id ?? undefined,
          value_name: matched.name ?? matched.value_name ?? String(fallbackValue || '').trim()
        };
      }

      if (fallbackValue === null || fallbackValue === undefined) return null;
      const normalizedFallback = String(fallbackValue).trim();
      if (!normalizedFallback) return null;

      return {
        id: attr.id || attr.FeedName || attr.Name,
        name: attr.name || attr.Label || attr.Name || attr.id,
        value_name: normalizedFallback
      };
    };

    if (attrId.includes('brand') || attrLabel.includes('brand') || attrLabel.includes('marca')) {
      return optionOrText([productBrand], productBrand);
    }

    if (attrId.includes('model') || attrLabel.includes('model') || attrLabel.includes('modelo')) {
      return optionOrText([productModel, compatibilityHint], productModel || compatibilityHint);
    }

    if (attrId === 'conditiontype' || attrLabel.includes('condition') || attrLabel.includes('condicion')) {
      if (!productCondition) return null;
      const mappedCondition = productCondition === 'new' ? 'Nuevo' : 'Usado';
      return optionOrText([mappedCondition, productCondition], mappedCondition);
    }

    if (attrId.includes('unidaddemedida') || attrLabel.includes('unidad de medida')) {
      if (!measurementHint) return null;
      const unitAliasMap = {
        ml: ['mililitro', 'mililitros', 'ml'],
        l: ['litro', 'litros', 'l'],
        kg: ['kilogramo', 'kilogramos', 'kg'],
        g: ['gramo', 'gramos', 'g'],
        oz: ['onza', 'onzas', 'oz'],
        cm: ['centimetro', 'centimetros', 'cm'],
        mm: ['milimetro', 'milimetros', 'mm'],
        m: ['metro', 'metros', 'm']
      };
      const unitCandidates = unitAliasMap[measurementHint.unit] || [measurementHint.unit];
      return optionOrText(unitCandidates, unitCandidates[0]);
    }

    if (attrId.includes('medidavolumen') || attrLabel.includes('medida volumen') || attrLabel.includes('volume')) {
      if (!measurementHint) return null;
      return {
        id: attr.id || attr.FeedName || attr.Name,
        name: attr.name || attr.Label || attr.Name || attr.id,
        value_name: String(measurementHint.value)
      };
    }

    if (attrId.includes('tipodeconsumible') || attrLabel.includes('tipo de consumible') || attrLabel.includes('consumible')) {
      const consumableHint = (() => {
        const text = this.getFalabellaProductText(product);
        if (/botella/i.test(text) && /tinta/i.test(text)) return 'Botella de tinta';
        if (/cartucho/i.test(text) && /tinta/i.test(text)) return 'Cartucho de tinta';
        if (/toner/i.test(text) || /t[oó]ner/i.test(text)) return 'Toner';
        if (/cinta/i.test(text)) return 'Cinta';
        if (/ribbon/i.test(text)) return 'Ribbon';
        if (/tinta/i.test(text)) return measurementHint?.unit === 'ml' ? 'Botella de tinta' : 'Tinta';
        return null;
      })();

      if (!consumableHint) return null;
      return optionOrText([consumableHint, 'Consumible'], consumableHint);
    }

    if (attrId.includes('compatiblecon') || attrLabel.includes('compatible con')) {
      const compatibleHint = compatibilityHint || productModel || productBrand;
      if (!compatibleHint) return null;
      return optionOrText([compatibleHint], compatibleHint);
    }

    if (attrId.includes('gtin') || attrId.includes('ean') || attrId.includes('upc') || attrId.includes('isbn')) {
      return optionOrText([productGtin], productGtin);
    }

    if (attrLabel.includes('peso') || attrLabel.includes('weight')) {
      if (packageWeightText === null) return null;
      return {
        id: attr.id || attr.FeedName || attr.Name,
        name: attr.name || attr.Label || attr.Name || attr.id,
        value_name: String(packageWeightText)
      };
    }

    if (attrLabel.includes('alto') || attrLabel.includes('height')) {
      if (!Number.isFinite(packageHeight)) return null;
      return {
        id: attr.id || attr.FeedName || attr.Name,
        name: attr.name || attr.Label || attr.Name || attr.id,
        value_name: String(packageHeight)
      };
    }

    if (attrLabel.includes('ancho') || attrLabel.includes('width')) {
      if (!Number.isFinite(packageWidth)) return null;
      return {
        id: attr.id || attr.FeedName || attr.Name,
        name: attr.name || attr.Label || attr.Name || attr.id,
        value_name: String(packageWidth)
      };
    }

    if (attrLabel.includes('largo') || attrLabel.includes('longitud') || attrLabel.includes('length')) {
      if (!Number.isFinite(packageLength)) return null;
      return {
        id: attr.id || attr.FeedName || attr.Name,
        name: attr.name || attr.Label || attr.Name || attr.id,
        value_name: String(packageLength)
      };
    }

    return null;
  }

  buildFalabellaAttributes(product) {
    const baseAttributes = Array.isArray(product?.attributes)
      ? product.attributes
          .filter((attr) => attr && attr.id)
          .map((attr) => ({
            id: attr.id,
            name: attr.name || attr.Label || attr.Name || attr.id,
            value_id: attr.value_id ?? undefined,
            value_name: attr.value_name ?? undefined,
            value: attr.value ?? attr.value_name ?? attr.value_id ?? undefined,
            attribute_type: attr.attribute_type ?? attr.AttributeType ?? undefined,
            input_type: attr.input_type ?? attr.InputType ?? undefined,
            group_name: attr.group_name ?? attr.GroupName ?? undefined,
            is_global_attribute: attr.is_global_attribute ?? attr.IsGlobalAttribute ?? undefined,
            example_value: attr.example_value ?? undefined,
            values: Array.isArray(attr.values) ? attr.values : []
          }))
      : [];

    const categoryAttributes = Array.isArray(product?.category_attributes)
      ? product.category_attributes
      : [];

    const byId = new Map();
    
    // 🔑 CORRECCIÓN: autoMappedIds solo se usa cuando el atributo NO tiene valor del usuario
    const autoMappedIds = new Set([
      'brand',
      'model',
      'conditiontype',
      'unidaddemedida',
      'medidavolumen',
      'tipodeconsumible',
      'compatiblecon',
      'gtin',
      'ean',
      'upc',
      'isbn',
      'peso',
      'weight',
      'alto',
      'height',
      'ancho',
      'width',
      'largo',
      'longitud',
      'length'
    ]);

    // ✅ PRIMERO: Registrar todos los atributos del usuario (tienen prioridad)
    for (const attr of baseAttributes) {
      byId.set(this.normalizeFalabellaText(attr.id), attr);
    }

    // ✅ SEGUNDO: Solo inferir para atributos que NO tienen valor del usuario
    for (const categoryAttr of categoryAttributes) {
      const attrId = categoryAttr?.id || categoryAttr?.FeedName || categoryAttr?.Name;
      if (!attrId) continue;

      const normalizedId = this.normalizeFalabellaText(attrId);
      const existing = byId.get(normalizedId);
      
      // 🔑 🔑 🔑 CORRECCIÓN CLAVE: Si el usuario ya definió un valor, NUNCA sobrescribir
      const existingHasValue = existing && (
        existing.value_name || 
        existing.value_id || 
        existing.value !== undefined
      );
      
      if (existingHasValue) {
        // ✅ El usuario ya configuró este atributo, respetar su valor
        continue;
      }

      // Solo inferir si el atributo NO tiene valor del usuario
      const inferred = this.inferFalabellaAttributeValue(categoryAttr, product);
      if (!inferred) continue;

      byId.set(normalizedId, {
        id: attrId,
        name: categoryAttr.name || categoryAttr.Label || categoryAttr.Name || attrId,
        value_id: inferred.value_id ?? categoryAttr.value_id ?? undefined,
        value_name: inferred.value_name ?? inferred.value ?? undefined,
        value: inferred.value_name ?? inferred.value ?? inferred.value_id ?? undefined,
        attribute_type: categoryAttr.attribute_type ?? categoryAttr.AttributeType ?? undefined,
        input_type: categoryAttr.input_type ?? categoryAttr.InputType ?? undefined,
        group_name: categoryAttr.group_name ?? categoryAttr.GroupName ?? undefined,
        is_global_attribute: categoryAttr.is_global_attribute ?? categoryAttr.IsGlobalAttribute ?? undefined,
        example_value: categoryAttr.example_value ?? categoryAttr.ExampleValue ?? undefined,
        values: Array.isArray(categoryAttr.values) ? categoryAttr.values : []
      });
    }

    return Array.from(byId.values());
  }

  extractFalabellaVariantSources(variant) {
    const sources = [];

    const pushSource = (key, value) => {
      if (key === undefined || key === null) return;
      const normalizedKey = String(key).trim();
      if (!normalizedKey) return;

      let normalizedValue = value;
      if (normalizedValue === undefined || normalizedValue === null) return;

      if (typeof normalizedValue === 'object') {
        if (normalizedValue.value_name !== undefined && normalizedValue.value_name !== null) {
          normalizedValue = normalizedValue.value_name;
        } else if (normalizedValue.value !== undefined && normalizedValue.value !== null) {
          normalizedValue = normalizedValue.value;
        } else if (normalizedValue.name !== undefined && normalizedValue.name !== null) {
          normalizedValue = normalizedValue.name;
        } else if (normalizedValue.code !== undefined && normalizedValue.code !== null) {
          normalizedValue = normalizedValue.code;
        } else {
          return;
        }
      }

      const finalValue = String(normalizedValue).trim();
      if (!finalValue) return;
      sources.push({ key: normalizedKey, value: finalValue });
    };

    if (variant && typeof variant.attributes === 'object') {
      if (Array.isArray(variant.attributes)) {
        for (const attr of variant.attributes) {
          if (!attr) continue;
          pushSource(attr.id || attr.name, attr.value_name ?? attr.value ?? attr.value_id);
        }
      } else {
        for (const [key, value] of Object.entries(variant.attributes)) {
          pushSource(key, value);
        }
      }
    }

    const variantValues = Array.isArray(variant?.variant_values)
      ? variant.variant_values
      : Array.isArray(variant?.variantValues)
        ? variant.variantValues
        : [];

    for (const variantValue of variantValues) {
      const definitionName = variantValue?.definition?.name || variantValue?.definition?.label || variantValue?.definition?.feed_name;
      const definitionId = variantValue?.definition?.id;
      const value = variantValue?.name ?? variantValue?.value_name ?? variantValue?.code;
      pushSource(definitionName, value);
      pushSource(definitionId, value);
      pushSource(variantValue?.name, value);
      pushSource(variantValue?.code, value);
    }

    if (typeof variant?.variant_label === 'string' && variant.variant_label.trim()) {
      sources.push({ key: '__variant_label__', value: variant.variant_label.trim() });
    }

    return sources;
  }

  normalizeFalabellaVariantImages(value) {
    const entries = Array.isArray(value) ? value : (value ? [value] : []);
    const normalized = [];
    const seen = new Set();

    for (const entry of entries) {
      let image = null;

      if (typeof entry === 'string') {
        const trimmed = entry.trim();
        if (!trimmed) continue;
        image = { source: trimmed };
      } else if (entry && typeof entry === 'object') {
        const source = entry.source || entry.url || entry.link || entry.href || null;
        if (source !== null && source !== undefined) {
          const trimmedSource = String(source).trim();
          if (trimmedSource) image = { source: trimmedSource };
        }
      }

      if (!image) continue;
      const dedupeKey = image.source;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      normalized.push(image);
    }

    return normalized;
  }

  getFalabellaVariantAttributes(variant, categoryAttributes = []) {
    const variationAttrs = (Array.isArray(categoryAttributes) ? categoryAttributes : [])
      .filter((attr) => this.isVariationAttribute(attr));

    if (variationAttrs.length === 0) {
      return [];
    }

    const sources = this.extractFalabellaVariantSources(variant);
    const variantAttributes = [];

    for (const categoryAttr of variationAttrs) {
      const attrId = categoryAttr?.id || categoryAttr?.FeedName || categoryAttr?.Name;
      if (!attrId) continue;

      const normalizedAttrId = this.normalizeFalabellaText(attrId);
      const match = sources.find(({ key }) => {
        const normalizedKey = this.normalizeFalabellaText(key);
        return normalizedKey === normalizedAttrId;
      });

      if (!match) continue;

      const matchedValue = String(match.value || '').trim();
      if (!matchedValue) continue;

      const optionMatch = Array.isArray(categoryAttr.values)
        ? categoryAttr.values.find((option) => {
            const optionName = this.normalizeFalabellaText(option?.name || option?.value_name || '');
            const optionId = this.normalizeFalabellaText(option?.id || '');
            return optionName === this.normalizeFalabellaText(matchedValue) || optionId === this.normalizeFalabellaText(matchedValue);
          })
        : null;

      variantAttributes.push({
        id: attrId,
        name: categoryAttr.name || categoryAttr.Label || categoryAttr.Name || attrId,
        value_id: optionMatch?.id ?? categoryAttr.value_id ?? undefined,
        value_name: optionMatch?.name ?? matchedValue,
        value: optionMatch?.name ?? matchedValue,
        attribute_type: categoryAttr.attribute_type ?? categoryAttr.AttributeType ?? undefined,
        input_type: categoryAttr.input_type ?? categoryAttr.InputType ?? undefined,
        group_name: categoryAttr.group_name ?? categoryAttr.GroupName ?? undefined,
        is_global_attribute: categoryAttr.is_global_attribute ?? categoryAttr.IsGlobalAttribute ?? undefined,
        example_value: categoryAttr.example_value ?? categoryAttr.ExampleValue ?? undefined,
        values: Array.isArray(categoryAttr.values) ? categoryAttr.values : []
      });
    }

    return variantAttributes;
  }

  mergeFalabellaAttributes(baseAttributes = [], overrideAttributes = []) {
    const byId = new Map();
    const pushAttr = (attr) => {
      if (!attr || !attr.id) return;
      byId.set(this.normalizeFalabellaText(attr.id), attr);
    };

    for (const attr of Array.isArray(baseAttributes) ? baseAttributes : []) {
      pushAttr(attr);
    }

    for (const attr of Array.isArray(overrideAttributes) ? overrideAttributes : []) {
      pushAttr(attr);
    }

    return Array.from(byId.values());
  }

  buildFalabellaVariantProducts(prepared, variants = [], categoryAttributes = []) {
    const publishableVariants = Array.isArray(variants)
      ? variants.filter((variant) => variant && variant.publish && Number(variant.price) > 0)
      : [];

    if (publishableVariants.length === 0) {
      return [];
    }

    const resolvedParentVariant = publishableVariants.find((variant) => {
      const variantSku = String(variant?.sku || variant?.SellerSku || '').trim();
      return variantSku && variantSku === String(prepared?.sku || '').trim();
    }) || publishableVariants[0];

    const parentSku = String(resolvedParentVariant?.sku || resolvedParentVariant?.SellerSku || '').trim();
    if (!parentSku) return [];

    const products = [];
    const seenSkus = new Set();

    const addProduct = (sku, variant) => {
      const normalizedSku = String(sku || '').trim();
      if (!normalizedSku || seenSkus.has(normalizedSku)) return;

      const variantAttributes = variant ? this.getFalabellaVariantAttributes(variant, categoryAttributes) : [];
      const fallbackImages = this.normalizeFalabellaVariantImages(prepared.images || []);
      const images = this.normalizeFalabellaVariantImages(
        variant?.images || variant?.image || variant?.pictures || fallbackImages
      );

      products.push({
        ...prepared,
        sku: normalizedSku,
        ParentSku: normalizedSku === parentSku ? parentSku : parentSku,
        productName: prepared.productName,
        brand: prepared.brand,
        description: prepared.description,
        PrimaryCategory: prepared.PrimaryCategory,
        price: Number(variant?.price ?? prepared.price) || prepared.price,
        stock: Math.max(0, Math.round(Number(variant?.publishStock ?? variant?.totalStock ?? variant?.stock ?? 0) || 0)),
        attributes: this.mergeFalabellaAttributes(prepared.attributes, variantAttributes),
        images
      });

      seenSkus.add(normalizedSku);
    };

    addProduct(resolvedParentVariant.sku || resolvedParentVariant.SellerSku || '', resolvedParentVariant);

    for (const variant of publishableVariants) {
      const sku = String(variant.sku || variant.SellerSku || '').trim();
      if (!sku || sku === parentSku) continue;
      addProduct(sku, variant);
    }

    return products;
  }

  isVariationAttribute(attr) {
    const groupName = String(attr?.group_name ?? attr?.GroupName ?? '').trim();
    const globalValue = attr?.is_global_attribute ?? attr?.IsGlobalAttribute;
    const isGlobalFalse = globalValue === false || globalValue === 0 || String(globalValue) === '0';
    return groupName === 'Variation' && isGlobalFalse;
  }

async hydrateAttributesForPublish(product) {
  if (!product || !product.PrimaryCategory || !Array.isArray(product.attributes) || product.attributes.length === 0) {
    return product;
  }

  const categoryAttributesResponse = await this.getCategoryAttributes(product.PrimaryCategory);
  const categoryAttributes = Array.isArray(categoryAttributesResponse?.attributes)
    ? categoryAttributesResponse.attributes
    : [];

  if (categoryAttributes.length === 0) {
    return product;
  }

  const categoryAttributeMap = new Map(categoryAttributes.map(attr => [attr.id, attr]));
  const mergedAttributes = product.attributes.map(attr => {
    const metadata = categoryAttributeMap.get(attr.id);
    return metadata ? { ...metadata, ...attr } : attr;
  });

  return {
    ...product,
    attributes: mergedAttributes,
    category_attributes: product.category_attributes || categoryAttributes
  };
}
// 🔑 NUEVO MÉTODO: Obtener atributos de categoría
async getCategoryAttributes(categoryId) {
  try {
    const credentialStatus = await this.ensureValidCredentials();
    if (!credentialStatus.valid) {
      throw new Error('Credenciales inválidas');
    }

    const timestamp = this.timestampMinus03();
    const params = {
      Action: 'GetCategoryAttributes',
      Format: 'JSON',
      PrimaryCategory: categoryId.toString(),
      Timestamp: timestamp,
      UserID: this.credential.seller_email.trim(),
      Version: '1.0'
    };

    const sortedKeys = Object.keys(params).sort();
    const stringToSign = sortedKeys.map(k => `${k}=${params[k]}`).join('&');
    
    const signatureHex = crypto
      .createHmac('sha256', this.credential.api_key.trim())
      .update(stringToSign, 'utf8')
      .digest('hex');

    const urlParams = { ...params, Signature: signatureHex };
    const urlSortedKeys = ['Action', 'Format', 'PrimaryCategory', 'Signature', 'Timestamp', 'UserID', 'Version'];
    const urlQueryString = urlSortedKeys
      .map(k => `${this.rfc3986Encode(k)}=${this.rfc3986Encode(String(urlParams[k]))}`)
      .join('&');

    const apiUrl = `https://sellercenter-api.falabella.com?${urlQueryString}`;

    const response = await axios.get(apiUrl, { timeout: 10000 });
    
    if (response.data.SuccessResponse?.Body?.Attribute) {
      const attrs = response.data.SuccessResponse.Body.Attribute;
      const items = Array.isArray(attrs) ? attrs : [attrs];
      
      return {
        success: true,
        attributes: items.map(attr => ({
          id: attr.FeedName || attr.Name,
          feed_name: attr.FeedName || attr.Name,
          name: attr.Label,
          group_name: attr.GroupName || '',
          is_global_attribute: attr.IsGlobalAttribute === "1" || attr.IsGlobalAttribute === 1 || attr.IsGlobalAttribute === true,
          is_mandatory: attr.isMandatory === "1" || attr.isMandatory === true,
          value_type: ['option', 'multi_option'].includes(attr.AttributeType) ? 'list' : 'string',
          attribute_type: attr.AttributeType || 'string',
          input_type: attr.InputType || '',
          example_value: attr.ExampleValue || '',
          options: attr.Options || null,
          values: attr.Options?.Option 
            ? (Array.isArray(attr.Options.Option) 
                ? attr.Options.Option.map(opt => ({ id: opt.id, name: opt.Name }))
                : [{ id: attr.Options.Option.id, name: attr.Options.Option.Name }])
            : []
        }))
      };
    }
    
    return { success: false, attributes: [] };
  } catch (error) {
    logger.error(`[FalabellaAdapter] Error obteniendo atributos: ${error.message}`);
    return { success: false, attributes: [] };
  }
}

  // ✅ Validación específica para Falabella
  validateProduct(product) {
    const errors = [];
    const required = ['sku', 'productName', 'brand', 'price', 'stock', 'PrimaryCategory', 'description'];

    for (const field of required) {
      if (product[field] == null || (typeof product[field] === 'string' && product[field].trim() === '')) {
        errors.push(`Campo requerido ausente: ${field}`);
      }
    }

    // Validar que PrimaryCategory sea numérico
    if (product.PrimaryCategory && isNaN(Number(product.PrimaryCategory))) {
      errors.push(`PrimaryCategory debe ser un número entero válido. Recibido: ${product.PrimaryCategory}`);
    }

    // Validar precio y stock
    if (product.price <= 0) errors.push('El precio debe ser mayor a 0');
    if (product.stock < 0) errors.push('El stock no puede ser negativo');

    if (Array.isArray(product?.falabella_products) && product.falabella_products.length > 0) {
      const skus = product.falabella_products.map((item) => String(item?.sku || '').trim()).filter(Boolean);
      const uniqueSkus = new Set(skus);
      if (skus.length !== uniqueSkus.size) {
        errors.push('Las variantes de Falabella contienen SKUs duplicados');
      }

      const parentSku = String(product.ParentSku || '').trim();
      if (!parentSku) {
        errors.push('ParentSku es requerido cuando existen variantes');
      } else if (!skus.includes(parentSku)) {
        errors.push(`ParentSku debe coincidir con el SellerSku de uno de los productos enviados. Recibido: ${parentSku}`);
      }

      for (const item of product.falabella_products) {
        const itemSku = String(item?.sku || '').trim();
        if (!itemSku) {
          errors.push('Cada variante debe tener un SellerSku válido');
          continue;
        }
        const itemParentSku = String(item?.ParentSku || '').trim();
        if (itemParentSku !== parentSku) {
          errors.push(`ParentSku inconsistente para SKU ${itemSku}. Recibido: ${itemParentSku}, esperado: ${parentSku}`);
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }
  buildProductXml(product) {
    const products = Array.isArray(product?.falabella_products) && product.falabella_products.length > 0
      ? product.falabella_products
      : [product];

    const builder = new Builder({
      headless: true,
      renderOpts: { pretty: true, indent: '  ', newline: '\n' }
    });

    const xmlObject = {
      Request: {
        Product: products.map((item) => this.buildFalabellaProductNodeXml(item))
      }
    };

    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n${builder.buildObject(xmlObject)}`;

    logger.info(`[FalabellaAdapter] 📦 XML Payload (${product?.__falabella_action || 'ProductCreate'}):`);
    logger.info(xml);

    return xml;
  }

  buildFalabellaProductNodeXml(product) {
    logger.info(
      `[DEBUG IMAGES] ${JSON.stringify({
        images: product.images,
        MainImage: product.MainImage
      })}`
    );

    const sku = String(product.sku || '').substring(0, 50);
    const name = String(product.productName || 'Producto sin nombre').substring(0, 255);
    const brandAttr = Array.isArray(product.attributes)
      ? product.attributes.find((a) => a.id === 'Brand')
      : null;
    const brand = String(brandAttr?.value_name || brandAttr?.value || product.brand || 'Genérica').substring(0, 50);
    const description = String(product.description || 'Producto sin descripción').substring(0, 25000);
    const categoryId = Number(product.PrimaryCategory);
    const price = Number(product.price).toFixed(2);
    const stock = Math.max(0, Math.round(Number(product.stock)));
    const marketplaceProductId = this.resolveMarketplaceProductId(product);
    const operatorCode = this.getFalabellaOperatorCode();

    const validateDimension = (value, fieldName) => {
      const numValue = Number(value);
      if (!Number.isFinite(numValue) || numValue < 2) {
        logger.warn(`[FalabellaAdapter] ⚠️ ${fieldName} valor ${value} fuera de rango (mínimo 2), ajustando a 2`);
        return 2;
      }
      if (numValue > 303) {
        logger.warn(`[FalabellaAdapter] ⚠️ ${fieldName} valor ${value} fuera de rango (máximo 303), ajustando a 303`);
        return 303;
      }
      return numValue;
    };

    const getAttributeValue = (attrId, fallback) => {
      const attr = Array.isArray(product.attributes)
        ? product.attributes.find((a) => a.id === attrId)
        : null;
      return attr?.value_name || attr?.value || fallback;
    };

    const height = validateDimension(getAttributeValue('PackageHeight', product.package_height || 10), 'PackageHeight');
    const width = validateDimension(getAttributeValue('PackageWidth', product.package_width || 10), 'PackageWidth');
    const length = validateDimension(getAttributeValue('PackageLength', product.package_length || 10), 'PackageLength');
    const weightValue = Number(getAttributeValue('PackageWeight', product.package_weight || 0.5));
    const weight = Number.isFinite(weightValue) && weightValue >= 0.001 ? weightValue : 0.5;

    const effectiveAttributes = this.buildFalabellaAttributes(product);
    const variationAttributes = Array.isArray(effectiveAttributes)
      ? effectiveAttributes.filter((attr) => this.isVariationAttribute(attr))
      : [];
    const variationField = Array.isArray(effectiveAttributes)
      ? effectiveAttributes.find((attr) => this.normalizeFalabellaText(attr?.id) === 'variation')
      : null;
    const variationValue = this.normalizeFalabellaAttributeValue(variationField);

    const productDataAttrs = {
      ConditionType: this.normalizeFalabellaAttributeValue(
        effectiveAttributes?.find((a) => String(a.id).toLowerCase() === 'conditiontype')
      ) || 'Nuevo',
      PackageHeight: height,
      PackageWidth: width,
      PackageLength: length,
      PackageWeight: weight.toFixed(3)
    };

    if (Array.isArray(effectiveAttributes)) {
      for (const attr of effectiveAttributes) {
        const feedName = attr.feed_name || attr.FeedName || attr.id;
        if (!feedName) continue;
        if (['SellerSku', 'ParentSku', 'Name', 'Brand', 'Description', 'PrimaryCategory', 'ProductId', 'images', 'productId', 'categoryName', 'category_attributes', 'falabella_products'].includes(feedName)) {
          continue;
        }
        if (feedName === 'Variation') {
          continue;
        }
        if (this.isVariationAttribute(attr)) {
          continue;
        }
        if (['PackageHeight', 'PackageWidth', 'PackageLength', 'PackageWeight'].includes(feedName)) {
          continue;
        }

        let value = this.normalizeFalabellaAttributeValue(attr);
        if ([
          'DuracionEnCondicionesPrevisiblesDeUso',
          'PlazoDeDisponibilidadDeRepuestos',
          'PlazoDeDisponibilidadDeServicioTecnico',
          'WarrantyTime',
          'WarrantyMonths'
        ].includes(feedName) && typeof value === 'string') {
          const match = value.match(/^\d+/);
          if (match) value = match[0];
        }

        if (value !== '' && value !== null && value !== undefined) {
          productDataAttrs[feedName] = value;
        }
      }
    }

    const node = {
      SellerSku: sku,
      Name: name,
      PrimaryCategory: String(categoryId),
      Description: description,
      Brand: brand,
      Variation: variationValue || undefined,
      BusinessUnits: {
        BusinessUnit: {
          OperatorCode: operatorCode,
          Price: price,
          Stock: String(stock),
          Status: 'active'
        }
      },
      ProductData: productDataAttrs
    };

    if (product.ParentSku) {
      node.ParentSku = String(product.ParentSku).substring(0, 50);
    }

    if (marketplaceProductId) {
      node.ProductId = String(marketplaceProductId);
    }

    for (const attr of variationAttributes) {
      const feedName = attr.feed_name || attr.FeedName || attr.id;
      const value = this.normalizeFalabellaAttributeValue(attr);
      if (feedName && value !== '' && value !== null && value !== undefined) {
        node[feedName] = value;
      }
    }

    const normalizedImages = this.normalizeFalabellaImages(product.images);
    if (normalizedImages.length > 0) {
      logger.info(`[FalabellaAdapter] ✅ Imágenes preparadas para asociación post-creación: ${normalizedImages.length}`);
    } else {
      logger.info(`[FalabellaAdapter] ℹ️ Sin imágenes en payload para SKU ${sku}`);
    }

    return node;
  }

    async publish(transformedProduct) {
    try {
      const credentialStatus = await this.ensureValidCredentials();
      if (!credentialStatus.valid) {
        return credentialStatus;
      }

      transformedProduct = await this.hydrateAttributesForPublish(transformedProduct);

      // Validar producto
      const validation = this.validateProduct(transformedProduct);
      if (!validation.valid) {
        logger.error(`[FalabellaAdapter] Validación fallida:`, validation.errors);
        return {
          success: false,
          error: 'validation_failed',
          details: validation.errors
        };
      }

      // ✅ Verificar si el producto ya existe para actualizarlo por SellerSku
      const existingProduct = await this.findExistingProductBySellerSku(transformedProduct.sku);
      const action = existingProduct ? 'ProductUpdate' : 'ProductCreate';
      if (existingProduct) {
        logger.info(
          `[FalabellaAdapter] SKU existente detectado (${existingProduct.sku}) -> se usará ${action}`
        );
        // Si Falabella ya conoce el SKU, reforzamos la actualización enviando también el ProductId
        // que devuelve GetProducts. No cambia el flujo de creación cuando no existe.
        transformedProduct.ProductId = transformedProduct.ProductId || existingProduct.productId || null;
        transformedProduct.productId = transformedProduct.productId || existingProduct.productId || null;
      }

      // ✅ Construir XML payload
      transformedProduct.__falabella_action = action;
      const xmlPayload = this.buildProductXml(transformedProduct);

      // ✅ Generar timestamp en hora de Chile (-03:00)
      const timestamp = this.timestampMinus03();

      // ✅ Parámetros para firma (orden alfabético)
      const params = {
        Action: action,
        Format: 'XML',
        Timestamp: timestamp,
        UserID: this.credential.seller_email.trim(),
        Version: '1.0'
      };

      const { canonicalQuery, signatureHex, signatureEncoded } = this.buildSignedQuery(params);

      logger.info(`[FalabellaAdapter] 🔍 String to sign (ENCODEADO):`);
      logger.info(canonicalQuery);
      logger.info(`[FalabellaAdapter] ✅ Firma generada (HEX): ${signatureHex}`);

      // ✅ 5) Construir URL final: canonicalQuery + &Signature=firma_encodeada
      const urlQueryString = `${canonicalQuery}&Signature=${signatureEncoded}`;
      const baseUrl = 'https://sellercenter-api.falabella.com';
      const apiUrl = `${baseUrl}?${urlQueryString}`;

      logger.info(`[FalabellaAdapter] 🌐 URL final:`);
      logger.info(apiUrl);

      // ✅ Headers obligatorios (User-Agent es OBLIGATORIO para POST)
      const headers = {
        'Content-Type': 'application/xml; charset=UTF-8',
        'User-Agent': `${this.credential.seller_id || 'SC72B9D'}/Node/${process.versions.node}/PROPIA/FACL`
      };

      logger.info(`[FalabellaAdapter] 👤 Headers:`);
      logger.info(JSON.stringify(headers, null, 2));
      logger.info(`[FalabellaAdapter] 📦 XML Payload (${action}):`);
      logger.info(xmlPayload);

      // ✅ Enviar solicitud POST
      const response = await axios.post(apiUrl, xmlPayload, {
        headers,
        timeout: 15000
      });

      logger.info(`[FalabellaAdapter] ✅ Respuesta HTTP ${response.status}:`);
      logger.info(response.data);

      const responseBody = response.data;

      if (responseBody.includes('<SuccessResponse>')) {
        const requestIdMatch = responseBody.match(/<RequestId>([^<]+)<\/RequestId>/);
        const requestId = requestIdMatch ? requestIdMatch[1] : null;

        if (!requestId) {
          logger.warn('[FalabellaAdapter] SuccessResponse sin RequestId; no se puede consultar FeedStatus');
          return {
            success: false,
            error: 'Falabella respondió éxito técnico, pero no devolvió RequestId para validar el feed',
            details: { error_code: 'missing_request_id' }
          };
        }

        // Falabella confirma la aceptación inicial con RequestId.
        // La confirmación final del estado se obtiene por FeedStatus; el webhook onFeedCompleted
        // queda como mecanismo de reconciliación asíncrona.
        logger.info(`[FalabellaAdapter] ✅ Feed aceptado por Falabella. FeedID: ${requestId}`);
        const marketplaceMessage = `Falabella emitió FeedID: ${requestId}; confirmar luego con FeedStatus`;

        return {
          success: true,
          external_id: transformedProduct.sku,
          data: {
            feed_id: requestId,
            action: action,
            status: 'processing',
            sku: transformedProduct.sku,
            published_skus: Array.isArray(transformedProduct.falabella_products)
              ? transformedProduct.falabella_products.map((item) => item?.sku).filter(Boolean)
              : [transformedProduct.sku].filter(Boolean),
            has_variants: Array.isArray(transformedProduct.falabella_products)
              && transformedProduct.falabella_products.length > 1,
            category_id: transformedProduct.PrimaryCategory,
            category_name: transformedProduct.categoryName,
            image_upload: { success: true, skipped: true }
          },
          has_warnings: false,
          warnings: [],
          warning_message: marketplaceMessage,
          message: marketplaceMessage
        };

      } else if (responseBody.includes('<ErrorResponse>')) {
        const errorMsgMatch =
          responseBody.match(/<ErrorMessage>([^<]+)<\/ErrorMessage>/);
        const errorCodeMatch =
          responseBody.match(/<ErrorCode>([^<]+)<\/ErrorCode>/);

        const errorMsg = errorMsgMatch
          ? errorMsgMatch[1]
          : 'Error desconocido en API de Falabella';
        const errorCode = errorCodeMatch
          ? errorCodeMatch[1]
          : 'UNKNOWN';

        logger.error(
          `[FalabellaAdapter] ❌ Error API Falabella (Código ${errorCode}): ${errorMsg}`
        );

        return {
          success: false,
          error: `Falabella API Error ${errorCode}: ${errorMsg}`,
          status_code: response.status,
          payload: xmlPayload
        };
      } else {
        logger.warn('[FalabellaAdapter] ⚠️ Respuesta inesperada:', responseBody.substring(0, 300));
        return {
          success: false,
          error: 'Respuesta inesperada de API de Falabella',
          payload: xmlPayload
        };
      }
    } catch (err) {
      let errorMsg = 'Error desconocido al publicar en Falabella';
      if (err.response) {
        errorMsg = `Error HTTP ${err.response.status}: ${err.response.statusText}`;
        logger.error(`[FalabellaAdapter] ❌ Error HTTP:`, {
          status: err.response.status,
          statusText: err.response.statusText,
          data: typeof err.response.data === 'string' ? err.response.data.substring(0, 500) : err.response.data
        });
      } else if (err.request) {
        errorMsg = 'No se recibió respuesta de Falabella (timeout o problema de red)';
        logger.error(`[FalabellaAdapter] ❌ Error de red: timeout o conexión rechazada`);
      } else {
        errorMsg = err.message || 'Error interno';
        logger.error(`[FalabellaAdapter] ❌ Error local:`, err.message);
      }
      return {
        success: false,
        error: errorMsg,
        details: err.response?.data || err.message
      };
    }
  }

 buildFalabellaUpdateXml({ sellerSku, status = undefined, price = undefined, available_quantity = undefined }) {
  const sku = String(sellerSku || '').trim();
  if (!sku) {
    return null;
  }

  const operatorCode = this.getFalabellaOperatorCode();
  const businessUnit = {
    OperatorCode: operatorCode
  };

  if (status !== undefined && status !== null && String(status).trim() !== '') {
    businessUnit.Status = String(status).trim().toLowerCase();
  }

  if (price !== undefined && price !== null && String(price).trim() !== '') {
    businessUnit.Price = Number(price).toFixed(2);
  }

  if (available_quantity !== undefined && available_quantity !== null && String(available_quantity).trim() !== '') {
    businessUnit.Stock = String(Math.max(0, Math.round(Number(available_quantity))));
  }

  const builder = new Builder({
    headless: true,
    renderOpts: { pretty: true, indent: '  ', newline: '\n' }
  });

  return `<?xml version="1.0" encoding="UTF-8"?>\n${builder.buildObject({
    Request: {
      Product: {
        SellerSku: sku,
        BusinessUnits: {
          BusinessUnit: businessUnit
        }
      }
    }
  })}`;
}

  getFalabellaOperatorCode() {
    const code = String(this.credential?.country || '').trim().toLowerCase();
    if (code === 'pe') return 'fape';
    if (code === 'co') return 'faco';
    if (code === 'mx') return 'fame';
    if (String(this.marketplace?.domain || '').includes('falabella.com.pe')) return 'fape';
    if (String(this.marketplace?.domain || '').includes('falabella.com.co')) return 'faco';
    return 'facl';
  }

  async updateItem({ sellerSku, status = undefined, price = undefined, available_quantity = undefined }) {
    try {
      const credentialStatus = await this.ensureValidCredentials();
      if (!credentialStatus.valid) {
        return credentialStatus;
      }

      const normalizedSku = String(sellerSku || '').trim();
      if (!normalizedSku) {
        return { success: false, error: 'missing_seller_sku' };
      }

      const hasStatus = status !== undefined && status !== null && String(status).trim() !== '';
      const hasPrice = price !== undefined && price !== null && String(price).trim() !== '';
      const hasQuantity = available_quantity !== undefined && available_quantity !== null && String(available_quantity).trim() !== '';

      if (!hasStatus && !hasPrice && !hasQuantity) {
        return { success: false, error: 'no_changes' };
      }

      const normalizedStatus = hasStatus ? String(status).trim().toLowerCase() : undefined;
      if (normalizedStatus && !['active', 'inactive'].includes(normalizedStatus)) {
        return {
          success: false,
          error: 'invalid_status',
          details: { allowed_values: ['active', 'inactive'] }
        };
      }

      const xmlPayload = this.buildFalabellaUpdateXml({
        sellerSku: normalizedSku,
        status: normalizedStatus,
        price: hasPrice ? Number(price) : undefined,
        available_quantity: hasQuantity ? Number(available_quantity) : undefined
      });

      const timestamp = this.timestampMinus03();
      const params = {
        Action: 'ProductUpdate',
        Format: 'XML',
        Timestamp: timestamp,
        UserID: this.credential.seller_email.trim(),
        Version: '1.0'
      };

      const { canonicalQuery, signatureHex, signatureEncoded } = this.buildSignedQuery(params);
      const urlQueryString = `${canonicalQuery}&Signature=${signatureEncoded}`;
      const apiUrl = `https://sellercenter-api.falabella.com?${urlQueryString}`;

      logger.info(`[FalabellaAdapter] 🔍 String to sign (ENCODEADO):`);
      logger.info(canonicalQuery);
      logger.info(`[FalabellaAdapter] ✅ Firma generada (HEX): ${signatureHex}`);
      logger.info(`[FalabellaAdapter] 📦 XML Payload (ProductUpdate): \n ${JSON.stringify(xmlPayload)}`);

      const headers = {
        'Content-Type': 'application/xml; charset=UTF-8',
        'User-Agent': `${this.credential.seller_id || 'SC72B9D'}/Node/${process.versions.node}/PROPIA/FACL`
      };

      const response = await axios.post(apiUrl, xmlPayload, {
        headers,
        timeout: 15000
      });

      const responseBody = response.data;
      if (typeof responseBody === 'string' && responseBody.includes('<SuccessResponse>')) {
        const requestIdMatch = responseBody.match(/<RequestId>([^<]+)<\/RequestId>/);
        const requestId = requestIdMatch ? requestIdMatch[1] : null;

        if (!requestId) {
          return {
            success: false,
            error: 'Falabella respondió éxito técnico, pero no devolvió RequestId para validar el feed',
            details: { error_code: 'missing_request_id' }
          };
        }

        // Confirmación síncrona del resultado del feed según el estado oficial de Falabella.
        // Si el webhook llega después, solo reconcilia el estado local.
        const { feed, timedOut } = await this.pollFeedStatus(requestId);
        return this.buildFeedDrivenResult({
          transformedProduct: {
            sku: normalizedSku,
            PrimaryCategory: null,
            categoryName: null
          },
          requestId,
          feed,
          timedOut,
          action: 'ProductUpdate'
        });
      }

      if (typeof responseBody === 'string' && responseBody.includes('<ErrorResponse>')) {
        const errorMsgMatch = responseBody.match(/<ErrorMessage>([^<]+)<\/ErrorMessage>/);
        const errorCodeMatch = responseBody.match(/<ErrorCode>([^<]+)<\/ErrorCode>/);
        const errorMsg = errorMsgMatch ? errorMsgMatch[1] : 'Error desconocido en API de Falabella';
        const errorCode = errorCodeMatch ? errorCodeMatch[1] : 'UNKNOWN';

        return {
          success: false,
          error: `Falabella API Error ${errorCode}: ${errorMsg}`,
          status_code: response.status,
          payload: xmlPayload
        };
      }

      return {
        success: false,
        error: 'Respuesta inesperada de API de Falabella',
        payload: xmlPayload
      };
    } catch (error) {
      return {
        success: false,
        error: error.response?.data || error.message || 'Error interno',
        details: error.response?.data || error.message
      };
    }
  }

  static supports(marketplace) {
    return marketplace.id === 4 || marketplace.domain?.includes('falabella.cl');
  }

   // 🔑 NUEVO MÉTODO: Subir imágenes después de publicar el producto
  async uploadProductImages(sellerSku, images = []) {
    if (!Array.isArray(images) || images.length === 0) {
      logger.info(`[FalabellaAdapter] No hay imágenes para subir para SKU ${sellerSku}`);
      return { success: true, skipped: true };
    }

    try {
      const credentialStatus = await this.ensureValidCredentials();
      if (!credentialStatus.valid) {
        return credentialStatus;
      }

      const sku = String(sellerSku || '').substring(0, 50);
      
      const normalizedImages = images
        .filter((imageUrl) => typeof imageUrl === 'string' && imageUrl.trim())
        .map((imageUrl) => imageUrl.trim())
        .slice(0, 8);

      if (normalizedImages.length > 0) {
        logger.info(`[FalabellaAdapter] 📸 Preparando ${normalizedImages.length} imagen(es) para SKU ${sellerSku} (máximo 8 según doc)`);
      }

      if (normalizedImages.length === 0) {
        logger.info(`[FalabellaAdapter] No hay URLs de imagen válidas para SKU ${sellerSku}`);
        return { success: true, skipped: true };
      }

      const builder = new Builder({
        headless: true,
        renderOpts: { pretty: true, indent: '  ', newline: '\n' }
      });

      const xmlPayload = `<?xml version="1.0" encoding="UTF-8"?>\n${builder.buildObject({
        Request: {
          ProductImage: {
            SellerSku: sku,
            Images: {
              Image: normalizedImages
            }
          }
        }
      })}`;

      const timestamp = this.timestampMinus03();
      const params = {
        Action: 'Image',
        Format: 'XML',
        Timestamp: timestamp,
        UserID: this.credential.seller_email.trim(),
        Version: '1.0'
      };

      const { canonicalQuery, signatureEncoded } = this.buildSignedQuery(params);
      const urlQueryString = `${canonicalQuery}&Signature=${signatureEncoded}`;
      const apiUrl = `https://sellercenter-api.falabella.com?${urlQueryString}`;

      const headers = {
        'Content-Type': 'application/xml; charset=UTF-8',
        'User-Agent': `${this.credential.seller_id || 'SC72B9D'}/Node/${process.versions.node}/PROPIA/FACL`
      };

      const logFalabellaResponse = (label, value) => {
        if (value === null || value === undefined) {
          logger.info(`[FalabellaAdapter] ${label}: <empty>`);
          return;
        }

        if (typeof value === 'string') {
          logger.info(`[FalabellaAdapter] ${label}: ${value}`);
          return;
        }

        try {
          logger.info(`[FalabellaAdapter] ${label}: ${JSON.stringify(value)}`);
        } catch (jsonError) {
          logger.info(`[FalabellaAdapter] ${label}: ${String(value)}`);
        }
      };

      logger.info(`[FalabellaAdapter] 📸 Subiendo ${images.length} imágenes para SKU ${sellerSku}`);
      logger.info(`[FalabellaAdapter] 📸 XML Payload (ProductImageCreate):`);
      logger.info(xmlPayload);

      const response = await axios.post(apiUrl, xmlPayload, {
        headers,
        timeout: 15000
      });

      const responseBody = response.data;
      logger.info(`[FalabellaAdapter] 📸 Response status (Image): ${response.status}`);
      logFalabellaResponse('📸 Respuesta Image', responseBody);

      if (typeof responseBody === 'string' && responseBody.includes('<SuccessResponse>')) {
        const requestIdMatch = responseBody.match(/<RequestId>([^<]+)<\/RequestId>/);
        const requestId = requestIdMatch ? requestIdMatch[1] : null;
        
        return {
          success: true,
          request_id: requestId,
          images_count: images.length,
          data: responseBody
        };
      } else if (typeof responseBody === 'string' && responseBody.includes('<ErrorResponse>')) {
        const errorMsgMatch = responseBody.match(/<ErrorMessage>([^<]+)<\/ErrorMessage>/);
        const errorCodeMatch = responseBody.match(/<ErrorCode>([^<]+)<\/ErrorCode>/);
        
        logger.error(`[FalabellaAdapter] ❌ Error subiendo imágenes: ${errorMsgMatch?.[1] || 'unknown'}`);
        logFalabellaResponse('❌ Respuesta Error Image', responseBody);
        
        return {
          success: false,
          error: `Error subiendo imágenes: ${errorMsgMatch?.[1] || 'unknown'}`,
          error_code: errorCodeMatch?.[1] || 'UNKNOWN',
          data: responseBody
        };
      }

      return {
        success: false,
        error: 'Respuesta inesperada al subir imágenes',
        data: responseBody
      };

    } catch (error) {
      logger.error(`[FalabellaAdapter] ❌ Error subiendo imágenes para SKU ${sellerSku}: ${error.message}`);
      logger.error(`[FalabellaAdapter] ❌ No se completó ProductImageCreate para SKU ${sellerSku}; xml_enviado=${Boolean(xmlPayload)}`);
      if (error.response) {
        logger.error(`[FalabellaAdapter] ❌ Image HTTP status: ${error.response.status}`);
        logFalabellaResponse('❌ Image error response', error.response.data);
      }
      return {
        success: false,
        error: error.message || 'Error subiendo imágenes',
        details: error.response?.data || null,
        status_code: error.response?.status || null
      };
    }
  }

  // 🔑 NUEVO MÉTODO: Consultar estado real del producto incluyendo QC
  async fetchProductStatus(sellerSku) {
    try {
      const products = await this.fetchProductsBySellerSku(sellerSku);
      if (!products || products.length === 0) {
        return {
          found: false,
          status: 'not_found',
          qc_status: null
        };
      }

      const product = products[0];
      const rawProduct = product.raw || {};
      const hasMainImage = FalabellaAdapter.hasFalabellaImage(rawProduct);
      const businessUnit = Array.isArray(rawProduct?.BusinessUnits?.BusinessUnit)
        ? rawProduct.BusinessUnits.BusinessUnit[0]
        : rawProduct?.BusinessUnits?.BusinessUnit || {};
      const parseBoolean = (value) => {
        if (value === true || value === false) return value;
        if (value === 1 || value === 0) return value === 1;
        const normalized = String(value || '').trim().toLowerCase();
        if (!normalized) return null;
        if (['1', 'true', 'yes', 'y', 'si', 'sí', 'active', 'published'].includes(normalized)) {
          return true;
        }
        if (['0', 'false', 'no', 'n', 'inactive', 'draft', 'unpublished'].includes(normalized)) {
          return false;
        }
        return null;
      };
      
      // Extraer QCStatus y causa posible desde raíz y BusinessUnit
      const qcStatus = rawProduct.QCStatus
        || rawProduct.qc_status
        || businessUnit.QCStatus
        || businessUnit.qc_status
        || null;
      const qcReason = [
        rawProduct.QCMessage,
        rawProduct.qc_message,
        rawProduct.QCReason,
        rawProduct.qc_reason,
        rawProduct.Reason,
        rawProduct.reason,
        rawProduct.ErrorMessage,
        rawProduct.error_message,
        businessUnit.QCMessage,
        businessUnit.qc_message,
        businessUnit.QCReason,
        businessUnit.qc_reason,
        businessUnit.Reason,
        businessUnit.reason,
        businessUnit.ErrorMessage,
        businessUnit.error_message
      ].find((value) => typeof value === 'string' && value.trim()) || null;
      const productErrors = FalabellaAdapter.extractRealFalabellaErrors(rawProduct);
      const status = product.status || null;
      const isPublished = parseBoolean(
        rawProduct.IsPublished ??
        rawProduct.is_published ??
        businessUnit.IsPublished ??
        businessUnit.is_published ??
        null
      );

      return {
        found: true,
        sku: product.sku,
        status: status || businessUnit.Status || null,
        qc_status: qcStatus,
        qc_reason: qcReason,
        is_published: isPublished,
        has_image: hasMainImage,
        price: businessUnit.Price ?? null,
        stock: businessUnit.Stock ?? null,
        product_id: rawProduct.ProductId || null,
        shop_sku: rawProduct.ShopSku || null,
        url: rawProduct.Url || null,
        product_errors: productErrors,
        raw: rawProduct
      };
    } catch (error) {
      logger.error(`[FalabellaAdapter] Error consultando estado de SKU ${sellerSku}: ${error.message}`);
      return {
        found: false,
        status: 'error',
        error: error.message
      };
    }
  }

  // ✅ MÉTODO ESTÁTICO: Extraer errores REALES del response de Falabella
  static hasFalabellaImage(productRaw) {
    if (!productRaw || typeof productRaw !== 'object') {
      return false;
    }

    const candidates = [
      productRaw.MainImage,
      productRaw.mainImage,
      productRaw.Image,
      productRaw.image,
      productRaw.Images,
      productRaw.images
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return true;
      }

      if (Array.isArray(candidate) && candidate.length > 0) {
        return true;
      }

      if (candidate && typeof candidate === 'object') {
        const values = Object.values(candidate);
        if (values.some(value => {
          if (typeof value === 'string') return value.trim().length > 0;
          if (Array.isArray(value)) return value.length > 0;
          return Boolean(value);
        })) {
          return true;
        }
      }
    }

    return false;
  }

  static extractRealFalabellaErrors(productRaw) {
    if (!productRaw || typeof productRaw !== 'object') {
      return [];
    }

    const errors = [];
    const businessUnits = Array.isArray(productRaw?.BusinessUnits?.BusinessUnit)
      ? productRaw.BusinessUnits.BusinessUnit
      : productRaw?.BusinessUnits?.BusinessUnit
        ? [productRaw.BusinessUnits.BusinessUnit]
        : [];

    const collectReason = (source, sourceName) => {
      if (!source || typeof source !== 'object') return;

      const qcStatus = String(source.QCStatus || source.qc_status || '').trim().toLowerCase();
      const reason = [
        source.QCMessage,
        source.qc_message,
        source.QCReason,
        source.qc_reason,
        source.Reason,
        source.reason,
        source.ErrorMessage,
        source.error_message,
        source.Message,
        source.message,
        source.Detail,
        source.detail
      ].find((value) => typeof value === 'string' && value.trim()) || null;

      if (reason && (qcStatus === 'rejected' || qcStatus === 'fail' || sourceName !== 'response')) {
        errors.push({
          source: sourceName,
          code: qcStatus === 'rejected' || qcStatus === 'fail' ? 'QC_REJECTED' : null,
          message: reason,
          field: qcStatus === 'rejected' || qcStatus === 'fail' ? 'QCStatus' : null
        });
      }
    };

    // ✅ 1. Errores del Feed
    if (productRaw.FeedErrors) {
      const feedErrors = Array.isArray(productRaw.FeedErrors) 
        ? productRaw.FeedErrors 
        : (productRaw.FeedErrors.Error ? [productRaw.FeedErrors.Error] : []);
      
      feedErrors.forEach(err => {
        errors.push({
          source: 'feed',
          code: err.Code || err.code || null,
          message: err.Message || err.message || String(err),
          field: err.Field || err.field || null
        });
      });
    }

    // ✅ 2. Errores/razones explícitas del QC
    const qcStatus = String(productRaw.QCStatus || productRaw.qc_status || '').trim().toLowerCase();
    if (qcStatus === 'rejected' || qcStatus === 'fail') {
      const qcReason =
        productRaw.QCMessage ||
        productRaw.qc_message ||
        productRaw.QCReason ||
        productRaw.qc_reason ||
        productRaw.Reason ||
        productRaw.reason ||
        productRaw.Message ||
        productRaw.message ||
        productRaw.ErrorMessage ||
        productRaw.error_message ||
        null;

      if (qcReason) {
        errors.push({
          source: 'qc',
          code: 'QC_REJECTED',
          message: qcReason,
          field: 'QCStatus'
        });
      }
    }

    businessUnits.forEach((unit) => {
      const unitQcStatus = String(unit?.QCStatus || unit?.qc_status || '').trim().toLowerCase();
      if (unitQcStatus === 'rejected' || unitQcStatus === 'fail') {
        const unitReason = [
          unit.QCMessage,
          unit.qc_message,
          unit.QCReason,
          unit.qc_reason,
          unit.Reason,
          unit.reason,
          unit.Message,
          unit.message,
          unit.ErrorMessage,
          unit.error_message
        ].find((value) => typeof value === 'string' && value.trim()) || null;

        if (unitReason) {
          errors.push({
            source: 'business_unit_qc',
            code: 'QC_REJECTED',
            message: unitReason,
            field: 'QCStatus'
          });
        }
      }
      collectReason(unit, 'business_unit');
    });

    collectReason(productRaw, 'response');

    // ✅ 3. Errores explícitos en el payload raíz
    const rootMessages = [
      productRaw.Error,
      productRaw.error,
      productRaw.ErrorMessage,
      productRaw.error_message,
      productRaw.Reason,
      productRaw.reason,
      productRaw.Detail,
      productRaw.detail
    ].filter(value => typeof value === 'string' && value.trim());

    rootMessages.forEach((message) => {
      errors.push({
        source: 'response',
        code: null,
        message: message.trim(),
        field: null
      });
    });

    // ✅ 4. Errores/advertencias estructurados extra
    const genericCollections = [
      productRaw.Errors,
      productRaw.Warnings,
      productRaw.Issues,
      productRaw.Messages
    ];

    genericCollections.forEach((collection) => {
      const list = Array.isArray(collection)
        ? collection
        : collection && typeof collection === 'object'
          ? Object.values(collection)
          : [];

      list.forEach((item) => {
        if (!item) return;
        if (typeof item === 'string') {
          errors.push({ source: 'response', code: null, message: item, field: null });
          return;
        }

        errors.push({
          source: 'response',
          code: item.Code || item.code || null,
          message: item.Message || item.message || item.Error || item.error || String(item),
          field: item.Field || item.field || item.Attribute || item.attribute || null
        });
      });
    });

    return errors;
  }
}

module.exports = FalabellaAdapter;
