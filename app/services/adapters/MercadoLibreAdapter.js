// src/services/adapters/MercadoLibreAdapter.js
const BaseAdapter = require("./BaseAdapter");
const logger = require("../../../config/logger");
const { MarketplaceCredentialRepository } = require("../../repositories");
const axios = require('axios');
const MarketplaceTransformerMercadoLibre = require("../MarketplaceTransformerMercadoLibre");
const MercadoLibreAttributesService = require('../MercadoLibreAttributesService');
const { verifyMercadoLibreItem } = require('../MarketplaceItemVerificationService');

const ML_SUPPORTED_LISTING_TYPES = ['gold_pro', 'gold_special', 'free'];
const ML_STRATEGY = {
  CONVERSION: 'CONVERSION',
  MARGIN: 'MARGIN'
};

function normalizeListingTypeId(listingType) {
  const normalized = listingType === 'bronze' ? 'gold_special' : listingType;
  if (!normalized) return 'gold_special';
  return ML_SUPPORTED_LISTING_TYPES.includes(normalized) ? normalized : 'gold_special';
}

function normalizeStrategyForPublish(strategy, legacyListingTypeId) {
  const raw = String(strategy || '').trim().toUpperCase();
  if (raw === ML_STRATEGY.CONVERSION) return ML_STRATEGY.CONVERSION;
  if (raw === ML_STRATEGY.MARGIN || raw === 'PROFIT') return ML_STRATEGY.MARGIN;
  if (legacyListingTypeId === 'gold_pro') return ML_STRATEGY.CONVERSION;
  if (legacyListingTypeId) return ML_STRATEGY.MARGIN;
  return ML_STRATEGY.CONVERSION;
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

function buildWarrantySaleTerms(productData) {
  const warrantyMonths = extractWarrantyMonths(productData);

  if (warrantyMonths === null) {
    return [];
  }

  const warrantyUnit = warrantyMonths === 1 ? 'mes' : 'meses';

  return [{
    id: 'WARRANTY_TIME',
    value_name: `${warrantyMonths} ${warrantyUnit}`
  }];
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

      const processedBrand = { id: attr.id };
      const resolvedValueId = matchById?.id || matchByName?.id || rawValueId || null;
      const resolvedValueName = matchById?.name || matchByName?.name || rawValueName || null;

      if (resolvedValueId) {
        processedBrand.value_id = String(resolvedValueId).trim();
      }

      if (resolvedValueName && (allowCustomValue || processedBrand.value_id)) {
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
        const attrMeta = categoryAttributesMap.get(attr.id);
        const isReadOnly = attrMeta?.tags?.read_only === true;
        const isHidden = attrMeta?.tags?.hidden === true;
        const isItemCondition = attr.id === 'ITEM_CONDITION';

        if (isReadOnly || isHidden || isItemCondition) {
          logger.warn(`[ML Adapter] ⚠️ Atributo ${attr.id} filtrado (read_only/hidden/ITEM_CONDITION)`);
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
      || mlData?.shipping_mode
      || null;
    const logisticTypeOverride = shippingEffective.logistic_type
      || shippingRequested.logistic_type
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

    // ✅ PASO 2: Determinar si es producto de catálogo
    const catalogDomain = categoryInfo.settings?.catalog_domain;
    const isCatalogProduct = !!catalogDomain && catalogDomain !== "MLC-UNCLASSIFIED_PRODUCTS";
    const hasVariationAttributes = categoryInfo.hasVariationAttributes;

    // ✅ PASO 3: Construir producto base
    const prepared = {
      category_id: mlData.category.category_id,
      price: Number(productData.price) || 0,
      currency_id: 'CLP',
      available_quantity: Number(productData.totalStock) || 0,
      buying_mode: 'buy_it_now',
      // Tipo por defecto soportado oficialmente.
      listing_type_id: 'gold_special',
      condition: productData.condition?.toLowerCase() === 'new' ? 'new' : 'used',
      description: {
        plain_text: productData.description?.trim() || productData.name?.trim() || ''
      },
      shipping: {
        mode: 'me2',
        local_pick_up: true,
        free_shipping: false
      },
      sale_terms: [],
      attributes: [],
      pictures: productData.images || [],
      category_settings: categoryInfo.settings || {},
      __ml_has_variation_attributes: hasVariationAttributes,
      __ml_is_catalog_product: isCatalogProduct
    };

    // Resolver tipo de publicación automáticamente según estrategia y disponibilidad real.
    prepared.listing_type_id = listingResolution.listing_type_id;
    const installmentsConfig = resolveInstallmentsForPublish(this.getSiteId(), prepared.listing_type_id);
    if (shippingModeOverride) {
      prepared.shipping_mode = shippingModeOverride;
    }
    if (logisticTypeOverride) {
      prepared.logistic_type = logisticTypeOverride;
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

  resolveListingTypeForPublish({ strategy, requestedListingTypeId, availableTypeIds }) {
    const requested = normalizeListingTypeId(requestedListingTypeId);
    const available = Array.isArray(availableTypeIds) ? availableTypeIds : [];
    const hasAvailable = available.length > 0;

    if (!hasAvailable) {
      return {
        listing_type_id: requested || 'gold_special',
        fallback_applied: true,
        note: 'No se pudo validar disponibilidad de listing types. Se usa fallback.'
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
      listing_type_id: requested || 'gold_special',
      fallback_applied: true,
      note: 'No hay listing type soportado disponible; se aplicó fallback.'
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

  // ✅ NUEVO MÉTODO: Obtener SOLO metadatos de la categoría (sin valores de atributos)
  async getCategoryMetadata(categoryId, accessToken) {
    try {
      // ✅ CORREGIDO: Eliminar espacios en URLs
      const [attributesRes, categoryRes] = await Promise.all([
        axios.get(`https://api.mercadolibre.com/categories/${categoryId}/attributes`, {
          headers: { 'Authorization': `Bearer ${accessToken}` },
          timeout: 10000
        }),
        axios.get(`https://api.mercadolibre.com/categories/${categoryId}`, {
          headers: { 'Authorization': `Bearer ${accessToken}` },
          timeout: 10000
        })
      ]);

      const rawAttributes = Array.isArray(attributesRes.data) ? attributesRes.data : [];
      const categoryData = categoryRes.data || {};

      // ✅ EXTRAER SOLO metadatos (tags, allow_variations, hierarchy, values[])
      const attributes = rawAttributes.map(attr => ({
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

      const variationAttributes = attributes.filter(
        (a) => a.tags?.allow_variations === true || a.tags?.variation_attribute === true
      );

      const hasVariationAttributes = variationAttributes.length > 0;
      const variationAttributeIds = new Set(variationAttributes.map(a => a.id));

      return {
        success: true,
        attributes,
        settings: categoryData.settings || {},
        sale_term_ids: Array.isArray(categoryData.sale_terms)
          ? categoryData.sale_terms.map(st => st?.id).filter(Boolean)
          : [],
        hasVariationAttributes,
        variationAttributeIds,
        isCatalog: !!(categoryData.settings?.catalog_domain && categoryData.settings.catalog_domain !== "MLC-UNCLASSIFIED_PRODUCTS")
      };
    } catch (error) {
      logger.error(`[ML Adapter] Error obteniendo metadatos de categoría ${categoryId}:`, error.message);
      throw new Error(`No se pudieron obtener metadatos de categoría ${categoryId}: ${error.message}`);
    }
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
  buildValidMercadoLibreVariations(variants, categoryAttributes, basePrice = null, fallbackPictures = []) {
    if (!Array.isArray(variants) || variants.length === 0) return null;

    const categoryAttrs = Array.isArray(categoryAttributes) ? categoryAttributes : [];
    const variationAttrs = categoryAttrs.filter((a) => a.tags?.allow_variations === true);
    const variationValueAttrs = categoryAttrs.filter(
      (a) => a.tags?.variation_attribute === true && a.tags?.allow_variations !== true
    );

    if (variationAttrs.length === 0) return null;

    const validVariations = [];
    const seenCombinationKeys = new Set();

    for (const variant of variants.filter(v => v.publish)) {
      const combinations = [];
      const variantSources = this.extractVariantAttributeSources(variant);
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
        let match = variantSources.find(
          ({ key }) =>
            this.matchesFlexibleText(key, mlAttr.name) ||
            this.matchesFlexibleText(key, mlAttr.id)
        );

        if (!match && variationAttrs.length === 1 && variantSources.length > 0) {
          const fallbackMatch = variantSources.find(({ value }) =>
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
        for (const mlAttr of variationValueAttrs) {
          const match = variantSources.find(
            ({ key, value }) =>
              this.matchesFlexibleText(key, mlAttr.name) ||
              this.matchesFlexibleText(key, mlAttr.id) ||
              this.matchesFlexibleText(value, mlAttr.name) ||
              this.matchesFlexibleText(value, mlAttr.id)
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

  buildMercadoLibreUserProductAttributes(baseAttributes = [], variant = null, categoryAttributes = []) {
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

    const variantSources = this.extractVariantAttributeSources(variant);

    for (const mlAttr of variationAttrs) {
      const match = variantSources.find(({ key, value }) =>
        this.matchesFlexibleText(key, mlAttr.name) ||
        this.matchesFlexibleText(key, mlAttr.id) ||
        this.matchesFlexibleText(value, mlAttr.name) ||
        this.matchesFlexibleText(value, mlAttr.id)
      );

      if (!match) continue;

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

  buildMercadoLibreUserProductItemPayload(transformedProduct, variant, categoryInfo) {
    const familyName = (transformedProduct.family_name || transformedProduct.name || transformedProduct.title || 'Producto sin nombre')
      .toString()
      .trim();
    const pictures = this.normalizeMercadoLibreVariationPictures(variant?.pictures || variant?.images || variant?.picture_ids || []);
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
      categoryInfo?.attributes || []
    );

    return {
      site_id: this.getSiteId(),
      category_id: transformedProduct.category_id,
      family_name: familyName,
      price,
      available_quantity: availableQuantity,
      currency_id: transformedProduct.currency_id || 'CLP',
      buying_mode: transformedProduct.buying_mode || 'buy_it_now',
      listing_type_id: normalizeListingTypeId(transformedProduct.listing_type_id),
      condition: transformedProduct.condition || 'new',
      shipping: transformedProduct.shipping ? { ...transformedProduct.shipping } : undefined,
      sale_terms: Array.isArray(transformedProduct.sale_terms) ? [...transformedProduct.sale_terms] : undefined,
      pictures,
      attributes,
      catalog_product_id: transformedProduct.catalog_product_id || undefined
    };
  }

  async publishMercadoLibreDescription(itemId, plainText) {
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

      const validation = {
        status: response.status,
        data: response.data || null,
        valid: response.status >= 200 && response.status < 300
      };

      logger.info('[MercadoLibreAdapter] Resultado de validación ML:', validation);

      if (!validation.valid) {
        return {
          valid: false,
          error: 'mercadolibre_validation_failed',
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

      logger.error('[MercadoLibreAdapter] Error ejecutando /items/validate:', validation);

      return {
        valid: false,
        error: 'mercadolibre_validation_failed',
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
      || mlData?.shipping_mode
      || null;
    const logisticTypeOverride = shippingEffective.logistic_type
      || shippingRequested.logistic_type
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

    const catalogDomain = categoryInfo.settings?.catalog_domain;
    const isCatalogProduct = !!catalogDomain && catalogDomain !== 'MLC-UNCLASSIFIED_PRODUCTS';
    const hasVariationAttributes = categoryInfo.hasVariationAttributes;

    const prepared = {
      category_id: mlData.category.category_id,
      price: Number(productData.price) || 0,
      currency_id: 'CLP',
      available_quantity: Number(
        productData.totalPublishingStock ??
        productData.stock ??
        productData.totalStock ??
        0
      ) || 0,
      buying_mode: 'buy_it_now',
      listing_type_id: 'gold_special',
      condition: productData.condition?.toLowerCase() === 'new' ? 'new' : 'used',
      description: {
        plain_text: productData.description?.trim() || productData.name?.trim() || ''
      },
      shipping: {
        mode: 'me2',
        local_pick_up: true,
        free_shipping: false
      },
      sale_terms: [],
      attributes: [],
      pictures: productData.images || [],
      category_settings: categoryInfo.settings || {},
      __ml_has_variation_attributes: hasVariationAttributes,
      __ml_is_catalog_product: isCatalogProduct
    };

    prepared.listing_type_id = listingResolution.listing_type_id;
    const installmentsConfig = resolveInstallmentsForPublish(this.getSiteId(), prepared.listing_type_id);
    if (shippingModeOverride) {
      prepared.shipping_mode = shippingModeOverride;
    }
    if (logisticTypeOverride) {
      prepared.logistic_type = logisticTypeOverride;
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

    const rawAttributes = Array.isArray(mlData.attributes) ? [...mlData.attributes] : [];
    const hasGTINInRaw = rawAttributes.some(attr => attr?.id === 'GTIN');
    if (!hasGTINInRaw) {
      logger.warn('[ML Adapter] ⚠️ El producto no trae GTIN explícito en los atributos del marketplace; no se generará uno artificialmente');
    }

    prepared.attributes = this.buildMercadoLibreAttributes(rawAttributes, categoryInfo.attributes);

    const warrantySaleTerms = buildWarrantySaleTerms(productData);
    if (warrantySaleTerms.length > 0) {
      prepared.sale_terms.push(...warrantySaleTerms);
      logger.info(`[ML Adapter] ✅ Garantía añadida: ${warrantySaleTerms[0].value_name}`);
    }

    const publishableVariants = (productData.variants || []).filter(v => v.publish && v.price > 0);
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
        prepared.pictures
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

    const siteId = this.getSiteId().trim();
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

  async publish(transformedProduct) {
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

      const buildUpdatePayload = () => {
        const payload = {};

        const price = normalizePositiveInteger(transformedProduct.price);
        const quantity = normalizePositiveInteger(
          transformedProduct.available_quantity ?? transformedProduct.stock
        );

        if (!useUserProductsModel && typeof transformedProduct.title === 'string' && transformedProduct.title.trim()) {
          payload.title = transformedProduct.title.trim();
        }

        if (price !== null) payload.price = price;
        if (quantity !== null) payload.available_quantity = quantity;

        if (typeof transformedProduct.description?.plain_text === 'string' && transformedProduct.description.plain_text.trim()) {
          payload.description = {
            plain_text: transformedProduct.description.plain_text.trim()
          };
        } else if (typeof transformedProduct.description === 'string' && transformedProduct.description.trim()) {
          payload.description = {
            plain_text: transformedProduct.description.trim()
          };
        }

        if (Array.isArray(transformedProduct.pictures) && transformedProduct.pictures.length > 0) {
          payload.pictures = transformedProduct.pictures;
        }

        if (!useUserProductsModel && Array.isArray(transformedProduct.variations) && transformedProduct.variations.length > 0) {
          const variations = transformedProduct.variations
            .map(buildUpdateVariation)
            .filter(Boolean);
          if (variations.length > 0) {
            payload.variations = variations;
          }
        }

        return payload;
      };

      const buildRelistPayload = () => {
        const payload = {
          listing_type_id: normalizeListingTypeId(transformedProduct.listing_type_id)
        };

        const price = normalizePositiveInteger(transformedProduct.price);
        const quantity = normalizePositiveInteger(
          transformedProduct.available_quantity ?? transformedProduct.stock
        );

        if (price !== null) payload.price = price;
        if (quantity !== null) payload.quantity = quantity;

        if (!useUserProductsModel && Array.isArray(transformedProduct.variations) && transformedProduct.variations.length > 0) {
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
            logger.info(`[MercadoLibreAdapter] Publicación existente detectada ${mlExistingItemId} en estado ${currentStatus || 'desconocido'}`);

            if (currentStatus === 'closed') {
              const relistPayload = buildRelistPayload();
              logger.info(`[MercadoLibreAdapter] REPUBLICAR item cerrado ${mlExistingItemId}`);
              this.logPublishPayloadMarker({
                label: 'relist',
                model: useUserProductsModel ? 'user_products' : 'classic',
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

            const updatePayload = buildUpdatePayload();
            if (Object.keys(updatePayload).length > 0) {
              logger.info(`[MercadoLibreAdapter] ACTUALIZAR item existente ${mlExistingItemId}`);
              this.logPublishPayloadMarker({
                label: 'update',
                model: useUserProductsModel ? 'user_products' : 'classic',
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

      const categoryId = transformedProduct.category_id || '';
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
        currency_id: "CLP",
        buying_mode: "buy_it_now",
        listing_type_id: normalizeListingTypeId(transformedProduct.listing_type_id),
        condition: transformedProduct.condition || "new", // ✅ Usar condition del producto
        pictures: transformedProduct.pictures || []
      };

      // Solo incluir config de shipping/logística cuando el frontend la envía (publishing-task -> MercadoLibre)
      // Si solo viene uno de los valores, completar el faltante con defaults.
      if (transformedProduct.shipping_mode || transformedProduct.logistic_type) {
        productToPublish.shipping = {
          mode: transformedProduct.shipping_mode || "me2",
          logistic_type: transformedProduct.logistic_type || "drop_off"
        };
      }

      if (Array.isArray(transformedProduct.attributes)) {
        productToPublish.attributes = transformedProduct.attributes;
      }

      if (Array.isArray(transformedProduct.sale_terms) && transformedProduct.sale_terms.length > 0) {
        const allowedSaleTermIds = await this.getCategorySaleTermIds(
          categoryId,
          this.credential?.access_token
        );

        const warrantySaleTerms = buildWarrantySaleTerms(transformedProduct);
        const saleTermsToSend = warrantySaleTerms.length > 0
          ? [
              ...transformedProduct.sale_terms.filter(st => st?.id !== 'WARRANTY_TIME'),
              ...warrantySaleTerms
            ]
          : transformedProduct.sale_terms;

        const filteredSaleTerms = allowedSaleTermIds
          ? saleTermsToSend.filter(st => st?.id && (allowedSaleTermIds.has(st.id) || st.id === 'WARRANTY_TIME'))
          : saleTermsToSend;

        const removedTerms = allowedSaleTermIds
          ? saleTermsToSend
            .filter(st => st?.id && !allowedSaleTermIds.has(st.id) && st.id !== 'WARRANTY_TIME')
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

      if (useUserProductsModel) {
        const publishableVariants = hasVariations
          ? transformedProduct.variations.filter((variant) => variant && variant.publish && Number(variant.price) > 0)
          : [null];

        const familyName = (transformedProduct.family_name || transformedProduct.name || transformedProduct.title || 'Producto sin nombre')
          .toString()
          .trim();
        const createdItems = [];

        for (const variant of publishableVariants) {
          const userProductPayload = this.buildMercadoLibreUserProductItemPayload(
            {
              ...transformedProduct,
              family_name: familyName
            },
            variant,
            categoryInfo
          );

          delete userProductPayload.title;
          delete userProductPayload.variations;

          const validationResult = await this.validateMercadoLibrePayload(userProductPayload);
          if (!validationResult.valid) {
            return {
              success: false,
              error: validationResult.error,
              validation: validationResult.validation,
              sku: variant?.sku || transformedProduct.sku || null
            };
          }

          this.logPublishPayloadMarker({
            label: 'create',
            model: 'user_products',
            sku: variant?.sku || transformedProduct.sku || null,
            itemId: null,
            payload: userProductPayload
          });

          const response = await axios.post(
            "https://api.mercadolibre.com/items",
            userProductPayload,
            {
              headers: {
                Authorization: `Bearer ${this.credential.access_token}`,
                "Content-Type": "application/json",
                Accept: "application/json"
              },
              timeout: 30000
            }
          );

          if (itemDescription) {
            await this.publishMercadoLibreDescription(response.data.id, itemDescription);
          }

          createdItems.push({
            id: response.data.id,
            data: response.data,
            sku: variant?.sku || transformedProduct.sku || null,
            validation: validationResult.validation
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
        productToPublish.variations = transformedProduct.variations;
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

  async updateItem({ itemId, status = undefined, price = undefined, available_quantity = undefined }) {
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

      if (Object.keys(payload).length === 0) {
        return { success: false, error: 'no_changes' };
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
        current_status: currentStatus
      };
    } catch (error) {
      logger.error('[MercadoLibreAdapter] Error actualizando item:', error.message);
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
      const categoryRes = await axios.get(`https://api.mercadolibre.com/categories/${categoryId}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 10000
      });

      const saleTerms = Array.isArray(categoryRes.data?.sale_terms)
        ? categoryRes.data.sale_terms
        : [];

      return new Set(saleTerms.map(st => st?.id).filter(Boolean));
    } catch (error) {
      logger.warn(
        `[ML Adapter] No se pudieron obtener sale_terms de categoría ${categoryId}. Se enviarán sale_terms originales. Error: ${error.message}`
      );
      // Fallback permisivo: no bloquear publicación por falla de consulta metadata.
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
    return "MLC";
  }

  static supports(marketplace) {
    return marketplace.domain?.includes("mercadolibre");
  }
}

module.exports = MercadoLibreAdapter;
