// src/services/adapters/MercadoLibreAdapter.js
const BaseAdapter = require("./BaseAdapter");
const logger = require("../../../config/logger");
const { MarketplaceCredentialRepository } = require("../../repositories");
const axios = require('axios');
const MarketplaceTransformerMercadoLibre = require("../MarketplaceTransformerMercadoLibre");
const MercadoLibreAttributesService = require('../MercadoLibreAttributesService');
const MercadoLibreCapabilitiesService = require('../MercadoLibreCapabilitiesService');
const { verifyMercadoLibreItem, resolveExistingItemModel } = require('../MarketplaceItemVerificationService');

const ML_SUPPORTED_LISTING_TYPES = ['gold_pro', 'gold_special', 'free'];
const ML_STRATEGY = {
  CONVERSION: 'CONVERSION',
  MARGIN: 'MARGIN'
};

function normalizeListingTypeId(listingType) {
  const normalized = listingType === 'bronze' ? 'gold_special' : listingType;
  if (!normalized) return null;
  return ML_SUPPORTED_LISTING_TYPES.includes(normalized) ? normalized : null;
}

function normalizeStrategyForPublish(strategy, legacyListingTypeId) {
  const raw = String(strategy || '').trim().toUpperCase();
  if (raw === ML_STRATEGY.CONVERSION) return ML_STRATEGY.CONVERSION;
  if (raw === ML_STRATEGY.MARGIN || raw === 'PROFIT') return ML_STRATEGY.MARGIN;
  if (legacyListingTypeId === 'gold_pro') return ML_STRATEGY.CONVERSION;
  if (legacyListingTypeId) return ML_STRATEGY.MARGIN;
  return ML_STRATEGY.CONVERSION;
}

function createMercadoLibreError({
  operation,
  itemModel,
  itemId = null,
  userProductId = null,
  sellerSku = null,
  categoryId = null,
  field = null,
  receivedValue = null,
  code = null,
  message = null,
  metadataSource = null,
  retryable = false,
  rawMarketplaceError = null
}) {
  return {
    marketplace: 'mercado_libre',
    operation,
    itemModel,
    itemId,
    userProductId,
    sellerSku,
    categoryId,
    field,
    receivedValue,
    code,
    message,
    metadataSource,
    retryable,
    rawMarketplaceError
  };
}

function parseJsonObject(value) {
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

function isMercadoLibreParentPkAttribute(attr) {
  const hierarchy = String(attr?.hierarchy || '').trim().toUpperCase();
  return attr?.tags?.parent_pk === true || attr?.tags?.family === true || hierarchy === 'PARENT_PK' || hierarchy === 'FAMILY';
}

function isMercadoLibreChildPkAttribute(attr) {
  const hierarchy = String(attr?.hierarchy || '').trim().toUpperCase();
  return attr?.tags?.child_pk === true || hierarchy === 'CHILD_PK';
}

function isMercadoLibreRequiredAttribute(attr) {
  return attr?.required === true ||
    attr?.tags?.required === true ||
    attr?.tags?.new_required === true ||
    attr?.tags?.catalog_required === true;
}

function getMercadoLibreAttributeValue(attributes, attributeId) {
  const sourceAttributes = Array.isArray(attributes) ? attributes : [];
  const match = sourceAttributes.find((attr) => String(attr?.id || '').trim() === String(attributeId || '').trim());
  if (!match) return null;
  const value = match.value_name ?? match.value ?? match.value_id;
  return value !== undefined && value !== null ? String(value).trim() : null;
}

function shouldRequireMercadoLibreChildPkAttribute(attr, resolvedAttributes = []) {
  const attributeId = String(attr?.id || '').trim();
  if (!isMercadoLibreRequiredAttribute(attr)) {
    return false;
  }

  if (attributeId === 'PACKS_NUMBER') {
    const saleFormat = getMercadoLibreAttributeValue(resolvedAttributes, 'SALE_FORMAT');
    const unitsPerPack = Number(getMercadoLibreAttributeValue(resolvedAttributes, 'UNITS_PER_PACK'));
    const isPackSale = /pack/i.test(String(saleFormat || '')) || String(saleFormat || '') === '1359392';
    return isPackSale && Number.isFinite(unitsPerPack) && unitsPerPack > 1;
  }

  return true;
}

function isMercadoLibreHiddenOrReadOnlyAttribute(attr) {
  return attr?.tags?.hidden === true || attr?.tags?.read_only === true || attr?.id === 'ITEM_CONDITION';
}

function normalizeMercadoLibreSaleTerms(saleTerms) {
  if (!Array.isArray(saleTerms)) return [];
  return saleTerms
    .map((saleTerm) => {
      if (!saleTerm || typeof saleTerm !== 'object') return null;
      const id = String(saleTerm.id || '').trim();
      if (!id) return null;
      const normalized = { id };
      if (saleTerm.value_name !== undefined && saleTerm.value_name !== null) {
        normalized.value_name = String(saleTerm.value_name).trim();
      }
      if (saleTerm.value_id !== undefined && saleTerm.value_id !== null) {
        normalized.value_id = String(saleTerm.value_id).trim();
      }
      return normalized;
    })
    .filter(Boolean);
}

function normalizePictureKey(picture) {
  if (!picture || typeof picture !== 'object') return null;
  return String(picture.source || picture.id || picture.url || '').trim() || null;
}

function mergeUniquePictures(...pictureGroups) {
  const seen = new Set();
  const merged = [];

  for (const group of pictureGroups) {
    const pictures = Array.isArray(group) ? group : [];
    for (const picture of pictures) {
      const key = normalizePictureKey(picture);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      if (typeof picture === 'string') {
        merged.push({ source: picture });
      } else if (picture && typeof picture === 'object') {
        merged.push(picture.source ? { ...picture } : { source: key });
      }
    }
  }

  return merged;
}

function resolveMercadoLibreCommercialFields(productData, { operation, itemModel, categoryId = null, sellerSku = null, metadataSource = 'product payload' } = {}) {
  const buyingMode = String(productData?.buying_mode ?? '').trim().toLowerCase();
  if (!buyingMode) {
    return {
      __blocked_error: createMercadoLibreError({
        operation,
        itemModel,
        categoryId,
        sellerSku,
        field: 'buying_mode',
        receivedValue: null,
        code: 'missing_buying_mode',
        message: 'No se pudo determinar buying_mode para Mercado Libre',
        metadataSource
      })
    };
  }

  if (buyingMode !== 'buy_it_now') {
    return {
      __blocked_error: createMercadoLibreError({
        operation,
        itemModel,
        categoryId,
        sellerSku,
        field: 'buying_mode',
        receivedValue: buyingMode,
        code: 'invalid_buying_mode',
        message: `buying_mode no soportado: ${buyingMode}`,
        metadataSource
      })
    };
  }

  const condition = String(productData?.condition ?? '').trim().toLowerCase();
  if (!condition) {
    return {
      __blocked_error: createMercadoLibreError({
        operation,
        itemModel,
        categoryId,
        sellerSku,
        field: 'condition',
        receivedValue: null,
        code: 'missing_condition',
        message: 'No se pudo determinar condition para Mercado Libre',
        metadataSource
      })
    };
  }

  if (!['new', 'used', 'not_specified'].includes(condition)) {
    return {
      __blocked_error: createMercadoLibreError({
        operation,
        itemModel,
        categoryId,
        sellerSku,
        field: 'condition',
        receivedValue: condition,
        code: 'invalid_condition',
        message: `condition no soportada: ${condition}`,
        metadataSource
      })
    };
  }

  return { buying_mode: buyingMode, condition };
}

function resolveInstallmentsForPublish(siteId, listingTypeId) {
  if (siteId !== 'MLA') {
    return {
      source: 'official_listing_type_policy',
      enabled: false,
      interest_free: false,
      max_installments: null
    };
  }

  if (listingTypeId === 'gold_pro') {
    return {
      source: 'official_listing_type_policy',
      enabled: true,
      interest_free: true,
      max_installments: 6
    };
  }

  return {
    source: 'official_listing_type_policy',
    enabled: false,
    interest_free: false,
    max_installments: null
  };
}

function normalizeCredentialKey(value) {
  if (value === undefined || value === null) return null;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && asNumber > 0) {
    return String(asNumber);
  }
  const asString = String(value).trim();
  return asString || null;
}

function pickMlDataForCredential(mlConfigByCredential, credentialId) {
  if (!mlConfigByCredential || typeof mlConfigByCredential !== 'object') return null;

  const normalizedCredentialKey = normalizeCredentialKey(credentialId);
  if (normalizedCredentialKey && mlConfigByCredential[normalizedCredentialKey]) {
    return mlConfigByCredential[normalizedCredentialKey];
  }

  const allKeys = Object.keys(mlConfigByCredential);
  if (allKeys.length === 0) return null;

  // Fallback legacy: usar primer bloque disponible si no coincide credential_id.
  return mlConfigByCredential[allKeys[0]];
}

function extractWarrantyMonths(productData) {
  if (!productData || typeof productData !== 'object') return null;

  const rawMonths = productData.warranty_months;
  const warrantyMonths = Number(rawMonths);

  if (!Number.isFinite(warrantyMonths) || warrantyMonths < 0) {
    return null;
  }

  return Number.isInteger(warrantyMonths)
    ? warrantyMonths
    : Number(warrantyMonths.toFixed(2));
}

function normalizeMercadoLibreTermValue(source = {}) {
  if (!source || typeof source !== 'object') return null;

  const term = {};
  if (source.value_id !== undefined && source.value_id !== null && String(source.value_id).trim()) {
    term.value_id = String(source.value_id).trim();
  }
  if (source.value_name !== undefined && source.value_name !== null && String(source.value_name).trim()) {
    term.value_name = String(source.value_name).trim();
  }
  return Object.keys(term).length > 0 ? term : null;
}

function findMercadoLibreTermSource(productData, termId) {
  const id = String(termId || '').trim();
  if (!productData || typeof productData !== 'object' || !id) return null;

  const sourceGroups = [
    productData.sale_terms,
    productData.attributes,
    productData.__ml_marketplace_attributes
  ];

  for (const group of sourceGroups) {
    if (!Array.isArray(group)) continue;
    const found = group.find((entry) => String(entry?.id || '').trim() === id);
    const normalized = normalizeMercadoLibreTermValue(found);
    if (normalized) return normalized;
  }

  if (id === 'WARRANTY_TYPE') {
    return normalizeMercadoLibreTermValue({
      value_id: productData.warranty_type_id,
      value_name: productData.warranty_type || productData.warranty_type_name
    });
  }

  if (id === 'WARRANTY_TIME') {
    return normalizeMercadoLibreTermValue({
      value_name: productData.warranty_time || productData.warranty_time_name
    });
  }

  return null;
}

function buildWarrantySaleTerms(productData) {
  const termsById = new Map();
  for (const term of normalizeMercadoLibreSaleTerms(productData?.sale_terms || [])) {
    termsById.set(term.id, term);
  }

  const warrantyType = findMercadoLibreTermSource(productData, 'WARRANTY_TYPE');
  if (warrantyType) {
    termsById.set('WARRANTY_TYPE', { id: 'WARRANTY_TYPE', ...warrantyType });
  }

  const explicitWarrantyTime = findMercadoLibreTermSource(productData, 'WARRANTY_TIME');
  if (explicitWarrantyTime) {
    termsById.set('WARRANTY_TIME', { id: 'WARRANTY_TIME', ...explicitWarrantyTime });
    return Array.from(termsById.values());
  }

  const warrantyMonths = extractWarrantyMonths(productData);

  if (warrantyMonths === null) {
    return Array.from(termsById.values());
  }

  const warrantyUnit = warrantyMonths === 1 ? 'mes' : 'meses';

  termsById.set('WARRANTY_TIME', {
    id: 'WARRANTY_TIME',
    value_name: `${warrantyMonths} ${warrantyUnit}`
  });

  return Array.from(termsById.values());
}

class MercadoLibreAdapter extends BaseAdapter {
  static supportsCategoryPrediction() {
    return true;
  }

  static getTransformer() {
    return MarketplaceTransformerMercadoLibre;
  }

  extractNumericValue(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'string') {
      const normalized = value.trim().replace(',', '.');
      if (!normalized) return null;
      const parsed = Number(normalized);
      return Number.isFinite(parsed) ? parsed : null;
    }
    if (typeof value === 'object' && value !== null) {
      if ('value' in value) return this.extractNumericValue(value.value);
      if ('number' in value) return this.extractNumericValue(value.number);
    }
    return null;
  }

  resolveMercadoLibreUnit(unit, attrMeta = null) {
    const normalizedUnit = String(unit || '').trim().toLowerCase();
    const allowedUnits = Array.isArray(attrMeta?.allowed_units) ? attrMeta.allowed_units : [];
    const defaultUnit = String(attrMeta?.default_unit || '').trim().toLowerCase();

    const candidates = [normalizedUnit, defaultUnit].filter(Boolean);
    for (const candidate of candidates) {
      const match = allowedUnits.find((allowed) => {
        const allowedId = String(allowed?.id || '').trim().toLowerCase();
        const allowedName = String(allowed?.name || '').trim().toLowerCase();
        return candidate === allowedId || candidate === allowedName;
      });

      if (match) {
        return match.id || match.name || candidate;
      }
    }

    if (allowedUnits.length > 0) {
      const fallback = allowedUnits[0];
      return fallback?.id || fallback?.name || normalizedUnit || defaultUnit || null;
    }

    return normalizedUnit || defaultUnit || null;
  }

  formatMercadoLibreAttribute(attr, attrMeta = null) {
    if (!attr || !attr.id) return null;

    const valueType = String(attrMeta?.value_type || '').trim().toLowerCase();
    const rawValue = attr.value_name ?? attr.value ?? attr.value_struct?.number ?? null;
    const rawUnit = attr.unit ?? attr.value_struct?.unit ?? null;

    if (valueType === 'number_unit') {
      const numericValue = this.extractNumericValue(rawValue);
      const resolvedUnit = this.resolveMercadoLibreUnit(rawUnit, attrMeta);

      if (numericValue === null) {
        logger.warn(`[ML Adapter] ⚠️ Atributo ${attr.id} ignorado: no se pudo obtener valor numérico válido`);
        return null;
      }

      const processedValue = Number.isInteger(numericValue)
        ? String(numericValue)
        : String(numericValue).replace(/\.0+$/, '');

      const formattedValue = resolvedUnit
        ? `${processedValue} ${resolvedUnit}`
        : processedValue;

      if (!resolvedUnit) {
        logger.warn(`[ML Adapter] ⚠️ Atributo ${attr.id} sin unidad válida; se enviará solo el valor numérico`);
      }

      logger.info(`[ML Adapter] ✅ Atributo ${attr.id} formateado para ML: "${formattedValue}"`);

      return {
        id: attr.id,
        value_name: formattedValue
      };
    }

    if (String(attr.id).trim() === 'BRAND') {
      const rawValueName = attr.value_name != null ? String(attr.value_name).trim() : '';
      const rawValueId = attr.value_id != null ? String(attr.value_id).trim() : '';
      const allowCustomValue = attrMeta?.tags?.allow_custom_value === true;
      const categoryValues = Array.isArray(attrMeta?.values) ? attrMeta.values : [];

      const matchById = rawValueId
        ? categoryValues.find((value) => String(value?.id || '').trim() === rawValueId)
        : null;
      const matchByName = rawValueName
        ? categoryValues.find((value) =>
            this.normalizeForComparison(value?.name || value?.value_name || '') ===
            this.normalizeForComparison(rawValueName)
          )
        : null;
      const idLooksLikeText = rawValueId && /[a-zA-Z]/.test(rawValueId);

      const processedBrand = { id: attr.id };
      const resolvedValueId = matchById?.id || matchByName?.id || (!idLooksLikeText ? rawValueId : null) || null;
      const resolvedValueName = matchById?.name || matchByName?.name || rawValueName || (idLooksLikeText ? rawValueId : null);

      if (resolvedValueId) {
        processedBrand.value_id = String(resolvedValueId).trim();
      }

      if (resolvedValueName && (allowCustomValue || processedBrand.value_id || idLooksLikeText)) {
        processedBrand.value_name = String(resolvedValueName).trim();
      }

      if (!processedBrand.value_name && rawValueName) {
        processedBrand.value_name = rawValueName;
      }

      return processedBrand;
    }

    const processed = {
      id: attr.id,
      value_name: attr.value_name ? String(attr.value_name).trim() : undefined,
      value_id: attr.value_id ? String(attr.value_id).trim() : undefined
    };

    if (['true', 'false'].includes(String(processed.value_name).toLowerCase())) {
      processed.value_name = String(processed.value_name).toLowerCase() === 'true' ? 'Sí' : 'No';
      logger.info(`[ML Adapter] ✅ Convertido valor booleano para ${attr.id}: "${processed.value_name}"`);
    }

    return processed;
  }

  enrichMercadoLibreParentAttributes(rawAttributes = [], productData = {}, categoryAttributes = []) {
    const attributes = Array.isArray(rawAttributes)
      ? rawAttributes.filter(Boolean).map((attr) => ({ ...attr }))
      : [];
    const readAttributeValue = (attr) => String(
      attr?.value_name ?? attr?.value ?? attr?.value_id ?? ''
    ).trim();
    const byId = new Set(
      attributes
        .filter((attr) => readAttributeValue(attr))
        .map((attr) => String(attr?.id || '').trim())
        .filter(Boolean)
    );
    const categoryIds = new Set(
      (Array.isArray(categoryAttributes) ? categoryAttributes : [])
        .map((attr) => String(attr?.id || '').trim())
        .filter(Boolean)
    );

    const addIfMissing = (id, value, extra = {}) => {
      const normalizedId = String(id || '').trim();
      if (!normalizedId || byId.has(normalizedId)) return;
      if (categoryIds.size > 0 && !categoryIds.has(normalizedId)) return;
      if (value === undefined || value === null || String(value).trim() === '') return;
      attributes.push({
        id: normalizedId,
        value_name: String(value).trim(),
        ...extra
      });
      byId.add(normalizedId);
    };

    addIfMissing('BRAND', productData.brand);
    addIfMissing('MODEL', productData.model);
    const gtinMeta = (Array.isArray(categoryAttributes) ? categoryAttributes : [])
      .find((attr) => String(attr?.id || '').trim() === 'GTIN');
    const gtinRequiredByCategory = !!gtinMeta && (
      gtinMeta?.tags?.required === true ||
      gtinMeta?.tags?.catalog_required === true ||
      gtinMeta?.tags?.conditional_required === true ||
      gtinMeta?.tags?.new_required === true ||
      gtinMeta?.tags?.validate === true ||
      gtinMeta?.type === 'product_identifier'
    );
    const existingGtin = attributes.find((attr) => String(attr?.id || '').trim() === 'GTIN');
    const gtinSeed = productData.gtin || productData.ean || productData.upc || readAttributeValue(existingGtin);
    const generatedGtinSeed = productData.sku || productData.id || productData.name;
    const resolvedGtin = gtinSeed || (gtinRequiredByCategory ? this.generateValidGTIN(generatedGtinSeed) : null);

    if (resolvedGtin) {
      const normalizedGtin = this.generateValidGTIN(resolvedGtin);
      if (existingGtin) {
        existingGtin.value_name = normalizedGtin;
        byId.add('GTIN');
      } else {
        addIfMissing('GTIN', normalizedGtin);
      }
    }
    addIfMissing('SELLER_SKU', productData.sku);

    addIfMissing('PACKAGE_HEIGHT', productData.height_cm, { unit: 'cm' });
    addIfMissing('PACKAGE_WIDTH', productData.width_cm, { unit: 'cm' });
    addIfMissing('PACKAGE_LENGTH', productData.length_cm, { unit: 'cm' });
    addIfMissing('PACKAGE_WEIGHT', productData.weight_grams, { unit: 'g' });
    addIfMissing('SELLER_PACKAGE_WEIGHT', productData.weight_grams, { unit: 'g' });

    return attributes;
  }

  logPublishPayloadMarker({ label, model, sku = null, itemId = null, payload }) {
    const marker = [
      '========== [MELI][PAYLOAD_TO_SEND] ==========' ,
      `label=${label}`,
      `model=${model}`,
      `sku=${sku || 'n/a'}`,
      `item_id=${itemId || 'n/a'}`,
      '============================================='
    ].join(' | ');

    logger.info(`[MercadoLibreAdapter] ${marker}`);

    try {
      logger.info(JSON.stringify(payload, null, 2));
    } catch (error) {
      logger.info(String(payload));
    }
  }

  buildMercadoLibreAttributes(attributes, categoryAttributes = []) {
    if (!Array.isArray(attributes) || attributes.length === 0) return [];

    const categoryAttributesMap = new Map(
      (Array.isArray(categoryAttributes) ? categoryAttributes : []).map((attr) => [attr.id, attr])
    );

    return attributes
      .filter(attr => attr && attr.id && (attr.value_name || attr.value_id || attr.value !== undefined || attr.unit || attr.value_struct))
      .filter(attr => {
        if (attr.id === 'ITEM_CONDITION') {
          logger.warn(`[ML Adapter] ⚠️ Atributo ${attr.id} filtrado (ITEM_CONDITION viaja como condition)`);
          return false;
        }
        return true;
      })
      .map(attr => this.formatMercadoLibreAttribute(attr, categoryAttributesMap.get(attr.id)))
      .filter(Boolean);
  }

  // 🔑 NUEVO MÉTODO: Preprocesamiento específico de MercadoLibre
  async prepareProduct(productData) {
    logger.info('[MercadoLibreAdapter] Preparando producto para publicación', {
      productId: productData.id,
      name: productData.name,
      variantsCount: productData.variants?.length || 0
    });

    if (!productData.mercado_libre || Object.keys(productData.mercado_libre).length === 0) {
      throw new Error('No se encontró información de MercadoLibre para el producto');
    }

    const mlData = pickMlDataForCredential(productData.mercado_libre, this.credentialId);
    if (!mlData || typeof mlData !== 'object') {
      throw new Error('No se encontró configuración de MercadoLibre para la credencial seleccionada');
    }

    const shippingEffective = mlData?.shipping?.effective || {};
    const shippingRequested = mlData?.shipping?.requested || {};
    const listingTypeOverride = normalizeListingTypeId(mlData?.listing_type_id || null);
    const shippingModeOverride = shippingEffective.shipping_mode
      || shippingRequested.shipping_mode
      || mlData?.selection?.shipping_mode
      || mlData?.category?.selection?.shipping_mode
      || mlData?.quote?.selection?.shipping_mode
      || mlData?.calculation_result?.selection?.shipping_mode
      || mlData?.shipping_mode
      || null;
    const logisticTypeOverride = shippingEffective.logistic_type
      || shippingRequested.logistic_type
      || mlData?.selection?.logistic_type
      || mlData?.category?.selection?.logistic_type
      || mlData?.quote?.selection?.logistic_type
      || mlData?.calculation_result?.selection?.logistic_type
      || mlData?.logistic_type
      || null;
    let strategy = normalizeStrategyForPublish(mlData?.strategy, mlData?.listing_type_id || null);
    if (!mlData?.category?.category_id) {
      throw new Error('Falta category_id para MercadoLibre');
    }

    // ✅ PASO 1: Obtener SOLO metadatos de la categoría (catalog_domain, settings, allow_variations)
    await this.ensureValidCredentials();
    const categoryInfo = await this.getCategoryMetadata(
      mlData.category.category_id,
      this.credential?.access_token
    );
    const availableListingTypes = await this.getAvailableListingTypeIdsForCategory(
      mlData.category.category_id,
      this.credential?.access_token
    );
    const listingResolution = this.resolveListingTypeForPublish({
      strategy,
      requestedListingTypeId: listingTypeOverride,
      availableTypeIds: availableListingTypes
    });

    if (!listingResolution?.listing_type_id) {
      return {
        success: false,
        error: 'missing_listing_type_id',
        details: createMercadoLibreError({
          operation: 'create',
          itemModel: 'classic',
          categoryId: mlData.category.category_id,
          field: 'listing_type_id',
          receivedValue: listingTypeOverride || null,
          code: 'missing_listing_type_id',
          message: 'No se pudo determinar listing_type_id desde metadata oficial',
          metadataSource: 'GET /sites/{site_id}/listing_types + GET /users/{user_id}/available_listing_types'
        })
      };
    }

    // ✅ PASO 2: Determinar si es producto de catálogo
    const catalogDomain = categoryInfo.category?.settings?.catalog_domain || categoryInfo.settings?.catalog_domain;
    const isCatalogProduct = !!catalogDomain && catalogDomain !== "MLC-UNCLASSIFIED_PRODUCTS";
    const hasVariationAttributes = categoryInfo.hasVariationAttributes;
    const currencyId = this.resolveCurrencyIdForPublish(productData, categoryInfo);

    // ✅ PASO 3: Construir producto base
    const prepared = {
      category_id: mlData.category.category_id,
      price: Number(productData.price) || 0,
      currency_id: currencyId,
      available_quantity: Number(productData.totalStock) || 0,
      buying_mode: null,
      // Tipo por defecto soportado oficialmente.
      listing_type_id: listingResolution.listing_type_id,
      condition: null,
      shipping: null,
      sale_terms: [],
      attributes: [],
      pictures: productData.images || [],
      description: {
        plain_text: productData.description?.trim() || ''
      },
      category_settings: categoryInfo.category || categoryInfo.settings || {},
      __ml_has_variation_attributes: hasVariationAttributes,
      __ml_is_catalog_product: isCatalogProduct
    };

    // Resolver tipo de publicación automáticamente según estrategia y disponibilidad real.
    const installmentsConfig = resolveInstallmentsForPublish(this.getSiteId(), prepared.listing_type_id);
    const shippingPreferences = categoryInfo?.shippingPreferences || {};
    const categoryShippingPreferences = shippingPreferences.category || null;
    const userShippingPreferences = shippingPreferences.user || null;
    const shippingLogistics = Array.isArray(categoryShippingPreferences?.logistics)
      ? categoryShippingPreferences.logistics
      : [];
    const preferredLogisticEntry = shippingLogistics.find((entry) => entry?.mode && Array.isArray(entry?.types) && entry.types.length > 0) || null;
    const derivedShippingMode = shippingModeOverride
      || preferredLogisticEntry?.mode
      || (Array.isArray(userShippingPreferences?.modes) && userShippingPreferences.modes.includes('me2') ? 'me2' : null);
    const derivedLogisticType = logisticTypeOverride
      || (Array.isArray(preferredLogisticEntry?.types) ? preferredLogisticEntry.types[0] : null);
    if (derivedShippingMode || derivedLogisticType) {
      prepared.shipping = {
        ...(derivedShippingMode ? { mode: derivedShippingMode } : {}),
        ...(derivedLogisticType ? { logistic_type: derivedLogisticType } : {})
      };
    }
    prepared.__ml_selection = {
      strategy,
      installments: installmentsConfig,
      listing_resolution: listingResolution
    };
    
    if (productData.economic_config) {
      const config = productData.economic_config;
      
      if (config.allow_price_adjustment && config.min_margin && config.commission_rate) {
        const basePrice = Number(productData.price) || 0;
        const commissionRate = Number(config.commission_rate) || 0;
        const minMargin = Number(config.min_margin) / 100;
        
        const currentMargin = 1 - commissionRate;
        
        if (currentMargin < minMargin && basePrice > 0) {
          const adjustedPrice = basePrice / (1 - commissionRate - minMargin);
          const roundedPrice = Math.ceil(adjustedPrice / 10) * 10;
          
          prepared.price = roundedPrice;
          
          logger.info(`[ML Adapter] 💰 Precio ajustado: $${basePrice} → $${roundedPrice} (margen: ${(minMargin * 100)}%)`);
        }
      }
    }

    const commercialFields = resolveMercadoLibreCommercialFields(productData, {
      operation: 'create',
      itemModel: 'classic',
      categoryId: mlData.category.category_id,
      metadataSource: 'product payload'
    });

    if (commercialFields.__blocked_error) {
      throw new Error(commercialFields.__blocked_error.message);
    }

    prepared.buying_mode = commercialFields.buying_mode;
    prepared.condition = commercialFields.condition;

    // ✅ PASO 4: Aplicar family_name vs title según documentación oficial
    if (isCatalogProduct || hasVariationAttributes) {
      const familyName = (productData.family_name || productData.name || productData.title || 'Producto sin nombre')
        .toString()
        .trim();
      prepared.family_name = familyName;
      prepared.name = productData.name?.trim() || familyName;
      prepared.title = productData.title?.trim() || familyName;
      logger.info(`[ML Adapter] 📦 Producto de catálogo o con variaciones → family_name: "${prepared.family_name}"`);
    } else {
      const title = (productData.title || productData.name || productData.family_name || 'Producto sin título')
        .toString()
        .trim();
      prepared.title = title;
      prepared.name = productData.name?.trim() || title;
      logger.info(`[ML Adapter] 📦 Producto simple → title: "${prepared.title}"`);
    }

    // ✅ PASO 5: INCLUIR atributos del frontend + FILTRAR read_only/hidden/ITEM_CONDITION
    if (Array.isArray(mlData.attributes) && mlData.attributes.length > 0) {
      prepared.attributes = this.buildMercadoLibreAttributes(mlData.attributes, categoryInfo.attributes);
    }

    // ✅ PASO 6: Asegurar que GTIN esté incluido (requerido para esta categoría)
    const hasGTIN = prepared.attributes.some(attr => attr.id === 'GTIN');
    if (!hasGTIN) {
      const gtinSeed = productData.gtin || productData.ean || productData.upc || productData.sku || String(productData.id);
      const gtinValue = this.generateValidGTIN(gtinSeed);

      if (!mlData.attributes) {
        mlData.attributes = [];
      }

      const existingGtinIndex = mlData.attributes.findIndex(a => a.id === 'GTIN');
      if (existingGtinIndex === -1) {
        mlData.attributes.push({
          id: 'GTIN',
          value_name: gtinValue
        });
        logger.info(`[ML Adapter] ✅ GTIN agregado a mlData.attributes: ${gtinValue}`);
      } else {
        mlData.attributes[existingGtinIndex].value_name = gtinValue;
        logger.info(`[ML Adapter] ✅ GTIN actualizado en mlData.attributes: ${gtinValue}`);
      }
    }

    // ✅ PASO 7: Procesar garantía → sale_terms (según documentación oficial)
    const warrantySaleTerms = buildWarrantySaleTerms(productData);
    if (warrantySaleTerms.length > 0) {
      prepared.sale_terms.push(...warrantySaleTerms);
      logger.info(`[ML Adapter] ✅ Garantía añadida: ${warrantySaleTerms[0].value_name}`);
    }

    // ✅ PASO 8: Procesar variantes publicables
    const publishableVariants = (productData.variants || []).filter(v => v.publish && v.price > 0);
    const hasMultipleVariants = publishableVariants.length > 1;
    const hasSingleVariant = publishableVariants.length === 1;

    if (hasMultipleVariants && hasVariationAttributes) {
      // Múltiples variantes → construir array variations[]
      logger.info(`[ML Adapter] Producto con ${publishableVariants.length} variantes. Construyendo variations.`);
      
      const variationAttrIds = new Set(categoryInfo.variationAttributeIds || []);
      const baseAttributes = prepared.attributes.filter(a => !variationAttrIds.has(a.id));
      prepared.attributes = baseAttributes;
      
      const variations = this.buildValidMercadoLibreVariations(
        publishableVariants,
        categoryInfo.attributes,
        prepared.price,
        prepared.pictures
      );
      
      if (variations && variations.length >= 2) {
        prepared.variations = variations;
        logger.info(`[ML Adapter] ✅ Variaciones construidas: ${variations.length}`);
      } else {
        logger.warn(`[ML Adapter] ⚠️ No se construyeron variaciones válidas. Restaurando atributos.`);
        prepared.attributes = this.buildMercadoLibreAttributes(mlData.attributes, categoryInfo.attributes);
        prepared.variations = undefined;
      }
    } else if (hasSingleVariant) {
      // 1 variante → ML acepta atributos de variación en nivel base
      logger.info(`[ML Adapter] Producto con 1 variante. Permitiendo atributos de variación en nivel base.`);
      prepared.attributes = this.buildMercadoLibreAttributes(mlData.attributes, categoryInfo.attributes);
      
      const singleVariant = publishableVariants[0];
      prepared.available_quantity = Number(singleVariant.publishStock ?? singleVariant.totalStock ?? productData.totalStock) || 0;
      prepared.price = Number(singleVariant.price) || Number(productData.price) || 0;
      prepared.variations = undefined;
    } else {
      // Sin variantes
      logger.info(`[ML Adapter] Producto sin variantes publicables.`);
      prepared.variations = undefined;
    }

    logger.info(`[ML Adapter] ✅ Producto preparado para ML:`, {
      category_id: prepared.category_id,
      has_variations: !!prepared.variations,
      variations_count: prepared.variations?.length || 0,
      attributes_count: prepared.attributes?.length || 0,
      sale_terms_count: prepared.sale_terms?.length || 0,
      pictures_count: prepared.pictures?.length || 0,
      has_family_name: !!prepared.family_name,
      has_title: !!prepared.title,
      is_catalog: isCatalogProduct
    });

    return prepared;
  }

  async getAvailableListingTypeIdsForCategory(categoryId, accessToken) {
    try {
      if (!categoryId || !accessToken) return [];
      const mlUserId = await this.getMercadoLibreUserId(accessToken);
      if (!mlUserId) return [];

      const response = await axios.get(
        `https://api.mercadolibre.com/users/${mlUserId}/available_listing_types`,
        {
          params: { category_id: categoryId },
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: 12000
        }
      );

      const availableData = response.data?.available || response.data || [];
      if (!Array.isArray(availableData)) return [];

      const normalized = [];
      for (const lt of availableData) {
        const rawId = typeof lt === 'string' ? lt : lt?.id;
        if (!rawId) continue;
        const id = normalizeListingTypeId(rawId);
        if (!ML_SUPPORTED_LISTING_TYPES.includes(id)) continue;
        if (!normalized.includes(id)) normalized.push(id);
      }

      return normalized;
    } catch (error) {
      logger.warn(`[ML Adapter] No se pudieron obtener listing types disponibles para ${categoryId}: ${error.message}`);
      return [];
    }
  }

  async getMercadoLibreUserId(accessToken) {
    if (this.__mlUserId) return this.__mlUserId;

    const fromCredential = this.extractMlUserIdFromCredential(this.credential);
    if (fromCredential) {
      this.__mlUserId = fromCredential;
      return this.__mlUserId;
    }

    if (!accessToken) return null;

    try {
      const response = await axios.get('https://api.mercadolibre.com/users/me', {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 8000
      });
      this.__mlUserId = response.data?.id || null;
      return this.__mlUserId;
    } catch (error) {
      logger.warn(`[ML Adapter] No se pudo obtener users/me para listing types: ${error.message}`);
      return null;
    }
  }

  extractMlUserIdFromCredential(credential) {
    if (!credential) return null;
    if (credential.ml_user_id) return credential.ml_user_id;
    const additionalData = credential.additional_data;
    if (!additionalData) return null;
    if (typeof additionalData === 'object') return additionalData.ml_user_id || null;
    if (typeof additionalData === 'string') {
      try {
        const parsed = JSON.parse(additionalData);
        return parsed?.ml_user_id || null;
      } catch (e) {
        return null;
      }
    }
    return null;
  }

  getMarketplaceConfig() {
    return parseJsonObject(this.credential?.marketplace?.config || this.marketplace?.config);
  }

  resolveCurrencyIdForPublish(productData, categoryInfo = null) {
    const candidates = [
      productData?.currency_id,
      productData?.currency,
      this.getMarketplaceConfig().currency_id,
      this.credential?.marketplace?.currency_id,
      this.credential?.currency_id
    ]
      .map((value) => String(value || '').trim().toUpperCase())
      .filter(Boolean);

    const allowedCurrencies = Array.isArray(categoryInfo?.category?.settings?.currencies)
      ? categoryInfo.category.settings.currencies.map((value) => String(value || '').trim().toUpperCase()).filter(Boolean)
      : [];

    const resolved = candidates.find((candidate) =>
      allowedCurrencies.length === 0 || allowedCurrencies.includes(candidate)
    );

    return resolved || null;
  }

  resolveListingTypeForPublish({ strategy, requestedListingTypeId, availableTypeIds }) {
    const requested = normalizeListingTypeId(requestedListingTypeId);
    const available = Array.isArray(availableTypeIds) ? availableTypeIds : [];
    const hasAvailable = available.length > 0;

    if (!hasAvailable) {
      return {
        listing_type_id: requested || null,
        fallback_applied: true,
        note: 'No se pudo validar disponibilidad de listing types. Se requiere un listing type explícito.'
      };
    }

    if (strategy === ML_STRATEGY.CONVERSION && available.includes('gold_pro')) {
      return {
        listing_type_id: 'gold_pro',
        fallback_applied: false,
        note: 'Mayor exposición activada'
      };
    }

    if (available.includes('gold_special')) {
      return {
        listing_type_id: 'gold_special',
        fallback_applied: strategy === ML_STRATEGY.CONVERSION,
        note: strategy === ML_STRATEGY.CONVERSION
          ? 'No hay opción de máxima exposición. Se aplicó mejor alternativa.'
          : 'Publicación optimizada a menor costo'
      };
    }

    if (available.includes('free')) {
      return {
        listing_type_id: 'free',
        fallback_applied: true,
        note: 'Solo puedes publicar gratis en esta categoría'
      };
    }

    return {
      listing_type_id: requested || null,
      fallback_applied: true,
      note: 'No hay listing type soportado disponible; se requiere un listing type explícito.'
    };
  }

  // ✅ GTIN seguro: nunca lanza por longitudes raras y normaliza a un código válido
  extractDigits(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/\D/g, '');
  }

  calculateGTINChecksum(baseDigits) {
    const digits = this.extractDigits(baseDigits);
    if (!digits) return 0;

    let sum = 0;
    let weight = 3;

    for (let i = digits.length - 1; i >= 0; i--) {
      const digit = Number(digits.charAt(i));
      if (!Number.isFinite(digit)) {
        continue;
      }
      sum += digit * weight;
      weight = weight === 3 ? 1 : 3;
    }

    return (10 - (sum % 10)) % 10;
  }

  isValidGTIN(gtinValue) {
    const digits = this.extractDigits(gtinValue);
    if (![8, 12, 13, 14].includes(digits.length)) {
      return false;
    }

    const baseDigits = digits.slice(0, -1);
    const expected = String(this.calculateGTINChecksum(baseDigits));
    return digits.slice(-1) === expected;
  }

  generateFallbackGTIN(seedValue = '') {
    const seedDigits = this.extractDigits(seedValue);
    const fallbackSeed = seedDigits.slice(0, 12);
    const randomLength = Math.max(0, 12 - fallbackSeed.length);
    const randomTail = Array.from({ length: randomLength }, () => Math.floor(Math.random() * 10)).join('');
    const base12 = `${fallbackSeed}${randomTail}`.padStart(12, '0').slice(0, 12);
    return `${base12}${this.calculateGTINChecksum(base12)}`;
  }

  generateValidGTIN(existingValue) {
    const digits = this.extractDigits(existingValue);

    if (!digits) {
      return this.generateFallbackGTIN(existingValue);
    }

    if ([8, 12, 13, 14].includes(digits.length)) {
      if (this.isValidGTIN(digits)) {
        return digits;
      }

      const baseDigits = digits.slice(0, -1);
      if (baseDigits.length >= 1) {
        return `${baseDigits}${this.calculateGTINChecksum(baseDigits)}`;
      }

      return this.generateFallbackGTIN(digits);
    }

    if (digits.length === 7) {
      return `${digits}${this.calculateGTINChecksum(digits)}`;
    }

    if (digits.length > 7 && digits.length < 12) {
      return this.generateFallbackGTIN(digits);
    }

    if (digits.length > 14) {
      return this.generateFallbackGTIN(digits.slice(0, 12));
    }

    return this.generateFallbackGTIN(digits);
  }

  // ✅ MÉTODO EXPLÍCITO: Obtener metadata oficial separada por recurso
  async getCategoryMetadata(categoryId, accessToken) {
    try {
      const [categoryRes, attributesRes, saleTermsRes] = await Promise.all([
        axios.get(`https://api.mercadolibre.com/categories/${categoryId}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: 10000
        }),
        axios.get(`https://api.mercadolibre.com/categories/${categoryId}/attributes`, {
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: 10000
        }),
        axios.get(`https://api.mercadolibre.com/categories/${categoryId}/sale_terms`, {
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: 10000
        }).catch((error) => {
          logger.warn(`[ML Adapter] No se pudieron obtener sale_terms de categoría ${categoryId}: ${error.message}`);
          return { data: [] };
        })
      ]);

      const category = categoryRes.data || {};
      const rawAttributes = Array.isArray(attributesRes.data) ? attributesRes.data : [];
      const rawSaleTerms = Array.isArray(saleTermsRes.data) ? saleTermsRes.data : [];

      const attributes = rawAttributes.map((attr) => ({
        id: attr.id,
        name: attr.name,
        value_type: attr.value_type,
        tags: attr.tags || {},
        values: attr.values || [],
        required: attr.tags?.required === true || attr.tags?.catalog_required === true,
        allow_custom_value: attr.tags?.allow_custom_value === true,
        hierarchy: attr.hierarchy,
        allowed_units: attr.allowed_units || [],
        default_unit: attr.default_unit || null,
        value_max_length: attr.value_max_length || null
      }));

      const saleTerms = normalizeMercadoLibreSaleTerms(rawSaleTerms);
      const variationAttributes = attributes.filter(
        (attr) => attr.tags?.allow_variations === true || attr.tags?.variation_attribute === true
      );
      const parentAttributes = attributes.filter(
        (attr) => isMercadoLibreParentPkAttribute(attr)
      );
      const childAttributes = attributes.filter(
        (attr) => isMercadoLibreChildPkAttribute(attr)
      );

      return {
        success: true,
        category,
        attributes,
        saleTerms,
        settings: category.settings || {},
        sale_term_ids: saleTerms.map((st) => st?.id).filter(Boolean),
        hasVariationAttributes: variationAttributes.length > 0,
        variationAttributeIds: new Set(variationAttributes.map((attr) => attr.id)),
        parentAttributeIds: new Set(parentAttributes.map((attr) => attr.id)),
        childAttributeIds: new Set(childAttributes.map((attr) => attr.id)),
        isCatalog: !!(category.settings?.catalog_domain && category.settings.catalog_domain !== 'MLC-UNCLASSIFIED_PRODUCTS')
      };
    } catch (error) {
      logger.error(`[ML Adapter] Error obteniendo metadatos de categoría ${categoryId}:`, error.message);
      throw new Error(`No se pudieron obtener metadatos de categoría ${categoryId}: ${error.message}`);
    }
  }

  async loadMercadoLibreMetadata({ categoryId, accessToken, sellerId = null }) {
    const metadata = await this.getCategoryMetadata(categoryId, accessToken);
    const shippingPreferences = {
      user: null,
      category: null
    };

    if (sellerId) {
      shippingPreferences.user = await MercadoLibreCapabilitiesService.getUserShippingPreferences(
        this.credential,
        sellerId
      );
    }

    shippingPreferences.category = await MercadoLibreCapabilitiesService.getCategoryShippingPreferences(
      this.credential,
      categoryId
    );

    return {
      ...metadata,
      shippingPreferences,
      siteId: this.getSiteId()
    };
  }

  // 🔑 Validación específica para MercadoLibre
  validateProduct(product) {
    const errors = [];

    if (!product.category_id) {
      errors.push('category_id es requerido');
    }

    if (product.price <= 0) {
      errors.push('price debe ser mayor a 0');
    }

    // Validación específica: si tiene variaciones, requiere family_name
    if (Array.isArray(product.variations) && product.variations.length > 0 && !product.family_name) {
      errors.push('family_name es requerido cuando existen variaciones');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  // 🔑 MÉTODO AUXILIAR: Construir variaciones
  buildValidMercadoLibreVariations(variants, categoryAttributes, basePrice = null, fallbackPictures = [], marketplaceAttributes = []) {
    if (!Array.isArray(variants) || variants.length === 0) return null;

    const categoryAttrs = Array.isArray(categoryAttributes) ? categoryAttributes : [];
    const categoryAttrsById = new Map(categoryAttrs.map((attr) => [attr.id, attr]));
    const variationAttrs = categoryAttrs.filter((a) => a.tags?.allow_variations === true);
    const variationValueAttrs = categoryAttrs.filter(
      (a) => a.tags?.variation_attribute === true && a.tags?.allow_variations !== true
    );
    const marketplaceCombinationSources = this.extractMarketplaceAttributeSources(
      marketplaceAttributes,
      categoryAttrsById,
      variationAttrs
    );

    if (variationAttrs.length === 0) return null;

    const validVariations = [];
    const seenCombinationKeys = new Set();

    for (const variant of variants.filter(v => v.publish)) {
      const combinations = [];
      const variantSources = this.extractVariantAttributeSources(variant);
      const combinationSources = [...variantSources, ...marketplaceCombinationSources];
      const variationPictures = this.normalizeMercadoLibreVariationPictures(
        this.getVariantPictures(variant, fallbackPictures)
      );
      const resolvedBasePrice = Number(basePrice);
      const firstVariantPrice = Number(variants.find(v => v?.publish && Number(v?.price) > 0)?.price);
      const variationPrice = Number.isFinite(resolvedBasePrice) && resolvedBasePrice > 0
        ? resolvedBasePrice
        : (Number.isFinite(firstVariantPrice) && firstVariantPrice > 0
          ? firstVariantPrice
          : Number(variant.price));

      for (const mlAttr of variationAttrs) {
        let match = combinationSources.find(
          ({ key }) =>
            this.matchesFlexibleText(key, mlAttr.name) ||
            this.matchesFlexibleText(key, mlAttr.id)
        );

        if (!match && variationAttrs.length === 1 && combinationSources.length > 0) {
          const fallbackMatch = combinationSources.find(({ value }) =>
            this.matchesFlexibleText(value, mlAttr.name) || this.matchesFlexibleText(value, mlAttr.id)
          );
          if (fallbackMatch) {
            match = fallbackMatch;
          }
        }

        if (!match) {
          combinations.length = 0;
          break;
        }

        const value = match.value;
        const combo = { id: mlAttr.id };

        const valueMatch = mlAttr.values?.find(
          v =>
            this.matchesFlexibleText(v.name, value) ||
            this.matchesFlexibleText(v.value_name, value) ||
            String(v.id || '') === String(value || '')
        );

        if (valueMatch) {
          combo.value_id = valueMatch.id;
          combo.value_name = valueMatch.name;
        } else {
          combo.value_name = String(value);
        }

        combinations.push(combo);
      }

      if (combinations.length === variationAttrs.length) {
        const variationAttributes = [];
        const marketplaceVariationValueSources = this.extractMarketplaceAttributeSources(
          marketplaceAttributes,
          categoryAttrsById,
          variationValueAttrs
        );

        for (const mlAttr of variationValueAttrs) {
          const match = [...variantSources, ...marketplaceVariationValueSources].find(
            ({ key, value, source, attributeId }) => {
              const directMatch =
                String(attributeId || '').trim() === String(mlAttr.id || '').trim() ||
                this.matchesFlexibleText(key, mlAttr.name) ||
                this.matchesFlexibleText(key, mlAttr.id);

              if (directMatch) return true;
              if (source === 'marketplace') return false;

              return (
                this.matchesFlexibleText(value, mlAttr.name) ||
                this.matchesFlexibleText(value, mlAttr.id)
              );
            }
          );

          if (!match) continue;

          const attrValue = String(match.value || '').trim();
          if (!attrValue) continue;

          variationAttributes.push({
            id: mlAttr.id,
            value_name: attrValue
          });
        }

        if (variant?.sku) {
          variationAttributes.push({
            id: 'SELLER_SKU',
            value_name: String(variant.sku).trim()
          });
        }

        const combinationKey = combinations
          .slice()
          .sort((a, b) => String(a.id).localeCompare(String(b.id)))
          .map((combo) => `${combo.id}:${combo.value_id ?? combo.value_name ?? ''}`)
          .join('|');

        if (seenCombinationKeys.has(combinationKey)) {
          logger.warn(`[ML Adapter] ⚠️ Combinación de variación duplicada descartada para SKU ${variant?.sku || variant?.id}`);
          continue;
        }

        seenCombinationKeys.add(combinationKey);

        const pictureIds = variationPictures
          .map((picture) => picture.source || picture.id)
          .filter(Boolean);

        validVariations.push({
          seller_custom_field: String(variant.sku || variant.SellerSku || variant.id || '').trim() || undefined,
          price: variationPrice,
          available_quantity: Math.max(0, Math.round(Number(variant.publishStock ?? variant.totalStock ?? variant.stock ?? variant.quantity ?? 0) || 0)),
          attribute_combinations: combinations,
          picture_ids: pictureIds.length > 0 ? pictureIds : undefined,
          attributes: variationAttributes.length > 0 ? variationAttributes : undefined
        });
      }
    }

    return validVariations.length >= 1 ? validVariations : null;
  }

  extractVariantAttributeSources(variant) {
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
      pushSource(definitionName, variantValue?.name ?? variantValue?.value_name ?? variantValue?.code);
      pushSource(definitionId, variantValue?.name ?? variantValue?.value_name ?? variantValue?.code);
      pushSource(variantValue?.name, variantValue?.name);
      pushSource(variantValue?.code, variantValue?.name ?? variantValue?.code);
    }

    if (typeof variant?.variant_label === 'string' && variant.variant_label.trim()) {
      sources.push({ key: '__variant_label__', value: variant.variant_label.trim() });
    }

    return sources;
  }

  extractMarketplaceAttributeSources(attributes, categoryAttrsById, allowedAttributes = []) {
    if (!Array.isArray(attributes) || attributes.length === 0) return [];

    const allowedIds = new Set((Array.isArray(allowedAttributes) ? allowedAttributes : []).map((attr) => attr.id));
    const sources = [];

    for (const attr of attributes) {
      if (!attr?.id || (allowedIds.size > 0 && !allowedIds.has(attr.id))) continue;

      const attrMeta = categoryAttrsById instanceof Map ? categoryAttrsById.get(attr.id) : null;
      const valueId = attr.value_id !== undefined && attr.value_id !== null ? String(attr.value_id).trim() : '';
      const valueName = attr.value_name !== undefined && attr.value_name !== null ? String(attr.value_name).trim() : '';
      const value = attr.value !== undefined && attr.value !== null ? String(attr.value).trim() : '';
      const matchedValue = valueId && Array.isArray(attrMeta?.values)
        ? attrMeta.values.find((option) => String(option?.id || '').trim() === valueId)
        : null;
      const resolvedValue = String(matchedValue?.name || valueName || value || valueId || '').trim();

      if (!resolvedValue) continue;

      sources.push({ key: attr.id, value: resolvedValue, source: 'marketplace', attributeId: attr.id });
      if (attrMeta?.name) {
        sources.push({ key: attrMeta.name, value: resolvedValue, source: 'marketplace', attributeId: attr.id });
      }
    }

    return sources;
  }

  normalizeMercadoLibreVariationPictures(value) {
    const entries = Array.isArray(value) ? value : (value ? [value] : []);
    const normalized = [];
    const seen = new Set();

    for (const entry of entries) {
      let picture = null;

      if (typeof entry === 'string') {
        const trimmed = entry.trim();
        if (!trimmed) continue;
        picture = /^https?:\/\//i.test(trimmed)
          ? { source: trimmed }
          : { id: trimmed };
      } else if (entry && typeof entry === 'object') {
        const source = entry.source || entry.url || entry.link || entry.href || null;
        const id = entry.id || entry.picture_id || null;
        if (source !== null && source !== undefined) {
          const trimmedSource = String(source).trim();
          if (trimmedSource) picture = { source: trimmedSource };
        } else if (id !== null && id !== undefined) {
          const trimmedId = String(id).trim();
          if (trimmedId) picture = { id: trimmedId };
        }
      }

      if (!picture) continue;
      const dedupeKey = picture.source || picture.id;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      normalized.push(picture);
    }

    return normalized;
  }

  getVariantPictures(variant, fallbackPictures = []) {
    const rawPictures = variant?.pictures || variant?.images || variant?.picture_ids || variant?.image || [];
    const normalizedPictures = this.normalizeMercadoLibreVariationPictures(rawPictures);
    if (normalizedPictures.length > 0) {
      return normalizedPictures;
    }

    const fallback = this.normalizeMercadoLibreVariationPictures(fallbackPictures);
    return fallback.length > 0 ? fallback : [];
  }

  // 🔑 MÉTODO AUXILIAR: Normalización para comparación
  normalizeForComparison(str) {
    if (typeof str !== 'string') return '';
    return str
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]/g, ' ')
      .trim()
      .replace(/\s+/g, ' ');
  }

  matchesFlexibleText(left, right) {
    const normalizedLeft = this.normalizeForComparison(left);
    const normalizedRight = this.normalizeForComparison(right);

    if (!normalizedLeft || !normalizedRight) {
      return false;
    }

    if (normalizedLeft === normalizedRight) {
      return true;
    }

    return normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft);
  }

  async getMercadoLibreSellerProfile() {
    if (this.__mlSellerProfile) {
      return this.__mlSellerProfile;
    }

    const accessToken = this.credential?.access_token;
    if (!accessToken) {
      return null;
    }

    try {
      const meResponse = await axios.get('https://api.mercadolibre.com/users/me', {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 8000
      });

      const sellerId = meResponse.data?.id || null;
      let sellerResponseData = meResponse.data || {};

      if (sellerId) {
        try {
          const sellerResponse = await axios.get(`https://api.mercadolibre.com/users/${sellerId}`, {
            headers: { Authorization: `Bearer ${accessToken}` },
            timeout: 8000
          });
          sellerResponseData = sellerResponse.data || sellerResponseData;
        } catch (sellerError) {
          logger.warn(`[ML Adapter] No se pudo confirmar /users/${sellerId}: ${sellerError.message}`);
        }
      }

      const tags = Array.isArray(sellerResponseData?.tags)
        ? sellerResponseData.tags
        : Array.isArray(meResponse.data?.tags)
          ? meResponse.data.tags
          : [];

      this.__mlSellerProfile = {
        seller_id: sellerId,
        tags,
        user_product_seller: tags.includes('user_product_seller'),
        me: meResponse.data || {},
        seller: sellerResponseData || {}
      };

      return this.__mlSellerProfile;
    } catch (error) {
      logger.warn(`[ML Adapter] No se pudo obtener el perfil del seller para detectar User Products: ${error.message}`);
      return null;
    }
  }

  buildMercadoLibreUserProductAttributes(baseAttributes = [], variant = null, categoryAttributes = [], marketplaceAttributes = []) {
    const attributes = Array.isArray(baseAttributes)
      ? baseAttributes.map((attr) => ({ ...attr }))
      : [];
    const byId = new Map();

    for (const attr of attributes) {
      if (attr?.id) {
        byId.set(String(attr.id), attr);
      }
    }

    const variationAttrs = (Array.isArray(categoryAttributes) ? categoryAttributes : []).filter(
      (attr) => attr?.tags?.allow_variations === true || attr?.tags?.variation_attribute === true
    );

    const variantSources = this.extractVariantAttributeSources(variant)
      .map((source) => ({ ...source, source: 'variant' }));
    const marketplaceSources = this.extractMarketplaceAttributeSources(
      marketplaceAttributes,
      new Map((Array.isArray(categoryAttributes) ? categoryAttributes : []).map((attr) => [attr.id, attr])),
      variationAttrs
    );
    const variationSources = [...variantSources, ...marketplaceSources];
    const hasExplicitMarketplaceAttribute = (attributeId) =>
      Array.isArray(marketplaceAttributes) &&
      marketplaceAttributes.some((attr) => String(attr?.id || '').trim() === String(attributeId || '').trim());
    const hasExplicitVariantAttribute = (attributeId) => {
      if (!variant || !variant.attributes) return false;
      if (Array.isArray(variant.attributes)) {
        return variant.attributes.some((attr) => String(attr?.id || '').trim() === String(attributeId || '').trim());
      }
      if (typeof variant.attributes === 'object') {
        return Object.prototype.hasOwnProperty.call(variant.attributes, attributeId);
      }
      return false;
    };

    for (const mlAttr of variationAttrs) {
      if (
        mlAttr?.id === 'EMPTY_GTIN_REASON' &&
        !hasExplicitMarketplaceAttribute(mlAttr.id) &&
        !hasExplicitVariantAttribute(mlAttr.id)
      ) {
        continue;
      }

      const match = variationSources.find(({ key, value, source, attributeId }) => {
        const directMatch =
          String(attributeId || '').trim() === String(mlAttr.id || '').trim() ||
          this.matchesFlexibleText(key, mlAttr.name) ||
          this.matchesFlexibleText(key, mlAttr.id);

        if (directMatch) return true;

        // Marketplace attributes from the front are category-approved facts.
        // Do not use their values to infer unrelated ML attributes.
        if (source === 'marketplace') return false;

        return (
          this.matchesFlexibleText(value, mlAttr.name) ||
          this.matchesFlexibleText(value, mlAttr.id)
        );
      });

      if (!match) continue;
      if (match.source === 'marketplace' && byId.has(String(mlAttr.id))) continue;

      const valueMatch = Array.isArray(mlAttr.values)
        ? mlAttr.values.find((option) =>
            this.matchesFlexibleText(option?.name, match.value) ||
            this.matchesFlexibleText(option?.value_name, match.value) ||
            String(option?.id || '') === String(match.value || '')
          )
        : null;

      const normalizedAttr = {
        id: mlAttr.id,
        name: mlAttr.name,
        value_name: valueMatch?.name || valueMatch?.value_name || match.value
      };

      if (valueMatch?.id) {
        normalizedAttr.value_id = valueMatch.id;
      }

      byId.set(String(normalizedAttr.id), normalizedAttr);
    }

    if (variant?.sku) {
      byId.set('SELLER_SKU', {
        id: 'SELLER_SKU',
        value_name: String(variant.sku).trim()
      });
    }

    return Array.from(byId.values()).filter((attr) => attr && attr.id);
  }

  resolveMercadoLibreAttributeValueFromVariant(variant, mlAttr) {
    const variantSources = this.extractVariantAttributeSources(variant);

    for (const source of variantSources) {
      if (
        this.matchesFlexibleText(source.key, mlAttr?.name) ||
        this.matchesFlexibleText(source.key, mlAttr?.id) ||
        this.matchesFlexibleText(source.value, mlAttr?.name) ||
        this.matchesFlexibleText(source.value, mlAttr?.id)
      ) {
        return String(source.value || '').trim() || null;
      }
    }

    return null;
  }

  resolveMercadoLibreAttributeValueFromAttributes(attributes, mlAttr) {
    const sourceAttributes = Array.isArray(attributes) ? attributes : [];
    const match = sourceAttributes.find((attr) =>
      attr?.id &&
      (
        String(attr.id).trim() === String(mlAttr?.id || '').trim() ||
        this.matchesFlexibleText(attr.id, mlAttr?.id) ||
        this.matchesFlexibleText(attr.id, mlAttr?.name)
      )
    );

    if (!match) return null;
    const value = match.value_name ?? match.value ?? match.value_id;
    return value !== undefined && value !== null && String(value).trim()
      ? String(value).trim()
      : null;
  }

  validateMercadoLibreUserProductVariant(transformedProduct, variant, categoryInfo, resolvedAttributes = []) {
    const categoryAttributes = Array.isArray(categoryInfo?.attributes) ? categoryInfo.attributes : [];
    const requiredAttributes = categoryAttributes.filter((attr) =>
      isMercadoLibreRequiredAttribute(attr) &&
      (!isMercadoLibreChildPkAttribute(attr) || shouldRequireMercadoLibreChildPkAttribute(attr, resolvedAttributes))
    );
    const childPkAttributes = categoryAttributes.filter((attr) =>
      isMercadoLibreChildPkAttribute(attr) && shouldRequireMercadoLibreChildPkAttribute(attr, resolvedAttributes)
    );
    const parentPkAttributes = categoryAttributes.filter((attr) => isMercadoLibreParentPkAttribute(attr));
    const resolveValue = (attr) =>
      this.resolveMercadoLibreAttributeValueFromVariant(variant, attr) ||
      this.resolveMercadoLibreAttributeValueFromAttributes(resolvedAttributes, attr);

    logger.info('[MercadoLibreAdapter] User Product Child PK validation', {
      categoryId: transformedProduct.category_id || null,
      sellerSku: variant?.sku || transformedProduct.sku || null,
      childPkAttributes: categoryAttributes
        .filter((attr) => isMercadoLibreChildPkAttribute(attr))
        .map((attr) => ({
          id: attr.id,
          required: isMercadoLibreRequiredAttribute(attr),
          enforced: shouldRequireMercadoLibreChildPkAttribute(attr, resolvedAttributes),
          value: resolveValue(attr) || null,
          tags: attr.tags || {}
        }))
    });

    const missingChildPk = childPkAttributes
      .filter((attr) => !resolveValue(attr))
      .map((attr) => attr.id);
    if (missingChildPk.length > 0) {
      return createMercadoLibreError({
        operation: 'create',
        itemModel: 'user_product',
        categoryId: transformedProduct.category_id || null,
        sellerSku: variant?.sku || transformedProduct.sku || null,
        field: 'child_pk',
        receivedValue: variant,
        code: 'missing_child_pk',
        message: `Faltan atributos Child PK requeridos: ${missingChildPk.join(', ')}`,
        metadataSource: 'GET /categories/{category_id}/attributes'
      });
    }

    const missingRequired = requiredAttributes
      .filter((attr) => !resolveValue(attr))
      .map((attr) => attr.id);

    if (missingRequired.length > 0) {
      return createMercadoLibreError({
        operation: 'create',
        itemModel: 'user_product',
        categoryId: transformedProduct.category_id || null,
        sellerSku: variant?.sku || transformedProduct.sku || null,
        field: 'attributes',
        receivedValue: variant,
        code: 'missing_required_attributes',
        message: `Faltan atributos requeridos: ${missingRequired.join(', ')}`,
        metadataSource: 'GET /categories/{category_id}/attributes'
      });
    }

    if (parentPkAttributes.length > 0) {
      const parentSignature = parentPkAttributes
        .map((attr) => resolveValue(attr) || '')
        .join('|');

      if (!parentSignature.replace(/\|/g, '').trim()) {
        return createMercadoLibreError({
          operation: 'create',
          itemModel: 'user_product',
          categoryId: transformedProduct.category_id || null,
          sellerSku: variant?.sku || transformedProduct.sku || null,
          field: 'parent_pk',
          receivedValue: variant,
          code: 'missing_parent_pk',
          message: 'Faltan atributos Parent PK requeridos',
          metadataSource: 'GET /categories/{category_id}/attributes'
        });
      }
    }

    return null;
  }

  normalizeMercadoLibreFamilyName(familyName, maxLength = null) {
    const normalized = (familyName || 'Producto sin nombre')
      .toString()
      .replace(/\s+/g, ' ')
      .trim();

    const limit = Number(maxLength || 0);
    if (!Number.isFinite(limit) || limit <= 0 || normalized.length <= limit) {
      return {
        value: normalized,
        originalValue: normalized,
        wasTruncated: false
      };
    }

    let truncated = normalized.slice(0, limit).trim();
    const lastSpaceIndex = truncated.lastIndexOf(' ');
    if (lastSpaceIndex > Math.floor(limit * 0.6)) {
      truncated = truncated.slice(0, lastSpaceIndex).trim();
    }

    if (!truncated) {
      truncated = normalized.slice(0, limit).trim();
    }

    return {
      value: truncated,
      originalValue: normalized,
      wasTruncated: truncated !== normalized
    };
  }

  buildMercadoLibreUserProductItemPayload(transformedProduct, variant, metadata = null) {
    const rawFamilyName = (transformedProduct.family_name || transformedProduct.name || transformedProduct.title || 'Producto sin nombre')
      .toString()
      .trim();
    const categoryInfo = metadata || {};
    const maxTitleLength = Number(categoryInfo?.category?.settings?.max_title_length || categoryInfo?.settings?.max_title_length || 0) || null;
    const familyNameInfo = this.normalizeMercadoLibreFamilyName(rawFamilyName, maxTitleLength);
    const familyName = familyNameInfo.value;

    if (familyNameInfo.wasTruncated) {
      logger.warn('[MercadoLibreAdapter] family_name ajustado a max_title_length', {
        categoryId: transformedProduct.category_id || null,
        sellerSku: variant?.sku || transformedProduct.sku || null,
        maxTitleLength,
        originalFamilyName: familyNameInfo.originalValue,
        normalizedFamilyName: familyName
      });
    }

    if (maxTitleLength && familyName.length > maxTitleLength) {
      return {
        __blocked_error: createMercadoLibreError({
          operation: 'create',
          itemModel: 'user_product',
          categoryId: transformedProduct.category_id || null,
          sellerSku: variant?.sku || transformedProduct.sku || null,
          field: 'family_name',
          receivedValue: familyName,
          code: 'family_name_too_long',
          message: `family_name supera max_title_length (${maxTitleLength})`,
          metadataSource: 'GET /categories/{category_id}'
        })
      };
    }
    const pictures = this.getVariantPictures(variant, transformedProduct.pictures || []);
    const availableQuantity = Math.max(0, Math.round(
      Number(
        variant?.publishStock ??
        variant?.stock ??
        variant?.totalStock ??
        transformedProduct.available_quantity ??
        transformedProduct.stock ??
        transformedProduct.totalStock ??
        0
      ) || 0
    ));
    const price = Number(variant?.price ?? transformedProduct.price) || 0;
    const attributes = this.buildMercadoLibreUserProductAttributes(
      transformedProduct.attributes,
      variant,
      categoryInfo?.attributes || [],
      transformedProduct.__ml_marketplace_attributes || []
    );

    const validationError = this.validateMercadoLibreUserProductVariant(transformedProduct, variant, categoryInfo, attributes);
    if (validationError) {
      return { __blocked_error: validationError };
    }

    const currencyId = transformedProduct.currency_id || transformedProduct.currency || null;
    if (!currencyId) {
      return {
        __blocked_error: createMercadoLibreError({
          operation: 'create',
          itemModel: 'user_product',
          categoryId: transformedProduct.category_id || null,
          sellerSku: variant?.sku || transformedProduct.sku || null,
          field: 'currency_id',
          receivedValue: currencyId,
          code: 'missing_currency_id',
          message: 'No se pudo determinar currency_id para el User Product',
          metadataSource: 'product payload + category metadata'
        })
      };
    }

    const listingTypeId = normalizeListingTypeId(transformedProduct.listing_type_id);
    if (!listingTypeId) {
      return {
        __blocked_error: createMercadoLibreError({
          operation: 'create',
          itemModel: 'user_product',
          categoryId: transformedProduct.category_id || null,
          sellerSku: variant?.sku || transformedProduct.sku || null,
          field: 'listing_type_id',
          receivedValue: transformedProduct.listing_type_id || null,
          code: 'missing_listing_type_id',
          message: 'No se pudo determinar listing_type_id para el User Product',
          metadataSource: 'product payload + available listing types'
        })
      };
    }

    const commercialFields = resolveMercadoLibreCommercialFields(transformedProduct, {
      operation: 'create',
      itemModel: 'user_product',
      categoryId: transformedProduct.category_id || null,
      sellerSku: variant?.sku || transformedProduct.sku || null,
      metadataSource: 'product payload'
    });

    if (commercialFields.__blocked_error) {
      return { __blocked_error: commercialFields.__blocked_error };
    }

    const saleTerms = buildWarrantySaleTerms(transformedProduct);

    return {
      site_id: this.getSiteId(),
      category_id: transformedProduct.category_id,
      family_name: familyName,
      price,
      available_quantity: availableQuantity,
      currency_id: currencyId,
      buying_mode: commercialFields.buying_mode,
      listing_type_id: listingTypeId,
      condition: commercialFields.condition,
      shipping: transformedProduct.shipping ? { ...transformedProduct.shipping } : undefined,
      sale_terms: saleTerms.length > 0 ? saleTerms : undefined,
      pictures,
      attributes,
      catalog_product_id: transformedProduct.catalog_product_id || undefined
    };
  }

  async createMercadoLibreDescription(itemId, plainText) {
    const description = String(plainText || '').trim();
    if (!itemId || !description) {
      return null;
    }

    await axios.post(
      `https://api.mercadolibre.com/items/${itemId}/description`,
      { plain_text: description },
      {
        headers: {
          Authorization: `Bearer ${this.credential.access_token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        timeout: 30000
      }
    );

    return true;
  }

  async getMercadoLibreItem(itemId) {
    const normalizedItemId = String(itemId || '').trim();
    if (!normalizedItemId) return null;

    const response = await axios.get(`https://api.mercadolibre.com/items/${normalizedItemId}`, {
      headers: {
        Authorization: `Bearer ${this.credential.access_token}`,
        Accept: 'application/json'
      },
      timeout: 30000
    });

    return response.data || null;
  }

  async updateMercadoLibreFamilyName(itemId, familyName) {
    const normalizedItemId = String(itemId || '').trim();
    const normalizedFamilyName = String(familyName || '').trim();
    if (!normalizedItemId || !normalizedFamilyName) {
      return null;
    }

    await axios.put(
      `https://api.mercadolibre.com/items/${normalizedItemId}/family_name`,
      { family_name: normalizedFamilyName },
      {
        headers: {
          Authorization: `Bearer ${this.credential.access_token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        timeout: 30000
      }
    );

    return true;
  }

  async getMercadoLibreUserProductStock(userProductId) {
    const normalizedUserProductId = String(userProductId || '').trim();
    if (!normalizedUserProductId) return null;

    const response = await axios.get(
      `https://api.mercadolibre.com/user-products/${normalizedUserProductId}/stock`,
      {
        headers: {
          Authorization: `Bearer ${this.credential.access_token}`,
          Accept: 'application/json'
        },
        timeout: 30000
      }
    );

    return {
      ...(response.data || {}),
      version: response.headers?.['x-version'] ?? response.headers?.['X-Version'] ?? response.data?.version ?? null
    };
  }

  resolveMercadoLibreUserProductStockType(stockInfo = null) {
    const directType = String(stockInfo?.type || stockInfo?.stock_type || '').trim();
    if (directType) return directType;

    const locations = Array.isArray(stockInfo?.locations) ? stockInfo.locations : [];
    const locationTypes = [...new Set(locations
      .map((location) => String(location?.type || '').trim())
      .filter(Boolean))];

    return locationTypes.length === 1 ? locationTypes[0] : '';
  }

  resolveMercadoLibreUserProductId(item = null, explicitUserProductId = null) {
    const explicit = String(explicitUserProductId || '').trim();
    if (explicit) return explicit;
    return String(item?.user_product_id || '').trim();
  }

  async updateMercadoLibreUserProductStock(userProductId, availableQuantity, stockInfo = null, itemId = null) {
    const normalizedUserProductId = String(userProductId || '').trim();
    const quantity = Number(availableQuantity);
    if (!normalizedUserProductId || !Number.isFinite(quantity) || quantity < 0) {
      return null;
    }

    const stockType = this.resolveMercadoLibreUserProductStockType(stockInfo);
    if (!stockType) {
      return {
        __blocked_error: createMercadoLibreError({
          operation: 'update',
          itemModel: 'user_product',
          itemId,
          userProductId: normalizedUserProductId,
          field: 'available_quantity',
          receivedValue: quantity,
          code: 'user_product_stock_type_unknown',
          message: 'No se pudo determinar el tipo de stock para el User Product',
          metadataSource: 'GET /user-products/{user_product_id}/stock'
        })
      };
    }

    if (stockType === 'seller_warehouse') {
      return {
        __blocked_error: createMercadoLibreError({
          operation: 'update',
          itemModel: 'user_product',
          itemId,
          userProductId: normalizedUserProductId,
          field: 'available_quantity',
          receivedValue: quantity,
          code: 'user_product_multi_origin_stock_unsupported',
          message: 'La actualización automática de stock multi-origin requiere una regla oficial explícita',
          metadataSource: 'GET /user-products/{user_product_id}/stock'
        })
      };
    }

    const response = await axios.put(
      `https://api.mercadolibre.com/user-products/${normalizedUserProductId}/stock/type/${encodeURIComponent(stockType)}`,
      { quantity: Math.round(quantity) },
      {
        headers: {
          Authorization: `Bearer ${this.credential.access_token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(stockInfo?.version !== undefined && stockInfo.version !== null ? { 'x-version': String(stockInfo.version) } : {})
        },
        timeout: 30000
      }
    );

    return response.data || null;
  }

  async createUserProductSalesCondition(userProductId, payload = {}) {
    const normalizedUserProductId = String(userProductId || '').trim();
    if (!normalizedUserProductId) {
      return null;
    }

    const response = await axios.post(
      `https://api.mercadolibre.com/user-products/${normalizedUserProductId}/items`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${this.credential.access_token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        timeout: 30000
      }
    );

    return response.data || null;
  }

  async updateMercadoLibreDescription(itemId, plainText) {
    const description = String(plainText || '').trim();
    if (!itemId || !description) {
      return null;
    }

    await axios.put(
      `https://api.mercadolibre.com/items/${itemId}/description?api_version=2`,
      { plain_text: description },
      {
        headers: {
          Authorization: `Bearer ${this.credential.access_token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        timeout: 30000
      }
    );

    return true;
  }

  async publishMercadoLibreDescription(itemId, plainText) {
    return this.createMercadoLibreDescription(itemId, plainText);
  }

  async validateMercadoLibrePayload(payload) {
    try {
      const response = await axios.post(
        'https://api.mercadolibre.com/items/validate',
        payload,
        {
          headers: {
            Authorization: `Bearer ${this.credential.access_token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json'
          },
          timeout: 30000,
          validateStatus: () => true
        }
      );

      const causes = Array.isArray(response.data?.cause) ? response.data.cause : [];
      const blockingCauses = causes.filter((cause) => String(cause?.type || '').toLowerCase() === 'error');
      const warningCauses = causes.filter((cause) => String(cause?.type || '').toLowerCase() === 'warning');
      const validation = {
        status: response.status,
        data: response.data || null,
        valid: (response.status >= 200 && response.status < 300) || (causes.length > 0 && blockingCauses.length === 0),
        warnings: warningCauses,
        errors: blockingCauses
      };

      logger.info('[MercadoLibreAdapter] Resultado de validacion ML', { validation });

      if (!validation.valid) {
        return {
          valid: false,
          error: 'mercadolibre_validation_failed',
          details: {
            error_code: 'mercadolibre_validation_failed',
            validation
          },
          validation
        };
      }

      return {
        valid: true,
        validation
      };
    } catch (error) {
      const validation = {
        status: error.response?.status || null,
        data: error.response?.data || error.message || null,
        valid: false
      };

      logger.error('[MercadoLibreAdapter] Error ejecutando /items/validate', { validation });

      return {
        valid: false,
        error: 'mercadolibre_validation_failed',
        details: {
          error_code: 'mercadolibre_validation_failed',
          validation
        },
        validation
      };
    }
  }

  async prepareProduct(productData) {
    logger.info('[MercadoLibreAdapter] Preparando producto para publicación', {
      productId: productData.id,
      name: productData.name,
      variantsCount: productData.variants?.length || 0
    });

    if (!productData.mercado_libre || Object.keys(productData.mercado_libre).length === 0) {
      throw new Error('No se encontró información de MercadoLibre para el producto');
    }

    const mlData = pickMlDataForCredential(productData.mercado_libre, this.credentialId);
    if (!mlData || typeof mlData !== 'object') {
      throw new Error('No se encontró configuración de MercadoLibre para la credencial seleccionada');
    }

    const shippingEffective = mlData?.shipping?.effective || {};
    const shippingRequested = mlData?.shipping?.requested || {};
    const listingTypeOverride = normalizeListingTypeId(mlData?.listing_type_id || null);
    const shippingModeOverride = shippingEffective.shipping_mode
      || shippingRequested.shipping_mode
      || mlData?.selection?.shipping_mode
      || mlData?.category?.selection?.shipping_mode
      || mlData?.quote?.selection?.shipping_mode
      || mlData?.calculation_result?.selection?.shipping_mode
      || mlData?.shipping_mode
      || null;
    const logisticTypeOverride = shippingEffective.logistic_type
      || shippingRequested.logistic_type
      || mlData?.selection?.logistic_type
      || mlData?.category?.selection?.logistic_type
      || mlData?.quote?.selection?.logistic_type
      || mlData?.calculation_result?.selection?.logistic_type
      || mlData?.logistic_type
      || null;
    let strategy = normalizeStrategyForPublish(mlData?.strategy, mlData?.listing_type_id || null);
    if (!mlData?.category?.category_id) {
      throw new Error('Falta category_id para MercadoLibre');
    }

    await this.ensureValidCredentials();
    const categoryInfo = await this.getCategoryMetadata(
      mlData.category.category_id,
      this.credential?.access_token
    );
    const availableListingTypes = await this.getAvailableListingTypeIdsForCategory(
      mlData.category.category_id,
      this.credential?.access_token
    );
    const listingResolution = this.resolveListingTypeForPublish({
      strategy,
      requestedListingTypeId: listingTypeOverride,
      availableTypeIds: availableListingTypes
    });

    const catalogDomain = categoryInfo.category?.settings?.catalog_domain || categoryInfo.settings?.catalog_domain;
    const isCatalogProduct = !!catalogDomain && catalogDomain !== 'MLC-UNCLASSIFIED_PRODUCTS';
    const hasVariationAttributes = categoryInfo.hasVariationAttributes;
    const currencyId = this.resolveCurrencyIdForPublish(productData, categoryInfo);

    const prepared = {
      category_id: mlData.category.category_id,
      price: Number(productData.price) || 0,
      currency_id: currencyId,
      available_quantity: Number(
        productData.totalPublishingStock ??
        productData.stock ??
        productData.totalStock ??
        0
      ) || 0,
      buying_mode: 'buy_it_now',
      listing_type_id: listingResolution.listing_type_id,
      condition: productData.condition?.toLowerCase() === 'new' ? 'new' : 'used',
      shipping: null,
      sale_terms: [],
      attributes: [],
      pictures: productData.images || [],
      description: {
        plain_text: productData.description?.trim() || ''
      },
      category_settings: categoryInfo.category || categoryInfo.settings || {},
      __ml_has_variation_attributes: hasVariationAttributes,
      __ml_is_catalog_product: isCatalogProduct
    };

    if (!prepared.currency_id) {
      return {
        success: false,
        error: 'missing_currency_id',
        details: createMercadoLibreError({
          operation: 'create',
          itemModel: 'classic',
          categoryId: mlData.category.category_id,
          field: 'currency_id',
          receivedValue: productData.currency_id || productData.currency || this.getMarketplaceConfig().currency_id || null,
          code: 'missing_currency_id',
          message: 'No se pudo determinar currency_id para preparar la publicación',
          metadataSource: 'product payload + category metadata'
        })
      };
    }

    const installmentsConfig = resolveInstallmentsForPublish(this.getSiteId(), prepared.listing_type_id);
    const shippingPreferences = categoryInfo?.shippingPreferences || {};
    const categoryShippingPreferences = shippingPreferences.category || null;
    const userShippingPreferences = shippingPreferences.user || null;
    const shippingLogistics = Array.isArray(categoryShippingPreferences?.logistics)
      ? categoryShippingPreferences.logistics
      : [];
    const preferredLogisticEntry = shippingLogistics.find((entry) => entry?.mode && Array.isArray(entry?.types) && entry.types.length > 0) || null;
    const derivedShippingMode = shippingModeOverride
      || preferredLogisticEntry?.mode
      || (Array.isArray(userShippingPreferences?.modes) && userShippingPreferences.modes.includes('me2') ? 'me2' : null);
    const derivedLogisticType = logisticTypeOverride
      || (Array.isArray(preferredLogisticEntry?.types) ? preferredLogisticEntry.types[0] : null);
    if (derivedShippingMode || derivedLogisticType) {
      prepared.shipping = {
        ...(derivedShippingMode ? { mode: derivedShippingMode } : {}),
        ...(derivedLogisticType ? { logistic_type: derivedLogisticType } : {})
      };
    }
    prepared.__ml_selection = {
      strategy,
      installments: installmentsConfig,
      listing_resolution: listingResolution
    };

    if (productData.economic_config) {
      const config = productData.economic_config;
      if (config.allow_price_adjustment && config.min_margin && config.commission_rate) {
        const basePrice = Number(productData.price) || 0;
        const commissionRate = Number(config.commission_rate) || 0;
        const minMargin = Number(config.min_margin) / 100;
        const currentMargin = 1 - commissionRate;

        if (currentMargin < minMargin && basePrice > 0) {
          const adjustedPrice = basePrice / (1 - commissionRate - minMargin);
          const roundedPrice = Math.ceil(adjustedPrice / 10) * 10;
          prepared.price = roundedPrice;
          logger.info(`[ML Adapter] 💰 Precio ajustado: $${basePrice} → $${roundedPrice} (margen: ${(minMargin * 100)}%)`);
        }
      }
    }

    if (isCatalogProduct || hasVariationAttributes) {
      const familyName = (productData.family_name || productData.name || productData.title || 'Producto sin nombre')
        .toString()
        .trim();
      prepared.family_name = familyName;
      prepared.name = productData.name?.trim() || familyName;
      prepared.title = productData.title?.trim() || familyName;
      logger.info(`[ML Adapter] 📦 Producto de catálogo o con variaciones → family_name: "${prepared.family_name}"`);
    } else {
      const title = (productData.title || productData.name || productData.family_name || 'Producto sin título')
        .toString()
        .trim();
      prepared.title = title;
      prepared.name = productData.name?.trim() || title;
      logger.info(`[ML Adapter] 📦 Producto simple → title: "${prepared.title}"`);
    }

    const rawAttributes = this.enrichMercadoLibreParentAttributes(
      Array.isArray(mlData.attributes) ? mlData.attributes : [],
      productData,
      categoryInfo.attributes
    );
    prepared.attributes = this.buildMercadoLibreAttributes(rawAttributes, categoryInfo.attributes);
    prepared.__ml_marketplace_attributes = rawAttributes;

    const warrantySaleTerms = buildWarrantySaleTerms(productData);
    if (warrantySaleTerms.length > 0) {
      prepared.sale_terms.push(...warrantySaleTerms);
      logger.info(`[ML Adapter] ✅ Garantía añadida: ${warrantySaleTerms[0].value_name}`);
    }

    const publishableVariants = (productData.variants || []).filter(v => v.publish && v.price > 0);
    prepared.__ml_source_variants = publishableVariants;
    const hasMultipleVariants = publishableVariants.length > 1;
    const hasSingleVariant = publishableVariants.length === 1;

      if (hasMultipleVariants && hasVariationAttributes) {
        logger.info(`[ML Adapter] Producto con ${publishableVariants.length} variantes. Construyendo variations.`);

      const variationAttrIds = new Set(categoryInfo.variationAttributeIds || []);
      prepared.attributes = prepared.attributes.filter(a => !variationAttrIds.has(a.id));

      const variations = this.buildValidMercadoLibreVariations(
        publishableVariants,
        categoryInfo.attributes,
        prepared.price,
        prepared.pictures,
        rawAttributes
      );

      if (variations && variations.length >= 2) {
        prepared.variations = variations;
        logger.info(`[ML Adapter] ✅ Variaciones construidas: ${variations.length}`);
      } else {
        logger.warn('[ML Adapter] ⚠️ No se pudieron construir variaciones válidas; se marcará para resolver según el modelo final del seller');
        prepared.variations = undefined;
        prepared.__ml_variation_build_failed = true;
        prepared.__ml_variation_build_reason = 'category_variation_build_failed';
      }
    } else if (hasMultipleVariants && !hasVariationAttributes) {
      logger.warn('[ML Adapter] ⚠️ La categoría no expone atributos de variación compatibles; se marcará para resolver según el modelo final del seller');
      prepared.variations = undefined;
      prepared.__ml_variation_build_failed = true;
      prepared.__ml_variation_build_reason = 'category_without_variation_attributes';
    } else if (hasSingleVariant) {
      logger.info('[ML Adapter] Producto con 1 variante. Permitiendo atributos de variación en nivel base.');
      prepared.attributes = this.buildMercadoLibreAttributes(rawAttributes, categoryInfo.attributes);

      const singleVariant = publishableVariants[0];
      prepared.available_quantity = Number(
        singleVariant.publishStock ??
        productData.totalPublishingStock ??
        singleVariant.totalStock ??
        productData.totalStock
      ) || 0;
      prepared.price = Number(singleVariant.price) || Number(productData.price) || 0;
      prepared.variations = undefined;
    } else {
      logger.info('[ML Adapter] Producto sin variantes publicables.');
      prepared.variations = undefined;
    }

    logger.info('[ML Adapter] ✅ Producto preparado para ML:', {
      category_id: prepared.category_id,
      has_variations: !!prepared.variations,
      variations_count: prepared.variations?.length || 0,
      attributes_count: prepared.attributes?.length || 0,
      sale_terms_count: prepared.sale_terms?.length || 0,
      pictures_count: prepared.pictures?.length || 0,
      has_family_name: !!prepared.family_name,
      has_title: !!prepared.title,
      is_catalog: isCatalogProduct
    });

    return prepared;
  }

      async ensureValidCredentials() {
    if (this.credentialId) {
    if (typeof this.credentialId === 'object' && this.credentialId !== null) {
      // Ya es el objeto completo
      this.credential = this.credentialId;
    } else {
      // Es un ID, buscar en repositorio
      this.credential = await MarketplaceCredentialRepository.findById(this.credentialId);
    }
  } else {
    // Fallback al comportamiento original
    if (this.companyId !== undefined && this.companyId !== null) {
      this.credential = await MarketplaceCredentialRepository.findByMarketplaceAndCompany(
        this.marketplaceId,
        this.companyId
      );
    }
  }

  if (!this.credential) {
    logger.info(`[MercadoLibreAdapter] No existe credencial para marketplace ${this.marketplaceId} y user ${this.userId}`);
    const authResponse = await this.getAuthUrl();
    if (authResponse.auth_required) {
      return {
        valid: false,
        auth_required: true,
        auth_url: authResponse.auth_url,
        message: authResponse.message
      };
    } else {
      return { valid: false, error: "marketplace_credentials_incomplete" };
    }
  }

    if (!this.credential.access_token) {
      logger.info("[MercadoLibreAdapter] No hay access_token disponible");
      const authResponse = await this.getAuthUrl();
      return {
        valid: false,
        auth_required: true,
        auth_url: authResponse.auth_url,
        message: authResponse.message
      };
    }

    try {
      const tokenCheck = await axios.get("https://api.mercadolibre.com/users/me", {
        headers: { Authorization: `Bearer ${this.credential.access_token}` },
        timeout: 3000,
      });
      logger.info(`[MercadoLibreAdapter] ✅ Token válido para: ${tokenCheck.data.nickname}`);
      return { valid: true };
    } catch (error) {
      logger.info(`[MercadoLibreAdapter] Token inválido: ${error.message}`);

      if (error.response?.status === 403) {
        logger.error("[MercadoLibreAdapter] Error 403 - App en modo Development. NO intentar refresh.");
        const authResponse = await this.getAuthUrl();
        return {
          valid: false,
          auth_required: true,
          auth_url: authResponse.auth_url,
          message: "App en modo desarrollo. Requiere nueva autorización."
        };
      }

      if (this.credential.refresh_token) {
        try {
          await this.refreshAccessToken();
          return { valid: true };
        } catch (refreshError) {
          logger.error("[MercadoLibreAdapter] Refresh falló:", refreshError.message);
        }
      }

      const authResponse = await this.getAuthUrl();
      return {
        valid: false,
        auth_required: true,
        auth_url: authResponse.auth_url,
        message: "Token expirado o inválido. Requiere reautorización."
      };
    }
  }
  async refreshAccessToken() {
  // ✅ EXTRAER marketplace DE LA CREDENCIAL
  const credential = this.credential;
  const marketplace = credential?.marketplace || {};
  logger.info(`credential value: ${JSON.stringify(credential)}`);
  logger.info(`marketplace value: ${JSON.stringify(marketplace)}`);
  // ✅ VALIDAR CON LOS CAMPOS CORRECTOS
  if (!credential?.refresh_token) throw new Error("refresh_token_not_available");
  if (!marketplace.client_id || !marketplace.client_secret) throw new Error("client_credentials_missing");

  // ✅ URL SIN ESPACIOS
  const oauthTokenUrl = "https://api.mercadolibre.com/oauth/token";
  
  const params = new URLSearchParams();
  params.append("grant_type", "refresh_token");
  params.append("client_id", marketplace.client_id);        // ← marketplace.client_id
  params.append("client_secret", marketplace.client_secret); // ← marketplace.client_secret
  params.append("refresh_token", credential.refresh_token);

  try {
    logger.info(`[MercadoLibreAdapter] Intentando refresh:`, {
      client_id: marketplace.client_id?.substring(0, 10) + '...',
      refresh_token: credential.refresh_token?.substring(0, 20) + '...'
    });

    const response = await axios.post(oauthTokenUrl, params, {
      headers: { 
        "Content-Type": "application/x-www-form-urlencoded", 
        "Accept": "application/json" 
      },
      timeout: 10000,
    });

    logger.info(`[MercadoLibreAdapter] ✅ Refresh exitoso`);

    const expiresAt = new Date(Date.now() + response.data.expires_in * 1000);
    
    await MarketplaceCredentialRepository.updatePartial(credential.id, {
      access_token: response.data.access_token,
      refresh_token: response.data.refresh_token || credential.refresh_token,
      expires_at: expiresAt
    });
    
    this.credential = { 
      ...credential, 
      access_token: response.data.access_token,
      refresh_token: response.data.refresh_token || credential.refresh_token,
      expires_at: expiresAt 
    };
    
    return true;
    
  } catch (error) {
    logger.error(`[MercadoLibreAdapter] ❌ Refresh falló:`, {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data
    });

    if (error.response?.status === 403) {
      throw new Error("app_not_authorized_for_refresh");
    }
    if (error.response?.status === 400 && error.response?.data?.error === 'invalid_grant') {
      throw new Error("refresh_token_expired");
    }
    if (error.response?.status === 401) {
      throw new Error("invalid_client_credentials");
    }
    
    throw new Error(`refresh_failed: ${error.message}`);
  }
}
  async predictCategory(title) {
    logger.info(`[MercadoLibreAdapter] Prediciendo categoría para título: ${title}`);
    if (!this.credential.access_token) {
      throw new Error("No hay access_token disponible para predicción");
    }

    const siteId = String(this.getSiteId() || '').trim();
    if (!siteId) {
      throw new Error('No se pudo determinar site_id de Mercado Libre');
    }
    try {
      // ✅ CORREGIDO: Eliminar espacios en URL
      const domainDiscoveryUrl = `https://api.mercadolibre.com/sites/${siteId}/domain_discovery/search`;
      const response = await axios.get(domainDiscoveryUrl, {
        params: { q: title.trim(), limit: 8 },
        headers: { Authorization: `Bearer ${this.credential.access_token}` }
      });

      if (!response.data || !Array.isArray(response.data) || response.data.length === 0) {
        throw new Error("No se encontró categoría compatible");
      }

      const prediction = response.data[0];
      const categoryId = prediction.category_id.trim();

      // ✅ CORREGIDO: Eliminar espacios en URLs
      const [attributesRes, categoryRes] = await Promise.all([
        axios.get(`https://api.mercadolibre.com/categories/${categoryId}/attributes`, {
          headers: { Authorization: `Bearer ${this.credential.access_token}` }
        }),
        axios.get(`https://api.mercadolibre.com/categories/${categoryId}`, {
          headers: { Authorization: `Bearer ${this.credential.access_token}` }
        })
      ]);

      const categoryAttributes = Array.isArray(attributesRes.data) ? attributesRes.data : [];
      const categoryInfoData = categoryRes.data || {};

      const catalogDomain = categoryInfoData.settings?.catalog_domain;
      const isUserProduct = !catalogDomain || catalogDomain === "MLC-UNCLASSIFIED_PRODUCTS";

      const requiredAttrs = categoryAttributes.filter(
        attr => attr.tags && (attr.tags.required === true || attr.tags.catalog_required === true)
      );
      const missingAttrs = requiredAttrs.filter(
        attr => !prediction.attributes?.some(a => a.id === attr.id)
      );

      return {
        category_id: categoryId,
        domain_id: prediction.domain_id,
        is_user_product: isUserProduct,
        attributes: prediction.attributes || [],
        missing_required_attributes: missingAttrs,
        category_attributes: categoryAttributes,
        category_settings: categoryInfoData
      };
    } catch (error) {
      logger.error(`[MercadoLibreAdapter] Error en predicción:`, error.message);
      throw error;
    }
  }

  async publish(transformedProduct, options = {}) {
    try {
      logger.info("[MercadoLibreAdapter] === INICIANDO PUBLICACIÓN ===");
      logger.info(`[DEBUG] Título recibido: "${transformedProduct.title}" (${transformedProduct.title?.length || 0} caracteres)`);
      logger.info(`[DEBUG] Name recibido: "${transformedProduct.name}"`);
      logger.info(`[DEBUG] Family_name recibido: "${transformedProduct.family_name}"`);
      logger.info(`[DEBUG] Category ID: ${transformedProduct.category_id}`);
      logger.info(`[DEBUG] Tiene variaciones: ${!!(Array.isArray(transformedProduct.variations) && transformedProduct.variations.length > 0)}`);
      logger.info(`[DEBUG] Variaciones count: ${transformedProduct.variations?.length || 0}`);

      const credentialStatus = await this.ensureValidCredentials();
      if (!credentialStatus?.valid) {
        return credentialStatus;
      }

      const sellerProfile = await this.getMercadoLibreSellerProfile();
      const useUserProductsModel = !!sellerProfile?.user_product_seller;
      logger.info(`[MercadoLibreAdapter] Modelo detectado: ${useUserProductsModel ? 'User Products' : 'Legacy classic'}`);

      const categoryIdForMetadata = String(transformedProduct.category_id || '').trim();
      if (!categoryIdForMetadata) {
        return {
          success: false,
          error: 'missing_category_id',
          message: 'Falta category_id para construir el payload de Mercado Libre'
        };
      }

      const categoryInfo = await this.loadMercadoLibreMetadata({
        categoryId: categoryIdForMetadata,
        accessToken: this.credential?.access_token,
        sellerId: sellerProfile?.seller_id || null
      });
      const categoryId = categoryIdForMetadata;

      if (!useUserProductsModel && transformedProduct.__ml_variation_build_failed === true) {
        const buildReason = transformedProduct.__ml_variation_build_reason || 'unknown';
        logger.error(
          `[MercadoLibreAdapter] ❌ No se puede publicar en modelo clásico porque no se pudieron construir variaciones válidas. reason=${buildReason}`
        );
        return {
          success: false,
          error: 'mercadolibre_variation_build_failed',
          error_code: 'MELI_VARIATION_BUILD_FAILED',
          message: 'No se pudieron construir variaciones válidas para Mercado Libre en modelo clásico',
          details: {
            reason: buildReason,
            model: 'classic'
          }
        };
      }

      const mlExistingItemId = String(
        transformedProduct.__ml_existing_item_id ||
        transformedProduct.external_id ||
        ''
      ).trim();

      const normalizePositiveInteger = (value) => {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed < 0) return null;
        return Math.round(parsed);
      };

      const buildUpdateVariation = (variation) => {
        if (!variation || !variation.id) return null;

        const updateVariation = { id: variation.id };
        const variationPrice = normalizePositiveInteger(variation.price);
        const variationQuantity = normalizePositiveInteger(
          variation.available_quantity ?? variation.quantity ?? variation.stock
        );

        if (variationPrice !== null) updateVariation.price = variationPrice;
        if (variationQuantity !== null) updateVariation.available_quantity = variationQuantity;

        return updateVariation;
      };

      const buildUpdatePayload = ({ existingItemModel, verificationItem }) => {
        const payload = {};
        const soldQuantity = Number(verificationItem?.sold_quantity ?? 0);
        const isUserProduct = existingItemModel === 'user_product';
        const hasExistingClassicVariations = Array.isArray(verificationItem?.variations) && verificationItem.variations.length > 0;
        const hasIncomingClassicVariations = Array.isArray(transformedProduct.variations) && transformedProduct.variations.length > 0;

        if (isUserProduct) {
          if (typeof transformedProduct.title === 'string' && transformedProduct.title.trim()) {
            logger.info('[MercadoLibreAdapter] title omitido en update User Products', {
              itemId: mlExistingItemId,
              categoryId,
              title: transformedProduct.title.trim()
            });
          }

          if (hasIncomingClassicVariations) {
            logger.info('[MercadoLibreAdapter] variations omitidas en update User Products', {
              itemId: mlExistingItemId,
              categoryId,
              variationsCount: transformedProduct.variations.length
            });
          }
        }

        const price = normalizePositiveInteger(transformedProduct.price);
        const quantity = normalizePositiveInteger(
          transformedProduct.available_quantity ?? transformedProduct.stock
        );

        if (!isUserProduct && typeof transformedProduct.title === 'string' && transformedProduct.title.trim()) {
          if (soldQuantity > 0) {
            return {
              __blocked_error: createMercadoLibreError({
                operation: 'update',
                itemModel: 'classic',
                itemId: mlExistingItemId,
                categoryId,
                field: 'title',
                receivedValue: transformedProduct.title.trim(),
                code: 'title_update_blocked',
                message: 'El título clásico no puede actualizarse cuando el ítem tiene ventas',
                metadataSource: 'GET /items/{item_id}'
              })
            };
          }
          payload.title = transformedProduct.title.trim();
        }

        if (price !== null) payload.price = price;
        if (quantity !== null) payload.available_quantity = quantity;

        if (Array.isArray(transformedProduct.pictures) && transformedProduct.pictures.length > 0) {
          payload.pictures = transformedProduct.pictures;
        }

        if (!isUserProduct && (hasExistingClassicVariations || hasIncomingClassicVariations)) {
          if (quantity !== null) {
            return {
              __blocked_error: createMercadoLibreError({
                operation: 'update',
                itemModel: 'classic',
                itemId: mlExistingItemId,
                categoryId,
                field: 'available_quantity',
                receivedValue: quantity,
                code: 'root_stock_not_allowed_with_variations',
                message: 'No se debe actualizar available_quantity raíz cuando el ítem usa variations',
                metadataSource: 'GET /items/{item_id}'
              })
            };
          }

          const variationSource = hasIncomingClassicVariations
            ? transformedProduct.variations
            : (verificationItem?.variations || []);
          const variations = variationSource
            .map(buildUpdateVariation)
            .filter(Boolean);
          if (variations.length > 0) {
            const variationPrices = variations
              .map((variation) => normalizePositiveInteger(variation.price))
              .filter((value) => value !== null);
            if (variationPrices.length > 1 && new Set(variationPrices).size > 1) {
              return {
                __blocked_error: createMercadoLibreError({
                  operation: 'update',
                  itemModel: 'classic',
                  itemId: mlExistingItemId,
                  categoryId,
                  field: 'price',
                  receivedValue: price,
                  code: 'root_price_ambiguous_for_variations',
                  message: 'No se puede inferir un price raíz cuando las variaciones tienen precios distintos',
                  metadataSource: 'GET /items/{item_id}'
                })
              };
            }

            payload.variations = variations;
          }
        }

        return payload;
      };

      const buildRelistPayload = ({ existingItemModel }) => {
        const listingTypeId = normalizeListingTypeId(transformedProduct.listing_type_id);
        if (!listingTypeId) {
          return {
            __blocked_error: createMercadoLibreError({
              operation: 'relist',
              itemModel: existingItemModel === 'user_product' ? 'user_product' : 'classic',
              itemId: mlExistingItemId,
              categoryId,
              field: 'listing_type_id',
              receivedValue: transformedProduct.listing_type_id || null,
              code: 'missing_listing_type_id',
              message: 'No se pudo determinar listing_type_id para relist',
              metadataSource: 'product payload + available listing types'
            })
          };
        }

        const payload = {
          listing_type_id: listingTypeId
        };
        const isUserProduct = existingItemModel === 'user_product';

        if (isUserProduct) {
          return {
            __blocked_error: createMercadoLibreError({
              operation: 'relist',
              itemModel: 'user_product',
              itemId: mlExistingItemId,
              categoryId,
              field: 'relist',
              code: 'user_product_relist_not_implemented',
              message: 'El relist automático de User Products no está implementado por falta de una regla oficial verificable',
              metadataSource: 'GET /items/{item_id} + user_product indicators'
            })
          };
        }

        const price = normalizePositiveInteger(transformedProduct.price);
        const quantity = normalizePositiveInteger(
          transformedProduct.available_quantity ?? transformedProduct.stock
        );

        if (price !== null) payload.price = price;
        if (quantity !== null) payload.quantity = quantity;

        if (!isUserProduct && Array.isArray(transformedProduct.variations) && transformedProduct.variations.length > 0) {
          const variations = transformedProduct.variations
            .map((variation) => {
              if (!variation || !variation.id) return null;
              const relistVariation = { id: variation.id };
              const variationPrice = normalizePositiveInteger(variation.price);
              const variationQuantity = normalizePositiveInteger(
                variation.available_quantity ?? variation.quantity ?? variation.stock
              );
              if (variationPrice !== null) relistVariation.price = variationPrice;
              if (variationQuantity !== null) relistVariation.quantity = variationQuantity;
              return relistVariation;
            })
            .filter(Boolean);

          if (variations.length > 0) {
            payload.variations = variations;
            delete payload.price;
            delete payload.quantity;
          }
        }

        return payload;
      };

      if (mlExistingItemId) {
        try {
          const verification = await verifyMercadoLibreItem({
            itemId: mlExistingItemId,
            accessToken: this.credential?.access_token
          });

          if (verification?.item_found) {
            const currentStatus = String(verification.status || '').trim().toLowerCase();
            const existingItemModelInfo = resolveExistingItemModel(verification.item);
            logger.info(`[MercadoLibreAdapter] Publicación existente detectada ${mlExistingItemId} en estado ${currentStatus || 'desconocido'}`);
            logger.info(`[MercadoLibreAdapter] Modelo detectado para ${mlExistingItemId}: ${existingItemModelInfo.model}`, {
              evidence: existingItemModelInfo.evidence,
              hasClassicVariations: existingItemModelInfo.hasClassicVariations
            });

            if (currentStatus === 'closed') {
              const relistPayload = buildRelistPayload({ existingItemModel: existingItemModelInfo.model });
              if (relistPayload?.__blocked_error) {
                return { success: false, error: relistPayload.__blocked_error.code, details: relistPayload.__blocked_error };
              }
              logger.info(`[MercadoLibreAdapter] REPUBLICAR item cerrado ${mlExistingItemId}`);
              this.logPublishPayloadMarker({
                label: 'relist',
                model: existingItemModelInfo.model,
                sku: transformedProduct.sku || transformedProduct.external_id || null,
                itemId: mlExistingItemId,
                payload: relistPayload
              });

              const relistResponse = await axios.post(
                `https://api.mercadolibre.com/items/${mlExistingItemId}/relist`,
                relistPayload,
                {
                  headers: {
                    Authorization: `Bearer ${this.credential.access_token}`,
                    'Content-Type': 'application/json',
                    Accept: 'application/json'
                  },
                  timeout: 30000
                }
              );

              return {
                success: true,
                external_id: relistResponse.data.id,
                data: relistResponse.data
              };
            }

            const updatePayload = buildUpdatePayload({
              existingItemModel: existingItemModelInfo.model,
              verificationItem: verification.item
            });
            if (updatePayload?.__blocked_error) {
              return { success: false, error: updatePayload.__blocked_error.code, details: updatePayload.__blocked_error };
            }
            if (Object.keys(updatePayload).length > 0) {
              logger.info(`[MercadoLibreAdapter] ACTUALIZAR item existente ${mlExistingItemId}`);
              this.logPublishPayloadMarker({
                label: 'update',
                model: existingItemModelInfo.model,
                sku: transformedProduct.sku || transformedProduct.external_id || null,
                itemId: mlExistingItemId,
                payload: updatePayload
              });

              const updateResponse = await axios.put(
                `https://api.mercadolibre.com/items/${mlExistingItemId}`,
                updatePayload,
                {
                  headers: {
                    Authorization: `Bearer ${this.credential.access_token}`,
                    'Content-Type': 'application/json',
                    Accept: 'application/json'
                  },
                  timeout: 30000
                }
              );

              return {
                success: true,
                external_id: updateResponse.data.id || mlExistingItemId,
                data: updateResponse.data
              };
            }

            logger.warn(`[MercadoLibreAdapter] Item existente ${mlExistingItemId} sin campos actualizables, se mantendrá publicación actual`);
            return {
              success: true,
              external_id: mlExistingItemId,
              data: verification.item
            };
          }
        } catch (existingError) {
          if (existingError?.response?.status !== 404) {
            logger.warn(`[MercadoLibreAdapter] No se pudo validar item existente ${mlExistingItemId}: ${existingError.message}`);
          } else {
            logger.warn(`[MercadoLibreAdapter] Item existente ${mlExistingItemId} no encontrado; se creará nueva publicación`);
          }
        }
      }

      const categorySettings = transformedProduct.category_settings || {};
      const catalogDomain = categorySettings?.settings?.catalog_domain;
      const isCatalogProduct = !!catalogDomain && catalogDomain !== "MLC-UNCLASSIFIED_PRODUCTS";

      const hasVariations =
        Array.isArray(transformedProduct.variations) &&
        transformedProduct.variations.length > 0;

      // 🔑 AJUSTE POST-TRANSFORMACIÓN: Regla ML específica
      if (transformedProduct.__ml_has_variation_attributes) {
        if (!transformedProduct.family_name && transformedProduct.title) {
          // Convertir title → family_name (regla ML para categorías con variaciones)
          transformedProduct.family_name = transformedProduct.title;
          delete transformedProduct.title;
          logger.info(`[ML Adapter] 🔑 Convirtiendo title a family_name: "${transformedProduct.family_name}"`);
        }
      }

      // 🔑 Fallback genérico de seguridad
      if (!transformedProduct.family_name && !transformedProduct.title) {
        transformedProduct.title = 
          transformedProduct.name || 
          `Producto ${Date.now().toString().slice(-6)}`;
        logger.warn(`[ML Adapter] ⚠️ Sin family_name ni title → usando fallback: "${transformedProduct.title}"`);
      }

      const productToPublish = {
        site_id: this.getSiteId(),
        category_id: categoryId,
        price: transformedProduct.price,
        available_quantity:
          transformedProduct.available_quantity ??
          transformedProduct.stock ??
          0,
        currency_id: transformedProduct.currency_id || transformedProduct.currency || null,
        buying_mode: null,
        listing_type_id: normalizeListingTypeId(transformedProduct.listing_type_id),
        condition: null,
        pictures: transformedProduct.pictures || []
      };

      if (!productToPublish.listing_type_id) {
        return {
          success: false,
          error: 'missing_listing_type_id',
          details: createMercadoLibreError({
            operation: 'create',
            itemModel: useUserProductsModel ? 'user_product' : 'classic',
            categoryId,
            field: 'listing_type_id',
            receivedValue: transformedProduct.listing_type_id || null,
            code: 'missing_listing_type_id',
            message: 'No se pudo determinar listing_type_id para la publicación',
            metadataSource: 'product payload + available listing types'
          })
        };
      }

      const categoryShippingPreferences = categoryInfo?.shippingPreferences?.category || null;
      const userShippingPreferences = categoryInfo?.shippingPreferences?.user || null;
      const shippingLogistics = Array.isArray(categoryShippingPreferences?.logistics)
        ? categoryShippingPreferences.logistics
        : [];
      const preferredLogisticEntry = shippingLogistics.find((entry) => entry?.mode && Array.isArray(entry?.types) && entry.types.length > 0) || null;
      const derivedShippingMode = transformedProduct.shipping_mode
        || preferredLogisticEntry?.mode
        || (Array.isArray(userShippingPreferences?.modes) && userShippingPreferences.modes.includes('me2') ? 'me2' : null);
      const derivedLogisticType = transformedProduct.logistic_type
        || (Array.isArray(preferredLogisticEntry?.types) && preferredLogisticEntry.types[0]) || null;

      if (derivedShippingMode || derivedLogisticType) {
        productToPublish.shipping = {
          ...(derivedShippingMode ? { mode: derivedShippingMode } : {}),
          ...(derivedLogisticType ? { logistic_type: derivedLogisticType } : {})
        };
      } else {
        return {
          success: false,
          error: 'shipping_not_available',
          details: createMercadoLibreError({
            operation: 'create',
            itemModel: useUserProductsModel ? 'user_product' : 'classic',
            categoryId,
            field: 'shipping',
            receivedValue: {
              shipping_mode: transformedProduct.shipping_mode || null,
              logistic_type: transformedProduct.logistic_type || null
            },
            code: 'shipping_not_available',
            message: 'No se pudo determinar shipping habilitado para el seller y la categoría',
            metadataSource: 'GET /users/{seller_id}/shipping_preferences + GET /categories/{category_id}/shipping_preferences'
          })
        };
      }

      const commercialFields = resolveMercadoLibreCommercialFields(transformedProduct, {
        operation: 'create',
        itemModel: useUserProductsModel ? 'user_product' : 'classic',
        categoryId,
        metadataSource: 'product payload'
      });

      if (commercialFields.__blocked_error) {
        return {
          success: false,
          error: commercialFields.__blocked_error.code,
          details: commercialFields.__blocked_error
        };
      }

      productToPublish.buying_mode = commercialFields.buying_mode;
      productToPublish.condition = commercialFields.condition;

      if (Array.isArray(transformedProduct.attributes)) {
        productToPublish.attributes = transformedProduct.attributes;
      }

      const saleTermsToSend = buildWarrantySaleTerms(transformedProduct);
      if (saleTermsToSend.length > 0) {
        const allowedSaleTermIds = new Set(Array.isArray(categoryInfo?.sale_term_ids) ? categoryInfo.sale_term_ids : []);

        const filteredSaleTerms = allowedSaleTermIds.size > 0
          ? saleTermsToSend.filter(st => st?.id && allowedSaleTermIds.has(st.id))
          : saleTermsToSend;

        const removedTerms = allowedSaleTermIds.size > 0
          ? saleTermsToSend
            .filter(st => st?.id && !allowedSaleTermIds.has(st.id))
            .map(st => st.id)
          : [];

        if (removedTerms.length > 0) {
          logger.warn(
            `[ML Adapter] Sale terms no soportados para categoría ${categoryId}, omitidos: ${removedTerms.join(', ')}`
          );
        }

        if (filteredSaleTerms.length > 0) {
          productToPublish.sale_terms = filteredSaleTerms;
        }
      }

      const itemDescription = typeof transformedProduct.description?.plain_text === 'string'
        ? transformedProduct.description.plain_text.trim()
        : typeof transformedProduct.description === 'string'
          ? transformedProduct.description.trim()
          : '';
      const sourcePublishableVariants = Array.isArray(transformedProduct.__ml_source_variants)
        ? transformedProduct.__ml_source_variants.filter((variant) => variant && variant.publish && Number(variant.price) > 0)
        : [];
      const marketplaceAttributesForVariations = Array.isArray(transformedProduct.__ml_marketplace_attributes)
        ? transformedProduct.__ml_marketplace_attributes
        : transformedProduct.attributes;

      if (useUserProductsModel) {
        const publishableVariants = sourcePublishableVariants.length > 0
          ? sourcePublishableVariants
          : hasVariations
          ? transformedProduct.variations.filter((variant) => variant && variant.publish && Number(variant.price) > 0)
          : [null];

        const familyName = (transformedProduct.family_name || transformedProduct.name || transformedProduct.title || 'Producto sin nombre')
          .toString()
          .trim();
        const createdItems = [];
        const parentPkAttributes = Array.isArray(categoryInfo?.attributes)
          ? categoryInfo.attributes.filter((attr) => isMercadoLibreParentPkAttribute(attr))
          : [];

        if (publishableVariants.length > 1 && parentPkAttributes.length > 0) {
          const parentSignatures = publishableVariants.map((variant) => {
            const resolvedAttributes = this.buildMercadoLibreUserProductAttributes(
              transformedProduct.attributes,
              variant,
              categoryInfo?.attributes || [],
              transformedProduct.__ml_marketplace_attributes || []
            );
            return parentPkAttributes
              .map((attr) =>
                this.resolveMercadoLibreAttributeValueFromVariant(variant, attr) ||
                this.resolveMercadoLibreAttributeValueFromAttributes(resolvedAttributes, attr) ||
                ''
              )
              .join('|');
          });

          const uniqueSignatures = new Set(parentSignatures.map((value) => value.trim()));
          uniqueSignatures.delete('');

          if (uniqueSignatures.size > 1) {
            return {
              success: false,
              error: 'parent_pk_inconsistent',
              details: createMercadoLibreError({
                operation: 'create',
                itemModel: 'user_product',
                categoryId,
                field: 'parent_pk',
                receivedValue: parentSignatures,
                code: 'parent_pk_inconsistent',
                message: 'Las variantes de User Products no comparten un Parent PK consistente',
                metadataSource: 'GET /categories/{category_id}/attributes'
              })
            };
          }
        }

        const validatedUserProductPayloads = [];

        for (const variant of publishableVariants) {
          const userProductPayload = this.buildMercadoLibreUserProductItemPayload(
            {
              ...transformedProduct,
              family_name: familyName
            },
            variant,
            categoryInfo
          );

          if (userProductPayload?.__blocked_error) {
            return {
              success: false,
              error: userProductPayload.__blocked_error.code,
              details: userProductPayload.__blocked_error
            };
          }

          delete userProductPayload.title;
          delete userProductPayload.variations;

          const validationResult = await this.validateMercadoLibrePayload(userProductPayload);
          if (!validationResult.valid) {
            return {
              success: false,
              error: validationResult.error,
              details: validationResult.details || {
                error_code: validationResult.error,
                validation: validationResult.validation
              },
              validation: validationResult.validation,
              sku: variant?.sku || transformedProduct.sku || null
            };
          }

          validatedUserProductPayloads.push({
            variant,
            sku: variant?.sku || transformedProduct.sku || null,
            payload: userProductPayload,
            validation: validationResult.validation
          });
        }

        for (const validatedPayload of validatedUserProductPayloads) {
          this.logPublishPayloadMarker({
            label: 'create',
            model: 'user_products',
            sku: validatedPayload.sku,
            itemId: null,
            payload: validatedPayload.payload
          });

          const response = await axios.post(
            "https://api.mercadolibre.com/items",
            validatedPayload.payload,
            {
              headers: {
                Authorization: `Bearer ${this.credential.access_token}`,
                "Content-Type": "application/json",
                Accept: "application/json"
              },
              timeout: 30000
            }
          );

          if (typeof options.onItemCreated === 'function') {
            await options.onItemCreated({
              marketplace: 'mercado_libre',
              model: 'user_products',
              operation: 'create',
              itemId: response.data?.id || null,
              sku: validatedPayload.sku,
              payload: validatedPayload.payload,
              response: response.data,
              validation: validatedPayload.validation
            });
          }

          if (itemDescription) {
            await this.publishMercadoLibreDescription(response.data.id, itemDescription);
          }

          createdItems.push({
            id: response.data.id,
            data: response.data,
            sku: validatedPayload.sku,
            validation: validatedPayload.validation
          });
        }

        return {
          success: true,
          external_id: createdItems[0]?.id || null,
          data: {
            model: 'user_products',
            items: createdItems,
            validation_results: createdItems.map((item) => item.validation).filter(Boolean)
          }
        };
      }

      if (hasVariations) {
        const publishableVariants = sourcePublishableVariants.length > 0
          ? sourcePublishableVariants
          : transformedProduct.variations.filter(
            (variant) => variant && variant.publish && Number(variant.price) > 0
          );

        if (publishableVariants.length > 1) {
          const builtVariations = this.buildValidMercadoLibreVariations(
            publishableVariants,
            categoryInfo.attributes,
            productToPublish.price,
            productToPublish.pictures,
            marketplaceAttributesForVariations
          );

          if (!builtVariations || builtVariations.length < 2) {
            return {
              success: false,
              error: 'mercadolibre_variation_build_failed',
              details: createMercadoLibreError({
                operation: 'create',
                itemModel: 'classic',
                categoryId,
                field: 'variations',
                receivedValue: transformedProduct.variations,
                code: 'variation_build_failed',
                message: 'No se pudieron construir variaciones válidas para la publicación clásica',
                metadataSource: 'GET /categories/{category_id}/attributes'
              })
            };
          }

          productToPublish.variations = builtVariations;

          const rootPictureKeys = new Set(
            (Array.isArray(productToPublish.pictures) ? productToPublish.pictures : [])
              .map(normalizePictureKey)
              .filter(Boolean)
          );
          const missingPictureIds = [];
          for (const variation of builtVariations) {
            for (const pictureId of Array.isArray(variation.picture_ids) ? variation.picture_ids : []) {
              if (!rootPictureKeys.has(String(pictureId).trim())) {
                missingPictureIds.push(pictureId);
              }
            }
          }

          if (missingPictureIds.length > 0) {
            return {
              success: false,
              error: 'variation_pictures_not_in_root',
              details: createMercadoLibreError({
                operation: 'create',
                itemModel: 'classic',
                categoryId,
                field: 'pictures',
                receivedValue: missingPictureIds,
                code: 'variation_images_missing_in_root',
                message: 'Las imágenes de variación deben incluirse también en pictures raíz',
                metadataSource: 'GET /items/validate'
              })
            };
          }
        }
      }

      if (!productToPublish.currency_id) {
        return {
          success: false,
          error: 'missing_currency_id',
          details: createMercadoLibreError({
            operation: 'create',
            itemModel: 'classic',
            categoryId,
            field: 'currency_id',
            receivedValue: transformedProduct.currency_id || transformedProduct.currency || null,
            code: 'missing_currency_id',
            message: 'No se pudo determinar currency_id para la publicación',
            metadataSource: 'product payload + category metadata'
          })
        };
      }

      // 🔑 APLICAR REGLA DEFINITIVA DE NAMING PARA MODELO CLÁSICO
      let titleValue = (transformedProduct.title || transformedProduct.name || transformedProduct.family_name || "Producto")
        .toString()
        .trim();
      if (!titleValue || titleValue.length === 0) titleValue = `Producto ${Date.now().toString().slice(-6)}`;
      if (titleValue.length < 6) titleValue = titleValue.padEnd(6, " ");
      if (titleValue.length > 60) titleValue = titleValue.substring(0, 60);
      productToPublish.title = titleValue;
      delete productToPublish.family_name;
      logger.info(`[DEBUG] 📦 Modelo clásico → title: "${titleValue}"`);

      this.logPublishPayloadMarker({
        label: 'create',
        model: 'classic',
        sku: transformedProduct.sku || transformedProduct.external_id || null,
        itemId: null,
        payload: productToPublish
      });

      const validationResult = await this.validateMercadoLibrePayload(productToPublish);
      if (!validationResult.valid) {
        return {
          success: false,
          error: validationResult.error,
          details: validationResult.details || {
            error_code: validationResult.error,
            validation: validationResult.validation
          },
          validation: validationResult.validation
        };
      }

      const response = await axios.post(
        "https://api.mercadolibre.com/items",
        productToPublish,
        {
          headers: {
            Authorization: `Bearer ${this.credential.access_token}`,
            "Content-Type": "application/json",
            Accept: "application/json"
          },
          timeout: 30000
        }
      );

      if (typeof options.onItemCreated === 'function') {
        await options.onItemCreated({
          marketplace: 'mercado_libre',
          model: hasVariations ? 'classic_variations' : 'classic',
          operation: 'create',
          itemId: response.data?.id || null,
          sku: transformedProduct.sku || transformedProduct.external_id || null,
          payload: productToPublish,
          response: response.data,
          validation: validationResult.validation
        });
      }

      if (itemDescription) {
        await this.publishMercadoLibreDescription(response.data.id, itemDescription);
      }

      logger.info(
        `[MercadoLibreAdapter] ✅ Resultado de publicación: ${JSON.stringify({
         data: response.data
        })}`
      );
      return {
        success: true,
        external_id: response.data.id,
        data: {
          ...response.data,
          validation: validationResult.validation
        }
      };
    } catch (error) {
      logger.error("[MercadoLibreAdapter] ❌ Error en publicación:");
      logger.error(`Error message: ${JSON.stringify(error.message)}`);
      
      if (error.response) {
        logger.error(`Status: ${error.response.status}`);
        logger.error(`Response: ${JSON.stringify(error.response.data, null, 2)}`);
      }
      
      return this.handlePublishError(error);
    }
  }

  async updateItem({
    itemId,
    status = undefined,
    price = undefined,
    available_quantity = undefined,
    title = undefined,
    family_name = undefined,
    description = undefined,
    pictures = undefined,
    variations = undefined,
    itemModel = null,
    user_product_id = undefined
  }) {
    try {
      const credentialStatus = await this.ensureValidCredentials();
      if (!credentialStatus?.valid) {
        return {
          success: false,
          error: credentialStatus?.auth_required ? 'auth_required' : (credentialStatus?.error || 'credential_invalid'),
          auth_required: !!credentialStatus?.auth_required,
          auth_url: credentialStatus?.auth_url || null,
          details: credentialStatus
        };
      }

      if (!this.credential?.access_token) {
        return { success: false, error: 'auth_required', auth_required: true };
      }

      const normalizedItemId = String(itemId || '').trim();
      if (!normalizedItemId) {
        return { success: false, error: 'missing_item_id' };
      }

      const payload = {};

      if (status !== undefined && status !== null && String(status).trim() !== '') {
        const normalizedStatus = String(status).trim().toLowerCase();
        if (!['active', 'paused', 'closed'].includes(normalizedStatus)) {
          return { success: false, error: 'invalid_status', details: { allowed_values: ['active', 'paused', 'closed'] } };
        }
        payload.status = normalizedStatus;
      }

      if (price !== undefined && price !== null && price !== '') {
        const parsedPrice = Number(price);
        if (!Number.isFinite(parsedPrice) || parsedPrice < 0) {
          return { success: false, error: 'invalid_price' };
        }
        payload.price = parsedPrice;
      }

      if (available_quantity !== undefined && available_quantity !== null && available_quantity !== '') {
        const parsedQuantity = Number(available_quantity);
        if (!Number.isFinite(parsedQuantity) || parsedQuantity < 0 || !Number.isInteger(parsedQuantity)) {
          return { success: false, error: 'invalid_available_quantity' };
        }
        payload.available_quantity = parsedQuantity;
      }

      const verification = await verifyMercadoLibreItem({
        itemId: normalizedItemId,
        accessToken: this.credential.access_token
      });

      if (!verification?.item_found) {
        return {
          success: false,
          error: verification?.error_code === 'item_not_found' ? 'item_not_found' : 'item_verification_failed',
          status_code: verification?.http_status || 404,
          details: verification
        };
      }

      const currentStatus = String(verification.status || '').trim().toLowerCase();
      if (currentStatus === 'closed') {
        return {
          success: false,
          error: 'item_closed_relist_required',
          status_code: 409,
          details: verification
        };
      }

      const existingItemModelInfo = itemModel
        ? {
            model: itemModel,
            hasClassicVariations: Array.isArray(verification.item?.variations) && verification.item.variations.length > 0,
            evidence: { source: 'override' }
          }
        : resolveExistingItemModel(verification.item);
      const resolvedModel = existingItemModelInfo.model;
      const isUserProduct = resolvedModel === 'user_product';

      const requestedStatus = status !== undefined && status !== null && String(status).trim() !== ''
        ? String(status).trim().toLowerCase()
        : null;
      if (requestedStatus) {
        if (!['active', 'paused', 'closed'].includes(requestedStatus)) {
          return { success: false, error: 'invalid_status', details: { allowed_values: ['active', 'paused', 'closed'] } };
        }
        payload.status = requestedStatus;
      }

      const parsedPrice = price !== undefined && price !== null && price !== '' ? Number(price) : null;
      if (parsedPrice !== null) {
        if (!Number.isFinite(parsedPrice) || parsedPrice < 0) {
          return { success: false, error: 'invalid_price' };
        }
        payload.price = parsedPrice;
      }

      const parsedQuantity = available_quantity !== undefined && available_quantity !== null && available_quantity !== ''
        ? Number(available_quantity)
        : null;
      let userProductStockUpdate = null;

      if (isUserProduct) {
        delete payload.available_quantity;

        if (title !== undefined && String(title).trim() !== '') {
          return {
            success: false,
            error: 'title_update_blocked_for_user_product',
            details: createMercadoLibreError({
              operation: 'update',
              itemModel: 'user_product',
              itemId: normalizedItemId,
              field: 'title',
              receivedValue: title,
              code: 'title_not_allowed',
              message: 'User Products no admite actualización de title',
              metadataSource: 'GET /items/{item_id}'
            })
          };
        }

        if (Array.isArray(variations) && variations.length > 0) {
          return {
            success: false,
            error: 'variations_not_allowed_for_user_product',
            details: createMercadoLibreError({
              operation: 'update',
              itemModel: 'user_product',
              itemId: normalizedItemId,
              field: 'variations',
              receivedValue: variations,
              code: 'variations_not_allowed',
              message: 'User Products no admite variaciones en update',
              metadataSource: 'GET /items/{item_id}'
            })
          };
        }

        if (Array.isArray(pictures) && pictures.length > 0) {
          payload.pictures = pictures;
        }

        if (parsedQuantity !== null) {
          const resolvedUserProductId = this.resolveMercadoLibreUserProductId(verification.item, user_product_id);
          if (!resolvedUserProductId) {
            return {
              success: false,
              error: 'user_product_id_missing_for_stock_update',
              details: createMercadoLibreError({
                operation: 'update',
                itemModel: 'user_product',
                itemId: normalizedItemId,
                field: 'available_quantity',
                receivedValue: parsedQuantity,
                code: 'user_product_id_missing',
                message: 'No se pudo actualizar stock User Products porque GET /items/{item_id} no retornó user_product_id',
                metadataSource: 'GET /items/{item_id}'
              })
            };
          }

          const stockInfo = await this.getMercadoLibreUserProductStock(resolvedUserProductId);
          const stockUpdate = await this.updateMercadoLibreUserProductStock(
            resolvedUserProductId,
            parsedQuantity,
            stockInfo,
            normalizedItemId
          );
          if (stockUpdate?.__blocked_error) {
            return { success: false, error: stockUpdate.__blocked_error.code, details: stockUpdate.__blocked_error };
          }
          userProductStockUpdate = {
            user_product_id: resolvedUserProductId,
            requested_quantity: Math.round(parsedQuantity),
            response: stockUpdate || null
          };
        }

        if (family_name !== undefined && String(family_name).trim() !== '') {
          const familyUpdate = await this.updateMercadoLibreFamilyName(normalizedItemId, family_name);
          if (familyUpdate === null) {
            return { success: false, error: 'family_name_update_failed' };
          }
        }

        if (payload.price === undefined && payload.status === undefined && !payload.pictures) {
          if (description !== undefined && String(description).trim() === '') {
            return { success: false, error: 'no_changes' };
          }
        }

        if (Object.keys(payload).length > 0) {
          const response = await axios.put(
            `https://api.mercadolibre.com/items/${normalizedItemId}`,
            payload,
            {
              headers: {
                Authorization: `Bearer ${this.credential.access_token}`,
                'Content-Type': 'application/json',
                Accept: 'application/json'
              },
              timeout: 30000
            }
          );

          if (description !== undefined && String(description).trim() !== '') {
            await this.updateMercadoLibreDescription(normalizedItemId, description);
          }

          return {
            success: true,
            external_id: response.data?.id || normalizedItemId,
            data: userProductStockUpdate
              ? { ...(response.data || {}), available_quantity: userProductStockUpdate.requested_quantity }
              : response.data,
            requested_changes: userProductStockUpdate
              ? { ...payload, available_quantity: userProductStockUpdate.requested_quantity }
              : payload,
            stock_update: userProductStockUpdate,
            current_status: currentStatus,
            item_model: resolvedModel
          };
        }

        if (description !== undefined && String(description).trim() !== '') {
          await this.updateMercadoLibreDescription(normalizedItemId, description);
          return {
            success: true,
            external_id: normalizedItemId,
            data: verification.item,
            requested_changes: { description: true },
            current_status: currentStatus,
            item_model: resolvedModel
          };
        }

        return {
          success: true,
          external_id: normalizedItemId,
          data: userProductStockUpdate
            ? { ...(verification.item || {}), available_quantity: userProductStockUpdate.requested_quantity }
            : verification.item,
          requested_changes: userProductStockUpdate
            ? { available_quantity: userProductStockUpdate.requested_quantity }
            : {},
          stock_update: userProductStockUpdate,
          current_status: currentStatus,
          item_model: resolvedModel
        };
      }

      if (family_name !== undefined && String(family_name).trim() !== '') {
        return {
          success: false,
          error: 'family_name_update_blocked_for_classic',
          details: createMercadoLibreError({
            operation: 'update',
            itemModel: 'classic',
            itemId: normalizedItemId,
            field: 'family_name',
            receivedValue: family_name,
            code: 'family_name_not_allowed',
            message: 'family_name solo se actualiza en User Products',
            metadataSource: 'GET /items/{item_id}'
          })
        };
      }

      if (title !== undefined && String(title).trim() !== '') {
        if (Number(verification.item?.sold_quantity || 0) > 0) {
          return {
            success: false,
            error: 'title_update_blocked',
            details: createMercadoLibreError({
              operation: 'update',
              itemModel: 'classic',
              itemId: normalizedItemId,
              field: 'title',
              receivedValue: title,
              code: 'title_update_blocked',
              message: 'El título clásico no puede actualizarse cuando el ítem tiene ventas',
              metadataSource: 'GET /items/{item_id}'
            })
          };
        }
        payload.title = String(title).trim();
      }

      if (parsedQuantity !== null) {
        payload.available_quantity = parsedQuantity;
      }

      if (Array.isArray(pictures) && pictures.length > 0) {
        payload.pictures = pictures;
      }

      if (Array.isArray(variations) && variations.length > 0) {
        const classicVariations = variations
          .map((variation) => {
            if (!variation || !variation.id) return null;
            const updateVariation = { id: variation.id };
            if (variation.price !== undefined && variation.price !== null && variation.price !== '') {
              const parsedVariationPrice = Number(variation.price);
              if (Number.isFinite(parsedVariationPrice) && parsedVariationPrice >= 0) {
                updateVariation.price = parsedVariationPrice;
              }
            }
            if (variation.available_quantity !== undefined && variation.available_quantity !== null && variation.available_quantity !== '') {
              const parsedVariationQty = Number(variation.available_quantity);
              if (Number.isFinite(parsedVariationQty) && parsedVariationQty >= 0) {
                updateVariation.available_quantity = Math.round(parsedVariationQty);
              }
            }
            return updateVariation;
          })
          .filter(Boolean);
        if (classicVariations.length > 0) {
          payload.variations = classicVariations;
        }
      }

      if (Object.keys(payload).length === 0) {
        if (description !== undefined && String(description).trim() !== '') {
          await this.updateMercadoLibreDescription(normalizedItemId, description);
          return {
            success: true,
            external_id: normalizedItemId,
            data: verification.item,
            requested_changes: { description: true },
            current_status: currentStatus,
            item_model: resolvedModel
          };
        }
        return { success: false, error: 'no_changes' };
      }

      const response = await axios.put(
        `https://api.mercadolibre.com/items/${normalizedItemId}`,
        payload,
        {
          headers: {
            Authorization: `Bearer ${this.credential.access_token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json'
          },
          timeout: 30000
        }
      );

      return {
        success: true,
        external_id: response.data?.id || normalizedItemId,
        data: response.data,
        requested_changes: payload,
        current_status: currentStatus,
        item_model: resolvedModel
      };
    } catch (error) {
      logger.error(`[MercadoLibreAdapter] Error actualizando item: ${error.message}`);
      logger.error(`[MercadoLibreAdapter] Update request fallido: ${JSON.stringify({
        method: error.config?.method || null,
        url: error.config?.url || null,
        payload: error.config?.data ? parseJsonObject(error.config.data) : null,
        status: error.response?.status || null,
        response: error.response?.data || null
      })}`);
      if (error.response) {
        if (error.response.status === 401) {
          return {
            success: false,
            error: 'auth_required',
            auth_required: true,
            status_code: error.response.status,
            details: error.response.data || null
          };
        }

        return {
          success: false,
          error: error.response.data?.message || error.response.data?.error || `Error ${error.response.status} en MercadoLibre`,
          status_code: error.response.status,
          details: error.response.data || null
        };
      }
      return { success: false, error: error.message || 'internal_error' };
    }
  }

  async getCategorySaleTermIds(categoryId, accessToken) {
    try {
      const metadata = await this.getCategoryMetadata(categoryId, accessToken);
      return new Set(Array.isArray(metadata?.sale_term_ids) ? metadata.sale_term_ids : []);
    } catch (error) {
      logger.warn(
        `[ML Adapter] No se pudieron obtener sale_terms de categoría ${categoryId}. Se enviarán sale_terms originales. Error: ${error.message}`
      );
      return null;
    }
  }

  handlePublishError(error) {
    if (error.response) {
      const { status, data } = error.response;
      let errorMessage = data?.message || data?.error || `Error ${status} en MercadoLibre`;
      if (data?.cause?.length) {
        errorMessage += ` - ${data.cause.map(c => c.message).join(", ")}`;
      }
      return { success: false, error: errorMessage, status_code: status };
    } else if (error.request) {
      return { success: false, error: `Error de conexión: ${error.message}` };
    } else {
      return { success: false, error: error.message || "Error interno" };
    }
  }

  async getAuthUrl() {
  let basicCred;
  let marketplace;
  
  // ✅ NUEVO: Si hay credentialId específico, usarlo
 if (this.credentialId) {
    if (typeof this.credentialId === 'object' && this.credentialId !== null) {
      // Ya es el objeto completo
      basicCred = this.credentialId;
      marketplace = basicCred.marketplace || basicCred || {};
      logger.info(`[MercadoLibreAdapter] Usando credential object para auth (ID: ${basicCred.id})`);
    } else {
      // Es un ID numérico, buscar en repositorio
      basicCred = await MarketplaceCredentialRepository.findById(this.credentialId);
      marketplace = basicCred?.marketplace || basicCred || {};
    }
  } else {
    // Fallback al comportamiento original
    marketplace = this.companyId
      ? await MarketplaceCredentialRepository.findByMarketplaceAndCompany(
          this.marketplaceId,
          this.companyId
        )
      : null;
  }
  
  if (!basicCred || !marketplace.client_id || !marketplace.redirect_uri) {
    return { success: false, error: "Credenciales incompletas para autenticación" };
  }

  const requiredScopes = "write offline_access urn:ml:mktp:publish-sync:/read-write";
  
  // ✅ NUEVO: Incluir credential_id en el state para el callback
  const state = `${this.marketplaceId}_${this.companyId || 0}_${this.userId}_${basicCred.id}`;
  
  // ✅ CORREGIDO: Eliminar espacios en URL
  const authUrl = `https://auth.mercadolibre.cl/authorization?response_type=code&client_id=${encodeURIComponent(marketplace.client_id)}&redirect_uri=${encodeURIComponent(marketplace.redirect_uri)}&state=${encodeURIComponent(state)}&scope=${encodeURIComponent(requiredScopes)}`;
 
  return { 
    auth_required: true, 
    auth_url: authUrl, 
    message: "Se requiere autorización en Mercado Libre",
    credential_id: basicCred.id  // ← NUEVO: Para referencia del frontend
  };
}

  getSiteId() {
    const configuredSiteId = String(this.getMarketplaceConfig().site_id || '').trim().toUpperCase();
    if (configuredSiteId) return configuredSiteId;

    const siteMap = {
      "mercadolibre.cl": "MLC",
      "mercadolibre.com.ar": "MLA",
      "mercadolibre.com.mx": "MLM",
      "mercadolibre.com.co": "MCO",
      "mercadolibre.com.br": "MLB"
    };
    if (this.marketplace?.domain) {
      for (const [domain, siteId] of Object.entries(siteMap)) {
        if (this.marketplace.domain.includes(domain)) return siteId;
      }
    }
    if (this.credential?.marketplace?.domain) {
      for (const [domain, siteId] of Object.entries(siteMap)) {
        if (this.credential.marketplace.domain.includes(domain)) return siteId;
      }
    }
    return null;
  }

  static supports(marketplace) {
    return marketplace.domain?.includes("mercadolibre");
  }
}

module.exports = MercadoLibreAdapter;
