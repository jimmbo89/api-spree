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

function buildWarrantySaleTerms(productData) {
  if (!productData || typeof productData !== 'object') return [];

  const warrantyMonthsRaw = productData.warranty_months;
  const warrantyUnitRaw = String(productData.warranty_text || '').trim();
  const warrantyMonths = Number(warrantyMonthsRaw);

  if (!Number.isFinite(warrantyMonths) || warrantyMonths < 0 || !warrantyUnitRaw) {
    return [];
  }

  const normalizedMonths = Number.isInteger(warrantyMonths)
    ? warrantyMonths
    : Number(warrantyMonths.toFixed(2));
  const warrantyValue = `${normalizedMonths} ${warrantyUnitRaw}`;

  return [{
    id: 'WARRANTY_TIME',
    value_name: warrantyValue
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
      prepared.attributes = mlData.attributes
        .filter(attr => attr.id && (attr.value_name || attr.value_id))
        // ✅ FILTRAR: Eliminar atributos problemáticos
        .filter(attr => {
          const attrMeta = categoryInfo.attributes?.find(a => a.id === attr.id);
          const isReadOnly = attrMeta?.tags?.read_only === true;
          const isHidden = attrMeta?.tags?.hidden === true;
          const isItemCondition = attr.id === 'ITEM_CONDITION';
          
          if (isReadOnly || isHidden || isItemCondition) {
            logger.warn(`[ML Adapter] ⚠️ Atributo ${attr.id} filtrado (read_only/hidden/ITEM_CONDITION)`);
            return false;
          }
          return true;
        })
        .map(attr => {
          const processed = {
            id: attr.id,
            value_name: attr.value_name ? String(attr.value_name).trim() : undefined,
            value_id: attr.value_id ? String(attr.value_id).trim() : undefined
          };
          
          // ✅ Convertir booleanos a "Sí"/"No"
          if (['true', 'false'].includes(String(processed.value_name).toLowerCase())) {
            processed.value_name = String(processed.value_name).toLowerCase() === 'true' ? 'Sí' : 'No';
            logger.info(`[ML Adapter] ✅ Convertido valor booleano para ${attr.id}: "${processed.value_name}"`);
          }
          
          return processed;
        });
    }

    // ✅ PASO 6: Asegurar que GTIN esté incluido (requerido para esta categoría)
    const hasGTIN = prepared.attributes.some(attr => attr.id === 'GTIN');
    if (!hasGTIN) {
      // Intentar obtener GTIN del producto Spree
      let gtinValue = productData.gtin || productData.ean || productData.upc || '';
      
      // Si no hay GTIN válido, generar uno basado en SKU
      if (!gtinValue || gtinValue.length < 8) {
        gtinValue = this.generateValidGTIN(productData.sku || String(productData.id));
        logger.warn(`[ML Adapter] ⚠️ GTIN no encontrado. Generando GTIN válido: ${gtinValue}`);
      }
      
      // ✅ Añadir GTIN a mlData.attributes para que pase por el filtro
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
        categoryInfo.attributes
      );
      
      if (variations && variations.length >= 2) {
        prepared.variations = variations;
        logger.info(`[ML Adapter] ✅ Variaciones construidas: ${variations.length}`);
      } else {
        logger.warn(`[ML Adapter] ⚠️ No se construyeron variaciones válidas. Restaurando atributos.`);
        prepared.attributes = mlData.attributes
          .filter(attr => attr.id && (attr.value_name || attr.value_id))
          // ✅ MISMO FILTRO para fallback
          .filter(attr => {
            const attrMeta = categoryInfo.attributes?.find(a => a.id === attr.id);
            const isReadOnly = attrMeta?.tags?.read_only === true;
            const isHidden = attrMeta?.tags?.hidden === true;
            const isItemCondition = attr.id === 'ITEM_CONDITION';
            
            if (isReadOnly || isHidden || isItemCondition) {
              return false;
            }
            return true;
          })
          .map(attr => {
            const processed = {
              id: attr.id,
              value_name: attr.value_name ? String(attr.value_name).trim() : undefined,
              value_id: attr.value_id ? String(attr.value_id).trim() : undefined
            };
            
            // ✅ Convertir booleanos
            if (['true', 'false'].includes(String(processed.value_name).toLowerCase())) {
              processed.value_name = String(processed.value_name).toLowerCase() === 'true' ? 'Sí' : 'No';
            }
            
            return processed;
          });
        prepared.variations = undefined;
      }
    } else if (hasSingleVariant) {
      // 1 variante → ML acepta atributos de variación en nivel base
      logger.info(`[ML Adapter] Producto con 1 variante. Permitiendo atributos de variación en nivel base.`);
      prepared.attributes = mlData.attributes
        .filter(attr => attr.id && (attr.value_name || attr.value_id))
        // ✅ MISMO FILTRO para variantes
        .filter(attr => {
          const attrMeta = categoryInfo.attributes?.find(a => a.id === attr.id);
          const isReadOnly = attrMeta?.tags?.read_only === true;
          const isHidden = attrMeta?.tags?.hidden === true;
          const isItemCondition = attr.id === 'ITEM_CONDITION';
          
          if (isReadOnly || isHidden || isItemCondition) {
            return false;
          }
          return true;
        })
        .map(attr => {
          const processed = {
            id: attr.id,
            value_name: attr.value_name ? String(attr.value_name).trim() : undefined,
            value_id: attr.value_id ? String(attr.value_id).trim() : undefined
          };
          
          // ✅ Convertir booleanos
          if (['true', 'false'].includes(String(processed.value_name).toLowerCase())) {
            processed.value_name = String(processed.value_name).toLowerCase() === 'true' ? 'Sí' : 'No';
          }
          
          return processed;
        });
      
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

  // ✅ NUEVO MÉTODO: Generar GTIN válido
  generateValidGTIN(existingDigits) {
    const digits = String(existingDigits).replace(/\D/g, '');
    
    if (digits.length >= 12) {
      // EAN-13 (13 dígitos)
      const base12 = digits.substring(0, 12);
      const checkDigit = this.calculateGTINChecksum(base12 + '0');
      return base12 + checkDigit;
    } else if (digits.length >= 7) {
      // EAN-8 (8 dígitos)
      const base7 = '0'.repeat(7 - digits.length) + digits.substring(0, Math.min(7, digits.length));
      const padded7 = base7.padStart(7, '0');
      const checkDigit = this.calculateGTINChecksum(padded7 + '0');
      return padded7 + checkDigit;
    } else {
      // Generar EAN-13 genérico
      return this.generateValidEAN13(digits);
    }
  }

  // ✅ NUEVO MÉTODO: Generar EAN-13 válido
  generateValidEAN13(baseId) {
    if (!baseId) baseId = '000000001';
    
    const genericPrefixes = ['00', '01', '02', '03', '04', '05', '06', '07', '08', '09'];
    const randomPrefix = genericPrefixes[Math.floor(Math.random() * genericPrefixes.length)];
    
    const baseDigits = String(baseId).replace(/\D/g, '').substring(0, 10);
    const padded = (baseDigits + '0000000000').substring(0, 10);
    const code12 = randomPrefix + padded;
    const checkDigit = this.calculateGTINChecksum(code12 + '0');
    
    return code12 + checkDigit;
  }

  // ✅ NUEVO MÉTODO: Calcular dígito verificador GTIN
  calculateGTINChecksum(gtinWithoutCheck) {
    const digits = String(gtinWithoutCheck).replace(/\D/g, '');
    let sum = 0;
    
    const isEvenLength = digits.length % 2 === 0;
    
    for (let i = 0; i < digits.length - 1; i++) {
      const digit = parseInt(digits.charAt(i));
      const multiplier = (i % 2 === 0) ? (isEvenLength ? 3 : 1) : (isEvenLength ? 1 : 3);
      sum += digit * multiplier;
    }
    
    const remainder = sum % 10;
    return remainder === 0 ? 0 : 10 - remainder;
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
        hierarchy: attr.hierarchy,
        allowed_units: attr.allowed_units || [],
        default_unit: attr.default_unit || null,
        value_max_length: attr.value_max_length || null
      }));

      const variationAttributes = attributes.filter(
        a => a.tags?.allow_variations === true || a.hierarchy === 'CHILD_PK'
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
  buildValidMercadoLibreVariations(variants, categoryAttributes) {
    if (!Array.isArray(variants) || variants.length === 0) return null;

    const variationAttrs = categoryAttributes.filter(
      a => a.tags?.allow_variations === true || a.hierarchy === 'CHILD_PK'
    );

    if (variationAttrs.length === 0) return null;

    const validVariations = [];

    for (const variant of variants.filter(v => v.publish)) {
      const combinations = [];

      for (const mlAttr of variationAttrs) {
        const match = Object.entries(variant.attributes || {}).find(
          ([key]) => this.normalizeForComparison(key) === this.normalizeForComparison(mlAttr.name)
        );

        if (!match) {
          combinations.length = 0;
          break;
        }

        const value = match[1];
        const combo = { id: mlAttr.id };

        const valueMatch = mlAttr.values?.find(
          v => this.normalizeForComparison(v.name) === this.normalizeForComparison(value)
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
        validVariations.push({
          seller_custom_field: variant.sku || String(variant.id),
          price: Number(variant.price),
          available_quantity: Number(variant.publishStock ?? variant.totalStock ?? 0),
          attribute_combinations: combinations
        });
      }
    }

    return validVariations.length >= 1 ? validVariations : null;
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
      available_quantity: Number(productData.totalStock) || 0,
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
      let gtinValue = productData.gtin || productData.ean || productData.upc || '';
      if (!gtinValue || gtinValue.length < 8) {
        gtinValue = this.generateValidGTIN(productData.sku || String(productData.id));
        logger.warn(`[ML Adapter] ⚠️ GTIN no encontrado. Generando GTIN válido: ${gtinValue}`);
      }
      rawAttributes.push({
        id: 'GTIN',
        value_name: gtinValue
      });
      logger.info(`[ML Adapter] ✅ GTIN agregado a mlData.attributes: ${gtinValue}`);
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
        categoryInfo.attributes
      );

      if (variations && variations.length >= 2) {
        prepared.variations = variations;
        logger.info(`[ML Adapter] ✅ Variaciones construidas: ${variations.length}`);
      } else {
        logger.warn('[ML Adapter] ⚠️ No se construyeron variaciones válidas. Restaurando atributos.');
        prepared.attributes = this.buildMercadoLibreAttributes(rawAttributes, categoryInfo.attributes);
        prepared.variations = undefined;
      }
    } else if (hasSingleVariant) {
      logger.info('[ML Adapter] Producto con 1 variante. Permitiendo atributos de variación en nivel base.');
      prepared.attributes = this.buildMercadoLibreAttributes(rawAttributes, categoryInfo.attributes);

      const singleVariant = publishableVariants[0];
      prepared.available_quantity = Number(singleVariant.publishStock ?? singleVariant.totalStock ?? productData.totalStock) || 0;
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
    this.credential = await MarketplaceCredentialRepository.findByMarketplaceAndUser(
      this.marketplaceId,
      this.userId
    );
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

        if (typeof transformedProduct.title === 'string' && transformedProduct.title.trim()) {
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

        if (Array.isArray(transformedProduct.variations) && transformedProduct.variations.length > 0) {
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

        if (Array.isArray(transformedProduct.variations) && transformedProduct.variations.length > 0) {
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

        const filteredSaleTerms = allowedSaleTermIds
          ? transformedProduct.sale_terms.filter(st => st?.id && (allowedSaleTermIds.has(st.id) || st.id === 'WARRANTY_TIME'))
          : transformedProduct.sale_terms;

        const removedTerms = allowedSaleTermIds
          ? transformedProduct.sale_terms
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

      if (hasVariations) {
        productToPublish.variations = transformedProduct.variations;
      }

      // 🔑 APLICAR REGLA DEFINITIVA DE NAMING
      if (hasVariations) {
        if (isCatalogProduct) {
          let titleValue = (transformedProduct.title || transformedProduct.name || "Producto").toString().trim();
          if (!titleValue || titleValue.length === 0) titleValue = `Producto ${Date.now().toString().slice(-6)}`;
          if (titleValue.length < 6) titleValue = titleValue.padEnd(6, " ");
          if (titleValue.length > 60) titleValue = titleValue.substring(0, 60);
          productToPublish.title = titleValue;
          logger.info(`[DEBUG] 📦 Catálogo con variaciones → title: "${titleValue}"`);
        } else {
          let familyValue = (transformedProduct.family_name || transformedProduct.name || transformedProduct.title || "Producto").toString().trim();
          if (!familyValue || familyValue.length === 0) familyValue = `Producto ${Date.now().toString().slice(-6)}`;
          if (familyValue.length > 60) familyValue = familyValue.substring(0, 60);
          productToPublish.family_name = familyValue;
          logger.info(`[DEBUG] 📦 Variaciones → family_name: "${familyValue}"`);
        }
      } else {
        if (transformedProduct.family_name) {
          let familyValue = transformedProduct.family_name.toString().trim();
          if (familyValue.length > 60) familyValue = familyValue.substring(0, 60);
          productToPublish.family_name = familyValue;
          logger.info(`[DEBUG] 📦 Sin variaciones pero con family_name → usando: "${familyValue}"`);
        } else {
          let title = (transformedProduct.title || transformedProduct.name || "").toString().trim();
          if (!title || title.length === 0) title = `Producto ${Date.now().toString().slice(-6)}`;
          if (title.length < 6) title = title.padEnd(6, " ");
          if (title.length > 60) title = title.substring(0, 60);
          productToPublish.title = title;
          logger.info(`[DEBUG] 📦 Sin variaciones ni family_name → title: "${title}"`);
        }
      }

      logger.info("[MercadoLibreAdapter] === PAYLOAD FINAL QUE SE ENVIARÁ A MERCADO LIBRE ===");
      logger.info(JSON.stringify(productToPublish, null, 2));

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

      logger.info(
        `[MercadoLibreAdapter] ✅ Resultado de publicación: ${JSON.stringify({
         data: response.data
        })}`
      );
      return {
        success: true,
        external_id: response.data.id,
        data: response.data
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
      marketplace = basicCred.marketplace || {};
      logger.info(`[MercadoLibreAdapter] Usando credential object para auth (ID: ${basicCred.id})`);
    } else {
      // Es un ID numérico, buscar en repositorio
      basicCred = await MarketplaceCredentialRepository.findById(this.credentialId);
      marketplace = basicCred?.marketplace || {};
    }
  } else {
    // Fallback al comportamiento original
    marketplace = await MarketplaceCredentialRepository.findByMarketplaceAndUser(
      this.marketplaceId,
      this.userId
    );
  }
  
  if (!basicCred || !marketplace.client_id || !marketplace.redirect_uri) {
    return { success: false, error: "Credenciales incompletas para autenticación" };
  }

  const requiredScopes = "write offline_access urn:ml:mktp:publish-sync:/read-write";
  
  // ✅ NUEVO: Incluir credential_id en el state para el callback
  const state = `${this.marketplaceId}_${this.userId}_${basicCred.id}`;
  
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
