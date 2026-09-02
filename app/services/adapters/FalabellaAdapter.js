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

  isFalabellaDateAttribute(feedName) {
    const normalized = this.normalizeFalabellaText(feedName);
    return normalized.includes('date') || normalized.includes('fecha');
  }

  normalizeFalabellaDateValue(value) {
    if (value === null || value === undefined) return value;

    const raw = String(value).trim();
    if (!raw) return raw;

    const isoDateMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/);
    if (isoDateMatch) {
      return `${isoDateMatch[1]}-${isoDateMatch[2]}-${isoDateMatch[3]}`;
    }

    const dayFirstMatch = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
    if (!dayFirstMatch) return raw;

    const day = Number(dayFirstMatch[1]);
    const month = Number(dayFirstMatch[2]);
    const year = Number(dayFirstMatch[3]);
    const parsed = new Date(Date.UTC(year, month - 1, day));

    if (
      parsed.getUTCFullYear() !== year ||
      parsed.getUTCMonth() !== month - 1 ||
      parsed.getUTCDate() !== day
    ) {
      return raw;
    }

    const pad = n => String(n).padStart(2, '0');
    return `${year}-${pad(month)}-${pad(day)}`;
  }

  normalizeFalabellaDateTimeValue(value, endOfDay = false) {
    const normalizedDate = this.normalizeFalabellaDateValue(value);
    if (!normalizedDate || typeof normalizedDate !== 'string') return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedDate)) return null;

    const raw = String(value).trim();
    const timeMatch = raw.match(/[T\s](\d{2}:\d{2}(?::\d{2})?)/);
    if (timeMatch) {
      const time = timeMatch[1].length === 5 ? `${timeMatch[1]}:00` : timeMatch[1];
      return `${normalizedDate} ${time}`;
    }

    return `${normalizedDate} ${endOfDay ? '23:59:59' : '00:00:00'}`;
  }

  getFalabellaAttributeValueByNames(product, feedNames = []) {
    for (const feedName of feedNames) {
      const value = this.getFalabellaAttributeValue(product, feedName);
      if (value !== null && value !== undefined && String(value).trim() !== '') {
        return value;
      }
    }
    return null;
  }

  resolveFalabellaOffer(product, priceValue = null) {
    const specialPriceRaw =
      product?.SpecialPrice ??
      product?.special_price ??
      product?.sale_price ??
      product?.promotional_price ??
      this.getFalabellaAttributeValueByNames(product, ['SpecialPrice', 'SalePriceFalabella']);

    const specialPrice = this.normalizeFalabellaFloat(specialPriceRaw);
    if (specialPrice === null || specialPrice <= 0) return null;

    const basePrice = priceValue !== null
      ? priceValue
      : this.normalizeFalabellaFloat(product?.price ?? product?.Price);

    if (basePrice !== null && specialPrice >= basePrice) {
      logger.warn(
        `[FalabellaAdapter] Oferta omitida para SKU ${product?.sku || product?.SellerSku || 'n/a'}: SpecialPrice ${specialPrice} debe ser menor que Price ${basePrice}`
      );
      return null;
    }

    const fromRaw =
      product?.SpecialFromDate ??
      product?.special_from_date ??
      product?.sale_start_date ??
      this.getFalabellaAttributeValueByNames(product, ['SpecialFromDate', 'SaleStartDateFalabella']);
    const toRaw =
      product?.SpecialToDate ??
      product?.special_to_date ??
      product?.sale_end_date ??
      this.getFalabellaAttributeValueByNames(product, ['SpecialToDate', 'SaleEndDateFalabella']);

    const specialFromDate = this.normalizeFalabellaDateTimeValue(fromRaw, false);
    const specialToDate = this.normalizeFalabellaDateTimeValue(toRaw, true);

    if (!specialFromDate || !specialToDate) {
      logger.warn(
        `[FalabellaAdapter] Oferta omitida para SKU ${product?.sku || product?.SellerSku || 'n/a'}: fechas de oferta incompletas o invalidas`
      );
      return null;
    }

    if (new Date(specialToDate.replace(' ', 'T')) < new Date(specialFromDate.replace(' ', 'T'))) {
      logger.warn(
        `[FalabellaAdapter] Oferta omitida para SKU ${product?.sku || product?.SellerSku || 'n/a'}: SpecialToDate anterior a SpecialFromDate`
      );
      return null;
    }

    return {
      SpecialPrice: specialPrice.toFixed(2),
      SpecialFromDate: specialFromDate,
      SpecialToDate: specialToDate
    };
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

  logPublishPayloadMarker({ label, action, sku, payload }) {
    logger.info(
      `[FalabellaAdapter] ========= [FALABELLA][PAYLOAD_TO_SEND] ========= label=${label} action=${action} sku=${sku || 'n/a'} =========`
    );

    try {
      logger.info(payload);
    } catch (error) {
      logger.info(String(payload));
    }
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

  parseFalabellaJsonObject(value) {
    if (!value) return {};
    if (typeof value === 'object' && !Array.isArray(value)) return value;
    if (typeof value !== 'string') return {};
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      return {};
    }
  }

  findFalabellaAttribute(product, feedName) {
    const normalizedFeedName = this.normalizeFalabellaText(feedName);
    if (!normalizedFeedName || !Array.isArray(product?.attributes)) return null;
    return product.attributes.find((attr) => {
      const candidates = [attr?.id, attr?.feed_name, attr?.FeedName, attr?.name, attr?.Name];
      return candidates.some((candidate) => this.normalizeFalabellaText(candidate) === normalizedFeedName);
    }) || null;
  }

  getFalabellaAttributeValue(product, feedName) {
    return this.normalizeFalabellaAttributeValue(this.findFalabellaAttribute(product, feedName));
  }

  resolvePackageMeasurementsFromAttributes(product) {
    const readNumber = (feedName) => {
      const value = this.getFalabellaAttributeValue(product, feedName);
      const parsed = this.normalizeFalabellaFloat(value);
      return parsed !== null ? parsed : null;
    };

    return {
      package_height: readNumber('PackageHeight'),
      package_width: readNumber('PackageWidth'),
      package_length: readNumber('PackageLength'),
      package_weight: readNumber('PackageWeight')
    };
  }

  resolvePackageMeasurements(productData) {
    const productMeasurements = this.parseFalabellaJsonObject(productData?.product_measurements);
    const packagingMeasurements = this.parseFalabellaJsonObject(productData?.packaging_measurements);
    const packageData = this.parseFalabellaJsonObject(productData?.package) || {};
    const dimensions = productMeasurements?.dimensions || {};
    const packagingDimensions = packagingMeasurements?.dimensions || {};

    const heightFromMeasurements = this.toCentimeters(dimensions.height);
    const widthFromMeasurements = this.toCentimeters(dimensions.width);
    const lengthFromMeasurements = this.toCentimeters(dimensions.length ?? dimensions.depth);
    const weightFromMeasurements = this.toKilograms(productMeasurements?.weight);

    const heightFromPackaging = this.toCentimeters(packagingDimensions.height);
    const widthFromPackaging = this.toCentimeters(packagingDimensions.width);
    const lengthFromPackaging = this.toCentimeters(packagingDimensions.length ?? packagingDimensions.depth);
    const weightFromPackaging = this.toKilograms(packagingMeasurements?.weight);

    const heightFromPackage = this.toCentimeters(packageData.height ?? packageData.height_cm);
    const widthFromPackage = this.toCentimeters(packageData.width ?? packageData.width_cm);
    const lengthFromPackage = this.toCentimeters(packageData.length ?? packageData.length_cm ?? packageData.depth ?? packageData.depth_cm);
    const weightFromPackage = packageData.weight_grams != null
      ? this.coerceNumber(packageData.weight_grams) / 1000
      : this.toKilograms(packageData.weight);

    const legacyHeight = this.coerceNumber(productData?.height_cm);
    const legacyWidth = this.coerceNumber(productData?.width_cm);
    const legacyLength = this.coerceNumber(productData?.length_cm);
    const legacyWeightKg = productData?.weight_grams != null
      ? this.coerceNumber(productData.weight_grams) / 1000
      : null;

    return {
      package_height: heightFromPackaging ?? heightFromPackage ?? heightFromMeasurements ?? legacyHeight ?? null,
      package_width: widthFromPackaging ?? widthFromPackage ?? widthFromMeasurements ?? legacyWidth ?? null,
      package_length: lengthFromPackaging ?? lengthFromPackage ?? lengthFromMeasurements ?? legacyLength ?? null,
      package_weight: weightFromPackaging ?? weightFromPackage ?? weightFromMeasurements ?? legacyWeightKg ?? null
    };
  }

  normalizeFalabellaBoolean(value) {
    if (value === true || value === 1) return true;
    const normalized = String(value ?? '').trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes';
  }

  normalizeFalabellaInteger(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
  }

  normalizeFalabellaFloat(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(String(value).trim().replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : null;
  }

  normalizeFalabellaConditionType(value) {
    const normalized = this.normalizeFalabellaText(value);
    if (!normalized) return null;
    if (['nuevo', 'new'].includes(normalized)) return 'Nuevo';
    if (['reacondicionado', 'refurbished', 'used', 'reconditioned'].includes(normalized)) return 'Reacondicionado';
    return String(value).trim();
  }

  resolveFalabellaOperatorCode(product = null) {
    const additional = this.credential?.additional_data;
    const nestedAdditional = additional && typeof additional === 'object'
      ? additional.falabella || additional
      : null;

    const candidates = [
      product?.OperatorCode,
      product?.operator_code,
      nestedAdditional?.operator_code,
      nestedAdditional?.OperatorCode,
      this.credential?.operator_code,
      this.credential?.OperatorCode,
      this.credential?.business_unit_code,
      this.credential?.businessUnitCode
    ];

    for (const candidate of candidates) {
      const normalized = String(candidate ?? '').trim().toLowerCase();
      if (normalized) return normalized;
    }

    const country = String(this.credential?.country || '').trim().toLowerCase();
    if (country === 'pe' || String(this.marketplace?.domain || '').includes('falabella.com.pe')) return 'fape';
    if (country === 'co' || String(this.marketplace?.domain || '').includes('falabella.com.co')) return 'faco';
    if (country === 'mx' || String(this.marketplace?.domain || '').includes('falabella.com.mx')) return 'fame';
    if (country === 'cl' || String(this.marketplace?.domain || '').includes('falabella.com.cl')) return 'facl';

    return 'facl';
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
      .map((product) => {
        const raw = product || {};
        const resolved = this.resolveExistingItemModel(raw);
        return {
          sku: String(product?.SellerSku || product?.SKU || normalizedSku).trim(),
          name: product?.Name || null,
          brand: product?.Brand || null,
          primaryCategory: product?.PrimaryCategory || null,
          productId: product?.ProductId || null,
          status: Array.isArray(product?.BusinessUnits?.BusinessUnit)
            ? product.BusinessUnits.BusinessUnit[0]?.Status || null
            : product?.BusinessUnits?.BusinessUnit?.Status || null,
          raw,
          ...resolved
        };
      });
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

  resolveExistingItemModel(item = null) {
    const raw = item?.raw || item || {};
    const familyName = String(raw?.family_name || raw?.FamilyName || raw?.Family || '').trim();
    const userProductId = String(raw?.user_product_id || raw?.UserProductId || raw?.userProductId || '').trim();
    const userProductListing = String(raw?.user_product_listing || raw?.UserProductListing || raw?.userProductListing || '').trim();
    const parentSku = String(raw?.ParentSku || raw?.parent_sku || '').trim();
    const variations = Array.isArray(raw?.variations)
      ? raw.variations
      : Array.isArray(raw?.Variations?.Variation)
        ? raw.Variations.Variation
        : [];
    const variationCount = variations.length;
    const hasClassicVariations = variationCount > 0 || parentSku.length > 0;
    const hasUserProductEvidence = Boolean(familyName || userProductId || userProductListing || raw?.ProductFamilyId || raw?.FamilySku);

    return {
      model: hasUserProductEvidence ? 'user_product' : 'classic',
      hasClassicVariations,
      evidence: {
        family_name: familyName || null,
        user_product_id: userProductId || null,
        user_product_listing: userProductListing || null,
        parent_sku: parentSku || null,
        variations_count: variationCount,
        product_id: raw?.ProductId || null,
        sku: raw?.SellerSku || raw?.SKU || null
      }
    };
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
            marketplace_error: {
              request_action: feed?.Action || action || 'ProductCreate',
              error_message: errorMessage,
              raw: feed?.raw || feed
            },
            feed: feedData
          },
          external_id: transformedProduct.sku,
          data: {
            ...feedData,
            feed_confirmed: true
          }
        };
      }

      if (warnings.length > 0) {
        logger.warn(`[FalabellaAdapter] Producto publicado con advertencias confirmadas por FeedStatus`, warnings);
        const warningMessage = warnings.map(item => item?.message).filter(Boolean).join(' | ');
        return {
          success: true,
          external_id: transformedProduct.sku,
          has_warnings: true,
          warnings,
          warning_message: warningMessage
            ? `Pendiente en Falabella: ${warningMessage}`
            : 'Pendiente en Falabella por advertencias del marketplace',
          data: {
            ...feedData,
            feed_confirmed: true
          }
        };
      }

      logger.info(`[FalabellaAdapter] Producto publicado exitosamente según FeedStatus`);
      return {
        success: true,
        external_id: transformedProduct.sku,
        data: {
          ...feedData,
          feed_confirmed: true
        }
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

  async uploadImagesAfterConfirmedProductCreate(transformedProduct, currentImageUploadResult = null) {
    const images = this.normalizeFalabellaImages(transformedProduct?.images || []);
    const baseResult = currentImageUploadResult || (
      images.length > 0
        ? {
            success: false,
            skipped: true,
            pending: true,
            reason: 'awaiting_product_create_feed',
            images_count: images.length
          }
        : { success: true, skipped: true, pending: false, images_count: 0 }
    );

    if (images.length === 0) {
      return baseResult;
    }

    const sellerSku = transformedProduct?.sku;
    let productStatus = null;

    try {
      productStatus = await this.fetchProductStatus(sellerSku);
    } catch (error) {
      logger.warn(
        `[FalabellaAdapter] No se pudo verificar existencia del producto ${sellerSku} antes de subir imágenes: ${error.message}`
      );
      return {
        ...baseResult,
        pending: true,
        reason: 'product_status_check_failed',
        error: error.message
      };
    }

    if (!productStatus?.found) {
      logger.info(
        `[FalabellaAdapter] ProductCreate confirmado para ${sellerSku}, pero GetProducts aún no lo expone; imágenes quedan pendientes`
      );
      return {
        ...baseResult,
        pending: true,
        reason: 'product_not_visible_after_confirmed_feed',
        product_status: productStatus
      };
    }

    if (productStatus.has_image !== false) {
      logger.info(`[FalabellaAdapter] SKU ${sellerSku} ya reporta imagen en Falabella; se omite Action=Image`);
      return {
        success: true,
        skipped: true,
        pending: false,
        reason: 'already_has_image',
        images_count: images.length,
        product_status: productStatus
      };
    }

    const terminalStatus = String(productStatus.status || '').trim().toLowerCase();
    if (['inactive', 'deleted'].includes(terminalStatus)) {
      logger.info(
        `[FalabellaAdapter] SKU ${sellerSku} está en estado terminal ${terminalStatus}; se omite Action=Image`
      );
      return {
        ...baseResult,
        pending: false,
        reason: 'terminal_product_status',
        product_status: productStatus
      };
    }

    logger.info(
      `[FalabellaAdapter] ProductCreate confirmado para ${sellerSku}; asociando ${images.length} imagen(es) via Action=Image`
    );
    return await this.uploadProductImages(sellerSku, images);
  }

  async resolveImmediateProductCreateFeedResult({ transformedProduct, requestId, imageUploadResult }) {
    const maxAttempts = Number(process.env.FALABELLA_PRODUCT_CREATE_FEED_STATUS_MAX_ATTEMPTS || 2);
    const intervalMs = Number(process.env.FALABELLA_PRODUCT_CREATE_FEED_STATUS_INTERVAL_MS || 3000);

    if (maxAttempts <= 0) return null;

    try {
      const { feed, timedOut } = await this.pollFeedStatus(requestId, {
        maxAttempts,
        intervalMs
      });

      if (timedOut || !feed) return null;

      const feedStatusLower = String(feed?.Status || '').toLowerCase();
      const failedRecords = parseInt(feed?.FailedRecords || '0', 10);
      const errors = this.normalizeFeedMessages(feed?.FeedErrors);

      if (!['finished', 'error', 'canceled'].includes(feedStatusLower)) {
        return null;
      }

      const feedResult = this.buildFeedDrivenResult({
        transformedProduct,
        requestId,
        feed,
        timedOut: false,
        action: 'ProductCreate'
      });

      feedResult.data = {
        ...(feedResult.data || {}),
        feed_id: feedResult.data?.feed_id || requestId,
        action: feedResult.data?.action || 'ProductCreate',
        sku: transformedProduct.sku,
        image_upload: imageUploadResult,
        feed_status_checked_immediately: true
      };

      if (!feedResult.success || failedRecords > 0 || errors.length > 0) {
        return feedResult;
      }

      const confirmedImageUploadResult = await this.uploadImagesAfterConfirmedProductCreate(
        transformedProduct,
        imageUploadResult
      );

      feedResult.data = {
        ...(feedResult.data || {}),
        image_upload: confirmedImageUploadResult
      };

      if (confirmedImageUploadResult?.success === false && confirmedImageUploadResult?.skipped !== true) {
        feedResult.has_warnings = true;
        feedResult.warnings = [
          ...(Array.isArray(feedResult.warnings) ? feedResult.warnings : []),
          {
            field: 'images',
            sku: transformedProduct.sku,
            message: confirmedImageUploadResult.error || 'No se pudo iniciar la subida de imágenes en Falabella',
            value: null
          }
        ];
        feedResult.warning_message = [
          feedResult.warning_message,
          `La subida de imágenes quedó pendiente: ${confirmedImageUploadResult.error || confirmedImageUploadResult.reason || 'sin detalle'}`
        ].filter(Boolean).join(' | ');
      }

      return {
        feed,
        feed_result: feedResult
      };
    } catch (error) {
      logger.warn(
        `[FalabellaAdapter] No se pudo confirmar FeedStatus inmediato para ProductCreate ${requestId}: ${error.message}`
      );
    }

    return null;
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
                         { price: productData.price ?? null, publishStock: productData.stock ?? null };

    // 🔑🔑 EXTRAER ATRIBUTOS: Priorizar falabella[credentialId].attributes
    let attributes = [];
    
    const falabellaConfig = this.getFalabellaConfig(productData);
    if (falabellaConfig?.attributes && Array.isArray(falabellaConfig.attributes) && falabellaConfig.attributes.length > 0) {
      attributes = falabellaConfig.attributes.map(attr => ({
        id: attr.id,
        name: attr.name,
        value_id: attr.value_id,
        value_name: attr.value_name ?? attr.value ?? attr.userValue ?? attr.user_value ?? attr.plain_text ?? attr.value_id,
        value: attr.value_name ?? attr.value ?? attr.userValue ?? attr.user_value ?? attr.plain_text ?? attr.value_id,
        example_value: attr.example_value || null
      }));
    }
    else if (falabellaConfig?.category?.attributes && Array.isArray(falabellaConfig.category.attributes) && falabellaConfig.category.attributes.length > 0) {
      attributes = falabellaConfig.category.attributes.map(attr => ({
        id: attr.id,
        name: attr.name,
        value_id: attr.value_id,
        value_name: attr.value_name ?? attr.value ?? attr.userValue ?? attr.user_value ?? attr.plain_text ?? attr.value_id,
        value: attr.value_name ?? attr.value ?? attr.userValue ?? attr.user_value ?? attr.plain_text ?? attr.value_id,
        example_value: attr.example_value || null
      }));
    }

    const categoryMetadata = await this.loadCategoryMetadata(category.id);
    const categoryAttributes = Array.isArray(categoryMetadata?.attributes)
      ? categoryMetadata.attributes
      : [];
    if (!categoryMetadata?.success || !categoryMetadata?.category) {
      throw new Error(`No se pudo validar la categoría Falabella ${category.id} con GetCategoryTree/GetCategoryAttributes`);
    }
    const categoryAttributeMap = new Map(categoryAttributes.map(attr => [attr.id, attr]));

    attributes = attributes.map(attr => {
      const metadata = categoryAttributeMap.get(attr.id);
      return metadata ? { ...metadata.raw, ...metadata, ...attr } : attr;
    });

    const resolvedConditionType = this.normalizeFalabellaConditionType(
      productData.condition ??
      productData.condition_type ??
      productData.ConditionType ??
      ''
    );
    if (resolvedConditionType) {
      const conditionTypeAttrId = 'ConditionType';
      if (!attributes.some((attr) => this.normalizeFalabellaText(attr.id) === 'conditiontype')) {
        attributes.push({
          id: conditionTypeAttrId,
          name: 'ConditionType',
          value_name: resolvedConditionType,
          value: resolvedConditionType,
          attribute_type: 'string',
          input_type: 'text',
          group_name: '',
          is_global_attribute: false,
          values: []
        });
      }
    }

    const packageMeasurementsFromPayload = this.resolvePackageMeasurements(productData);
    const packageMeasurementsFromAttributes = this.resolvePackageMeasurementsFromAttributes({ attributes });
    const packageMeasurements = {
      package_height: packageMeasurementsFromAttributes.package_height ?? packageMeasurementsFromPayload.package_height,
      package_width: packageMeasurementsFromAttributes.package_width ?? packageMeasurementsFromPayload.package_width,
      package_length: packageMeasurementsFromAttributes.package_length ?? packageMeasurementsFromPayload.package_length,
      package_weight: packageMeasurementsFromAttributes.package_weight ?? packageMeasurementsFromPayload.package_weight
    };
    // Valores elegidos en atributos marketplace mandan sobre ficha Spree.
    const selectedBrand = this.getFalabellaAttributeValueByNames({ attributes }, ['Brand']);
    const selectedName = this.getFalabellaAttributeValueByNames({ attributes }, ['Name']);
    const selectedDescription = this.getFalabellaAttributeValueByNames({ attributes }, ['Description', 'description']);
    const selectedSku = this.getFalabellaAttributeValueByNames({ attributes }, ['SellerSku']);
    const selectedPrice = this.getFalabellaAttributeValueByNames({ attributes }, ['Price', 'PriceFalabella']);
    const selectedStock = this.getFalabellaAttributeValueByNames({ attributes }, ['Quantity', 'Stock', 'StockFalabella']);

    const resolvedBrand = String(
      selectedBrand ?? productData.brand ?? productData.Brand ?? ''
    ).trim() || null;

    const resolvedName = String(
      selectedName ?? productData.productName ?? productData.name ?? productData.title ??
      ''
    ).trim() || null;

    const resolvedDescription = String(
      selectedDescription ?? productData.description ?? productData.Description ??
      ''
    ).trim() || null;

    const resolvedSku = String(selectedSku ?? productData.sku ?? productData.SellerSku ?? '').trim() || null;
    const resolvedPrice = this.normalizeFalabellaFloat(selectedPrice ?? validVariant?.price ?? productData.price ?? productData.Price);
    const resolvedStock = this.normalizeFalabellaInteger(
      selectedStock ?? productData.totalPublishingStock ??
      productData.stock ??
      productData.totalStock ??
      validVariant?.publishStock ??
      validVariant?.stock ??
      validVariant?.totalStock
    );

    const attributeProductId = this.getFalabellaAttributeValue({ attributes }, 'ProductId');

    const prepared = {
      sku: resolvedSku,
      productName: resolvedName,
      brand: resolvedBrand,
      price: resolvedPrice,
      stock: resolvedStock,
      PrimaryCategory: category.id,
      description: resolvedDescription,
      package_height: packageMeasurements.package_height,
      package_width: packageMeasurements.package_width,
      package_length: packageMeasurements.package_length,
      package_weight: packageMeasurements.package_weight,
      attributes: attributes,
      SpecialPrice: validVariant?.SpecialPrice ?? validVariant?.special_price ?? validVariant?.sale_price ?? validVariant?.promotional_price ?? productData.SpecialPrice ?? productData.special_price ?? productData.sale_price ?? productData.promotional_price ?? this.getFalabellaAttributeValueByNames({ attributes }, ['SpecialPrice', 'SalePriceFalabella']) ?? null,
      SpecialFromDate: validVariant?.SpecialFromDate ?? validVariant?.special_from_date ?? validVariant?.sale_start_date ?? productData.SpecialFromDate ?? productData.special_from_date ?? productData.sale_start_date ?? this.getFalabellaAttributeValueByNames({ attributes }, ['SpecialFromDate', 'SaleStartDateFalabella']) ?? null,
      SpecialToDate: validVariant?.SpecialToDate ?? validVariant?.special_to_date ?? validVariant?.sale_end_date ?? productData.SpecialToDate ?? productData.special_to_date ?? productData.sale_end_date ?? this.getFalabellaAttributeValueByNames({ attributes }, ['SpecialToDate', 'SaleEndDateFalabella']) ?? null,
      images: this._transformImages(productData.images || productData.pictures || []),
      productIdentifier: attributeProductId || productData.productIdentifier || productData.gtin || productData.ean || productData.upc || productData.isbn || null,
      gtin: productData.gtin || null,
      ean: productData.ean || null,
      upc: productData.upc || null,
      isbn: productData.isbn || null,
      categoryName: category.name,
      category_attributes: categoryAttributes,
      category_metadata: categoryMetadata
    };

    prepared.attributes = this.buildFalabellaAttributes(prepared);
    prepared.images = this.normalizeFalabellaImages(prepared.images);

    const publishableVariants = Array.isArray(productData.variants)
      ? productData.variants.filter((variant) => variant && variant.publish !== false)
      : [];
    const hasMultipleVariants = publishableVariants.length > 1;
    const variationCapability = this.resolveFalabellaVariationCapability(categoryAttributes);
    const supportsMultiVariant = variationCapability.supportsMultiVariation;

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
      logger.info(`[FalabellaAdapter] La categoría ${category.id} no admite multivariantes; se publicará como productos simples independientes`);
      const publicationItems = this.buildFalabellaIndependentVariantProducts(
        prepared,
        publishableVariants,
        categoryAttributes
      );

      if (publicationItems.length >= 1) {
        prepared.falabella_publication_items = publicationItems;
        logger.info(`[FalabellaAdapter] Variantes separadas listas para publicación: ${publicationItems.length} productos simples independientes`);
      } else {
        throw new Error('No se pudieron construir variantes válidas para Falabella');
      }
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

    //logger.info(`[FalabellaAdapter] Producto preparado para publicación:\n ${JSON.stringify(prepared)}`);

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
    const reservedAttributeIds = new Set([
      'sellersku',
      'parentsku',
      'productid',
      'name',
      'brand',
      'description',
      'primarycategory',
      'categories',
      'sku',
      'product_id',
      'productname',
      'categoryname',
      'category_attributes',
      'falabella_products',
      'falabella_publication_items',
      'images',
      'productimage',
      'productimages',
      'pricefalabella',
      'salepricefalabella',
      'salestartdatefalabella',
      'saleenddatefalabella',
      'specialprice',
      'specialfromdate',
      'specialtodate',
      'quantityfalabella',
      'operatorcode',
      'productdata'
    ]);

    const baseAttributes = Array.isArray(product?.attributes)
      ? product.attributes
          .filter((attr) => attr && attr.id)
          .filter((attr) => !reservedAttributeIds.has(this.normalizeFalabellaText(attr.id)))
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
            values: Array.isArray(attr.values) ? attr.values : [],
            feed_name: attr.feed_name ?? attr.FeedName ?? attr.id,
            raw: attr.raw ?? attr
          }))
      : [];

    const byId = new Map();
    for (const attr of baseAttributes) {
      byId.set(this.normalizeFalabellaText(attr.id), attr);
    }

    return Array.from(byId.values()).filter((attr) => attr && !reservedAttributeIds.has(this.normalizeFalabellaText(attr.id)));
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
      const normalizedId = this.normalizeFalabellaText(attr.id);
      if (['sellersku', 'parentsku', 'productid', 'productdata'].includes(normalizedId)) return;
      byId.set(normalizedId, attr);
    };

    for (const attr of Array.isArray(baseAttributes) ? baseAttributes : []) {
      pushAttr(attr);
    }

    for (const attr of Array.isArray(overrideAttributes) ? overrideAttributes : []) {
      pushAttr(attr);
    }

    return Array.from(byId.values()).filter((attr) => {
      const normalizedId = this.normalizeFalabellaText(attr?.id);
      return !['sellersku', 'parentsku', 'productid', 'productdata'].includes(normalizedId);
    });
  }

  buildFalabellaVariantProducts(prepared, variants = [], categoryAttributes = []) {
    const publishableVariants = Array.isArray(variants)
      ? variants.filter((variant) => variant && variant.publish !== false)
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
        ParentSku: parentSku,
        productName: prepared.productName,
        brand: prepared.brand,
        description: prepared.description,
        PrimaryCategory: prepared.PrimaryCategory,
        price: Number(variant?.price ?? prepared.price) || prepared.price,
        SpecialPrice: variant?.SpecialPrice ?? variant?.special_price ?? variant?.sale_price ?? variant?.promotional_price ?? prepared.SpecialPrice ?? null,
        SpecialFromDate: variant?.SpecialFromDate ?? variant?.special_from_date ?? variant?.sale_start_date ?? prepared.SpecialFromDate ?? null,
        SpecialToDate: variant?.SpecialToDate ?? variant?.special_to_date ?? variant?.sale_end_date ?? prepared.SpecialToDate ?? null,
        stock: Math.max(0, Math.round(Number(variant?.publishStock ?? variant?.totalStock ?? variant?.stock ?? prepared.stock ?? 0) || 0)),
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

  resolveFalabellaVariantLabel(variant, categoryAttributes = [], fallbackProduct = null) {
    const sources = this.extractFalabellaVariantSources(variant);
    const candidateKeys = [
      'Variation',
      'variation',
      'Color',
      'color',
      'variant_label',
      'variantLabel',
      'variant',
      'label',
      'name',
      'title'
    ];

    for (const candidateKey of candidateKeys) {
      const sourceMatch = sources.find(({ key }) => this.normalizeFalabellaText(key) === this.normalizeFalabellaText(candidateKey));
      if (sourceMatch?.value) {
        const value = String(sourceMatch.value).trim();
        if (value) return value;
      }

      const directValue = variant?.[candidateKey] ?? variant?.[candidateKey.toLowerCase()];
      if (directValue !== undefined && directValue !== null) {
        const value = String(directValue).trim();
        if (value) return value;
      }
    }

    if (fallbackProduct) {
      const fallbackVariationAttr = Array.isArray(fallbackProduct.attributes)
        ? fallbackProduct.attributes.find((attr) => this.normalizeFalabellaText(attr?.id || attr?.feed_name || attr?.FeedName || '') === 'variation')
        : null;
      const fallbackValue = this.normalizeFalabellaAttributeValue(fallbackVariationAttr) || String(fallbackProduct.Variation || '').trim();
      if (fallbackValue) return fallbackValue;
    }

    const categoryVariationAttr = Array.isArray(categoryAttributes)
      ? categoryAttributes.find((attr) => this.normalizeFalabellaText(attr?.feed_name || attr?.FeedName || attr?.id || '') === 'variation')
      : null;
    if (categoryVariationAttr) {
      const categoryValue = this.normalizeFalabellaAttributeValue(categoryVariationAttr);
      if (categoryValue) return categoryValue;
    }

    return '';
  }

  adjustFalabellaTextForVariation(text, variationValue) {
    const sourceText = String(text || '').trim();
    const variationText = String(variationValue || '').trim();

    if (!sourceText || !variationText) {
      return sourceText;
    }

    const sourceNormalized = this.normalizeFalabellaText(sourceText);
    const variationNormalized = this.normalizeFalabellaText(variationText);
    if (sourceNormalized.includes(variationNormalized)) {
      return sourceText;
    }

    const commonColorTokens = [
      'negro', 'azul', 'rojo', 'blanco', 'gris', 'verde', 'amarillo',
      'morado', 'violeta', 'naranja', 'rosa', 'cian', 'magenta'
    ];

    for (const token of commonColorTokens) {
      if (token === variationNormalized) continue;
      if (!sourceNormalized.includes(token)) continue;

      const tokenRegex = new RegExp(`\\b${token}\\b`, 'i');
      const replaced = sourceText.replace(tokenRegex, variationText);
      if (replaced !== sourceText) {
        return replaced;
      }
    }

    return sourceText;
  }

  buildFalabellaSimpleVariantProduct(prepared, variant, categoryAttributes = []) {
    const variantSku = String(variant?.sku || variant?.SellerSku || '').trim();
    if (!variantSku) return null;

    const variationValue = this.resolveFalabellaVariantLabel(variant, categoryAttributes, prepared);
    const variantAttributes = Array.isArray(categoryAttributes)
      ? this.getFalabellaVariantAttributes(variant, categoryAttributes)
      : [];
    const variationAttr = variationValue
      ? {
          id: 'Variation',
          feed_name: 'Variation',
          name: 'Variante',
          value_name: variationValue,
          value: variationValue,
          attribute_type: 'value',
          input_type: 'text',
          group_name: '',
          is_global_attribute: false,
          values: []
        }
      : null;

    const mergedAttributes = this.mergeFalabellaAttributes(
      prepared.attributes || [],
      [
        ...variantAttributes,
        ...(variationAttr ? [variationAttr] : [])
      ]
    );

    const variantImages = this.normalizeFalabellaVariantImages(
      variant?.images || variant?.image || variant?.pictures || prepared.images || []
    );

    const productName = String(
      variant?.productName ||
      variant?.name ||
      variant?.title ||
      variant?.variant_name ||
      variant?.variantLabel ||
      variant?.variant_label ||
      prepared.productName ||
      ''
    ).trim();

    const productDescription = String(
      variant?.description ||
      variant?.Description ||
      variant?.variant_description ||
      prepared.description ||
      ''
    ).trim();

    return {
      ...prepared,
      sku: variantSku,
      productName: this.adjustFalabellaTextForVariation(productName, variationValue || variantSku),
      description: this.adjustFalabellaTextForVariation(productDescription, variationValue || variantSku),
      price: this.normalizeFalabellaFloat(variant?.price ?? variant?.publishPrice ?? prepared.price),
      SpecialPrice: variant?.SpecialPrice ?? variant?.special_price ?? variant?.sale_price ?? variant?.promotional_price ?? prepared.SpecialPrice ?? null,
      SpecialFromDate: variant?.SpecialFromDate ?? variant?.special_from_date ?? variant?.sale_start_date ?? prepared.SpecialFromDate ?? null,
      SpecialToDate: variant?.SpecialToDate ?? variant?.special_to_date ?? variant?.sale_end_date ?? prepared.SpecialToDate ?? null,
      stock: this.normalizeFalabellaInteger(variant?.publishStock ?? variant?.totalStock ?? variant?.stock ?? prepared.stock),
      attributes: this.buildFalabellaAttributes({
        ...prepared,
        sku: variantSku,
        productName: this.adjustFalabellaTextForVariation(productName, variationValue || variantSku),
        description: this.adjustFalabellaTextForVariation(productDescription, variationValue || variantSku),
        attributes: mergedAttributes,
        images: variantImages
      }),
      images: variantImages,
      ParentSku: undefined,
      category_attributes: prepared.category_attributes || categoryAttributes
    };
  }

  buildFalabellaIndependentVariantProducts(prepared, variants = [], categoryAttributes = []) {
    const publishableVariants = Array.isArray(variants)
      ? variants.filter((variant) => variant && variant.publish !== false)
      : [];

    if (publishableVariants.length === 0) {
      return [];
    }

    const products = [];
    const seenSkus = new Set();

    for (const variant of publishableVariants) {
      const product = this.buildFalabellaSimpleVariantProduct(prepared, variant, categoryAttributes);
      if (!product) continue;

      const normalizedSku = String(product.sku || '').trim();
      if (!normalizedSku || seenSkus.has(normalizedSku)) continue;

      seenSkus.add(normalizedSku);
      products.push(product);
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
    if (!product || !product.PrimaryCategory) {
      return product;
    }

    const categoryMetadata = await this.loadCategoryMetadata(product.PrimaryCategory);
    if (!categoryMetadata?.success) {
      return product;
    }

    const categoryAttributes = Array.isArray(categoryMetadata.attributes)
      ? categoryMetadata.attributes
      : [];

    if (!Array.isArray(product.attributes) || product.attributes.length === 0 || categoryAttributes.length === 0) {
      return {
        ...product,
        category_attributes: product.category_attributes || categoryAttributes,
        category_metadata: categoryMetadata
      };
    }

    const categoryAttributeMap = new Map(categoryAttributes.map((attr) => [this.normalizeFalabellaText(attr.feed_name || attr.id), attr]));
    const mergedAttributes = product.attributes.map((attr) => {
      const metadata = categoryAttributeMap.get(this.normalizeFalabellaText(attr.id));
      return metadata ? { ...metadata.raw, ...metadata, ...attr } : attr;
    });

    return {
      ...product,
      attributes: mergedAttributes,
      category_attributes: product.category_attributes || categoryAttributes,
      category_metadata: categoryMetadata
    };
  }

  async loadCategoryMetadata(categoryId) {
    const [attributesResponse, treeResponse] = await Promise.all([
      this.getCategoryAttributes(categoryId),
      this.getCategoryTree()
    ]);

    const categoryTree = Array.isArray(treeResponse?.categories)
      ? treeResponse.categories
      : [];
    const treeMatch = this.findCategoryInTree(categoryTree, String(categoryId));

    return {
      success: attributesResponse?.success === true,
      category_id: String(categoryId),
      category: treeMatch || null,
      tree: categoryTree,
      attributes: Array.isArray(attributesResponse?.attributes) ? attributesResponse.attributes : [],
      raw_attributes: attributesResponse?.raw || null,
      raw_tree: treeResponse?.raw || null,
      retrieved_at: new Date().toISOString(),
      source: {
        category_tree: treeResponse?.source || 'GetCategoryTree',
        category_attributes: attributesResponse?.source || 'GetCategoryAttributes'
      }
    };
  }

  async getCategoryTree() {
    try {
      const credentialStatus = await this.ensureValidCredentials();
      if (!credentialStatus.valid) {
        throw new Error('Credenciales inválidas');
      }

      const params = {
        Action: 'GetCategoryTree',
        Format: 'JSON',
        Timestamp: this.timestampMinus03(),
        UserID: this.credential.seller_email.trim(),
        Version: '1.0'
      };

      const { canonicalQuery, signatureEncoded } = this.buildSignedQuery(params);
      const apiUrl = `https://sellercenter-api.falabella.com?${canonicalQuery}&Signature=${signatureEncoded}`;
      const response = await axios.get(apiUrl, { timeout: 10000 });
      const tree = response.data?.SuccessResponse?.Body?.Categories?.Category || [];
      return {
        success: true,
        categories: Array.isArray(tree) ? tree : [tree],
        raw: response.data,
        source: 'GetCategoryTree'
      };
    } catch (error) {
      logger.error(`[FalabellaAdapter] Error obteniendo árbol de categorías: ${error.message}`);
      return { success: false, categories: [], raw: error.response?.data || null, source: 'GetCategoryTree' };
    }
  }

  // 🔑 Obtener atributos oficiales de categoría
  async getCategoryAttributes(categoryId) {
    try {
      const credentialStatus = await this.ensureValidCredentials();
      if (!credentialStatus.valid) {
        throw new Error('Credenciales inválidas');
      }

      const params = {
        Action: 'GetCategoryAttributes',
        Format: 'JSON',
        PrimaryCategory: String(categoryId),
        Timestamp: this.timestampMinus03(),
        UserID: this.credential.seller_email.trim(),
        Version: '1.0'
      };

      const { canonicalQuery, signatureEncoded } = this.buildSignedQuery(params);
      const apiUrl = `https://sellercenter-api.falabella.com?${canonicalQuery}&Signature=${signatureEncoded}`;
      const response = await axios.get(apiUrl, { timeout: 10000 });

      const rawAttributes = response.data?.SuccessResponse?.Body?.Attribute;
      const items = Array.isArray(rawAttributes) ? rawAttributes : rawAttributes ? [rawAttributes] : [];

      return {
        success: true,
        source: 'GetCategoryAttributes',
        attributes: items
          .filter((attr) => attr && (attr.Name || attr.Label || attr.FeedName))
          .map((attr) => {
            const feedName = attr.FeedName || attr.Name || null;
            const name = attr.Name || attr.Label || feedName || null;
            const label = attr.Label || attr.Name || feedName || null;
            const inputType = attr.InputType || attr.input_type || null;
            const attributeType = attr.AttributeType || attr.attribute_type || null;
            const maxLength = this.normalizeFalabellaInteger(
              attr.MaxLength || attr.maxLength || attr.MaximumLength || attr.maximum_length
            );
            const mandatory = this.normalizeFalabellaBoolean(attr.isMandatory || attr.IsMandatory || attr.Mandatory);
            const isGlobalAttribute = this.normalizeFalabellaBoolean(attr.IsGlobalAttribute ?? attr.is_global_attribute);
            const options = attr.Options || null;
            const optionList = Array.isArray(attr.Options?.Option)
              ? attr.Options.Option
              : attr.Options?.Option
                ? [attr.Options.Option]
                : [];

            return {
              id: feedName,
              feed_name: feedName,
              name,
              label,
              mandatory,
              is_mandatory: mandatory,
              attributeType,
              attribute_type: attributeType,
              options,
              values: optionList.map((option) => ({
                id: option?.id ?? option?.Id ?? null,
                name: option?.Name ?? option?.name ?? null,
                value_name: option?.Name ?? option?.name ?? null,
                raw: option
              })).filter((option) => option.id !== null || option.name !== null),
              groupName: attr.GroupName || null,
              group_name: attr.GroupName || null,
              isGlobalAttribute,
              is_global_attribute: isGlobalAttribute,
              inputType,
              input_type: inputType,
              maxLength,
              max_length: maxLength,
              raw: attr
            };
          }),
        raw: response.data
      };
    } catch (error) {
      logger.error(`[FalabellaAdapter] Error obteniendo atributos: ${error.message}`);
      return { success: false, source: 'GetCategoryAttributes', attributes: [], raw: error.response?.data || null };
    }
  }

  resolveFalabellaVariationCapability(categoryAttributes = []) {
    const normalized = Array.isArray(categoryAttributes) ? categoryAttributes : [];
    const variationNode = normalized.find((attr) => this.normalizeFalabellaText(attr?.feed_name || attr?.FeedName || attr?.id) === 'variation');
    const multiVariationAttributes = normalized.filter((attr) => this.isVariationAttribute(attr));
    const supportsMultiVariation = !variationNode && multiVariationAttributes.length > 0;
    const reason = variationNode
      ? 'La categoría expone FeedName=Variation, por lo que solo admite publicación simple por variante'
      : (multiVariationAttributes.length > 0
        ? 'La categoría expone atributos generadores de multivariante con GroupName=Variation e IsGlobalAttribute=0'
        : 'No se encontraron atributos oficiales suficientes para multivariante');

    return {
      supportsMultiVariation,
      simpleVariationAttribute: variationNode || null,
      multiVariationAttributes,
      reason,
      evidence: {
        variation_node: variationNode || null,
        multi_variation_attributes: multiVariationAttributes,
        category_attributes_count: normalized.length
      }
    };
  }

  findCategoryInTree(nodes, targetCategoryId, path = []) {
    const nodeList = Array.isArray(nodes) ? nodes : (nodes ? [nodes] : []);
    for (const node of nodeList) {
      const currentName = String(node?.Name || '').trim();
      const currentPath = currentName ? [...path, currentName] : [...path];
      if (String(node?.CategoryId || '').trim() === String(targetCategoryId || '').trim()) {
        return {
          level1: currentPath[0] || null,
          level2: currentPath[1] || null,
          level3: currentPath[2] || null,
          level4: currentPath[3] || null,
          api_name: currentName || null,
          category_id: String(node?.CategoryId || '').trim() || null,
          raw: node
        };
      }

      if (node?.Children?.Category) {
        const result = this.findCategoryInTree(node.Children.Category, targetCategoryId, currentPath);
        if (result) return result;
      }
    }

    return null;
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

    const attributePackageMeasurements = this.resolvePackageMeasurementsFromAttributes(product);
    const packageMeasurements = {
      package_height: attributePackageMeasurements.package_height ?? this.normalizeFalabellaFloat(product.package_height),
      package_width: attributePackageMeasurements.package_width ?? this.normalizeFalabellaFloat(product.package_width),
      package_length: attributePackageMeasurements.package_length ?? this.normalizeFalabellaFloat(product.package_length),
      package_weight: attributePackageMeasurements.package_weight ?? this.normalizeFalabellaFloat(product.package_weight)
    };

    for (const [field, value] of Object.entries(packageMeasurements)) {
      if (value === null) {
        errors.push(`Campo requerido ausente: ${field}`);
      }
    }

    const operatorCode = this.resolveFalabellaOperatorCode(product);
    if (!operatorCode) {
      errors.push('Campo requerido ausente: OperatorCode');
    }

    const hasConditionType = Array.isArray(product?.attributes)
      ? product.attributes.some((attr) => this.normalizeFalabellaText(attr?.id || attr?.feed_name || attr?.FeedName || '') === 'conditiontype')
      : false;
    if (!hasConditionType) {
      errors.push('Campo requerido ausente: ConditionType');
    }

    const normalizedImages = this.normalizeFalabellaImages(product?.images || []);
    if (normalizedImages.length === 0) {
      errors.push('Se requiere al menos una imagen válida para Falabella');
    }

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

    if (Array.isArray(product?.falabella_publication_items) && product.falabella_publication_items.length > 0) {
      const skus = product.falabella_publication_items
        .map((item) => String(item?.sku || '').trim())
        .filter(Boolean);
      const uniqueSkus = new Set(skus);
      if (skus.length !== uniqueSkus.size) {
        errors.push('Las publicaciones independientes de Falabella contienen SKUs duplicados');
      }

      for (const item of product.falabella_publication_items) {
        const itemSku = String(item?.sku || '').trim();
        if (!itemSku) {
          errors.push('Cada publicación independiente de Falabella debe tener un SellerSku válido');
          continue;
        }

        const itemVariation = Array.isArray(item?.attributes)
          ? item.attributes.find((attr) => this.normalizeFalabellaText(attr?.id || attr?.feed_name || attr?.FeedName || '') === 'variation')
          : null;
        const itemVariationValue = this.normalizeFalabellaAttributeValue(itemVariation);
        if (!itemVariationValue) {
          errors.push(`La publicación independiente SKU ${itemSku} requiere el atributo Variation con un valor real`);
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

    this.logPublishPayloadMarker({
      label: 'product_create_or_update',
      action: product?.__falabella_action || 'ProductCreate',
      sku: product?.sku || null,
      payload: xml
    });

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
    const name = String(product.productName || '').substring(0, 255);
    const brandAttr = Array.isArray(product.attributes)
      ? product.attributes.find((a) => this.normalizeFalabellaText(a.id) === 'brand')
      : null;
    const brand = String(brandAttr?.value_name || brandAttr?.value || product.brand || '').substring(0, 50);
    const description = String(product.description || '').substring(0, 25000);
    const categoryId = Number(product.PrimaryCategory);
    const priceValue = this.normalizeFalabellaFloat(product.price);
    const stockValue = this.normalizeFalabellaInteger(product.stock);
    const price = priceValue !== null ? priceValue.toFixed(2) : undefined;
    const stock = stockValue !== null ? Math.max(0, stockValue) : undefined;
    const offer = this.resolveFalabellaOffer(product, priceValue);
    const marketplaceProductId = this.resolveMarketplaceProductId(product);
    const operatorCode = this.getFalabellaOperatorCode();

    const validateDimension = (value, fieldName) => {
      const numValue = Number(value);
      if (!Number.isFinite(numValue) || numValue <= 0) {
        logger.warn(`[FalabellaAdapter] ⚠️ ${fieldName} valor ${value} fuera de rango o ausente`);
        return null;
      }
      if (numValue > 303) {
        logger.warn(`[FalabellaAdapter] ⚠️ ${fieldName} valor ${value} fuera de rango`);
        return null;
      }
      return numValue;
    };

    const getAttributeValue = (attrId, fallback) => {
      const attr = Array.isArray(product.attributes)
        ? product.attributes.find((a) => a.id === attrId)
        : null;
      return attr?.value_name || attr?.value || fallback;
    };

    const height = validateDimension(getAttributeValue('PackageHeight', product.package_height), 'PackageHeight');
    const width = validateDimension(getAttributeValue('PackageWidth', product.package_width), 'PackageWidth');
    const length = validateDimension(getAttributeValue('PackageLength', product.package_length), 'PackageLength');
    const weightValue = Number(getAttributeValue('PackageWeight', product.package_weight));
    const weight = Number.isFinite(weightValue) && weightValue >= 0.001 ? weightValue : null;

    const effectiveAttributes = this.buildFalabellaAttributes(product);
    const variationAttributes = Array.isArray(effectiveAttributes)
      ? effectiveAttributes.filter((attr) => this.isVariationAttribute(attr))
      : [];
    const variationField = Array.isArray(effectiveAttributes)
      ? effectiveAttributes.find((attr) => this.normalizeFalabellaText(attr?.id) === 'variation')
      : null;
    const variationValue = this.normalizeFalabellaAttributeValue(variationField);
    const conditionTypeAttr = Array.isArray(effectiveAttributes)
      ? effectiveAttributes.find((a) => this.normalizeFalabellaText(a.id) === 'conditiontype')
      : null;
    const conditionType = this.normalizeFalabellaAttributeValue(conditionTypeAttr);

    const productDataAttrs = {
      ...(conditionType ? { ConditionType: conditionType } : {}),
      ...(height !== null ? { PackageHeight: height } : {}),
      ...(width !== null ? { PackageWidth: width } : {}),
      ...(length !== null ? { PackageLength: length } : {}),
      ...(weight !== null ? { PackageWeight: weight.toFixed(3) } : {})
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
        if (this.isFalabellaDateAttribute(feedName)) {
          value = this.normalizeFalabellaDateValue(value);
        }
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
      SellerSku: sku || undefined,
      Name: name || undefined,
      PrimaryCategory: Number.isFinite(categoryId) ? String(categoryId) : undefined,
      Description: description || undefined,
      Brand: brand || undefined,
      Variation: variationValue || undefined,
      BusinessUnits: {
        BusinessUnit: {
          OperatorCode: operatorCode || undefined,
          Price: price,
          ...(offer || {}),
          Stock: stock !== undefined ? String(stock) : undefined,
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
      this.logPublishPayloadMarker({
        label: 'publish',
        action,
        sku: transformedProduct.sku,
        payload: xmlPayload
      });

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

        const imagesPendingCount = this.normalizeFalabellaImages(transformedProduct.images || []).length;
        const normalizedImages = [];
        const imageUploadResult = imagesPendingCount > 0
          ? {
              success: false,
              skipped: true,
              pending: true,
              reason: 'awaiting_product_create_feed',
              images_count: imagesPendingCount
            }
          : { success: true, skipped: true, pending: false, images_count: 0 };

        // Falabella confirma la aceptación inicial con RequestId.
        // La confirmación final del estado se obtiene por FeedStatus; el webhook onFeedCompleted
        // queda como mecanismo de reconciliación asíncrona.
        logger.info(`[FalabellaAdapter] ✅ Feed aceptado por Falabella. FeedID: ${requestId}`);
        const marketplaceMessage = `Falabella emitió FeedID: ${requestId}; confirmar luego con FeedStatus`;

        const immediateFeedResult = action === 'ProductCreate'
          ? await this.resolveImmediateProductCreateFeedResult({
              transformedProduct,
              requestId,
              imageUploadResult
            })
          : null;

        if (immediateFeedResult?.success === false) {
          return immediateFeedResult;
        }

        const immediateFeedResultData = immediateFeedResult?.feed_result || null;
        const immediateFeedData = immediateFeedResultData?.data || null;
        const finalImageUploadResult = immediateFeedData?.image_upload || imageUploadResult;
        const finalWarnings = Array.isArray(immediateFeedResultData?.warnings)
          ? immediateFeedResultData.warnings
          : [];
        const finalHasWarnings = immediateFeedResultData?.has_warnings === true || finalWarnings.length > 0;

        return {
          success: true,
          external_id: transformedProduct.sku,
          data: {
            feed_id: requestId,
            action: action,
            status: 'processing',
            feed_status_result: immediateFeedData,
            feed_confirmed: Boolean(immediateFeedData?.feed_confirmed),
            sku: transformedProduct.sku,
            published_skus: Array.isArray(transformedProduct.falabella_products)
              ? transformedProduct.falabella_products.map((item) => item?.sku).filter(Boolean)
              : [transformedProduct.sku].filter(Boolean),
            has_variants: Array.isArray(transformedProduct.falabella_products)
              && transformedProduct.falabella_products.length > 1,
            category_id: transformedProduct.PrimaryCategory,
            category_name: transformedProduct.categoryName,
            image_upload: finalImageUploadResult
          },
          has_warnings: finalHasWarnings,
          warnings: finalWarnings,
          warning_message: immediateFeedResultData?.warning_message || (normalizedImages.length > 0 && finalImageUploadResult?.success === false
            ? `${marketplaceMessage}. La subida de imágenes falló y debe reintentarse.`
            : marketplaceMessage),
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
  if (!operatorCode) {
    return null;
  }
  const businessUnit = {
    OperatorCode: operatorCode
  };

  if (status !== undefined && status !== null && String(status).trim() !== '') {
    businessUnit.Status = String(status).trim().toLowerCase();
  }

  if (price !== undefined && price !== null && String(price).trim() !== '') {
    const parsedPrice = this.normalizeFalabellaFloat(price);
    if (parsedPrice === null) {
      return null;
    }
    businessUnit.Price = parsedPrice.toFixed(2);
  }

  if (available_quantity !== undefined && available_quantity !== null && String(available_quantity).trim() !== '') {
    const parsedQuantity = this.normalizeFalabellaInteger(available_quantity);
    if (parsedQuantity === null) {
      return null;
    }
    businessUnit.Stock = String(Math.max(0, parsedQuantity));
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
    return this.resolveFalabellaOperatorCode();
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

      if (!xmlPayload) {
        return {
          success: false,
          error: 'missing_required_metadata',
          details: {
            field: 'OperatorCode',
            message: 'No se pudo construir el XML de actualización por falta de metadata obligatoria'
          }
        };
      }

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
      this.logPublishPayloadMarker({
        label: 'update',
        action: 'ProductUpdate',
        sku: normalizedSku,
        payload: xmlPayload
      });

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
      this.logPublishPayloadMarker({
        label: 'image',
        action: 'Image',
        sku,
        payload: xmlPayload
      });

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
