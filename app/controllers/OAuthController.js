const logger = require("../../config/logger");
const axios = require("axios");
const qs = require("qs");
const {
  MarketplaceCredentialRepository,
  LogRepository,
  CategoryCommissionRepository,
} = require("../repositories");
const { getRequestMetadata } = require("../util/requestUtil");
const { getUserId } = require("../../config/context");
const crypto = require("crypto");
const { getFromCache, clearMarketplaceCache, clearAllCache, saveToCache, getCacheStats } = require("../../helpers/marketplaceCacheHelper");
const { marketplaceRateLimiter } = require("../../config/rateLimiter");
const { getMercadoLibreSiteId } = require("../util/marketplaceUtil");
const MercadoLibreCapabilitiesService = require("../services/MercadoLibreCapabilitiesService");

const rfc3986Encode = (str) =>
  encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );

const timestampMinus03 = (date = new Date()) => {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}-03:00`
  );
};

const normalizeFalabellaBoolean = (value) => {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  return String(value || "").trim().toLowerCase() === "true";
};

const normalizeFalabellaOptions = (options) => {
  const rawOptions = options?.Option;
  if (!rawOptions) return [];
  const list = Array.isArray(rawOptions) ? rawOptions : [rawOptions];
  return list
    .map((option) => ({
      id: option?.id ?? option?.Name ?? option?.Value ?? null,
      name: option?.Name ?? option?.Value ?? option?.id ?? null
    }))
    .filter((option) => option.id !== null || option.name !== null);
};

const mapFalabellaCategoryAttribute = (attr) => {
  const feedName = attr?.FeedName || attr?.Name || attr?.Label;
  if (!feedName) return null;
  const label = attr?.Label || attr?.Name || feedName;
  const mandatory = normalizeFalabellaBoolean(attr?.isMandatory);
  const attributeType = attr?.AttributeType || attr?.Type || "string";

  return {
    id: feedName,
    name: label,
    label,
    is_mandatory: mandatory,
    description: attr?.Description || '',
    attribute_type: attributeType,
    example_value: attr?.ExampleValue || '',
    value_type: ['option', 'multi_option'].includes(attributeType) ? 'list' :
      attributeType === 'numberfield' ? 'number' : 'string',
    values: normalizeFalabellaOptions(attr?.Options),
    tags: { required: mandatory, catalog_required: mandatory, hidden: false }
  };
};

const ML_SUPPORTED_LISTING_TYPES = ["gold_pro", "gold_special", "free"];
const ML_STRATEGY = {
  CONVERSION: "CONVERSION",
  MARGIN: "MARGIN",
};

const normalizeStrategy = (strategy, legacyListingTypeId) => {
  const raw = String(strategy || "").trim().toUpperCase();
  if (raw === ML_STRATEGY.CONVERSION) return ML_STRATEGY.CONVERSION;
  if (raw === ML_STRATEGY.MARGIN || raw === "PROFIT") return ML_STRATEGY.MARGIN;

  // Compatibilidad legacy: si frontend aún envía listing_type_id, inferir estrategia.
  if (legacyListingTypeId === "gold_pro") return ML_STRATEGY.CONVERSION;
  if (legacyListingTypeId) return ML_STRATEGY.MARGIN;

  return ML_STRATEGY.CONVERSION;
};

const normalizeInstallments = (installments) => {
  if (!installments || typeof installments !== "object") {
    return {
      requested: false,
      enabled: false,
      interest_free: false,
      max_installments: null,
      campaign_tag: null,
    };
  }

  const enabled = Boolean(installments.enabled);
  const interestFree = enabled && Boolean(installments.interest_free);
  const maxInstallments = enabled
    ? Number.isFinite(Number(installments.max_installments))
      ? Math.max(1, Math.trunc(Number(installments.max_installments)))
      : null
    : null;
  const campaignTag = enabled && installments.campaign_tag
    ? String(installments.campaign_tag).trim()
    : null;

  return {
    requested: true,
    enabled,
    interest_free: interestFree,
    max_installments: maxInstallments,
    campaign_tag: campaignTag || null,
  };
};

const buildInstallmentsSaleTermsPreview = (installments) => {
  if (!installments?.enabled || !installments?.max_installments) return [];
  return [
    {
      id: "INSTALLMENTS",
      value_name: String(installments.max_installments),
    },
  ];
};

const buildAutomaticInstallmentsResolution = ({
  siteId,
  listingTypeId,
  requestedCampaignTag,
  campaignTagsByListingType,
}) => {
  const availableCampaignTags = Array.isArray(campaignTagsByListingType?.[listingTypeId])
    ? campaignTagsByListingType[listingTypeId]
    : [];
  const selectedCampaignTag = requestedCampaignTag && availableCampaignTags.includes(requestedCampaignTag)
    ? requestedCampaignTag
    : null;

  const result = {
    source: "official_listing_type_policy",
    site_id: siteId,
    listing_type_id: listingTypeId,
    enabled: false,
    interest_free: false,
    max_installments: null,
    campaign_tag_requested: requestedCampaignTag || null,
    campaign_tag_applied: selectedCampaignTag,
    available_campaign_tags: availableCampaignTags,
    seller_fee_focus: true,
    note: "Resolución automática orientada a costo/comisión del vendedor según listing_type y campañas oficiales.",
  };

  if (siteId !== "MLA") {
    result.note = "Documentación oficial de cuotas diferenciadas aplica para Argentina (MLA).";
    return result;
  }

  if (listingTypeId === "gold_pro") {
    result.enabled = true;
    result.interest_free = true;
    result.max_installments = 6;
    result.note = "gold_pro impacta costo vendedor con esquema de cuotas al mismo precio; default backend usa 6.";

    if (selectedCampaignTag === "3x_campaign" || selectedCampaignTag === "cuota-simple-3") {
      result.max_installments = 3;
    }
    if (selectedCampaignTag === "cuota-simple-6") {
      result.max_installments = 6;
    }
    return result;
  }

  if (listingTypeId === "gold_special") {
    result.enabled = false;
    result.interest_free = false;
    result.max_installments = null;
    result.note = selectedCampaignTag === "pcj-co-funded"
      ? "gold_special con pcj-co-funded aplica costo/comisión promocional para vendedor."
      : "gold_special usa esquema base sin cuotas promocionales resueltas por backend para vendedor.";
    return result;
  }

  if (listingTypeId === "free") {
    result.note = "free no resuelve cuotas promocionales en este flujo.";
  }

  return result;
};

const stableStringify = (value) => {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
};

const buildRequestFingerprint = (payload) =>
  crypto.createHash("sha1").update(stableStringify(payload)).digest("hex");

const logMercadoLibreEndpointTrace = ({
  stage = "response",
  endpoint,
  productId = null,
  categoryId = null,
  listingTypeId = null,
  shippingMode = null,
  logisticType = null,
  params = null,
  response = null,
  extra = null,
}) => {
  logger.info(`[ML ENDPOINT TRACE] ${stage} ${endpoint}`, {
    product_id: productId,
    category_id: categoryId,
    listing_type_id: listingTypeId,
    shipping_mode: shippingMode,
    logistic_type: logisticType,
    params,
    response,
    extra,
  });
};

const normalizeSupportedListingTypes = (availableData, siteId) => {
  if (!Array.isArray(availableData)) return [];

  const map = new Map();

  for (const lt of availableData) {
    const rawId = typeof lt === "string" ? lt : lt?.id;
    if (!rawId) continue;

    const normalizedId = rawId === "bronze" ? "gold_special" : rawId;
    if (!ML_SUPPORTED_LISTING_TYPES.includes(normalizedId)) continue;
    if (map.has(normalizedId)) continue;

    map.set(normalizedId, {
      value: normalizedId,
      title: normalizedId,
      description:
        (typeof lt === "object" ? lt?.name : null) || `Tipo ${normalizedId}`,
      ml_metadata: {
        name: typeof lt === "object" ? lt?.name || null : null,
        site_id: typeof lt === "object" ? lt?.site_id || siteId : siteId,
        remaining_listings:
          typeof lt === "object" ? lt?.remaining_listings ?? null : null,
        user_specific: true,
      },
    });
  }

  return Array.from(map.values());
};

const resolveListingTypeByStrategy = (strategy, listingTypesForCategory) => {
  const availableValues = Array.isArray(listingTypesForCategory)
    ? listingTypesForCategory.map((t) => t.value).filter(Boolean)
    : [];

  if (strategy === ML_STRATEGY.CONVERSION && availableValues.includes("gold_pro")) {
    return {
      listing_type_id: "gold_pro",
      fallback_applied: false,
      note: "Mayor exposición activada",
    };
  }

  if (availableValues.includes("gold_special")) {
    return {
      listing_type_id: "gold_special",
      fallback_applied: strategy === ML_STRATEGY.CONVERSION,
      note:
        strategy === ML_STRATEGY.CONVERSION
          ? "No hay opción de máxima exposición en esta categoría. Se aplicó la mejor alternativa disponible."
          : "Publicación optimizada a menor costo",
    };
  }

  if (availableValues.includes("free")) {
    return {
      listing_type_id: "free",
      fallback_applied: true,
      note: "Solo puedes publicar gratis en esta categoría",
    };
  }

  throw new Error("No valid listing type");
};

const normalizeCampaignTagValue = (tag) => {
  if (!tag) return null;
  if (typeof tag === "string") return tag;
  if (typeof tag === "object") {
    return tag.tag || tag.id || tag.value || tag.name || null;
  }
  return null;
};

const extractCampaignTags = (campaignsResponse) => {
  if (!Array.isArray(campaignsResponse)) return [];
  const tags = [];
  for (const entry of campaignsResponse) {
    const available = Array.isArray(entry?.available_campaigns) ? entry.available_campaigns : [];
    for (const campaign of available) {
      const tagValue = normalizeCampaignTagValue(campaign);
      if (tagValue) tags.push(tagValue);
    }
  }
  return Array.from(new Set(tags));
};

const toNumberOrZero = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const toNumberOrNull = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const resolveProductCostBasis = (product) => {
  const candidates = [
    product?.purchase_price,
    product?.cost_price,
    product?.cost,
    product?.unit_cost,
    product?.base_cost
  ];

  for (const candidate of candidates) {
    const parsed = toNumberOrNull(candidate);
    if (parsed !== null && parsed >= 0) return parsed;
  }
  return null;
};

const resolveEconomicInputs = (product) => {
  const productCost = resolveProductCostBasis(product);
  const packingCost = toNumberOrNull(product?.packing_cost);
  const operationalCost = toNumberOrNull(product?.operational_cost);
  const advertisingCost = toNumberOrNull(product?.advertising_cost);
  const returnCostReserve = toNumberOrNull(product?.return_cost_reserve);
  const desiredMarginPercent = toNumberOrNull(product?.desired_margin_percent);

  const variableCostComponents = [
    productCost,
    packingCost,
    operationalCost,
    advertisingCost,
    returnCostReserve
  ].filter((value) => value !== null && value >= 0);

  return {
    product_cost: productCost,
    packing_cost: packingCost,
    operational_cost: operationalCost,
    advertising_cost: advertisingCost,
    return_cost_reserve: returnCostReserve,
    desired_margin_percent: desiredMarginPercent,
    total_cost_basis: variableCostComponents.length > 0
      ? Number(variableCostComponents.reduce((sum, value) => sum + value, 0).toFixed(2))
      : null
  };
};

const extractCoverageSubsidy = (coverage) => {
  const discount = coverage?.discount;
  if (!discount) return 0;
  if (typeof discount === "number") return toNumberOrZero(discount);
  if (typeof discount === "object") {
    const direct = toNumberOrNull(discount.promoted_amount);
    if (direct !== null) return Math.max(0, direct);
    const amount = toNumberOrNull(discount.amount);
    if (amount !== null) return Math.max(0, amount);
  }
  return 0;
};

const extractCoverageCostDetails = (coverage) => {
  const finalCost = toNumberOrNull(coverage?.cost);
  if (finalCost !== null) {
    return {
      cost: finalCost,
      source: "coverage.cost",
      used_fallback: false
    };
  }

  return {
    cost: toNumberOrZero(coverage?.list_cost),
    source: "coverage.list_cost_fallback",
    used_fallback: true
  };
};

const SHIPPING_RESOLUTION_STATE = Object.freeze({
  RESOLVED: "resolved",
  PARTIAL: "partial",
  MANUAL: "manual",
  DYNAMIC: "dynamic",
  UNSUPPORTED: "unsupported"
});

const SHIPPING_COMPLEXITY = Object.freeze({
  AUTOMATED: "automated",
  MANUAL: "manual",
  DYNAMIC: "dynamic",
  UNKNOWN: "unknown"
});

const MANUAL_SHIPPING_MODES = new Set(["custom", "not_specified"]);
const DYNAMIC_SHIPPING_MODES = new Set(["me1"]);
const MARKETPLACE_SHIPPING_MODES = new Set(["me2"]);
const VALID_LOGISTIC_TYPES = new Set([
  "drop_off",
  "cross_docking",
  "xd_drop_off",
  "self_service",
  "turbo",
  "fulfillment",
  "default"
]);

const isManualShippingMode = (shippingMode) => MANUAL_SHIPPING_MODES.has(normalizeMarketplaceShippingValue(shippingMode));
const isDynamicShippingMode = (shippingMode) => DYNAMIC_SHIPPING_MODES.has(normalizeMarketplaceShippingValue(shippingMode));
const isMarketplaceShippingMode = (shippingMode) => MARKETPLACE_SHIPPING_MODES.has(normalizeMarketplaceShippingValue(shippingMode));

const normalizeMarketplaceLogisticType = (shippingMode, value) => {
  const normalizedMode = normalizeMarketplaceShippingValue(shippingMode);
  if (isManualShippingMode(normalizedMode)) return null;

  const normalized = normalizeMarketplaceShippingValue(value);
  if (!normalized) return null;
  if (MANUAL_SHIPPING_MODES.has(normalized)) return null;
  if (!VALID_LOGISTIC_TYPES.has(normalized)) return null;
  return normalized;
};

const buildShippingComboKey = (shippingMode, logisticType) => {
  const mode = normalizeMarketplaceShippingValue(shippingMode) || "unknown";
  const logistic = normalizeMarketplaceShippingValue(logisticType);
  return `${mode}:${logistic || "none"}`;
};

const classifyShippingResolution = ({
  shippingMode,
  logisticType,
  validationSupport = null
}) => {
  const normalizedMode = normalizeMarketplaceShippingValue(shippingMode);
  const normalizedType = normalizeMarketplaceLogisticType(normalizedMode, logisticType);

  if (!normalizedMode) {
    return {
      shipping_resolution_state: SHIPPING_RESOLUTION_STATE.UNSUPPORTED,
      shipping_complexity: SHIPPING_COMPLEXITY.UNKNOWN,
      is_resolved: false,
      is_partial: false,
      is_manual: false,
      is_dynamic: false,
      requires_buyer_context: false
    };
  }

  if (isManualShippingMode(normalizedMode)) {
    return {
      shipping_resolution_state: SHIPPING_RESOLUTION_STATE.MANUAL,
      shipping_complexity: SHIPPING_COMPLEXITY.MANUAL,
      is_resolved: false,
      is_partial: false,
      is_manual: true,
      is_dynamic: false,
      requires_buyer_context: false
    };
  }

  if (normalizedMode === "me2" && !normalizedType) {
    return {
      shipping_resolution_state: SHIPPING_RESOLUTION_STATE.PARTIAL,
      shipping_complexity: SHIPPING_COMPLEXITY.DYNAMIC,
      is_resolved: false,
      is_partial: true,
      is_manual: false,
      is_dynamic: true,
      requires_buyer_context: true
    };
  }

  if (validationSupport === false) {
    return {
      shipping_resolution_state: SHIPPING_RESOLUTION_STATE.UNSUPPORTED,
      shipping_complexity: SHIPPING_COMPLEXITY.UNKNOWN,
      is_resolved: false,
      is_partial: false,
      is_manual: false,
      is_dynamic: false,
      requires_buyer_context: false
    };
  }

  if (validationSupport === true) {
    return {
      shipping_resolution_state: SHIPPING_RESOLUTION_STATE.RESOLVED,
      shipping_complexity: SHIPPING_COMPLEXITY.AUTOMATED,
      is_resolved: true,
      is_partial: false,
      is_manual: false,
      is_dynamic: false,
      requires_buyer_context: false
    };
  }

  if (isDynamicShippingMode(normalizedMode)) {
    return {
      shipping_resolution_state: SHIPPING_RESOLUTION_STATE.DYNAMIC,
      shipping_complexity: SHIPPING_COMPLEXITY.DYNAMIC,
      is_resolved: false,
      is_partial: false,
      is_manual: false,
      is_dynamic: true,
      requires_buyer_context: true
    };
  }

  return {
    shipping_resolution_state: SHIPPING_RESOLUTION_STATE.DYNAMIC,
    shipping_complexity: SHIPPING_COMPLEXITY.DYNAMIC,
    is_resolved: false,
    is_partial: false,
    is_manual: false,
    is_dynamic: true,
    requires_buyer_context: true
  };
};

const deriveLogisticModel = (shippingMode, logisticType, resolutionState = null) => {
  const normalizedMode = normalizeMarketplaceShippingValue(shippingMode);
  const normalizedType = normalizeMarketplaceLogisticType(normalizedMode, logisticType);
  const normalizedState = normalizeMarketplaceShippingValue(resolutionState);

  if (normalizedState === SHIPPING_RESOLUTION_STATE.MANUAL || isManualShippingMode(normalizedMode)) {
    return "manual";
  }
  if (normalizedState === SHIPPING_RESOLUTION_STATE.PARTIAL) {
    return "mercado_envios_partial";
  }
  if (normalizedState === SHIPPING_RESOLUTION_STATE.DYNAMIC || isDynamicShippingMode(normalizedMode)) {
    return normalizedMode === "me1" ? "mercado_envios_1" : "contextual";
  }
  if (normalizedType === "fulfillment") {
    return "full";
  }
  if (normalizedMode === "custom") {
    return "manual";
  }
  if (normalizedMode === "me2") {
    return "mercado_envios";
  }
  if (normalizedMode === "me1") {
    return "mercado_envios_1";
  }
  return "unspecified";
};

const deriveShippingOperation = (shippingMode, logisticType, resolutionState = null) => {
  const normalizedMode = normalizeMarketplaceShippingValue(shippingMode);
  const normalizedType = normalizeMarketplaceLogisticType(normalizedMode, logisticType);
  const normalizedState = normalizeMarketplaceShippingValue(resolutionState);

  if (normalizedState === SHIPPING_RESOLUTION_STATE.MANUAL || isManualShippingMode(normalizedMode)) {
    return normalizedMode === "not_specified" ? "contact_seller" : "manual_rates";
  }
  if (normalizedState === SHIPPING_RESOLUTION_STATE.PARTIAL) {
    return "pending_resolution";
  }
  if (normalizedType === "self_service") return "flex";
  if (normalizedType === "xd_drop_off") return "places";
  if (normalizedType === "fulfillment") return "fulfillment";
  if (normalizedType === "cross_docking") return "cross_docking";
  if (normalizedType === "drop_off") return "drop_off";
  if (normalizedType === "turbo") return "turbo";
  if (normalizedType === "default" && normalizedMode === "me1") return "merchant_logistics";
  if (normalizedType) return normalizedType;
  if (normalizedMode === "me1") return "merchant_logistics";
  return "unspecified";
};

const buildShippingMeasurementInput = (product) => {
  if (!product || typeof product !== "object") return null;

  if (product.package && typeof product.package === "object") {
    return {
      ...product.package,
      volumetric_weight:
        product.package.volumetric_weight ??
        product.package.volumetric_weight_measurement ??
        product.package.volumetric_weight_grams ??
        product.volumetric_weight ??
        product.volumetric_weight_measurement ??
        product.volumetric_weight_grams ??
        product.volumetric_weightolumetric_weight ??
        null
    };
  }

  const packagingMeasurements =
    product.packaging_measurements && typeof product.packaging_measurements === "object"
      ? product.packaging_measurements
      : {};
  const productMeasurements =
    product.product_measurements && typeof product.product_measurements === "object"
      ? product.product_measurements
      : {};

  return {
    height_cm: product.height_cm,
    width_cm: product.width_cm,
    length_cm: product.length_cm,
    weight_grams: product.weight_grams,
    dimensions: Object.keys(packagingMeasurements.dimensions || {}).length > 0
      ? packagingMeasurements.dimensions
      : productMeasurements.dimensions,
    weight: packagingMeasurements.weight || productMeasurements.weight || null,
    volumetric_weight:
      packagingMeasurements.volumetric_weight ||
      productMeasurements.volumetric_weight ||
      product.volumetric_weight ||
      product.volumetric_weight_measurement ||
      product.volumetric_weight_grams ||
      product.volumetric_weightolumetric_weight ||
      null
  };
};

const buildPricingSummary = (pricing) => {
  if (!pricing || pricing.error) return pricing || null;

  return {
    listing_type_id: pricing.listing_type_id || null,
    listing_type_name: pricing.listing_type_name || null,
    input_price: toNumberOrNull(pricing.input_price),
    sale_fee_amount: toNumberOrZero(pricing.sale_fee_amount),
    listing_fee_amount: toNumberOrZero(pricing.listing_fee_amount),
    total_fee_amount: toNumberOrZero(pricing.total_fee_amount),
    fee_percentage: toNumberOrZero(pricing.fee_percentage),
    total_fee_percentage: toNumberOrZero(pricing.total_fee_percentage),
    seller_shipping_cost: toNumberOrNull(pricing.seller_shipping_cost),
    shipping_subsidy: toNumberOrZero(pricing.shipping_subsidy),
    shipping_requested: Boolean(pricing.shipping_requested),
    shipping_scenario: pricing.shipping_scenario || null,
    campaign_tag_requested: pricing.campaign_tag_requested || null,
    campaign_tag_applied: pricing.campaign_tag_applied || null,
    campaign_pricing_applied: Boolean(pricing.campaign_pricing_applied),
    net_amount_before_shipping: toNumberOrZero(pricing.net_amount),
    net_amount_after_shipping:
      pricing.net_amount_after_shipping !== undefined && pricing.net_amount_after_shipping !== null
        ? toNumberOrZero(pricing.net_amount_after_shipping)
        : toNumberOrZero(pricing.net_amount),
    warning: pricing.warning || null
  };
};

const buildPricingOptionsSummary = (pricingOptions = []) =>
  Array.isArray(pricingOptions)
    ? pricingOptions.map((option) => buildPricingSummary(option)).filter(Boolean)
    : [];

const buildCompactShippingView = (shipping, sellerShippingView) => {
  if (!shipping) return null;
  const shippingResolutionState = sellerShippingView?.shipping_resolution_state || shipping?.shipping_resolution_state || null;

  const shippingUi = buildShippingUi(
    shipping.shipping_mode || sellerShippingView?.shipping_mode || null,
    shipping.logistic_type || sellerShippingView?.logistic_type || null,
    shippingResolutionState
  );

  return {
    buyer_pays: shipping.buyer_pays || null,
    seller_pays: shipping.seller_pays || null,
    selected_scenario_key: shipping.selected_scenario_key || null,
    selected_summary: sellerShippingView || null,
    shipping_ui: shippingUi,
    requested_free_shipping: shipping.requested_free_shipping ?? null,
    mandatory_free_shipping_detected: shipping.mandatory_free_shipping_detected ?? false,
    logistic_model: shipping.logistic_model || sellerShippingView?.logistic_model || null,
    shipping_operation: shipping.shipping_operation || sellerShippingView?.shipping_operation || null,
    zip_code_used: shipping.zip_code_used || null,
    item_shipping_option_used: shipping.item_shipping_option_used || null,
    shipping_cost_source: shipping.shipping_cost_source || null,
    shipping_cost_fallbacks: shipping.shipping_cost_fallbacks || null,
    warning: shipping.warning || null
  };
};

const normalizeMlSuggestedCategoriesResponseDetail = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (["full", "complete", "verbose"].includes(normalized)) return "full";
  return "essential";
};

const buildMlSuggestedCategoryPayload = (categoryData, responseDetail) => {
  if (responseDetail === "full") {
    return categoryData;
  }

  return {
    response_format_version: "v2_essential",
    category_id: categoryData.category_id,
    category_name: categoryData.category_name,
    domain_id: categoryData.domain_id,
    domain_name: categoryData.domain_name,
    path: categoryData.path,
    resolved: categoryData.resolved,
    listing_resolution: categoryData.listing_resolution,
    selection_warnings: Array.isArray(categoryData.selection_warnings) ? categoryData.selection_warnings : [],
    attributes: Array.isArray(categoryData.attributes) ? categoryData.attributes : [],
    available_choices: {
      listing_types: Array.isArray(categoryData.listing_types)
        ? categoryData.listing_types.map((item) => ({
            value: item.value,
            title: item.title,
            description: item.description
          }))
        : [],
      shipping_combinations: Array.isArray(categoryData.shipping_combinations)
        ? categoryData.shipping_combinations
        : [],
      shipping_modes_count: categoryData.shipping_modes_count ?? 0
    },
    quote: categoryData.quote
      ? {
          price: categoryData.quote.price ?? null,
          pricing: categoryData.quote.pricing || null,
          shipping: categoryData.quote.shipping
            ? {
                selected_scenario_key: categoryData.quote.shipping.selected_scenario_key || null,
                selected_summary: categoryData.quote.shipping.selected_summary || null,
                shipping_cost_source: categoryData.quote.shipping.shipping_cost_source || null,
                shipping_cost_fallbacks: categoryData.quote.shipping.shipping_cost_fallbacks || null,
                warning: categoryData.quote.shipping.warning || null
              }
            : null,
          profitability: categoryData.quote.profitability || null,
          economic_summary: categoryData.quote.economic_summary || null,
          shipping_policy: categoryData.quote.shipping_policy || null
        }
      : null
  };
};

const buildMlSuggestedProductSuggestion = ({
  product,
  credentialId,
  marketplaceId,
  selectedStrategy,
  normalizedInstallments,
  strategyWarnings,
  categories
}) => ({
  product_id: product.id,
  credential_id: credentialId,
  marketplace_id: marketplaceId,
  response_focus: "economic_summary",
  selection_context: {
    strategy: selectedStrategy,
    installments: {
      request_ignored: normalizedInstallments.requested,
      campaign_tag_requested: normalizeCampaignTagValue(normalizedInstallments?.campaign_tag)
    },
    warnings: strategyWarnings
  },
  categories
});

const normalizeMarketplaceShippingValue = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === "object") {
    return normalizeMarketplaceShippingValue(
      value.mode ??
      value.shipping_mode ??
      value.type ??
      value.logistic_type ??
      value.value ??
      value.id ??
      value.name ??
      value.title
    );
  }
  const normalized = String(value).trim();
  return normalized || null;
};

const normalizeMarketplaceShippingEntry = (entry, fallbackKey = "value") => {
  const value = normalizeMarketplaceShippingValue(
    entry?.[fallbackKey] ?? entry?.mode ?? entry?.shipping_mode ?? entry?.type ?? entry?.logistic_type ?? entry
  );
  if (!value) return null;

  return {
    value,
    label: entry?.label || entry?.name || entry?.title || value,
    description: entry?.description || entry?.name || entry?.title || value,
    is_default: Boolean(entry?.default ?? entry?.is_default),
    raw: entry
  };
};

const getMercadoLibreUserIdFromCredential = (cred) => {
  if (!cred) return null;

  if (cred.ml_user_id) return cred.ml_user_id;

  const additional = cred.additional_data;
  if (!additional) return null;

  if (typeof additional === "object") return additional.ml_user_id || null;

  if (typeof additional === "string") {
    try {
      const parsed = JSON.parse(additional);
      return parsed?.ml_user_id || null;
    } catch (e) {
      return null;
    }
  }

  return null;
};

const fetchMercadoLibreUserId = async (accessToken) => {
  if (!accessToken) return null;
  try {
    const response = await axios.get("https://api.mercadolibre.com/users/me", {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 8000
    });
    return response.data?.id || null;
  } catch (e) {
    return null;
  }
};

const persistMercadoLibreUserIdOnCredential = async (credential, mlUserId) => {
  if (!credential?.id || !mlUserId || getMercadoLibreUserIdFromCredential(credential)) {
    return;
  }

  try {
    let additional = credential.additional_data;
    if (typeof additional === "string") {
      try {
        additional = JSON.parse(additional);
      } catch (e) {
        additional = {};
      }
    }

    if (typeof additional !== "object" || additional === null) additional = {};

    await MarketplaceCredentialRepository.updatePartial(credential.id, {
      additional_data: { ...additional, ml_user_id: mlUserId }
    });
  } catch (e) {
    logger.warn(`[ML] No se pudo persistir ml_user_id en additional_data para credencial ${credential.id}: ${e.message}`);
  }
};

const resolveMercadoLibreUserIdForCredential = async (credential) => {
  const mlUserId =
    getMercadoLibreUserIdFromCredential(credential) ||
    (await fetchMercadoLibreUserId(credential?.access_token));

  if (mlUserId) {
    await persistMercadoLibreUserIdOnCredential(credential, mlUserId);
  }

  return mlUserId;
};

const buildMercadoLibreShippingBaseParams = ({
  product,
  categoryId,
  listingType,
  shippingMode,
  logisticType
}) => {
  let dimensions = null;
  try {
    const shippingMeasurementInput = buildShippingMeasurementInput(product);
    if (shippingMeasurementInput) {
      dimensions = OAuthController.formatDimensionsForAPI(shippingMeasurementInput, { strict: true });
    }
  } catch (e) {
    dimensions = null;
  }

  const itemId = product?.ml_item_id || product?.item_id || null;
  const zipCode = extractProductZipCode(product);
  const productSelection = product?.selection && typeof product.selection === "object"
    ? product.selection
    : null;
  const requestedFreeShipping =
    typeof product?.shipping?.free_shipping === "boolean"
      ? product.shipping.free_shipping
      : (typeof product?.free_shipping === "boolean"
        ? product.free_shipping
        : (typeof productSelection?.free_shipping === "boolean"
          ? productSelection.free_shipping
          : null));
  const normalizedLogisticType = normalizeMarketplaceShippingValue(logisticType);

  const baseParams = {
    item_price: product.price,
    category_id: categoryId,
    listing_type_id: listingType,
    mode: shippingMode || "me2",
    condition: product.condition || "new",
    verbose: true
  };

  if (normalizedLogisticType) baseParams.logistic_type = normalizedLogisticType;
  if (dimensions) baseParams.dimensions = dimensions;
  if (itemId) baseParams.item_id = itemId;

  return {
    baseParams,
    dimensions,
    itemId,
    zipCode,
    requestedFreeShipping
  };
};

const validateMarketplaceShippingComboForProduct = async ({
  credential,
  mlUserId,
  product,
  categoryId,
  listingType,
  combo
}) => {
  const { baseParams } = buildMercadoLibreShippingBaseParams({
    product,
    categoryId,
    listingType,
    shippingMode: combo?.shipping_mode,
    logisticType: combo?.logistic_type
  });

  if (!mlUserId) {
    return {
      supported: null,
      reason: "missing_ml_user_id"
    };
  }

  if (!baseParams.item_id && !baseParams.dimensions) {
    return {
      supported: null,
      reason: "missing_dimensions_or_item_id"
    };
  }

  if (!Number.isFinite(Number(baseParams.item_price))) {
    return {
      supported: null,
      reason: "missing_item_price"
    };
  }

  try {
    const response = await axios.get(
      `https://api.mercadolibre.com/users/${mlUserId}/shipping_options/free`,
      {
        params: { ...baseParams, free_shipping: false },
        headers: { Authorization: `Bearer ${credential.access_token}` },
        timeout: 15000
      }
    );

    return {
      supported: true,
      reason: null,
      response: response.data || null
    };
  } catch (error) {
    const status = error.response?.status || null;
    const message = error.response?.data?.message || error.message;

    if (status && status >= 400 && status < 500) {
      return {
        supported: false,
        reason: message,
        status
      };
    }

    return {
      supported: null,
      reason: message,
      status
    };
  }
};

const filterSupportedMarketplaceShippingCombosForProduct = async ({
  credential,
  product,
  categoryId,
  listingType,
  combos
}) => {
  const normalizedCombos = finalizeShippingCombos(combos);
  if (normalizedCombos.length === 0) {
    return {
      combos: [],
      warnings: []
    };
  }

  const mlUserId = await resolveMercadoLibreUserIdForCredential(credential);
  const validations = [];

  for (const combo of normalizedCombos) {
    const validation = await validateMarketplaceShippingComboForProduct({
      credential,
      mlUserId,
      product,
      categoryId,
      listingType,
      combo
    });

    validations.push({
      combo,
      validation
    });
  }

  const supported = validations.filter(entry => entry.validation?.supported === true).map(entry => entry.combo);
  const indeterminate = validations.filter(entry => entry.validation?.supported === null);
  const warnings = validations
    .filter(entry => entry.validation?.supported !== true)
    .map(entry => {
      const mode = entry.combo?.shipping_mode || "none";
      const logisticType = entry.combo?.logistic_type || "none";
      const reason = entry.validation?.reason || "unknown";
      const kind = entry.validation?.supported === false ? "shipping_combo_rejected" : "shipping_combo_validation_skipped";
      return `${kind}:${mode}:${logisticType}:${reason}`;
    });

  if (supported.length > 0) {
    return {
      combos: finalizeShippingCombos(supported).map((combo) => ({
        ...combo,
        shipping_resolution_state: SHIPPING_RESOLUTION_STATE.RESOLVED,
        shipping_complexity: SHIPPING_COMPLEXITY.AUTOMATED,
        is_resolved: true,
        is_partial: false,
        is_manual: false,
        is_dynamic: false,
        requires_buyer_context: false
      })),
      warnings
    };
  }

  if (indeterminate.length > 0) {
    return {
      combos: finalizeShippingCombos(normalizedCombos).map((combo) => ({
        ...combo,
        shipping_resolution_state: combo.shipping_resolution_state || SHIPPING_RESOLUTION_STATE.DYNAMIC,
        shipping_complexity: combo.shipping_complexity || SHIPPING_COMPLEXITY.DYNAMIC,
        is_resolved: combo.shipping_resolution_state === SHIPPING_RESOLUTION_STATE.RESOLVED,
        is_partial: combo.shipping_resolution_state === SHIPPING_RESOLUTION_STATE.PARTIAL,
        is_manual: combo.shipping_resolution_state === SHIPPING_RESOLUTION_STATE.MANUAL,
        is_dynamic: combo.shipping_resolution_state === SHIPPING_RESOLUTION_STATE.DYNAMIC || isDynamicShippingMode(combo.shipping_mode),
        requires_buyer_context: combo.shipping_resolution_state === SHIPPING_RESOLUTION_STATE.DYNAMIC || combo.shipping_resolution_state === SHIPPING_RESOLUTION_STATE.PARTIAL
      })),
      warnings
    };
  }

  return {
    combos: [],
    warnings
  };
};

const buildShippingUi = (shippingMode, logisticType, resolutionState = null) => {
  const normalizedMode = normalizeMarketplaceShippingValue(shippingMode);
  const normalizedType = normalizeMarketplaceLogisticType(normalizedMode, logisticType);
  const normalizedState = normalizeMarketplaceShippingValue(resolutionState);

  const sharedMercadoEnvios = {
    family: "mercado_envios",
    label: "Mercado Envíos"
  };

  const byLogisticType = {
    drop_off: {
      ...sharedMercadoEnvios,
      seller_instruction: "Deberás llevar el paquete a un punto de entrega habilitado por Mercado Libre."
    },
    xd_drop_off: {
      ...sharedMercadoEnvios,
      seller_instruction: "Deberás entregar el paquete en un punto o tienda habilitada por Mercado Libre."
    },
    cross_docking: {
      ...sharedMercadoEnvios,
      seller_instruction: "Mercado Libre retirará el paquete según la configuración de tu cuenta."
    },
    self_service: {
      family: "flex",
      label: "Flex",
      seller_instruction: "Tú realizas la entrega mediante Envíos Flex."
    },
    fulfillment: {
      family: "full",
      label: "Full",
      seller_instruction: "Mercado Libre gestionará el envío desde sus bodegas."
    },
    turbo: {
      family: "mercado_envios",
      label: "Mercado Envíos",
      seller_instruction: "Mercado Libre gestionará una entrega rápida según cobertura y configuración disponible."
    }
  };

  const modeFallbacks = {
    custom: {
      family: "custom",
      label: "Envío manual",
      seller_instruction: "Deberás cargar tu tabla de costos o configuración manual."
    },
    me1: {
      family: "mercado_envios",
      label: "Mercado Envíos",
      seller_instruction: "La logística depende de la configuración y contexto disponible de tu cuenta."
    },
    me2: {
      family: "mercado_envios",
      label: "Mercado Envíos",
      seller_instruction: "Mercado Libre gestionará el envío según la configuración y el contexto disponible."
    },
    not_specified: {
      family: "shipping",
      label: "Entrega manual",
      seller_instruction: "No hay costo logístico específico; el comprador y vendedor acuerdan la entrega."
    }
  };

  const partialMe2Ui = {
    family: "mercado_envios",
    label: "Mercado Envíos (pendiente)",
    seller_instruction: "Modo disponible, pero todavía sin tipo logístico resuelto."
  };

  const ui = normalizedState === SHIPPING_RESOLUTION_STATE.PARTIAL
    ? partialMe2Ui
    : (byLogisticType[normalizedType] || modeFallbacks[normalizedMode] || {
    family: "shipping",
    label: "Envío",
    seller_instruction: "Mercado Libre definirá la operación logística según la configuración disponible."
    });

  return {
    ...ui,
    resolution_state: normalizedState || null,
    internal_shipping_mode: normalizedMode || null,
    internal_logistic_type: normalizedType || null
  };
};

const buildMarketplaceShippingSelection = ({ userPreferences, categoryPreferences }) => {
  const categoryLogistics = Array.isArray(categoryPreferences?.logistics)
    ? categoryPreferences.logistics
    : [];
  const userModes = Array.isArray(userPreferences?.modes)
    ? userPreferences.modes.map((entry) => normalizeMarketplaceShippingEntry(entry, "mode")).filter(Boolean)
    : [];
  const userLogistics = Array.isArray(userPreferences?.logistics)
    ? userPreferences.logistics
    : [];

  const userLogisticsByMode = new Map();
  for (const entry of userLogistics) {
    const normalizedModeEntry = normalizeMarketplaceShippingEntry(entry, "mode");
    const mode = normalizedModeEntry?.value || null;
    const types = Array.isArray(entry?.types)
      ? entry.types.map((typeEntry) => normalizeMarketplaceShippingEntry(typeEntry, "type")).filter(Boolean)
      : [];

    if (!mode) continue;
    userLogisticsByMode.set(mode, {
      is_default: normalizedModeEntry?.is_default || false,
      types
    });
  }

  const allowedModeSet = userModes.length > 0 ? new Set(userModes.map((entry) => entry.value)) : null;
  const shippingModesByValue = new Map();
  const logisticTypes = [];
  const combos = [];
  const seenTypes = new Set();

  const upsertMode = ({
    value,
    label,
    description,
    is_default = false,
    shipping_resolution_state = SHIPPING_RESOLUTION_STATE.DYNAMIC,
    shipping_complexity = SHIPPING_COMPLEXITY.DYNAMIC
  }) => {
    if (!value) return null;

    const current = shippingModesByValue.get(value) || {
      value,
      title: label || value,
      description: description || label || value,
      is_default: false,
      shipping_resolution_state,
      shipping_complexity,
      is_manual_shipping: false,
      is_dynamic_shipping: false,
      is_partial_shipping: false,
      is_resolved_shipping: false,
      supports_manual_shipping: false,
      supports_dynamic_shipping: false,
      available_logistic_types: [],
      logistic_types_count: 0,
      ml_metadata: {
        source: "marketplace_shipping_preferences",
        is_default: false
      }
    };

    current.title = label || current.title || value;
    current.description = description || current.description || value;
    current.is_default = Boolean(current.is_default || is_default);
    current.shipping_resolution_state = shipping_resolution_state || current.shipping_resolution_state;
    current.shipping_complexity = shipping_complexity || current.shipping_complexity;
    current.is_manual_shipping = current.shipping_resolution_state === SHIPPING_RESOLUTION_STATE.MANUAL;
    current.is_dynamic_shipping = current.shipping_resolution_state === SHIPPING_RESOLUTION_STATE.DYNAMIC;
    current.is_partial_shipping = current.shipping_resolution_state === SHIPPING_RESOLUTION_STATE.PARTIAL;
    current.is_resolved_shipping = current.shipping_resolution_state === SHIPPING_RESOLUTION_STATE.RESOLVED;
    current.supports_manual_shipping = current.is_manual_shipping || isManualShippingMode(value);
    current.supports_dynamic_shipping = current.supports_dynamic_shipping || current.is_dynamic_shipping || isDynamicShippingMode(value) || value === "me2";
    current.ml_metadata = {
      ...current.ml_metadata,
      is_default: Boolean(current.ml_metadata?.is_default || is_default)
    };

    shippingModesByValue.set(value, current);
    return current;
  };

  const pushType = (typeEntry) => {
    if (!typeEntry?.value || seenTypes.has(typeEntry.value)) return;
    seenTypes.add(typeEntry.value);
    const entry = {
      value: typeEntry.value,
      title: typeEntry.label,
      description: typeEntry.description,
      ml_metadata: {
        source: "marketplace_shipping_preferences",
        is_default: typeEntry.is_default
      }
      };
    logisticTypes.push(entry);
  };

  for (const categoryEntry of categoryLogistics) {
    const normalizedCategoryMode = normalizeMarketplaceShippingEntry(categoryEntry, "mode");
    const mode = normalizedCategoryMode?.value || null;
    if (!mode) continue;
    if (allowedModeSet && !allowedModeSet.has(mode)) continue;

    const userModeEntry = userModes.find((entry) => entry.value === mode) || null;
    const userModeConfig = userLogisticsByMode.get(mode) || { is_default: false, types: [] };
    const isManualMode = isManualShippingMode(mode);
    const isDynamicMode = isDynamicShippingMode(mode);
    const baseState = isManualMode
      ? SHIPPING_RESOLUTION_STATE.MANUAL
      : (mode === "me2" ? SHIPPING_RESOLUTION_STATE.PARTIAL : SHIPPING_RESOLUTION_STATE.DYNAMIC);

    upsertMode({
      value: mode,
      label: normalizedCategoryMode?.label || userModeEntry?.label || mode,
      description: normalizedCategoryMode?.description || userModeEntry?.description || mode,
      is_default: userModeEntry?.is_default || userModeConfig.is_default || normalizedCategoryMode?.is_default || false,
      shipping_resolution_state: baseState,
      shipping_complexity: isManualMode
        ? SHIPPING_COMPLEXITY.MANUAL
        : (isDynamicMode || mode === "me2" ? SHIPPING_COMPLEXITY.DYNAMIC : SHIPPING_COMPLEXITY.DYNAMIC)
    });

    const categoryTypes = Array.isArray(categoryEntry?.types)
      ? categoryEntry.types
        .map((typeEntry) => normalizeMarketplaceShippingEntry(typeEntry, "type"))
        .filter(Boolean)
        .filter((typeEntry) => !MANUAL_SHIPPING_MODES.has(typeEntry.value))
      : [];
    const userTypes = userModeConfig.types || [];
    const effectiveTypes = userTypes.length > 0
      ? categoryTypes.filter(type => userTypes.some((userType) => userType.value === type.value))
      : categoryTypes;

    if (isManualMode) {
      continue;
    }

    if (effectiveTypes.length === 0) {
      upsertMode({
        value: mode,
        label: normalizedCategoryMode?.label || userModeEntry?.label || mode,
        description: normalizedCategoryMode?.description || userModeEntry?.description || mode,
        is_default: userModeEntry?.is_default || userModeConfig.is_default || normalizedCategoryMode?.is_default || false,
        shipping_resolution_state: mode === "me2"
          ? SHIPPING_RESOLUTION_STATE.PARTIAL
          : SHIPPING_RESOLUTION_STATE.DYNAMIC,
        shipping_complexity: SHIPPING_COMPLEXITY.DYNAMIC
      });
      continue;
    }

    for (const type of effectiveTypes) {
      const matchingUserType = userTypes.find((userType) => userType.value === type.value) || null;
      const comboState = classifyShippingResolution({
        shippingMode: mode,
        logisticType: type.value,
        validationSupport: null
      });
      combos.push({
        shipping_mode: mode,
        logistic_type: type.value,
        shipping_resolution_state: comboState.shipping_resolution_state,
        shipping_complexity: comboState.shipping_complexity,
        is_resolved: comboState.is_resolved,
        is_partial: comboState.is_partial,
        is_manual: comboState.is_manual,
        is_dynamic: comboState.is_dynamic,
        requires_buyer_context: comboState.requires_buyer_context,
        is_default: Boolean(
          matchingUserType?.is_default ||
          type.is_default ||
          userModeEntry?.is_default ||
          userModeConfig.is_default ||
          normalizedCategoryMode?.is_default
        )
      });
      pushType({
        value: type.value,
        label: type.label,
        description: type.description,
        is_default: matchingUserType?.is_default || type.is_default || false
      });
      const currentModeState = shippingModesByValue.get(mode);
      if (currentModeState) {
        const currentLogistics = Array.isArray(currentModeState.available_logistic_types)
          ? currentModeState.available_logistic_types
          : [];
        if (!currentLogistics.some((entry) => entry.value === type.value)) {
          currentLogistics.push({
            value: type.value,
            title: type.label,
            description: type.description,
            is_default: matchingUserType?.is_default || type.is_default || false
          });
        }
        currentModeState.available_logistic_types = currentLogistics;
        currentModeState.logistic_types_count = currentLogistics.length;
        shippingModesByValue.set(mode, currentModeState);
      }
      upsertMode({
        value: mode,
        label: normalizedCategoryMode?.label || userModeEntry?.label || mode,
        description: normalizedCategoryMode?.description || userModeEntry?.description || mode,
        is_default: userModeEntry?.is_default || userModeConfig.is_default || normalizedCategoryMode?.is_default || false,
        shipping_resolution_state: mode === "me2"
          ? SHIPPING_RESOLUTION_STATE.DYNAMIC
          : SHIPPING_RESOLUTION_STATE.DYNAMIC,
        shipping_complexity: SHIPPING_COMPLEXITY.DYNAMIC
      });
    }
  }

  const shippingModes = Array.from(shippingModesByValue.values()).map((modeEntry) => ({
    ...modeEntry,
    available_logistic_types: Array.isArray(modeEntry.available_logistic_types) ? modeEntry.available_logistic_types : [],
    logistic_types_count: Number.isFinite(modeEntry.logistic_types_count) ? modeEntry.logistic_types_count : 0
  }));

  return {
    shippingModes,
    logisticTypes,
    combos: finalizeShippingCombos(combos)
  };
};

const buildMlSelectionCategoryPayload = ({
  cat,
  attributes,
  listingTypesForCategory,
  filteredShippingModes,
  logisticTypesForCategory,
  shippingCombinations,
  shippingOptions,
  shippingModeStates,
  selectedStrategy,
  effectiveListingType,
  effectiveShippingMode,
  effectiveLogisticType,
  selectionWarnings
}) => {
  const logisticTypesByShippingMode = {};
  const shippingStatesByMode = {};
  const defaultCombo = Array.isArray(shippingCombinations)
    ? shippingCombinations.find((combo) => combo.shipping_mode === effectiveShippingMode && combo.logistic_type === effectiveLogisticType)
    : null;
  const defaultMode = Array.isArray(shippingModeStates)
    ? shippingModeStates.find((modeEntry) => modeEntry?.value === effectiveShippingMode)
    : null;
  const defaultResolutionState = defaultCombo?.shipping_resolution_state || defaultMode?.shipping_resolution_state || null;
  const automationStatus = defaultResolutionState === SHIPPING_RESOLUTION_STATE.RESOLVED
    ? "automated"
    : defaultResolutionState === SHIPPING_RESOLUTION_STATE.MANUAL
      ? "manual"
      : defaultResolutionState === SHIPPING_RESOLUTION_STATE.PARTIAL
        ? "partial"
        : defaultResolutionState === SHIPPING_RESOLUTION_STATE.DYNAMIC
          ? "dynamic"
          : "unsupported";

  for (const modeEntry of Array.isArray(shippingModeStates) ? shippingModeStates : []) {
    if (!modeEntry?.value) continue;
    shippingStatesByMode[modeEntry.value] = {
      shipping_mode: modeEntry.value,
      shipping_resolution_state: modeEntry.shipping_resolution_state || null,
      shipping_complexity: modeEntry.shipping_complexity || null,
      is_manual_shipping: Boolean(modeEntry.is_manual_shipping),
      is_dynamic_shipping: Boolean(modeEntry.is_dynamic_shipping),
      is_partial_shipping: Boolean(modeEntry.is_partial_shipping),
      is_resolved_shipping: Boolean(modeEntry.is_resolved_shipping),
      supports_manual_shipping: Boolean(modeEntry.supports_manual_shipping),
      supports_dynamic_shipping: Boolean(modeEntry.supports_dynamic_shipping),
      logistic_types_count: Number(modeEntry.logistic_types_count || 0),
      available_logistic_types: Array.isArray(modeEntry.available_logistic_types)
        ? modeEntry.available_logistic_types
        : []
    };
    logisticTypesByShippingMode[modeEntry.value] = Array.isArray(modeEntry.available_logistic_types)
      ? modeEntry.available_logistic_types.map((typeEntry) => ({
          value: typeEntry.value,
          title: typeEntry.title || typeEntry.value,
          description: typeEntry.description || typeEntry.value
        }))
      : [];
  }

  for (const combo of Array.isArray(shippingCombinations) ? shippingCombinations : []) {
    if (!combo?.shipping_mode) continue;
    if (!logisticTypesByShippingMode[combo.shipping_mode]) {
      logisticTypesByShippingMode[combo.shipping_mode] = [];
    }

    if (!combo.logistic_type) continue;

    const currentList = logisticTypesByShippingMode[combo.shipping_mode];
    if (currentList.some((entry) => entry.value === combo.logistic_type)) continue;

    currentList.push({
      value: combo.logistic_type,
      title: combo.logistic_type,
      description: combo.logistic_type
    });
  }

  return {
    category_id: cat.category_id,
    category_name: cat.category_name,
    domain_id: cat.domain_id,
    domain_name: cat.domain_name,
    path: cat.path,
    attributes: Array.isArray(attributes) ? attributes : [],
    listing_types: Array.isArray(listingTypesForCategory) ? listingTypesForCategory : [],
    shipping_modes: Array.isArray(filteredShippingModes) ? filteredShippingModes : [],
    shipping_options: Array.isArray(shippingOptions) ? shippingOptions : [],
    logistic_types_by_shipping_mode: logisticTypesByShippingMode,
    shipping_states_by_mode: shippingStatesByMode,
    shipping_combinations: Array.isArray(shippingCombinations) ? shippingCombinations : [],
    shipping_capabilities: {
      manual_shipping_supported: Object.values(shippingStatesByMode).some((entry) => entry.is_manual_shipping),
      dynamic_shipping_supported: Object.values(shippingStatesByMode).some((entry) => entry.is_dynamic_shipping),
      resolved_shipping_supported: Array.isArray(shippingCombinations) && shippingCombinations.some((combo) => combo?.shipping_resolution_state === SHIPPING_RESOLUTION_STATE.RESOLVED),
      partial_shipping_supported: Object.values(shippingStatesByMode).some((entry) => entry.is_partial_shipping),
      unsupported_shipping_detected: Array.isArray(shippingCombinations) && shippingCombinations.some((combo) => combo?.shipping_resolution_state === SHIPPING_RESOLUTION_STATE.UNSUPPORTED),
      automation_status: automationStatus,
      ui_flags: {
        show_marketplace_envios: Object.values(shippingStatesByMode).some((entry) => entry.is_dynamic_shipping || entry.is_resolved_shipping || entry.is_partial_shipping),
        show_manual_shipping: Object.values(shippingStatesByMode).some((entry) => entry.is_manual_shipping),
        show_dynamic_shipping: Object.values(shippingStatesByMode).some((entry) => entry.is_dynamic_shipping),
        show_shipping_warning: Array.isArray(selectionWarnings) && selectionWarnings.length > 0,
        block_shipping_selection: automationStatus === "unsupported"
      }
    },
    defaults: {
      strategy: selectedStrategy,
      listing_type_id: effectiveListingType,
      shipping_mode: effectiveShippingMode,
      logistic_type: effectiveLogisticType,
      shipping_resolution_state: defaultCombo?.shipping_resolution_state || defaultMode?.shipping_resolution_state || null,
      shipping_complexity: defaultCombo?.shipping_complexity || defaultMode?.shipping_complexity || null,
      shipping_ui: buildShippingUi(
        effectiveShippingMode,
        effectiveLogisticType,
        defaultCombo?.shipping_resolution_state || defaultMode?.shipping_resolution_state || null
      )
    },
    selection_warnings: Array.isArray(selectionWarnings) ? selectionWarnings : []
  };
};

const extractProductZipCode = (product) => {
  const candidates = [
    product?.zip_code,
    product?.zipcode,
    product?.postal_code,
    product?.shipping_zip_code,
    product?.shipping?.zip_code,
    product?.shipping?.zipcode,
    product?.shipping?.postal_code,
    product?.receiver_address?.zip_code,
    product?.address?.zip_code
  ];

  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined) continue;
    const normalized = String(candidate).trim();
    if (normalized) return normalized;
  }

  return null;
};

const normalizeShippingScenarios = ({
  shippingMode,
  logisticType,
  buyerPays,
  sellerPays,
  requestedFreeShipping,
  mandatoryFreeShipping
}) => {
  const shippingResolution = classifyShippingResolution({
    shippingMode,
    logisticType
  });
  const buyerCost = toNumberOrZero(buyerPays?.cost);
  const sellerCost = toNumberOrZero(sellerPays?.cost);
  const subsidy = Math.max(0, extractCoverageSubsidy(sellerPays));

  const scenarios = {
    buyer_pays_shipping: {
      scenario: "buyer_pays_shipping",
      free_shipping: false,
      mandatory_free_shipping: Boolean(mandatoryFreeShipping),
      buyer_shipping_cost: buyerCost,
      seller_shipping_cost: 0,
      shipping_subsidy: 0,
      who_pays: "buyer"
    },
    seller_free_shipping: {
      scenario: "seller_free_shipping",
      free_shipping: true,
      mandatory_free_shipping: false,
      buyer_shipping_cost: 0,
      seller_shipping_cost: sellerCost,
      shipping_subsidy: subsidy,
      who_pays: "seller"
    },
    mandatory_free_shipping: {
      scenario: "mandatory_free_shipping",
      free_shipping: true,
      mandatory_free_shipping: true,
      buyer_shipping_cost: 0,
      seller_shipping_cost: sellerCost,
      shipping_subsidy: subsidy,
      who_pays: subsidy > 0 ? "shared" : "seller"
    },
    subsidized_shipping: {
      scenario: "subsidized_shipping",
      free_shipping: true,
      mandatory_free_shipping: Boolean(mandatoryFreeShipping),
      buyer_shipping_cost: 0,
      seller_shipping_cost: sellerCost,
      shipping_subsidy: subsidy,
      who_pays: subsidy > 0 ? "shared" : "seller"
    }
  };

  let selectedScenario = "buyer_pays_shipping";
  if (mandatoryFreeShipping) {
    selectedScenario = subsidy > 0 ? "subsidized_shipping" : "mandatory_free_shipping";
  } else if (requestedFreeShipping === true) {
    selectedScenario = subsidy > 0 ? "subsidized_shipping" : "seller_free_shipping";
  } else if (requestedFreeShipping === false) {
    selectedScenario = "buyer_pays_shipping";
  } else if (subsidy > 0) {
    selectedScenario = "subsidized_shipping";
  }

  const selected = scenarios[selectedScenario];

  return {
    shipping_summary: {
      shipping_mode: shippingMode,
      logistic_type: logisticType,
      shipping_resolution_state: shippingResolution.shipping_resolution_state,
      shipping_complexity: shippingResolution.shipping_complexity,
      logistic_model: deriveLogisticModel(shippingMode, logisticType),
      shipping_operation: deriveShippingOperation(shippingMode, logisticType),
      free_shipping: selected.free_shipping,
      mandatory_free_shipping: selected.mandatory_free_shipping,
      buyer_shipping_cost: selected.buyer_shipping_cost,
      seller_shipping_cost: selected.seller_shipping_cost,
      shipping_subsidy: selected.shipping_subsidy,
      who_pays: selected.who_pays,
      scenario: selected.scenario
    },
    shipping_scenarios: scenarios,
    selected_scenario_key: selectedScenario
  };
};

const buildProfitabilityMetrics = ({ pricing, shippingSummary, productPrice, economicInputs }) => {
  if (!pricing || pricing.error || !Number.isFinite(Number(productPrice))) return null;

  const price = toNumberOrZero(productPrice);
  const totalFee = toNumberOrZero(pricing.total_fee_amount);
  const listingCharge = toNumberOrZero(pricing.listing_fee_amount);
  const shippingCost = toNumberOrZero(shippingSummary?.seller_shipping_cost);
  const netWithoutShipping = price - totalFee;
  const netWithShipping = netWithoutShipping - shippingCost;
  const productCost = economicInputs?.product_cost ?? null;
  const totalCostBasis = economicInputs?.total_cost_basis ?? null;
  const costBasis = toNumberOrZero(totalCostBasis);
  const utilityFinal = totalCostBasis === null ? null : netWithShipping - costBasis;
  const marginRaw = utilityFinal === null || price <= 0 ? null : (utilityFinal / price) * 100;
  const marginReal = marginRaw === null ? null : Number(clamp(marginRaw, -300, 300).toFixed(2));

  const profitable = utilityFinal === null ? null : utilityFinal >= 0;
  const criticalLoss = utilityFinal === null ? false : utilityFinal < 0 && (marginReal !== null && marginReal <= -30);
  const profitabilityStatus = utilityFinal === null
    ? "unknown_cost_basis"
    : profitable
      ? "profitable"
      : (criticalLoss ? "critical_loss" : "loss");

  const recommendedMinimumPrice = totalCostBasis === null
    ? null
    : Number((costBasis + totalFee + shippingCost).toFixed(2));
  const estimatedBreakEvenPrice = recommendedMinimumPrice;

  const shippingRiskLevel = !shippingSummary
    ? "unknown"
    : shippingSummary.mandatory_free_shipping
      ? "high"
      : (shippingSummary.shipping_subsidy > 0 ? "medium" : "low");

  return {
    commission_amount: toNumberOrZero(pricing.sale_fee_amount),
    listing_charge_amount: listingCharge,
    total_fee_amount: totalFee,
    net_amount_without_shipping: Number(netWithoutShipping.toFixed(2)),
    net_amount_with_shipping: Number(netWithShipping.toFixed(2)),
    product_cost_basis: productCost,
    total_cost_basis: totalCostBasis,
    cost_components: economicInputs || null,
    final_profit: utilityFinal === null ? null : Number(utilityFinal.toFixed(2)),
    real_margin_percentage: marginReal,
    profitable,
    warning: profitable === false,
    critical_loss: criticalLoss,
    recommended_minimum_price: recommendedMinimumPrice,
    estimated_break_even_price: estimatedBreakEvenPrice,
    shipping_risk_level: shippingRiskLevel,
    profitability_status: profitabilityStatus
  };
};

const buildSellerShippingView = (shippingSummary) => {
  if (!shippingSummary || typeof shippingSummary !== "object") return null;

  return {
    shipping_mode: shippingSummary.shipping_mode || null,
    logistic_type: shippingSummary.logistic_type || null,
    logistic_model: shippingSummary.logistic_model || null,
    shipping_operation: shippingSummary.shipping_operation || null,
    shipping_resolution_state: shippingSummary.shipping_resolution_state || null,
    shipping_complexity: shippingSummary.shipping_complexity || null,
    scenario: shippingSummary.scenario || null,
    free_shipping: Boolean(shippingSummary.free_shipping),
    mandatory_free_shipping: Boolean(shippingSummary.mandatory_free_shipping),
    seller_shipping_cost: toNumberOrZero(shippingSummary.seller_shipping_cost),
    shipping_subsidy: toNumberOrZero(shippingSummary.shipping_subsidy),
    seller_pays_shipping: toNumberOrZero(shippingSummary.seller_shipping_cost) > 0,
  };
};

const dedupeShippingCombos = (combos = []) => {
  const seen = new Map();

  for (const combo of combos) {
    const mode = combo?.shipping_mode || null;
    if (!mode) continue;
    const logistic = normalizeMarketplaceLogisticType(mode, combo?.logistic_type);
    const key = buildShippingComboKey(mode, logistic);
    if (!seen.has(key)) {
      seen.set(key, {
        ...combo,
        shipping_mode: mode,
        logistic_type: logistic,
        is_default: Boolean(combo?.is_default)
      });
      continue;
    }

    const existing = seen.get(key);
    if (!existing.is_default && combo?.is_default) {
      seen.set(key, {
        ...existing,
        is_default: true
      });
    }
  }

  return Array.from(seen.values());
};

const getShippingComboPriority = (combo) => {
  const mode = normalizeMarketplaceShippingValue(combo?.shipping_mode);
  const logisticType = normalizeMarketplaceLogisticType(mode, combo?.logistic_type);
  const resolutionState = normalizeMarketplaceShippingValue(combo?.shipping_resolution_state);
  const isResolved = resolutionState === SHIPPING_RESOLUTION_STATE.RESOLVED;
  const isPartial = resolutionState === SHIPPING_RESOLUTION_STATE.PARTIAL;
  const isDynamic = resolutionState === SHIPPING_RESOLUTION_STATE.DYNAMIC || isDynamicShippingMode(mode);
  const isManual = resolutionState === SHIPPING_RESOLUTION_STATE.MANUAL || isManualShippingMode(mode);
  const isMarketplaceShipping = isMarketplaceShippingMode(mode);

  if (combo?.is_default && isResolved) return 120;
  if (isResolved && isMarketplaceShipping) return 110;
  if (combo?.is_default && isDynamic) return 100;
  if (isDynamic && isMarketplaceShipping) return 90;
  if (combo?.is_default && isPartial) return 80;
  if (isPartial) return 70;
  if (combo?.is_default && isManual) return 60;
  if (isManual) return 50;
  if (logisticType && isMarketplaceShipping) return 40;
  if (logisticType) return 30;
  return 0;
};

const pickBestShippingCombo = (combos = []) => {
  if (!Array.isArray(combos) || combos.length === 0) return null;

  return combos.reduce((best, current) => {
    if (!best) return current;

    const bestPriority = getShippingComboPriority(best);
    const currentPriority = getShippingComboPriority(current);
    if (currentPriority > bestPriority) return current;

    return best;
  }, null);
};

const finalizeShippingCombos = (combos = []) => {
  const dedupedCombos = dedupeShippingCombos(combos);
  const selectedDefault = pickBestShippingCombo(dedupedCombos);

  return dedupedCombos.map((combo) => ({
    ...combo,
    is_default: Boolean(
      selectedDefault &&
      combo.shipping_mode === selectedDefault.shipping_mode &&
      combo.logistic_type === selectedDefault.logistic_type
    )
  }));
};

const selectPreferredShippingCombo = ({
  requestedMode,
  requestedLogisticType,
  availableCombos = [],
  availableModes = []
}) => {
  const combos = finalizeShippingCombos(availableCombos);
  const modes = Array.isArray(availableModes) ? availableModes : [];
  if (combos.length === 0) {
    const requestedModeMatch = requestedMode
      ? modes.find((entry) => entry?.value === requestedMode)
      : null;
    if (requestedModeMatch) {
      return {
        combo: null,
        selection: {
          shipping_mode: requestedModeMatch.value,
          logistic_type: null,
          shipping_resolution_state: requestedModeMatch.shipping_resolution_state || SHIPPING_RESOLUTION_STATE.DYNAMIC,
          shipping_complexity: requestedModeMatch.shipping_complexity || SHIPPING_COMPLEXITY.DYNAMIC,
          shipping_ui: buildShippingUi(
            requestedModeMatch.value,
            null,
            requestedModeMatch.shipping_resolution_state || SHIPPING_RESOLUTION_STATE.DYNAMIC
          )
        },
        warnings: []
      };
    }

    return {
      combo: null,
      selection: null,
      warnings: []
    };
  }

  const pickBestCombo = (list = []) => {
    return pickBestShippingCombo(list);
  };

  if (requestedMode && requestedLogisticType) {
    const exactMatch = combos.find(
      combo =>
        combo.shipping_mode === requestedMode &&
        combo.logistic_type === requestedLogisticType
    );
    if (exactMatch) {
      return {
        combo: exactMatch,
        selection: {
          shipping_mode: exactMatch.shipping_mode,
          logistic_type: exactMatch.logistic_type || null,
          shipping_resolution_state: exactMatch.shipping_resolution_state || SHIPPING_RESOLUTION_STATE.RESOLVED,
          shipping_complexity: exactMatch.shipping_complexity || SHIPPING_COMPLEXITY.AUTOMATED,
          shipping_ui: buildShippingUi(
            exactMatch.shipping_mode,
            exactMatch.logistic_type,
            exactMatch.shipping_resolution_state || SHIPPING_RESOLUTION_STATE.RESOLVED
          )
        },
        warnings: []
      };
    }

    return {
      combo: null,
      selection: null,
      warnings: [`shipping_combo_not_found:${requestedMode}:${requestedLogisticType}`]
    };
  }

  if (requestedMode && !requestedLogisticType) {
    const modeEntry = modes.find((entry) => entry?.value === requestedMode) || null;
    if (modeEntry) {
      return {
        combo: null,
        selection: {
          shipping_mode: requestedMode,
          logistic_type: null,
          shipping_resolution_state: modeEntry.shipping_resolution_state || SHIPPING_RESOLUTION_STATE.DYNAMIC,
          shipping_complexity: modeEntry.shipping_complexity || SHIPPING_COMPLEXITY.DYNAMIC,
          shipping_ui: buildShippingUi(
            requestedMode,
            null,
            modeEntry.shipping_resolution_state || SHIPPING_RESOLUTION_STATE.DYNAMIC
          )
        },
        warnings: []
      };
    }
  }

  const selected = pickBestCombo(combos);
  if (!selected) {
    const fallbackMode = modes.find((entry) => entry?.shipping_resolution_state === SHIPPING_RESOLUTION_STATE.DYNAMIC)
      || modes.find((entry) => entry?.shipping_resolution_state === SHIPPING_RESOLUTION_STATE.PARTIAL)
      || modes.find((entry) => entry?.shipping_resolution_state === SHIPPING_RESOLUTION_STATE.MANUAL)
      || modes[0]
      || null;

    if (fallbackMode) {
      return {
        combo: null,
        selection: {
          shipping_mode: fallbackMode.value,
          logistic_type: null,
          shipping_resolution_state: fallbackMode.shipping_resolution_state || SHIPPING_RESOLUTION_STATE.DYNAMIC,
          shipping_complexity: fallbackMode.shipping_complexity || SHIPPING_COMPLEXITY.DYNAMIC,
          shipping_ui: buildShippingUi(
            fallbackMode.value,
            null,
            fallbackMode.shipping_resolution_state || SHIPPING_RESOLUTION_STATE.DYNAMIC
          )
        },
        warnings: []
      };
    }

    return {
      combo: null,
      selection: null,
      warnings: []
    };
  }

  const warnings = [];
  if (requestedMode && requestedMode !== selected.shipping_mode) {
    warnings.push(`shipping_mode_normalized:${requestedMode}->${selected.shipping_mode}`);
  }
  const normalizedRequestedType = normalizeMarketplaceLogisticType(requestedMode, requestedLogisticType);
  if (requestedLogisticType && normalizedRequestedType !== requestedLogisticType) {
    warnings.push(`logistic_type_normalized:${requestedLogisticType}->${normalizedRequestedType || "none"}`);
  }

  return {
    combo: selected,
    selection: {
      shipping_mode: selected.shipping_mode,
      logistic_type: selected.logistic_type || null,
      shipping_resolution_state: selected.shipping_resolution_state || SHIPPING_RESOLUTION_STATE.RESOLVED,
      shipping_complexity: selected.shipping_complexity || SHIPPING_COMPLEXITY.AUTOMATED,
      shipping_ui: buildShippingUi(
        selected.shipping_mode,
        selected.logistic_type,
        selected.shipping_resolution_state || SHIPPING_RESOLUTION_STATE.RESOLVED
      )
    },
    warnings
  };
};

const inferShippingResolutionStateFromCapabilities = ({ shippingModes = [], shippingCombos = [] }) => {
  const combos = Array.isArray(shippingCombos) ? shippingCombos : [];
  const modes = Array.isArray(shippingModes) ? shippingModes : [];

  if (combos.some((combo) => combo?.shipping_resolution_state === SHIPPING_RESOLUTION_STATE.RESOLVED)) {
    return SHIPPING_RESOLUTION_STATE.RESOLVED;
  }
  if (combos.some((combo) => combo?.shipping_resolution_state === SHIPPING_RESOLUTION_STATE.PARTIAL)) {
    return SHIPPING_RESOLUTION_STATE.PARTIAL;
  }
  if (modes.some((mode) => mode?.shipping_resolution_state === SHIPPING_RESOLUTION_STATE.MANUAL || isManualShippingMode(mode?.value))) {
    return SHIPPING_RESOLUTION_STATE.MANUAL;
  }
  if (modes.some((mode) => mode?.shipping_resolution_state === SHIPPING_RESOLUTION_STATE.DYNAMIC || isDynamicShippingMode(mode?.value))) {
    return SHIPPING_RESOLUTION_STATE.DYNAMIC;
  }
  if (modes.some((mode) => mode?.value === "me2")) {
    return SHIPPING_RESOLUTION_STATE.PARTIAL;
  }
  if (modes.some((mode) => mode?.value === "me1")) {
    return SHIPPING_RESOLUTION_STATE.DYNAMIC;
  }
  if (modes.length === 0 && combos.length === 0) {
    return SHIPPING_RESOLUTION_STATE.UNSUPPORTED;
  }
  return SHIPPING_RESOLUTION_STATE.UNSUPPORTED;
};

const analyzeShippingPackage = (packageData) => {
  if (!packageData || typeof packageData !== "object") return null;

  const extractNumber = (value) => {
    if (value === null || value === undefined) return null;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string") {
      const parsed = Number(value.trim().replace(",", "."));
      return Number.isFinite(parsed) ? parsed : null;
    }
    if (typeof value === "object" && value !== null && "value" in value) {
      return extractNumber(value.value);
    }
    return null;
  };

  const toCm = (dimension) => {
    if (!dimension) return null;
    const value = extractNumber(dimension);
    if (value === null) return null;
    const unit = String(dimension.unit || "cm").toLowerCase();

    switch (unit) {
      case "m": return value * 100;
      case "mm": return value / 10;
      case "in": return value * 2.54;
      case "ft": return value * 30.48;
      default: return value;
    }
  };

  const toGrams = (weightData) => {
    if (!weightData) return null;
    const value = extractNumber(weightData);
    if (value === null) return null;
    const unit = String(weightData.unit || "g").toLowerCase();

    switch (unit) {
      case "kg": return value * 1000;
      case "lb": return value * 453.592;
      case "oz": return value * 28.3495;
      default: return value;
    }
  };

  const data = packageData.package && typeof packageData.package === "object"
    ? packageData.package
    : packageData;
  const dims = data.dimensions && typeof data.dimensions === "object" ? data.dimensions : {};
  const heightCm = toCm(dims.height || dims.alto || dims.altura || data.height_cm || data.height || data.alto || data.altura);
  const widthCm = toCm(dims.width || dims.ancho || data.width_cm || data.width || data.ancho);
  const lengthCm = toCm(dims.length || dims.largo || dims.longitud || dims.depth || data.length_cm || data.length || data.largo || data.longitud || data.depth);
  const weightGrams = toGrams(
    data.weight ??
    data.weight_grams ??
    data.weight_gram ??
    data.weight_g ??
    (data.weight_kg !== undefined && data.weight_kg !== null ? { unit: "kg", value: data.weight_kg } : null)
  );
  const volumetricWeightInputGrams = toGrams(
    data.volumetric_weight ??
    data.volumetric_weight_measurement ??
    data.volumetric_weight_grams ??
    null
  );

  if (![heightCm, widthCm, lengthCm, weightGrams].every(value => Number.isFinite(value) && value > 0)) {
    return null;
  }

  const calculatedVolumetricWeightGrams = (heightCm * widthCm * lengthCm) / 6;
  const volumetricWeightGrams = Number.isFinite(volumetricWeightInputGrams) && volumetricWeightInputGrams > 0
    ? volumetricWeightInputGrams
    : calculatedVolumetricWeightGrams;
  return {
    height_cm: heightCm,
    width_cm: widthCm,
    length_cm: lengthCm,
    weight_grams: weightGrams,
    volumetric_weight_grams: volumetricWeightGrams,
    volumetric_weight_source: Number.isFinite(volumetricWeightInputGrams) && volumetricWeightInputGrams > 0
      ? "input.volumetric_weight"
      : "calculated_from_dimensions",
    calculated_volumetric_weight_grams: calculatedVolumetricWeightGrams,
    billable_weight_grams: Math.max(weightGrams, volumetricWeightGrams),
    volumetric_ratio: volumetricWeightGrams / weightGrams
  };
};

const buildEconomicSummary = ({
  productId,
  categoryId,
  categoryName,
  listingTypeId,
  strategy,
  price,
  pricing,
  resolvedInstallments,
  sellerShippingView,
  profitability,
  economicInputs,
  warnings
}) => {
  if (!Number.isFinite(Number(price)) || !pricing || pricing.error) return null;

  return {
    product_id: productId,
    category_id: categoryId,
    category_name: categoryName,
    listing_type_id: listingTypeId,
    strategy,
    price: Number(price),
    fees: {
      sale_fee_amount: toNumberOrZero(pricing.sale_fee_amount),
      listing_fee_amount: toNumberOrZero(pricing.listing_fee_amount),
      total_fee_amount: toNumberOrZero(pricing.total_fee_amount),
      fee_percentage: toNumberOrZero(pricing.fee_percentage)
    },
    installments: {
      enabled: Boolean(resolvedInstallments?.enabled),
      interest_free: Boolean(resolvedInstallments?.interest_free),
      max_installments: resolvedInstallments?.max_installments ?? null,
      seller_fee_focus: true
    },
    shipping: sellerShippingView ? {
      shipping_mode: sellerShippingView.shipping_mode,
      logistic_type: sellerShippingView.logistic_type,
      free_shipping: sellerShippingView.free_shipping,
      mandatory_free_shipping: sellerShippingView.mandatory_free_shipping,
      seller_shipping_cost: toNumberOrZero(sellerShippingView.seller_shipping_cost),
      shipping_subsidy: toNumberOrZero(sellerShippingView.shipping_subsidy)
    } : null,
    net: {
      net_amount_before_shipping: toNumberOrZero(pricing.net_amount),
      net_amount_after_shipping: pricing.net_amount_after_shipping !== undefined && pricing.net_amount_after_shipping !== null
        ? toNumberOrZero(pricing.net_amount_after_shipping)
        : toNumberOrZero(pricing.net_amount)
    },
    profitability: profitability ? {
      product_cost: profitability.product_cost_basis,
      total_cost_basis: profitability.total_cost_basis ?? null,
      estimated_profit: profitability.final_profit,
      margin_percent: profitability.real_margin_percentage
    } : {
      product_cost: null,
      total_cost_basis: null,
      estimated_profit: null,
      margin_percent: null
    },
    economic_inputs: economicInputs || null,
    warnings: Array.isArray(warnings) ? warnings : []
  };
};

const OAuthController = {
async mercadoLibreCallback(req, res) {
  const { code, state } = req.body;
  logger.info("Datos recibidos actualizar las credenciales de mercado libre:");
  logger.info(JSON.stringify(req.body));
  const metadata = getRequestMetadata(req);
  let credentialIdForCleanup = null;

  if (!code || !state) {
    logger.warn("OAuth callback sin code o state");
    return res.status(400).json({ error: 'Datos incompletos: se requieren "code" y "state"' });
  }

  try {
    // ✅ Parsear state legado y nuevo (formato nuevo: marketplaceId_companyId_userId_credentialId)
    const stateParts = state.split("_");
    const marketplaceId = stateParts[0];
    const companyId = stateParts.length >= 4 ? Number(stateParts[1]) : null;
    const userId = stateParts.length >= 4 ? stateParts[2] : stateParts[1];
    const credentialId = stateParts.length >= 4 ? stateParts[3] : stateParts[2];

    credentialIdForCleanup = credentialId; 
    
    // ✅ Buscar credencial específica por ID
    const credential = credentialId 
      ? await MarketplaceCredentialRepository.findById(credentialId)
      : companyId
        ? await MarketplaceCredentialRepository.findByMarketplaceAndCompany(marketplaceId, companyId)
        : await MarketplaceCredentialRepository.findByMarketplaceAndUser(marketplaceId, userId);

    logger.info("Credenciales básicas obtenidas para OAuth Mercado Libre");
    logger.info(JSON.stringify(credential));

    const marketplace = credential?.marketplace || credential || {};

    if (!credential || !marketplace.client_id || !marketplace.client_secret) {
      throw new Error("Credenciales OAuth incompletas en la base de datos");
    }

    if (companyId && Number(credential.company_id) !== Number(companyId)) {
      throw new Error("La credencial no corresponde a la empresa indicada");
    }

    // ✅ URL oficial de tokens (sin espacios)
    const oauthTokenUrl = "https://api.mercadolibre.com/oauth/token";

    logger.info("[OAuth] Enviando solicitud a Mercado Libre");

    // ✅ Obtener tokens
    const tokenRes = await axios.post(
      oauthTokenUrl,
      qs.stringify({
        grant_type: "authorization_code",
        client_id: marketplace.client_id,
        client_secret: marketplace.client_secret,
        code: code,
        redirect_uri: marketplace.redirect_uri.trim(),
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      },
    );

    logger.info("[OAuth] Tokens recibidos correctamente");

    if (!tokenRes.data.access_token || !tokenRes.data.refresh_token) {
      throw new Error(
        "Respuesta de Mercado Libre no contiene access_token o refresh_token",
      );
    }

    // ✅ NUEVO: Obtener datos del usuario de ML para validar duplicados
    const mlUserRes = await axios.get("https://api.mercadolibre.com/users/me", {
      headers: { Authorization: `Bearer ${tokenRes.data.access_token}` },
      timeout: 5000,
    });

    const mlUserId = mlUserRes.data?.id;
    
    if (!mlUserId) {
      throw new Error("No se pudo obtener el ID del usuario de MercadoLibre");
    }

    logger.info(`[OAuth] ML User ID obtenido: ${mlUserId}`);

    const allCredentials = companyId
      ? await MarketplaceCredentialRepository.findByCompany(companyId)
      : await MarketplaceCredentialRepository.findByUser(userId);

    function getMLUserIdFromCredential(cred) {
  if (!cred.additional_data) return null;
  
  // Si ya es objeto (depende de configuración de Sequelize)
  if (typeof cred.additional_data === 'object') {
    return cred.additional_data.ml_user_id;
  }
  
  // Si es string JSON, parsearlo
  try {
    const parsed = JSON.parse(cred.additional_data);
    return parsed?.ml_user_id;
  } catch (e) {
    return null;
  }
}
    
    // Filtrar las que son de este marketplace y tienen el mismo ml_user_id
    const duplicateCredential = allCredentials.find(c => 
      c.marketplace_id === Number(marketplaceId) &&
      c.id !== credential.id &&  // Excluir la credencial actual
      getMLUserIdFromCredential(c) === mlUserId  // Mismo usuario de ML
    );

    if (duplicateCredential && (duplicateCredential.active === false || Number(duplicateCredential.active) === 0)) {
      logger.info(`[OAuth] Reconectando credencial historica ${duplicateCredential.id} para ML user ${mlUserId}`);

      const duplicateAdditionalData = duplicateCredential.additional_data || {};
      const originalName = duplicateAdditionalData.original_name || duplicateCredential.name;
      const reconnectedAdditionalData = {
        ...duplicateAdditionalData,
        ml_user_id: mlUserId,
        connection_status: 'connected',
        reconnected_at: new Date().toISOString()
      };

      try {
        await MarketplaceCredentialRepository.deleteById(credential.id);
        logger.info(`[OAuth] Credencial temporal ${credential.id} eliminada tras reconectar historica ${duplicateCredential.id}`);
      } catch (deleteError) {
        logger.error('[OAuth] Error eliminando credencial temporal tras reconexion:', deleteError.message);
        throw deleteError;
      }

      await MarketplaceCredentialRepository.updatePartial(duplicateCredential.id, {
        name: originalName,
        access_token: tokenRes.data.access_token,
        refresh_token: tokenRes.data.refresh_token,
        expires_at: new Date(Date.now() + tokenRes.data.expires_in * 1000),
        active: true,
        additional_data: reconnectedAdditionalData
      });

      await LogRepository.create({
        user_id: userId,
        action: "oauth.mercadolibre.reconnect",
        description: `Credencial historica reconectada para ML user ${mlUserId}`,
        ip_address: metadata.ip_address,
        user_agent: metadata.user_agent,
        status: "success",
        meta: {
          marketplace_id: marketplaceId,
          credential_id: duplicateCredential.id,
          temporary_credential_id: credential.id,
          ml_user_id: mlUserId
        },
      });

      credentialIdForCleanup = null;
      return res.status(200).json({
        success: true,
        message: "Cuenta de Mercado Libre reconectada correctamente",
        data: {
          marketplace_id: marketplaceId,
          credential_id: duplicateCredential.id,
          ml_user_id: mlUserId,
          reconnected: true,
          access_token: "[REDACTADO]",
          refresh_token: "[REDACTADO]",
          expires_in: tokenRes.data.expires_in,
        },
      });
    }

    if (duplicateCredential) {
      logger.warn(`[OAuth] DUPLICADO DETECTADO: ML user ${mlUserId} ya existe en credencial ${duplicateCredential.id}`);
      
      // ✅ ELIMINAR la credencial en proceso (la que se está creando)
      // ELIMINAR la credencial en proceso (la que se está creando)
      try {
        await MarketplaceCredentialRepository.deleteById(credential.id);
        logger.info(`[OAuth] Credencial ${credential.id} eliminada por duplicado`);
      } catch (deleteError) {
        logger.error('[OAuth] Error eliminando credencial duplicada:', deleteError.message);
      }

      return res.status(409).json({
        success: false,
        error: "duplicate_ml_account",
        message: `Ya tienes una conexión con esta cuenta de MercadoLibre (Usuario ML: ${mlUserId}). Nombre de conexión existente: "${duplicateCredential.name}"`,
        existing_credential: {
          id: duplicateCredential.id,
          name: duplicateCredential.name,
          country: duplicateCredential.country,
          ml_user_id: mlUserId
        }
      });
    }


    // ✅ No hay duplicado: guardar tokens + ml_user_id en additional_data
    const updatedAdditionalData = {
      ...(credential.additional_data || {}),
      ml_user_id: mlUserId  // ← Guardar ID de usuario de ML
    };

    await MarketplaceCredentialRepository.updatePartial(credential.id, {
      access_token: tokenRes.data.access_token,
      refresh_token: tokenRes.data.refresh_token,
      expires_at: new Date(Date.now() + tokenRes.data.expires_in * 1000),
      additional_data: updatedAdditionalData  // ← NUEVO: Incluir ml_user_id
    });

    await LogRepository.create({
      user_id: userId,
      action: "oauth.mercadolibre.success",
      description: `Tokens guardados para ML user ${mlUserId}`,
      ip_address: metadata.ip_address,
      user_agent: metadata.user_agent,
      status: "success",
      meta: { 
        marketplace_id: marketplaceId,
        credential_id: credential.id,
        ml_user_id: mlUserId
      },
    });
    credentialIdForCleanup = null;
    return res.status(200).json({
      success: true,
      message: "Tokens de Mercado Libre guardados correctamente",
      data: {
        marketplace_id: marketplaceId,
        credential_id: credential.id,
        ml_user_id: mlUserId,  // ← NUEVO: Para referencia del frontend
        access_token: "[REDACTADO]",
        refresh_token: "[REDACTADO]",
        expires_in: tokenRes.data.expires_in,
      },
    });

  } catch (error) {
    logger.error("OAuth callback error:", {
      message: error.message,
      stack: error.stack,
      code: req.body.code?.substring(0, 10),
      state: req.body.state,
    });

     if (credentialIdForCleanup) {
      try {
        const cred = await MarketplaceCredentialRepository.findById(credentialIdForCleanup);
        // Solo eliminar si NO tiene access_token (está pendiente de OAuth)
        if (cred && !cred.access_token) {
          await MarketplaceCredentialRepository.deleteById(credentialIdForCleanup);
          logger.info(`[OAuth] Credencial huérfana eliminada: ${credentialIdForCleanup}`);
        }
      } catch (deleteError) {
        logger.error('[OAuth] Error limpiando credencial huérfana:', deleteError.message);
      }
    }

    await LogRepository.create({
      user_id: req.body.userId,
      action: "oauth.mercadolibre.error",
      description: `Error en OAuth: ${error.message}`,
      ip_address: metadata.ip_address,
      user_agent: metadata.user_agent,
      status: "error",
      meta: { error: error.message },
    });

    return res.status(500).json({
      success: false,
      error: error.message || "Error interno al procesar el callback de Mercado Libre",
    });
  }
},
  async mercadoLibreCategory(req, res) {
    const {
      productName,
      site_id,
      marketplace_id,
      user_id: bodyUserId,
    } = req.body;
    const user_id = bodyUserId || getUserId();
    logger.info(
      "Datos recibidos al optener ls categorías de un producto en mercado libre:",
    );
    logger.info(JSON.stringify(req.body));

    try {
      const credential =
        await MarketplaceCredentialRepository.findByMarketplaceAndUser(
          marketplace_id,
          user_id,
        );
      logger.info("Credenciales básicas obtenidas para OAuth Mercado Libre");
      logger.info(JSON.stringify(credential));

      const domainDiscoveryUrl = `https://api.mercadolibre.com/sites/${site_id}/domain_discovery/search`;
      const response = await axios.get(domainDiscoveryUrl, {
        params: { q: productName, limit: 8 }, //,
        //headers: { Authorization: `Bearer ${credential.access_token}` }
      });

      return res.status(200).json({
        success: true,
        categories: response.data,
      });
    } catch (error) {
      logger.error("OAuth Category error:", {
        message: error.message,
        stack: error.stack,
      });

      return res.status(500).json({
        success: false,
        error:
          error.message ||
          "Error interno al obtener las categorías de Mercado Libre",
      });
    }
  },

  async mercadoLibreAttributes(req, res) {
    const { category_id, marketplace_id, user_id: bodyUserId } = req.body;
    const user_id = bodyUserId || getUserId();
    logger.info(
      "Datos recibidos al optener los atributos de una categoría en mercado libre:",
    );
    logger.info(JSON.stringify(req.body));

    try {
      const credential =
        await MarketplaceCredentialRepository.findByMarketplaceAndUser(
          marketplace_id,
          user_id,
        );
      logger.info("Credenciales básicas obtenidas para OAuth Mercado Libre");
      logger.info(JSON.stringify(credential));

      const domainCategoriesUrl = `https://api.mercadolibre.com/categories/${category_id}/attributes`;
      const response = await axios.get(domainCategoriesUrl, {
        headers: { Authorization: `Bearer ${credential.access_token}` },
      });

      return res.status(200).json({
        success: true,
        attributes: response.data,
      });
    } catch (error) {
      logger.error("OAuth Category error:", {
        message: error.message,
        stack: error.stack,
      });

      return res.status(500).json({
        success: false,
        error:
          error.message ||
          "Error interno al obtener los atributos de Mercado Libre",
      });
    }
  },

  async mercadoLibreCategoryStructure(req, res) {
    const { category_id, credential_id } = req.body;
    const user_id = getUserId();
    logger.info(
      "Datos recibidos para obtener la estructura completa de una categoría en Mercado Libre:",
    );
    logger.info(JSON.stringify(req.body));

    try {
      if (!credential_id) {
        return res.status(400).json({
          success: false,
          error: "credential_id es requerido",
        });
      }

      const credential = await MarketplaceCredentialRepository.findById(credential_id);

      if (!credential) {
        return res.status(404).json({
          success: false,
          error: "Credencial no encontrada",
        });
      }

      if (credential.user_id !== user_id) {
        return res.status(403).json({
          success: false,
          error: "No autorizado",
        });
      }

      const site_id = getMercadoLibreSiteId(credential.marketplace?.domain);
      const cacheNamespace = `ml_site_${site_id}`;

      const buildStructuredCategoryNode = async (categoryInput, ancestry = new Set()) => {
        const categoryId = String(categoryInput?.id || categoryInput?.category_id || '').trim();
        const categoryNameHint = String(categoryInput?.name || categoryInput?.category_name || '').trim();

        if (!categoryId) return null;
        if (ancestry.has(categoryId)) return null;

        const cachedCategoryDetail = getFromCache(cacheNamespace, 'category_structure_v3', categoryId);
        if (cachedCategoryDetail) {
          return cachedCategoryDetail;
        }

        try {
          const [attributesResponse, detailResponse] = await Promise.all([
            axios.get(`https://api.mercadolibre.com/categories/${categoryId}/attributes`, {
              headers: { Authorization: `Bearer ${credential.access_token}` },
              timeout: 30000
            }),
            axios.get(`https://api.mercadolibre.com/categories/${categoryId}`, {
              headers: { Authorization: `Bearer ${credential.access_token}` },
              timeout: 30000
            })
          ]);

          const detail = detailResponse.data || {};
          const categoryName = String(detail.name || categoryNameHint || '').trim() || categoryId;
          const pathFromRoot = Array.isArray(detail.path_from_root) && detail.path_from_root.length > 0
            ? detail.path_from_root
                .map((entry) => ({
                  id: entry?.id || null,
                  name: String(entry?.name || '').trim()
                }))
                .filter((entry) => entry.id && entry.name)
            : [{
                id: categoryId,
                name: categoryName
              }];

          const searchText = [
            categoryName,
            Array.isArray(pathFromRoot)
              ? pathFromRoot.map((entry) => entry?.name).filter(Boolean).join(' ')
              : ''
          ]
            .filter(Boolean)
            .join(' ')
            .trim();

          const nextAncestry = new Set(ancestry);
          nextAncestry.add(categoryId);

          const children_categories = Array.isArray(detail.children_categories)
            ? detail.children_categories
                .map((childRef) => {
                  const childId = String(childRef?.id || childRef?.category_id || '').trim();
                  const childName = String(childRef?.name || childRef?.category_name || '').trim();

                  if (!childId || !childName) return null;
                  if (nextAncestry.has(childId)) return null;

                  const childPathFromRoot = [
                    ...pathFromRoot,
                    {
                      id: childId,
                      name: childName
                    }
                  ];

                  return {
                    category_id: childId,
                    category_name: childName,
                    domain_id: childRef?.domain_id || null,
                    domain_name: childRef?.domain_name || null,
                    path: childPathFromRoot.map((entry) => entry.name).filter(Boolean).join(' > '),
                    search_text: [
                      childName,
                      childPathFromRoot.map((entry) => entry.name).filter(Boolean).join(' ')
                    ]
                      .filter(Boolean)
                      .join(' ')
                      .trim(),
                    attributes: [],
                    path_from_root: childPathFromRoot,
                    children_categories: [],
                    category_settings: {},
                    attributable: null,
                    date_created: null,
                    picture: null,
                    permalink: null,
                    total_items_in_this_category: null
                  };
                })
                .filter(Boolean)
            : [];

          const structuredCategory = {
            category_id: categoryId,
            category_name: categoryName,
            domain_id: detail.domain_id || categoryInput?.domain_id || null,
            domain_name: detail.domain_name || categoryInput?.domain_name || null,
            path: Array.isArray(pathFromRoot) && pathFromRoot.length > 0
              ? pathFromRoot.map((entry) => entry.name).filter(Boolean).join(' > ')
              : categoryName,
            search_text: searchText,
            attributes: Array.isArray(attributesResponse.data) ? attributesResponse.data : [],
            path_from_root: pathFromRoot,
            children_categories,
            category_settings: detail.settings || {},
            attributable: detail.attributable ?? null,
            date_created: detail.date_created || null,
            picture: detail.picture || null,
            permalink: detail.permalink || null,
            total_items_in_this_category: detail.total_items_in_this_category ?? null
          };

          saveToCache(cacheNamespace, 'category_structure_v3', categoryId, structuredCategory, 86400);
          return structuredCategory;
        } catch (error) {
          logger.warn(`No se pudo obtener la estructura de la categoría ${categoryId} en site ${site_id}: ${error.message}`);

          const fallbackCategory = {
            category_id: categoryId,
            category_name: categoryNameHint || categoryId,
            domain_id: categoryInput?.domain_id || null,
            domain_name: categoryInput?.domain_name || null,
            path: categoryNameHint || categoryId,
            search_text: categoryNameHint || categoryId,
            attributes: [],
            path_from_root: [{
              id: categoryId,
              name: categoryNameHint || categoryId
            }],
            children_categories: [],
            category_settings: {},
            attributable: null,
            date_created: null,
            picture: null,
            permalink: null,
            total_items_in_this_category: null
          };

          saveToCache(cacheNamespace, 'category_structure_v3', categoryId, fallbackCategory, 86400);
          return fallbackCategory;
        }
      };

      const categoryStructure = await buildStructuredCategoryNode({ id: category_id });

      return res.status(200).json({
        success: true,
        category: categoryStructure
      });
    } catch (error) {
      logger.error("OAuth Category structure error:", {
        message: error.message,
        stack: error.stack,
      });

      return res.status(500).json({
        success: false,
        error:
          error.message ||
          "Error interno al obtener la estructura de la categoría de Mercado Libre",
      });
    }
  },

/**
 * Convertir dimensiones del formato del frontend al formato de la API de MercadoLibre
 * API ML espera: "HeightxWidthxLength,Weight" - TODOS ENTEROS, en cm y gramos
 * 
 * @param {Object} packageData - Datos del paquete desde el frontend
 * @param {Object} [options] - Opciones de parseo
 * @param {boolean} [options.strict=true] - Si es false, completa faltantes con defaults en vez de lanzar error
 * @param {Object} [options.defaults] - Defaults cuando faltan datos (en cm y gramos)
 * @param {number} [options.defaults.height_cm=1]
 * @param {number} [options.defaults.width_cm=1]
 * @param {number} [options.defaults.length_cm=1]
 * @param {number} [options.defaults.weight_grams=1]
 * @returns {String} Dimensiones en formato "15x8x22,320"
 */
formatDimensionsForAPI(packageData, options = {}) {
  const strict = options?.strict !== false;
  const defaults = options?.defaults || {};
  const defaultHeightCm = Number.isFinite(Number(defaults.height_cm)) ? Number(defaults.height_cm) : 1;
  const defaultWidthCm = Number.isFinite(Number(defaults.width_cm)) ? Number(defaults.width_cm) : 1;
  const defaultLengthCm = Number.isFinite(Number(defaults.length_cm)) ? Number(defaults.length_cm) : 1;
  const defaultWeightGrams = Number.isFinite(Number(defaults.weight_grams)) ? Number(defaults.weight_grams) : 1;

  // Helper para extraer número de cualquier formato
  const extractNumber = (value) => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') {
      const num = Number(value.trim().replace(',', '.'));
      return Number.isFinite(num) ? num : null;
    }
    if (typeof value === 'object' && value !== null && 'value' in value) {
      return extractNumber(value.value);
    }
    return null;
  };

  // Helper para convertir a cm (siempre retorna número)
  const toCm = (dimension) => {
    if (!dimension) return null;
    const value = extractNumber(dimension);
    if (value === null) return null;
    const unit = (dimension.unit || dimension.unit || 'cm')?.toLowerCase();
    
    switch(unit) {
      case 'm': return value * 100;
      case 'mm': return value / 10;
      case 'in': return value * 2.54;
      case 'ft': return value * 30.48;
      case 'cm':
      default: return value;
    }
  };

  // Helper para convertir a gramos (siempre retorna número)
  const toGrams = (weightData) => {
    if (!weightData) return null;
    const value = extractNumber(weightData);
    if (value === null) return null;
    const unit = (weightData.unit || weightData.unit || 'g')?.toLowerCase();
    
    switch(unit) {
      case 'kg': return value * 1000;
      case 'lb': return value * 453.592;
      case 'oz': return value * 28.3495;
      case 'g':
      default: return value;
    }
  };

  if (!packageData) {
    if (strict) throw new Error('Package data is required');
    logger.warn(`[Dimensions] Package data ausente, usando defaults: ${defaultHeightCm}x${defaultWidthCm}x${defaultLengthCm},${defaultWeightGrams}`);
    const h = Math.max(1, Math.ceil(defaultHeightCm));
    const w = Math.max(1, Math.ceil(defaultWidthCm));
    const l = Math.max(1, Math.ceil(defaultLengthCm));
    const wt = Math.max(1, Math.ceil(defaultWeightGrams));
    return `${h}x${w}x${l},${wt}`;
  }

  // Aceptar shape { package: {...} } por si llega envuelto
  if (packageData.package && typeof packageData.package === 'object') {
    packageData = packageData.package;
  }

  // Aceptar string preformateado "HxWxL,Weight"
  const dimensionsString =
    (typeof packageData.dimensions === 'string' && packageData.dimensions) ||
    (typeof packageData.dimensions_string === 'string' && packageData.dimensions_string) ||
    (typeof packageData.ml_dimensions === 'string' && packageData.ml_dimensions);

  if (dimensionsString) {
    const cleaned = dimensionsString.trim();
    const [dimPart, weightPart] = cleaned.split(',').map((s) => s.trim());
    if (dimPart && weightPart) {
      const parts = dimPart.split(/x/i).map((s) => extractNumber(s.trim())).filter((n) => n !== null);
      const weightParsed = extractNumber(weightPart);
      if (parts.length === 3 && weightParsed !== null) {
        const [hRaw, wRaw, lRaw] = parts;
        const h = Math.max(1, Math.ceil(hRaw));
        const w = Math.max(1, Math.ceil(wRaw));
        const l = Math.max(1, Math.ceil(lRaw));
        const wt = Math.max(1, Math.ceil(weightParsed));
        return `${h}x${w}x${l},${wt}`;
      }
    }
  }

  const dims = (packageData.dimensions && typeof packageData.dimensions === 'object') ? packageData.dimensions : {};
  const weightData =
    packageData.weight ??
    packageData.weight_grams ??
    packageData.weight_gram ??
    packageData.weight_g ??
    packageData.peso_grams ??
    packageData.peso_g ??
    (packageData.weight_kg !== undefined && packageData.weight_kg !== null ? { unit: 'kg', value: packageData.weight_kg } : null) ??
    (packageData.peso_kg !== undefined && packageData.peso_kg !== null ? { unit: 'kg', value: packageData.peso_kg } : null);

  // Extraer dimensiones en cm
  const heightCm = toCm(
    dims.height || dims.alto || dims.altura ||
    packageData.height_cm || packageData.alto_cm || packageData.altura_cm ||
    packageData.height || packageData.alto || packageData.altura
  );
  const widthCm = toCm(
    dims.width || dims.ancho ||
    packageData.width_cm || packageData.ancho_cm ||
    packageData.width || packageData.ancho
  );
  const lengthCm = toCm(
    dims.length || dims.largo || dims.longitud || dims.depth || dims.profundidad ||
    packageData.length_cm || packageData.largo_cm || packageData.longitud_cm || packageData.depth_cm || packageData.profundidad_cm ||
    packageData.length || packageData.largo || packageData.longitud || packageData.depth || packageData.profundidad
  );
  
  // Extraer peso en gramos
  const weightGrams = toGrams(weightData);

  // Validar que todos los valores existan
  const missing = [];
  if (heightCm === null) missing.push('height');
  if (widthCm === null) missing.push('width');
  if (lengthCm === null) missing.push('length');
  if (weightGrams === null) missing.push('weight');

  if (missing.length) {
    if (strict) {
      throw new Error(
        `Missing required dimensions: ${missing.join(', ')}. ` +
        `Accepted shapes: {package:{height_cm,width_cm,length_cm,weight_grams}} or {package:{dimensions:{height,width,length},weight}}`
      );
    }

    const heightFallback = heightCm ?? defaultHeightCm;
    const widthFallback = widthCm ?? defaultWidthCm;
    const lengthFallback = lengthCm ?? defaultLengthCm;
    const weightFallback = weightGrams ?? defaultWeightGrams;

    logger.warn(
      `[Dimensions] Faltan datos (${missing.join(', ')}), usando defaults para MercadoLibre: ` +
      `${heightFallback}x${widthFallback}x${lengthFallback},${weightFallback}`
    );

    const h = Math.max(1, Math.ceil(heightFallback));
    const w = Math.max(1, Math.ceil(widthFallback));
    const l = Math.max(1, Math.ceil(lengthFallback));
    const wt = Math.max(1, Math.ceil(weightFallback));
    return `${h}x${w}x${l},${wt}`;
  }

  // ✅ IMPORTANTE: Redondear TODOS los valores a enteros (ML API lo requiere)
  const h = Math.max(1, Math.ceil(heightCm));
  const w = Math.max(1, Math.ceil(widthCm));
  const l = Math.max(1, Math.ceil(lengthCm));
  const wt = Math.max(1, Math.ceil(weightGrams));

  // Formato exacto que espera ML: "HeightxWidthxLength,Weight" (sin espacios)
  return `${h}x${w}x${l},${wt}`;
},
/**
 * Convertir unidad a centímetros
 */
convertToCm(dimension) {
  const coerceNumber = (value) => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return null;
      const num = Number(trimmed.replace(',', '.'));
      return Number.isFinite(num) ? num : null;
    }
    if (typeof value === 'object' && value !== null && 'value' in value) {
      return coerceNumber(value.value);
    }
    return null;
  };

  if (dimension === null || dimension === undefined) return null;

  if (typeof dimension === 'number' || typeof dimension === 'string') {
    const value = coerceNumber(dimension);
    return value === null ? null : value;
  }

  const value = coerceNumber(dimension.value);
  const unit = (dimension.unit || 'cm')?.toLowerCase();

  if (value === null) return null;
  
  switch(unit) {
    case 'm': return value * 100;
    case 'mm': return value / 10;
    case 'in': return value * 2.54;
    case 'ft': return value * 30.48;
    case 'cm':
    default: return value;
  }
},

/**
 * Convertir unidad a gramos
 */
convertToGrams(weightData) {
  const coerceNumber = (value) => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return null;
      const num = Number(trimmed.replace(',', '.'));
      return Number.isFinite(num) ? num : null;
    }
    if (typeof value === 'object' && value !== null && 'value' in value) {
      return coerceNumber(value.value);
    }
    return null;
  };

  if (weightData === null || weightData === undefined) return null;

  if (typeof weightData === 'number' || typeof weightData === 'string') {
    const value = coerceNumber(weightData);
    return value === null ? null : value;
  }

  const value = coerceNumber(weightData.value);
  const unit = (weightData.unit || 'g')?.toLowerCase();

  if (value === null) return null;
  
  switch(unit) {
    case 'kg': return value * 1000;
    case 'lb': return value * 453.592;
    case 'oz': return value * 28.3495;
    case 'g':
    default: return value;
  }
},

/**
 * Calcular costos de envío para un producto en MercadoLibre
 * @param {Object} credential - Credencial de MercadoLibre
 * @param {Object} product - Producto con price, package, etc.
 * @param {String} categoryId - ID de la categoría
 * @param {String} siteId - Site ID (MLA, MLC, etc.)
 * @param {String} listingType - Tipo de publicación (gold_special, etc.)
 * @returns {Object} Costos de envío (quién paga y cuánto)
 */
async calculateMercadoLibreShippingCosts(credential, product, categoryId, siteId, listingType = 'gold_special', logistic_type, shipping_mode, options = {}) {
  const getCurrencyIdFromSite = (site) => {
    switch (String(site || '').toUpperCase()) {
      case 'MLC': return 'CLP';
      case 'MLA': return 'ARS';
      case 'MLB': return 'BRL';
      case 'MCO': return 'COP';
      case 'MLM': return 'MXN';
      case 'MLU': return 'UYU';
      case 'MLV': return 'VES';
      case 'MPE': return 'PEN';
      case 'MEC': return 'USD';
      case 'MGT': return 'GTQ';
      case 'MHN': return 'HNL';
      case 'MNI': return 'NIO';
      case 'MSV': return 'USD';
      case 'MCU': return 'CUP';
      case 'MPY': return 'PYG';
      case 'MBO': return 'BOB';
      case 'MCR': return 'CRC';
      case 'MPA': return 'PAB';
      case 'MRD': return 'DOP';
      default: return 'ARS';
    }
  };

  const {
    baseParams,
    itemId,
    zipCode,
    requestedFreeShipping
  } = buildMercadoLibreShippingBaseParams({
    product,
    categoryId,
    listingType,
    shippingMode: shipping_mode,
    logisticType: logistic_type
  });
  const mlUserId = await resolveMercadoLibreUserIdForCredential(credential);
  const bypassCache = Boolean(options?.bypassCache);

  if (!mlUserId) {
    const currencyId = getCurrencyIdFromSite(siteId);
    const errMsg = 'No se pudo determinar el ml_user_id para calcular shipping (falta additional_data.ml_user_id).';
    logger.error(errMsg, { site_id: siteId, category_id: categoryId, credential_id: credential?.id });
    const fallback = {
      buyer_pays: { cost: 0, currency_id: currencyId, paid_by: 'buyer', error: errMsg },
      seller_pays: { cost: 0, currency_id: currencyId, paid_by: 'seller', error: errMsg }
    };
    const normalized = normalizeShippingScenarios({
      shippingMode: baseParams.mode,
      logisticType: baseParams.logistic_type,
      buyerPays: fallback.buyer_pays,
      sellerPays: fallback.seller_pays,
      requestedFreeShipping,
      mandatoryFreeShipping: false
    });
    return { ...fallback, ...normalized, requested_free_shipping: requestedFreeShipping, warning: errMsg };
  }

  if (!baseParams.dimensions && !baseParams.item_id) {
    const currencyId = getCurrencyIdFromSite(siteId);
    const errMsg = 'No se puede calcular shipping: faltan dimensions o item_id.';
    const fallback = {
      buyer_pays: { cost: 0, currency_id: currencyId, paid_by: 'buyer', error: errMsg },
      seller_pays: { cost: 0, currency_id: currencyId, paid_by: 'seller', error: errMsg }
    };
    const normalized = normalizeShippingScenarios({
      shippingMode: baseParams.mode,
      logisticType: baseParams.logistic_type,
      buyerPays: fallback.buyer_pays,
      sellerPays: fallback.seller_pays,
      requestedFreeShipping,
      mandatoryFreeShipping: false
    });
    return { ...fallback, ...normalized, requested_free_shipping: requestedFreeShipping, warning: errMsg };
  }

  try {
    let actualItemShippingOption = null;
    if (itemId && zipCode) {
      try {
        /*logger.info(`[ML ENDPOINT TRACE] shipping.item_shipping_options.request`, {
          endpoint: `https://api.mercadolibre.com/items/${itemId}/shipping_options`,
          method: "GET",
          item_id: itemId,
          category_id: categoryId,
          params: { zip_code: zipCode }
        });*/
        const shippingOptionsResponse = await axios.get(
          `https://api.mercadolibre.com/items/${itemId}/shipping_options`,
          {
            params: { zip_code: zipCode },
            headers: { Authorization: `Bearer ${credential.access_token}` },
            timeout: 15000
          }
        );
        /*logger.info(`[ML ENDPOINT TRACE] shipping.item_shipping_options.response`, {
          endpoint: `https://api.mercadolibre.com/items/${itemId}/shipping_options`,
          method: "GET",
          item_id: itemId,
          category_id: categoryId,
          response: shippingOptionsResponse.data
        });*/
        actualItemShippingOption = Array.isArray(shippingOptionsResponse.data?.options)
          ? shippingOptionsResponse.data.options[0] || null
          : null;
      } catch (shippingOptionsErr) {
        logger.warn(`[ML] No se pudo obtener shipping_options para item ${itemId} y zip ${zipCode}: ${shippingOptionsErr.message}`);
      }
    }

    // Consulta 1: Comprador paga el envío
    /*logger.info(`[ML ENDPOINT TRACE] shipping.user_shipping_options_buyer.request`, {
      endpoint: `https://api.mercadolibre.com/users/${mlUserId}/shipping_options/free`,
      method: "GET",
      user_id: mlUserId,
      category_id: categoryId,
      params: { ...baseParams, free_shipping: false }
    });*/
    const buyerPaysResponse = await axios.get(
      `https://api.mercadolibre.com/users/${mlUserId}/shipping_options/free`,
      {
        params: { ...baseParams, free_shipping: false },
        headers: { Authorization: `Bearer ${credential.access_token}` },
        timeout: 15000
      }
    );
    /*logger.info(`[ML ENDPOINT TRACE] shipping.user_shipping_options_buyer.response`, {
      endpoint: `https://api.mercadolibre.com/users/${mlUserId}/shipping_options/free`,
      method: "GET",
      user_id: mlUserId,
      category_id: categoryId,
      response: buyerPaysResponse.data
    });*/

    // Consulta 2: Vendedor ofrece envío gratis (vende paga)
    /*logger.info(`[ML ENDPOINT TRACE] shipping.user_shipping_options_seller.request`, {
      endpoint: `https://api.mercadolibre.com/users/${mlUserId}/shipping_options/free`,
      method: "GET",
      user_id: mlUserId,
      category_id: categoryId,
      params: { ...baseParams, free_shipping: true }
    });*/
    const sellerPaysResponse = await axios.get(
      `https://api.mercadolibre.com/users/${mlUserId}/shipping_options/free`,
      {
        params: { ...baseParams, free_shipping: true },
        headers: { Authorization: `Bearer ${credential.access_token}` },
        timeout: 15000
      }
    );
    /*logger.info(`[ML ENDPOINT TRACE] shipping.user_shipping_options_seller.response`, {
      endpoint: `https://api.mercadolibre.com/users/${mlUserId}/shipping_options/free`,
      method: "GET",
      user_id: mlUserId,
      category_id: categoryId,
      response: sellerPaysResponse.data
    });*/

    const buyerCoverage = buyerPaysResponse.data?.coverage?.all_country || {};
    const sellerCoverage = sellerPaysResponse.data?.coverage?.all_country || {};
    const buyerTags = Array.isArray(buyerPaysResponse.data?.tags) ? buyerPaysResponse.data.tags : [];
    const sellerTags = Array.isArray(sellerPaysResponse.data?.tags) ? sellerPaysResponse.data.tags : [];
    let mandatoryFreeShipping = ['mandatory_free_shipping'].some(tag =>
      buyerTags.includes(tag) || sellerTags.includes(tag)
    );
    let effectiveRequestedFreeShipping = requestedFreeShipping;
    if (!mandatoryFreeShipping && itemId) {
      try {
        const itemCacheKey = `item_shipping_policy_${itemId}`;
        const cachedItemData = bypassCache
          ? null
          : getFromCache(`credential_${credential?.id}`, 'item_shipping_policy', itemCacheKey);
        let itemData = cachedItemData;
        if (!itemData) {
          /*logger.info(`[ML ENDPOINT TRACE] shipping.item_policy.request`, {
            endpoint: `https://api.mercadolibre.com/items/${itemId}`,
            method: "GET",
            item_id: itemId,
            category_id: categoryId
          });*/
          const itemResponse = await axios.get(
            `https://api.mercadolibre.com/items/${itemId}`,
            {
              headers: { Authorization: `Bearer ${credential.access_token}` },
              timeout: 12000
            }
          );
          /*logger.info(`[ML ENDPOINT TRACE] shipping.item_policy.response`, {
            endpoint: `https://api.mercadolibre.com/items/${itemId}`,
            method: "GET",
            item_id: itemId,
            category_id: categoryId,
            response: itemResponse.data
          });*/
          itemData = itemResponse.data || null;
          saveToCache(`credential_${credential?.id}`, 'item_shipping_policy', itemCacheKey, itemData, 900);
        }
        const itemTags = Array.isArray(itemData?.tags) ? itemData.tags : [];
        if (itemTags.includes('mandatory_free_shipping')) {
          mandatoryFreeShipping = true;
        }
        if (effectiveRequestedFreeShipping === null || effectiveRequestedFreeShipping === undefined) {
          const itemFreeShipping = itemData?.shipping?.free_shipping;
          if (typeof itemFreeShipping === 'boolean') {
            effectiveRequestedFreeShipping = itemFreeShipping;
          }
        }
      } catch (itemShippingErr) {
        logger.warn(`[ML] No se pudo validar shipping policy del item ${itemId}: ${itemShippingErr.message}`);
      }
    }

    const buyerCoverageCost = extractCoverageCostDetails(buyerCoverage);
    const sellerCoverageCost = extractCoverageCostDetails(sellerCoverage);
    const shippingCostSource = {
      buyer: actualItemShippingOption
        ? "item.shipping_options.list_cost"
        : buyerCoverageCost.source,
      seller: actualItemShippingOption
        ? "item.shipping_options.cost"
        : sellerCoverageCost.source
    };
    const shippingCostFallbacks = {
      buyer_used_list_cost_fallback: !actualItemShippingOption && buyerCoverageCost.used_fallback,
      seller_used_list_cost_fallback: !actualItemShippingOption && sellerCoverageCost.used_fallback
    };

    if (shippingCostFallbacks.buyer_used_list_cost_fallback || shippingCostFallbacks.seller_used_list_cost_fallback) {
      logger.warn(`[ML SHIPPING COST FALLBACK] Se usó list_cost por falta de cost`, {
        credential_id: credential?.id,
        category_id: categoryId,
        item_id: itemId,
        shipping_mode: baseParams.mode,
        logistic_type: baseParams.logistic_type,
        buyer_source: shippingCostSource.buyer,
        seller_source: shippingCostSource.seller,
        buyer_coverage: buyerCoverage,
        seller_coverage: sellerCoverage
      });
    }

    /*logger.info(`[ML SHIPPING COST TRACE] category=${categoryId} item=${itemId || "none"}`, {
      credential_id: credential?.id,
      shipping_mode: baseParams.mode,
      logistic_type: baseParams.logistic_type,
      logistic_model: deriveLogisticModel(baseParams.mode, baseParams.logistic_type),
      shipping_operation: deriveShippingOperation(baseParams.mode, baseParams.logistic_type),
      requested_free_shipping: effectiveRequestedFreeShipping,
      mandatory_free_shipping: mandatoryFreeShipping,
      buyer_source: shippingCostSource.buyer,
      seller_source: shippingCostSource.seller,
      buyer_cost: actualItemShippingOption
        ? toNumberOrZero(actualItemShippingOption.list_cost)
        : buyerCoverageCost.cost,
      seller_cost: actualItemShippingOption
        ? toNumberOrZero(actualItemShippingOption.cost)
        : sellerCoverageCost.cost,
      buyer_list_cost: actualItemShippingOption
        ? toNumberOrZero(actualItemShippingOption.list_cost)
        : toNumberOrZero(buyerCoverage.list_cost),
      seller_list_cost: actualItemShippingOption
        ? toNumberOrZero(actualItemShippingOption.list_cost)
        : toNumberOrZero(sellerCoverage.list_cost),
      buyer_discount: actualItemShippingOption?.discount || buyerCoverage.discount || null,
      seller_discount: actualItemShippingOption?.discount || sellerCoverage.discount || null,
      buyer_tags: buyerTags,
      seller_tags: sellerTags
    });*/

    const result = {
      buyer_pays: {
        cost: actualItemShippingOption
          ? toNumberOrZero(actualItemShippingOption.list_cost)
          : buyerCoverageCost.cost,
        list_cost: actualItemShippingOption
          ? toNumberOrZero(actualItemShippingOption.list_cost)
          : toNumberOrZero(buyerCoverage.list_cost),
        currency_id: buyerCoverage.currency_id || getCurrencyIdFromSite(siteId),
        billable_weight: buyerCoverage.billable_weight,
        discount: actualItemShippingOption?.discount || buyerCoverage.discount,
        shipping_method_id: actualItemShippingOption?.shipping_method_id || buyerCoverage.shipping_method_id,
        shipping_cost_source: shippingCostSource.buyer,
        paid_by: 'buyer',
        free_shipping: false
      },
      seller_pays: {
        cost: actualItemShippingOption
          ? toNumberOrZero(actualItemShippingOption.cost)
          : sellerCoverageCost.cost,
        list_cost: actualItemShippingOption
          ? toNumberOrZero(actualItemShippingOption.list_cost)
          : toNumberOrZero(sellerCoverage.list_cost),
        currency_id: sellerCoverage.currency_id || getCurrencyIdFromSite(siteId),
        billable_weight: sellerCoverage.billable_weight,
        discount: actualItemShippingOption?.discount || sellerCoverage.discount,
        shipping_method_id: actualItemShippingOption?.shipping_method_id || sellerCoverage.shipping_method_id,
        shipping_cost_source: shippingCostSource.seller,
        paid_by: 'seller',
        free_shipping: true
      }
    };
    const normalized = normalizeShippingScenarios({
      shippingMode: baseParams.mode,
      logisticType: baseParams.logistic_type,
      buyerPays: result.buyer_pays,
      sellerPays: result.seller_pays,
      requestedFreeShipping: effectiveRequestedFreeShipping,
      mandatoryFreeShipping
    });
    return {
      ...result,
      ...normalized,
      shipping_cost_source: shippingCostSource,
      shipping_cost_fallbacks: shippingCostFallbacks,
      logistic_model: deriveLogisticModel(baseParams.mode, baseParams.logistic_type),
      shipping_operation: deriveShippingOperation(baseParams.mode, baseParams.logistic_type),
      requested_free_shipping: effectiveRequestedFreeShipping,
      mandatory_free_shipping_detected: mandatoryFreeShipping,
      zip_code_used: zipCode,
      item_shipping_option_used: actualItemShippingOption
    };
  } catch (error) {
    logger.error(`Error calculando envío para categoría ${categoryId}: ${error.message}`, {
      status: error.response?.status,
      data: error.response?.data,
      params: baseParams,
      ml_user_id: mlUserId
    });

    const currencyId = getCurrencyIdFromSite(siteId);
    const errMsg = error.response?.data?.message
      ? `${error.message}: ${error.response.data.message}`
      : error.message;
    const fallback = {
      buyer_pays: { cost: 0, currency_id: currencyId, paid_by: 'buyer', error: errMsg },
      seller_pays: { cost: 0, currency_id: currencyId, paid_by: 'seller', error: errMsg }
    };
    const normalized = normalizeShippingScenarios({
      shippingMode: baseParams.mode,
      logisticType: baseParams.logistic_type,
      buyerPays: fallback.buyer_pays,
      sellerPays: fallback.seller_pays,
      requestedFreeShipping,
      mandatoryFreeShipping: false
    });
    return { ...fallback, ...normalized, requested_free_shipping: requestedFreeShipping, warning: errMsg };
  }
},

/**
 * Endpoint independiente para calcular costos de envío
 * Útil cuando ya se tiene la categoría seleccionada
 */
async mercadoLibreShippingCosts(req, res) {
  logger.info(`Datos recibidos para calcular costos de envío en MercadoLibre:\n ${JSON.stringify(req.body)}`);

  const { credential_id, product, category_id, listing_type_id } = req.body;
  const user_id = req.user?.id || req.body.user_id;

  // Validaciones
  if (!credential_id) {
    return res.status(400).json({ success: false, error: "credential_id es requerido" });
  }

  if (!product || !product.id) {
    return res.status(400).json({ success: false, error: "Se requiere información del producto con 'id'" });
  }

  if (!product.package) {
    return res.status(400).json({ 
      success: false, 
      error: "El producto debe incluir 'package' con dimensions y weight",
      example: {
        package: {
          weight: { unit: "g", value: 320 },
          dimensions: {
            height: { unit: "cm", value: 15 },
            width: { unit: "cm", value: 8 },
            length: { unit: "cm", value: 22 }
          }
        }
      }
    });
  }

  if (!product.price || isNaN(product.price)) {
    return res.status(400).json({ success: false, error: "El producto debe tener un 'price' válido" });
  }

  if (!category_id) {
    return res.status(400).json({ success: false, error: "category_id es requerido" });
  }

  try {
    // Rate Limit
    try {
      await marketplaceRateLimiter.consume(user_id);
    } catch (rateLimitError) {
      return res.status(429).json({
        success: false,
        error: "Demasiadas solicitudes. Por favor, espera un momento."
      });
    }

    // Obtener Credencial
    const credential = await MarketplaceCredentialRepository.findById(credential_id);
    if (!credential) {
      return res.status(404).json({ success: false, error: "Credencial no encontrada" });
    }

    if (credential.user_id !== user_id) {
      return res.status(403).json({ success: false, error: "No autorizado" });
    }

    const site_id = getMercadoLibreSiteId(credential.marketplace?.domain);
    const listingType = listing_type_id || 'gold_special';

    // Cache key
    const dimensions = OAuthController.formatDimensionsForAPI(product.package, { strict: false });
    const cacheKey = `shipping_${category_id}_${product.price}_${dimensions}_${listingType}`;
    const cachedShipping = getFromCache(`credential_${credential_id}`, 'shipping_costs', cacheKey);

    if (cachedShipping) {
      logger.info(`[CACHE HIT] Shipping para ${category_id}`);
      return res.status(200).json({
        success: true,
        shipping: cachedShipping,
        cached: true
      });
    }

    // Calcular costos
    logger.info(`[CACHE MISS] Calculando shipping para ${category_id}`);
    const shipping = await OAuthController.calculateMercadoLibreShippingCosts(
      credential,
      product,
      category_id,
      site_id,
      listingType
    );

    // Guardar en cache (15 minutos)
    saveToCache(`credential_${credential_id}`, 'shipping_costs', cacheKey, shipping, 900);

    return res.status(200).json({
      success: true,
      shipping,
      cached: false,
      product_id: product.id,
      category_id,
      dimensions,
      stats: {
        pricing_requested: true
      }
    });

  } catch (error) {
    logger.error(`❌ Error en mercadoLibreShippingCosts: ${error.message}`, {
      stack: error.stack,
      body: req.body
    });
    return res.status(500).json({
      success: false,
      error: "Error interno al calcular costos de envío de MercadoLibre."
    });
  }
},

  async mercadoLibreSuggestedCategoriesSelection(req, res) {
    logger.info(`Datos recibidos para categorías sugeridas de selección en MercadoLibre:\n ${JSON.stringify(req.body)}`);

    const {
      credential_id,
      products,
      listing_type_id,
      logistic_type,
      shipping_mode,
      strategy
    } = req.body;

    const user_id = req.user?.id || req.body.user_id;
    const selectedStrategy = normalizeStrategy(strategy, listing_type_id);

    if (!credential_id) {
      return res.status(400).json({ success: false, error: "credential_id es requerido" });
    }

    if (!Array.isArray(products) || products.length === 0) {
      return res.status(400).json({
        success: false,
        error: "Se requiere un array no vacío de productos con 'id' y 'name'."
      });
    }

    const invalidProducts = products.filter(product => !String(product?.name || "").trim());
    if (invalidProducts.length > 0) {
      return res.status(400).json({
        success: false,
        error: "Todos los productos deben incluir 'name'."
      });
    }

    try {
      try {
        await marketplaceRateLimiter.consume(user_id);
      } catch (rateLimitError) {
        logger.warn(`Rate limit excedido para usuario ${user_id}`);
        return res.status(429).json({
          success: false,
          error: "Demasiadas solicitudes. Por favor, espera un momento."
        });
      }

      const credential = await MarketplaceCredentialRepository.findById(credential_id);
      if (!credential) {
        return res.status(404).json({ success: false, error: "Credencial no encontrada" });
      }

      if (credential.user_id !== user_id) {
        return res.status(403).json({ success: false, error: "No autorizado" });
      }

      const marketplace_id = credential.marketplace_id;
      const site_id = getMercadoLibreSiteId(credential.marketplace?.domain);

      const fetchAllMarketplaceCategories = async (accessToken) => {
        const cacheNamespace = `ml_site_${site_id}`;
        const cacheKey = 'all_categories_tree_v3';
        const cachedCategories = getFromCache(cacheNamespace, 'categories', cacheKey);

        if (cachedCategories) {
          return cachedCategories;
        }

        try {
          const allCategoriesResponse = await axios.get(
            `https://api.mercadolibre.com/sites/${site_id}/categories`,
            {
              headers: { Authorization: `Bearer ${accessToken}` },
              timeout: 30000
            }
          );

          const rawCategories = Array.isArray(allCategoriesResponse.data)
            ? allCategoriesResponse.data
            : Array.isArray(allCategoriesResponse.data?.categories)
              ? allCategoriesResponse.data.categories
              : Array.isArray(allCategoriesResponse.data?.results)
                ? allCategoriesResponse.data.results
                : [];

          const normalizedCategories = rawCategories
            .map((category) => {
              const categoryId = String(category?.id || category?.category_id || '').trim();
              const categoryName = String(category?.name || category?.category_name || '').trim();

              if (!categoryId || !categoryName) return null;

              return {
                category_id: categoryId,
                category_name: categoryName,
                domain_id: category?.domain_id || null,
                domain_name: category?.domain_name || null,
                path: categoryName,
                path_from_root: [{
                  id: categoryId,
                  name: categoryName
                }],
                children_categories: [],
                category_settings: {},
                attributable: null,
                date_created: null,
                picture: null,
                permalink: null,
                total_items_in_this_category: null
              };
            })
            .filter(Boolean)
            .filter((category, index, list) =>
              list.findIndex((item) => item.category_id === category.category_id) === index
            )
            .sort((a, b) => a.category_name.localeCompare(b.category_name, 'es', { sensitivity: 'base' }));

          saveToCache(cacheNamespace, 'categories', cacheKey, normalizedCategories, 86400);
          return normalizedCategories;
        } catch (error) {
          logger.warn(`No se pudieron cargar todas las categorías del site ${site_id}: ${error.message}`);
          return [];
        }
      };

      const allCategories = await fetchAllMarketplaceCategories(credential.access_token);
      const countCategoryTreeNodes = (nodes = []) => {
        let total = 0;
        for (const node of Array.isArray(nodes) ? nodes : []) {
          if (!node) continue;
          total += 1;
          total += countCategoryTreeNodes(node.children_categories);
        }
        return total;
      };
      const allCategoriesCount = countCategoryTreeNodes(allCategories);

      const getMercadoLibreUserIdFromCredential = (cred) => {
        if (!cred) return null;
        if (cred.ml_user_id) return cred.ml_user_id;
        const additional = cred.additional_data;
        if (!additional) return null;
        if (typeof additional === "object") return additional.ml_user_id || null;
        if (typeof additional === "string") {
          try {
            const parsed = JSON.parse(additional);
            return parsed?.ml_user_id || null;
          } catch (e) {
            return null;
          }
        }
        return null;
      };

      const fetchMercadoLibreUserId = async (accessToken) => {
        if (!accessToken) return null;
        try {
          const meResponse = await axios.get("https://api.mercadolibre.com/users/me", {
            headers: { Authorization: `Bearer ${accessToken}` },
            timeout: 8000
          });
          return meResponse.data?.id || null;
        } catch (e) {
          return null;
        }
      };

      const mlUserId = getMercadoLibreUserIdFromCredential(credential) || await fetchMercadoLibreUserId(credential.access_token);

      const buildSelectionShippingOptions = (combos, modeStates, effectiveMode, effectiveLogistic) => {
        const comboOptions = dedupeShippingCombos(combos).map((combo) => {
          const shippingUi = buildShippingUi(
            combo.shipping_mode,
            combo.logistic_type,
            combo.shipping_resolution_state || SHIPPING_RESOLUTION_STATE.DYNAMIC
          );
          return {
            shipping_mode: combo.shipping_mode,
            logistic_type: combo.logistic_type || null,
            logistic_model: deriveLogisticModel(
              combo.shipping_mode,
              combo.logistic_type,
              combo.shipping_resolution_state || SHIPPING_RESOLUTION_STATE.DYNAMIC
            ),
            shipping_operation: deriveShippingOperation(
              combo.shipping_mode,
              combo.logistic_type,
              combo.shipping_resolution_state || SHIPPING_RESOLUTION_STATE.DYNAMIC
            ),
            shipping_resolution_state: combo.shipping_resolution_state || SHIPPING_RESOLUTION_STATE.DYNAMIC,
            shipping_complexity: combo.shipping_complexity || SHIPPING_COMPLEXITY.DYNAMIC,
            id: buildShippingComboKey(combo.shipping_mode, combo.logistic_type),
            title: shippingUi.label,
            subtitle: shippingUi.seller_instruction,
            shipping_mode_label: combo.shipping_mode,
            logistic_type_label: combo.logistic_type || null,
            group: "marketplace_shipping",
            service_code: combo.logistic_type || combo.shipping_mode || "unknown",
            service_name: shippingUi.label,
            shipping_ui: shippingUi,
            is_flex: combo.logistic_type === "self_service",
            is_default: combo.shipping_mode === effectiveMode && combo.logistic_type === effectiveLogistic
          };
        });

        const modeOptions = Array.isArray(modeStates)
          ? modeStates
            .filter((modeEntry) =>
              modeEntry?.value &&
              (modeEntry.shipping_resolution_state !== SHIPPING_RESOLUTION_STATE.RESOLVED ||
                (modeEntry.logistic_types_count || 0) === 0)
            )
            .map((modeEntry) => {
              const shippingUi = buildShippingUi(
                modeEntry.value,
                null,
                modeEntry.shipping_resolution_state || SHIPPING_RESOLUTION_STATE.DYNAMIC
              );
              return {
                shipping_mode: modeEntry.value,
                logistic_type: null,
                logistic_model: deriveLogisticModel(
                  modeEntry.value,
                  null,
                  modeEntry.shipping_resolution_state || SHIPPING_RESOLUTION_STATE.DYNAMIC
                ),
                shipping_operation: deriveShippingOperation(
                  modeEntry.value,
                  null,
                  modeEntry.shipping_resolution_state || SHIPPING_RESOLUTION_STATE.DYNAMIC
                ),
                shipping_resolution_state: modeEntry.shipping_resolution_state || SHIPPING_RESOLUTION_STATE.DYNAMIC,
                shipping_complexity: modeEntry.shipping_complexity || SHIPPING_COMPLEXITY.DYNAMIC,
                id: buildShippingComboKey(modeEntry.value, null),
                title: shippingUi.label,
                subtitle: shippingUi.seller_instruction,
                shipping_mode_label: modeEntry.value,
                logistic_type_label: null,
                group: "marketplace_shipping",
                service_code: modeEntry.value || "unknown",
                service_name: shippingUi.label,
                shipping_ui: shippingUi,
                is_flex: false,
                is_default: modeEntry.value === effectiveMode && !effectiveLogistic
              };
            })
          : [];

        return [...comboOptions, ...modeOptions];
      };

      const suggestions = [];
      let cacheHits = 0;
      let apiCalls = 0;
      let listingTypesCalls = 0;

      for (const product of products) {
        const nameFixed = product.name.trim();
        const productCondition = String(product.condition || "new").toLowerCase();
        const productPrice = Number.isFinite(Number(product.price)) ? Number(product.price) : null;
        const shippingMeasurementInput = buildShippingMeasurementInput(product);
        const requestFingerprint = stableStringify({
          strategy: selectedStrategy,
          listing_type_id: listing_type_id || null,
          shipping_mode: shipping_mode || null,
          logistic_type: logistic_type || null,
          product: {
            id: product.id,
            name: nameFixed,
            condition: productCondition,
            price: productPrice,
            shipping_measurements: shippingMeasurementInput || null,
            item_id: product.item_id || null,
            ml_item_id: product.ml_item_id || null
          }
        });

        const productCacheKey = `${nameFixed}__${requestFingerprint}`;

        apiCalls++;

        let categories = [];
        try {
          const catResponse = await axios.get(
            `https://api.mercadolibre.com/sites/${site_id}/domain_discovery/search`,
            {
              params: { q: nameFixed },
              headers: { Authorization: `Bearer ${credential.access_token}` },
              timeout: 30000
            }
          );

          categories = (catResponse.data || []).map(cat => ({
            category_id: cat.category_id,
            category_name: cat.category_name,
            domain_id: cat.domain_id,
            domain_name: cat.domain_name,
            path: cat.domain_name || ""
          }));
        } catch (catErr) {
          logger.error(`Error al obtener categorías para "${nameFixed}": ${catErr.message}`);
          suggestions.push({
            product_id: product.id,
            credential_id,
            marketplace_id,
            categories: []
          });
          continue;
        }

        const categoriesSelection = [];

        for (const cat of categories) {
          if (!cat.category_id) continue;

          const categoryCacheKey = `${cat.category_id}__${requestFingerprint}`;

          const selectionWarnings = [];
          let attributes = [];

          try {
            const attrResponse = await axios.get(
              `https://api.mercadolibre.com/categories/${cat.category_id}/attributes`,
              {
                headers: { Authorization: `Bearer ${credential.access_token}` },
                timeout: 20000
              }
            );
            attributes = attrResponse.data || [];
          } catch (attrErr) {
            logger.error(`Error al cargar atributos para categoría ${cat.category_id}: ${attrErr.message}`);
          }

          let listingTypesForCategory = [];
          try {
            if (mlUserId) {
              const listingTypesCacheKey = `listing_types_${site_id}_${cat.category_id}`;
              listingTypesCalls++;
              const userLtResponse = await axios.get(
                `https://api.mercadolibre.com/users/${mlUserId}/available_listing_types`,
                {
                  params: { category_id: cat.category_id },
                  headers: { Authorization: `Bearer ${credential.access_token}` },
                  timeout: 12000
                }
              );

              const availableData = userLtResponse.data?.available || userLtResponse.data || [];
              listingTypesForCategory = normalizeSupportedListingTypes(availableData, site_id);
              saveToCache(`credential_${credential_id}`, "category_listing_types", listingTypesCacheKey, listingTypesForCategory, 1800);
            }
          } catch (ltError) {
            logger.warn(`No se pudieron obtener listing types para categoría ${cat.category_id}: ${ltError.message}`);
            listingTypesForCategory = [];
          }

          let listingResolution = null;
          let effectiveListingType = null;
          try {
            listingResolution = resolveListingTypeByStrategy(selectedStrategy, listingTypesForCategory);
            effectiveListingType = listingResolution.listing_type_id;
          } catch (listingError) {
            logger.warn(`No se pudo resolver listing type para categoría ${cat.category_id}: ${listingError.message}`);
            effectiveListingType = "gold_special";
            listingResolution = {
              listing_type_id: effectiveListingType,
              fallback_applied: true,
              note: "No se pudieron validar tipos de publicación para esta categoría. Se aplicó fallback por defecto.",
              error: listingError.message
            };
            selectionWarnings.push("listing_type_resolution_fallback_applied");
          }

          let userShippingPreferences = null;
          let categoryShippingPreferences = null;

          if (mlUserId) {
            try {
              [userShippingPreferences, categoryShippingPreferences] = await Promise.all([
                MercadoLibreCapabilitiesService.getUserShippingPreferences(credential, mlUserId),
                MercadoLibreCapabilitiesService.getCategoryShippingPreferences(credential, cat.category_id)
              ]);
            } catch (shippingPreferencesError) {
              logger.warn(`[ML SHIPPING PREFS] No se pudieron cargar preferencias oficiales para categoría ${cat.category_id}: ${shippingPreferencesError.message}`);
            }
          }

          const shippingSelection = buildMarketplaceShippingSelection({
            userPreferences: userShippingPreferences,
            categoryPreferences: categoryShippingPreferences
          });

          let filteredShippingModes = Array.isArray(shippingSelection?.shippingModes) ? shippingSelection.shippingModes : [];
          let logisticTypesForCategory = Array.isArray(shippingSelection?.logisticTypes) ? shippingSelection.logisticTypes : [];
          let availableShippingCombos = Array.isArray(shippingSelection?.combos) ? shippingSelection.combos : [];
          let effectiveShippingMode = null;
          let effectiveLogisticType = null;

          if (filteredShippingModes.length === 0) {
            selectionWarnings.push("shipping_modes_empty_by_preferences");
          }

          if (availableShippingCombos.length === 0) {
            selectionWarnings.push("shipping_combinations_empty_from_marketplace");
          }

          availableShippingCombos = finalizeShippingCombos(
            availableShippingCombos.filter(combo =>
              filteredShippingModes.length === 0 || filteredShippingModes.some(modeEntry => modeEntry.value === combo.shipping_mode)
            )
          );

          const supportedShippingResolution = await filterSupportedMarketplaceShippingCombosForProduct({
            credential,
            product: { ...product, price: productPrice ?? product.price },
            categoryId: cat.category_id,
            listingType: effectiveListingType,
            combos: availableShippingCombos
          });
          availableShippingCombos = supportedShippingResolution.combos;
          selectionWarnings.push(...supportedShippingResolution.warnings);

          const hasRequestedLogisticType = logistic_type !== undefined && logistic_type !== null && String(logistic_type).trim() !== "";
          const hasRequestedShippingSelection = Boolean(shipping_mode || hasRequestedLogisticType);
          const shippingComboResolution = selectPreferredShippingCombo({
            requestedMode: shipping_mode,
            requestedLogisticType: logistic_type,
            availableCombos: availableShippingCombos,
            availableModes: filteredShippingModes
          });

          if (shippingComboResolution.selection) {
            effectiveShippingMode = shippingComboResolution.selection.shipping_mode;
            effectiveLogisticType = shippingComboResolution.selection.logistic_type || null;
          } else if (hasRequestedShippingSelection) {
            return res.status(422).json({
              success: false,
              error: "La combinación shipping_mode/logistic_type seleccionada no está permitida para la categoría o credencial.",
              product_id: product.id,
              category_id: cat.category_id,
              requested_shipping_mode: shipping_mode,
              requested_logistic_type: logistic_type,
              available_shipping_combinations: availableShippingCombos
            });
          }

          selectionWarnings.push(...shippingComboResolution.warnings);

          const selectionShippingOptions = buildSelectionShippingOptions(
            availableShippingCombos,
            filteredShippingModes,
            effectiveShippingMode,
            effectiveLogisticType
          );

          const categoryPayload = buildMlSelectionCategoryPayload({
            cat,
            attributes,
            listingTypesForCategory,
            filteredShippingModes,
            logisticTypesForCategory,
            shippingCombinations: availableShippingCombos,
            shippingOptions: selectionShippingOptions,
            shippingModeStates: filteredShippingModes,
            selectedStrategy,
            effectiveListingType,
            effectiveShippingMode,
            effectiveLogisticType,
            selectionWarnings
          });

          saveToCache(`credential_${credential_id}`, `category_selection_${site_id}_v1`, categoryCacheKey, categoryPayload, 900);
          categoriesSelection.push(categoryPayload);
        }

        saveToCache(`credential_${credential_id}`, `product_selection_${site_id}_v1`, productCacheKey, categoriesSelection, 900);
        suggestions.push({
          product_id: product.id,
          credential_id,
          marketplace_id,
          categories: categoriesSelection
        });
      }

      return res.status(200).json({
        success: true,
        response_format_version: "v1_selection",
        all_categories: allCategories,
        all_categories_count: allCategoriesCount,
        selection_model: {
          strategies: [
            {
              value: ML_STRATEGY.MARGIN,
              label: "Ganar más por producto",
              description: "Menor comisión"
            },
            {
              value: ML_STRATEGY.CONVERSION,
              label: "Vender más rápido",
              description: "Mayor exposición"
            }
          ],
          strategy: selectedStrategy,
          selection_scope: {
            listing_type_effective: "category",
            shipping_mode_effective: "category",
            logistic_type_effective: "category"
          },
          warnings: []
        },
        suggestions,
        count: suggestions.length,
        stats: {
          total_products: products.length,
          cache_hits: cacheHits,
          api_calls: apiCalls,
          listing_types_calls: listingTypesCalls,
          cache_hit_rate: products.length > 0
            ? ((cacheHits / products.length) * 100).toFixed(2) + "%"
            : "0%"
        },
        warnings: []
      });
    } catch (error) {
      logger.error(`❌ Error general en mercadoLibreSuggestedCategoriesSelection: ${error.message}`, {
        stack: error.stack,
        body: req.body
      });
      return res.status(500).json({
        success: false,
        error: "Error interno al procesar categorías sugeridas de selección de MercadoLibre."
      });
    }
  },

// ✅ MÉTODO ACTUALIZADO - Ahora incluye shipping costs
  async mercadoLibreSuggestedCategoriesWithAttributes(req, res) {
  logger.info(`Datos recibidos para categorías sugeridas con atributos, pricing y shipping en MercadoLibre:\n ${JSON.stringify(req.body)}`);

  const {
    credential_id,
    products,
    listing_type_id,
    logistic_type,
    shipping_mode,
    strategy,
    installments,
    response_detail
  } = req.body;
  const user_id = req.user?.id || req.body.user_id;
  let selectedStrategy = normalizeStrategy(strategy, listing_type_id);
  const normalizedInstallments = normalizeInstallments(installments);
  const resolvedResponseDetail = normalizeMlSuggestedCategoriesResponseDetail(response_detail);
  const hasExplicitSelections = Array.isArray(products) && products.length > 0
    ? products.every(product => product?.selection?.category_id)
    : false;
  const strategyWarnings = [];
  if (normalizedInstallments.requested) {
    strategyWarnings.push("installments_request_ignored_backend_resolves_by_listing_type");
  }

  if (!credential_id) {
    return res.status(400).json({ success: false, error: "credential_id es requerido" });
  }

  if (!Array.isArray(products) || products.length === 0) {
    return res.status(400).json({
      success: false,
      error: "Se requiere un array no vacío de productos con 'id' y 'name'."
    });
  }

  const productsWithIncompleteSelection = products
    .filter(product => {
      const selection = product?.selection;
      if (!selection || typeof selection !== "object") return true;
      return !selection.category_id
        || !selection.listing_type_id;
    })
    .map(product => ({
      product_id: product?.id ?? null,
      missing: {
        category_id: !product?.selection?.category_id,
        listing_type_id: !product?.selection?.listing_type_id,
        shipping_mode: !product?.selection?.shipping_mode,
        logistic_type: !product?.selection?.logistic_type
      }
    }));

  if (productsWithIncompleteSelection.length > 0) {
    return res.status(422).json({
      success: false,
      error: "Cada producto debe incluir selection.category_id y selection.listing_type_id.",
      invalid_products: productsWithIncompleteSelection
    });
  }

  // ✅ NUEVO: Validar que los productos tengan package/dimensions si quieren shipping
  const productsWithoutPackage = products.filter(p => !p.package && p.price !== undefined);
  if (productsWithoutPackage.length > 0) {
    logger.warn(`Productos sin package (no se calculará shipping): ${productsWithoutPackage.map(p => p.id).join(', ')}`);
  }

  try {
    // === PASO 1: Rate Limit ===
    try {
      await marketplaceRateLimiter.consume(user_id);
    } catch (rateLimitError) {
      logger.warn(`Rate limit excedido para usuario ${user_id}`);
      return res.status(429).json({
        success: false,
        error: "Demasiadas solicitudes. Por favor, espera un momento."
      });
    }

    // === PASO 2: Obtener Credencial ===
    const credential = await MarketplaceCredentialRepository.findById(credential_id);
    if (!credential) {
      return res.status(404).json({ success: false, error: "Credencial no encontrada" });
    }

    if (credential.user_id !== user_id) {
      return res.status(403).json({ success: false, error: "No autorizado" });
    }

    const marketplace_id = credential.marketplace_id;
    const site_id = getMercadoLibreSiteId(credential.marketplace?.domain);
    const getPricingCurrencyIdFromSite = (site) => {
      switch (String(site || "").toUpperCase()) {
        case "MLC": return "CLP";
        case "MLA": return "ARS";
        case "MLB": return "BRL";
        case "MCO": return "COP";
        case "MLM": return "MXN";
        case "MLU": return "UYU";
        case "MLV": return "VES";
        case "MPE": return "PEN";
        case "MEC": return "USD";
        case "MGT": return "GTQ";
        case "MHN": return "HNL";
        case "MNI": return "NIO";
        case "MSV": return "USD";
        case "MCU": return "CUP";
        case "MPY": return "PYG";
        case "MBO": return "BOB";
        case "MCR": return "CRC";
        case "MPA": return "PAB";
        case "MRD": return "DOP";
        default: return "ARS";
      }
    };
    const derivePricingBillableWeight = (shippingResult) => {
      const candidates = [
        shippingResult?.item_shipping_option_used?.billable_weight,
        shippingResult?.buyer_pays?.billable_weight,
        shippingResult?.seller_pays?.billable_weight
      ]
        .map(value => Number(value))
        .filter(value => Number.isFinite(value) && value > 0);

      if (candidates.length === 0) return null;

      return Math.round(Math.max(...candidates));
    };
    const getMercadoLibreUserIdFromCredential = (cred) => {
      if (!cred) return null;
      if (cred.ml_user_id) return cred.ml_user_id;
      const additional = cred.additional_data;
      if (!additional) return null;
      if (typeof additional === 'object') return additional.ml_user_id || null;
      if (typeof additional === 'string') {
        try {
          const parsed = JSON.parse(additional);
          return parsed?.ml_user_id || null;
        } catch (e) {
          return null;
        }
      }
      return null;
    };
    const fetchMercadoLibreUserId = async (accessToken) => {
      if (!accessToken) return null;
      try {
        const meResponse = await axios.get('https://api.mercadolibre.com/users/me', {
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: 8000
        });
        return meResponse.data?.id || null;
      } catch (e) {
        return null;
      }
    };
    const mlUserId = getMercadoLibreUserIdFromCredential(credential) || await fetchMercadoLibreUserId(credential.access_token);

    const buildShippingOptionsFromCombos = (combos) => {
      if (!Array.isArray(combos) || combos.length === 0) return [];

      return dedupeShippingCombos(combos).map((combo) => {
        const isFlex = combo.logistic_type === 'self_service';
        const serviceCode = isFlex
          ? 'flex'
          : (combo.logistic_type || combo.shipping_mode || 'unknown');
        const shippingUi = buildShippingUi(
          combo.shipping_mode,
          combo.logistic_type,
          combo.shipping_resolution_state || SHIPPING_RESOLUTION_STATE.DYNAMIC
        );
        const serviceName = shippingUi.label;
        const group = isFlex ? 'seller_logistics' : 'mercado_envios';
        return {
          shipping_mode: combo.shipping_mode,
          logistic_type: combo.logistic_type || null,
          logistic_model: deriveLogisticModel(
            combo.shipping_mode,
            combo.logistic_type,
            combo.shipping_resolution_state || SHIPPING_RESOLUTION_STATE.DYNAMIC
          ),
          shipping_operation: deriveShippingOperation(
            combo.shipping_mode,
            combo.logistic_type,
            combo.shipping_resolution_state || SHIPPING_RESOLUTION_STATE.DYNAMIC
          ),
          shipping_resolution_state: combo.shipping_resolution_state || SHIPPING_RESOLUTION_STATE.DYNAMIC,
          shipping_complexity: combo.shipping_complexity || SHIPPING_COMPLEXITY.DYNAMIC,
          id: buildShippingComboKey(combo.shipping_mode, combo.logistic_type),
          title: serviceName,
          service_code: serviceCode,
          service_name: serviceName,
          group,
          shipping_mode_label: combo.shipping_mode,
          logistic_type_label: combo.logistic_type || null,
          shipping_ui: shippingUi,
          is_flex: isFlex,
          is_default: false
        };
      });
    };

    const suggestions = [];
    let cacheHits = 0;
    let apiCalls = 0;
    let pricingCalls = 0;
    let shippingCalls = 0;
    let listingTypesCalls = 0;
    let shippingValidationCalls = 0;
    const loadPricingOptionsForCategory = async ({
      cat,
      product,
      productPrice,
      effectiveListingType,
      effectiveShippingMode,
      effectiveLogisticType,
      listingTypesForCategory,
      requestFingerprint,
      pricingBillableWeight,
      campaignTagRequested
    }) => {
      let pricing = null;
      let pricing_options = [];
      let campaignTags = [];
      let campaignTagsByListingType = {
        gold_pro: [],
        gold_special: [],
        free: []
      };

      if (productPrice !== null && site_id === 'MLA') {
        const campaignsCacheKey = `installments_campaigns_${site_id}_${cat.category_id}`;
        try {
          const campaignParams = {
            category_id: cat.category_id,
            channel: 'marketplace'
          };
          if (product?.brand) campaignParams.brand = String(product.brand);
          if (product?.model) campaignParams.model = String(product.model);
          logMercadoLibreEndpointTrace({
            stage: "pricing.special_installments_campaigns.request",
            endpoint: `https://api.mercadolibre.com/special_installments/campaigns`,
            categoryId: cat.category_id,
            params: campaignParams
          });

          const campaignsResponse = await axios.get(
            `https://api.mercadolibre.com/special_installments/campaigns`,
            {
              params: campaignParams,
              headers: { Authorization: `Bearer ${credential.access_token}` },
              timeout: 12000
            }
          );
          logMercadoLibreEndpointTrace({
            stage: "pricing.special_installments_campaigns.response",
            endpoint: `https://api.mercadolibre.com/special_installments/campaigns`,
            categoryId: cat.category_id,
            response: campaignsResponse.data
          });

          const allTags = extractCampaignTags(campaignsResponse.data);
          campaignTags = allTags;
          campaignTagsByListingType = {
            gold_pro: allTags.filter(t => ['3x_campaign', 'cuota-simple-3', 'cuota-simple-6', '9x_campaign', '12x_campaign', 'cuota-simple-12'].includes(t)),
            gold_special: allTags.filter(t => ['pcj-co-funded', 'cuota-simple-paid-by-buyer'].includes(t)),
            free: []
          };

          saveToCache(
            `credential_${credential_id}`,
            'special_installments_campaigns',
            campaignsCacheKey,
            { tags: campaignTags, tags_by_listing_type: campaignTagsByListingType },
            1800
          );
        } catch (campaignErr) {
          logger.warn(`No se pudieron obtener campañas de cuotas para categoría ${cat.category_id}: ${campaignErr.message}`);
        }
      }

      if (productPrice !== null) {
        const pricingCandidates = listingTypesForCategory.length > 0
          ? listingTypesForCategory
          : [{ value: effectiveListingType, title: effectiveListingType, description: effectiveListingType, ml_metadata: null }];

        for (const listingCandidate of pricingCandidates) {
          const pricingTypeId = listingCandidate.value;
          const pricingCacheKey = `pricing_${site_id}_${cat.category_id}_${requestFingerprint}_${pricingTypeId}_${effectiveShippingMode}_${effectiveLogisticType}_${pricingBillableWeight || "no_bw"}`;

          try {
            pricingCalls++;
            const pricingUrl = `https://api.mercadolibre.com/sites/${site_id}/listing_prices`;
            const pricingParams = {
              price: productPrice,
              category_id: cat.category_id,
              listing_type_id: pricingTypeId,
              currency_id: getPricingCurrencyIdFromSite(site_id),
              shipping_mode: effectiveShippingMode,
              logistic_type: effectiveLogisticType
            };
            if (cat.domain_id) pricingParams.domain_id = cat.domain_id;
            if (site_id === "MLA" && Number.isFinite(Number(pricingBillableWeight)) && Number(pricingBillableWeight) > 0) {
              pricingParams.billable_weight = Math.round(Number(pricingBillableWeight));
            }

            const listingCampaignTags = Array.isArray(campaignTagsByListingType?.[pricingTypeId])
              ? campaignTagsByListingType[pricingTypeId]
              : [];
            const campaignTagSelected = campaignTagRequested && listingCampaignTags.includes(campaignTagRequested)
              ? campaignTagRequested
              : null;
            if (campaignTagSelected) pricingParams.tags = campaignTagSelected;

            logMercadoLibreEndpointTrace({
              stage: "pricing.listing_prices.request",
              endpoint: pricingUrl,
              categoryId: cat.category_id,
              listingTypeId: pricingTypeId,
              shippingMode: effectiveShippingMode,
              logisticType: effectiveLogisticType,
              params: pricingParams
            });

            const pricingResponse = await axios.get(pricingUrl, {
              params: pricingParams,
              headers: { Authorization: `Bearer ${credential.access_token}` },
              timeout: 15000
            });
            logMercadoLibreEndpointTrace({
              stage: "pricing.listing_prices.response",
              endpoint: pricingUrl,
              categoryId: cat.category_id,
              listingTypeId: pricingTypeId,
              shippingMode: effectiveShippingMode,
              logisticType: effectiveLogisticType,
              response: pricingResponse.data
            });

            const fees = Array.isArray(pricingResponse.data)
              ? (pricingResponse.data[0] || {})
              : (pricingResponse.data || {});
            const saleFeeAmount = Number(fees.sale_fee_amount || 0);
            const listingFeeAmount = Number(fees.listing_fee_amount || 0);
            const totalFeeAmount = fees.total_fee_amount !== undefined && fees.total_fee_amount !== null
              ? Number(fees.total_fee_amount)
              : saleFeeAmount + listingFeeAmount;
            const pricingOption = {
              sale_fee_amount: saleFeeAmount,
              listing_fee_amount: listingFeeAmount,
              total_fee_amount: totalFeeAmount,
              listing_type_id: fees.listing_type_id || pricingTypeId,
              input_price: productPrice,
              net_amount: parseFloat((productPrice - totalFeeAmount).toFixed(2)),
              fee_percentage: productPrice > 0
                ? parseFloat(((saleFeeAmount / productPrice) * 100).toFixed(2))
                : 0,
              total_fee_percentage: productPrice > 0
                ? parseFloat(((totalFeeAmount / productPrice) * 100).toFixed(2))
                : 0,
              listing_type_name: listingCandidate.description || listingCandidate.title || pricingTypeId,
              campaign_tag_applied: campaignTagSelected,
              campaign_tag_requested: campaignTagRequested || null,
              campaign_pricing_applied: Boolean(campaignTagSelected)
            };

            saveToCache(`credential_${credential_id}`, 'category_pricing', pricingCacheKey, pricingOption, 1800);
            pricing_options.push(pricingOption);
          } catch (pricingErr) {
            logger.warn(`No se pudo obtener pricing para categoría ${cat.category_id} y listing ${pricingTypeId}: ${pricingErr.message}`);
          }
        }

        pricing = pricing_options.find(po => po.listing_type_id === effectiveListingType) || pricing_options[0] || {
          error: 'No se pudo calcular',
          message: `No hay pricing disponible para categoría ${cat.category_id}`
        };
      }

      return {
        pricing,
        pricing_options,
        campaignTags,
        campaignTagsByListingType
      };
    };

    // === PROCESAR CADA PRODUCTO ===
    for (const product of products) {
      if (!product.id || !product.name) {
        logger.warn(`Producto inválido omitido: ${JSON.stringify(product)}`);
        continue;
      }

      const nameFixed = product.name.trim();
      const shippingMeasurementInput = buildShippingMeasurementInput(product);
      const productSelection = product?.selection && typeof product.selection === "object"
        ? product.selection
        : {};
      const requestedCategoryId = productSelection.category_id || null;
      const requestedCategoryName = productSelection.category_name || null;
      const requestedDomainId = productSelection.domain_id || null;
      const requestedDomainName = productSelection.domain_name || null;
      const requestedPath = productSelection.path || null;
      const requestedListingTypeId = productSelection.listing_type_id || listing_type_id || null;
      const requestedShippingMode = productSelection.shipping_mode || shipping_mode || null;
      const requestedLogisticType = productSelection.logistic_type || logistic_type || null;
      
      // Obtener price de cada producto
      const productPrice = (product.price !== undefined && product.price !== null && !isNaN(product.price))
        ? parseFloat(product.price)
        : null;
      const economicInputs = resolveEconomicInputs(product);
      
      // Validar y formatear dimensiones si existen
      let dimensionsFormatted = null;
      const packageAnalysis = analyzeShippingPackage(shippingMeasurementInput);
      if (shippingMeasurementInput) {
        try {
          dimensionsFormatted = OAuthController.formatDimensionsForAPI(shippingMeasurementInput, { strict: true });
          logger.info(`[Producto ${product.id}] Dimensiones formateadas: ${dimensionsFormatted}`);
        } catch (dimError) {
          logger.warn(`[Producto ${product.id}] Package inválido para shipping oficial ML: ${dimError.message}`);
          dimensionsFormatted = null;
        }
      }
      
      const productCondition = String(product.condition || "new").toLowerCase();
      const requestFingerprint = buildRequestFingerprint({
        credential_id,
        site_id,
        strategy: selectedStrategy,
        campaign_tag: normalizeCampaignTagValue(normalizedInstallments?.campaign_tag),
        listing_type_id: requestedListingTypeId,
        shipping_mode: requestedShippingMode,
        logistic_type: requestedLogisticType,
        category_id: requestedCategoryId,
        product: {
          id: product.id,
          name: nameFixed,
          condition: productCondition,
          price: productPrice,
          shipping_measurements: shippingMeasurementInput || null,
          item_id: product.item_id || null,
          ml_item_id: product.ml_item_id || null
        }
      });
      const productCacheKey = `${nameFixed}__${requestFingerprint}__${resolvedResponseDetail}`;
      apiCalls++;

      let categories = [];

      if (requestedCategoryId) {
        try {
          const categoryDetailUrl = `https://api.mercadolibre.com/categories/${requestedCategoryId}`;
          const categoryResponse = await axios.get(categoryDetailUrl, {
            headers: { Authorization: `Bearer ${credential.access_token}` },
            timeout: 20000
          });
          const categoryDetail = categoryResponse.data || {};
          categories = [{
            category_id: requestedCategoryId,
            category_name: requestedCategoryName || categoryDetail.name || requestedCategoryId,
            domain_id: requestedDomainId || categoryDetail.settings?.catalog_domain || null,
            domain_name: requestedDomainName || categoryDetail.name || null,
            path: requestedPath || categoryDetail.path_from_root?.map(entry => entry.name).join(" > ") || categoryDetail.name || ""
          }];
        } catch (categorySelectionErr) {
          logger.warn(`No se pudo cargar detalle de categoría seleccionada ${requestedCategoryId}: ${categorySelectionErr.message}`);
          return res.status(422).json({
            success: false,
            error: "La categoría seleccionada no es válida o no se pudo consultar en Mercado Libre.",
            product_id: product.id,
            selection: productSelection,
            detail: categorySelectionErr.message
          });
        }
      } else {
        // === Obtener categorías sugeridas ===
        try {
          const domainDiscoveryUrl = `https://api.mercadolibre.com/sites/${site_id}/domain_discovery/search`;
          logMercadoLibreEndpointTrace({
            stage: "categories.domain_discovery.request",
            endpoint: domainDiscoveryUrl,
            productId: product.id,
            params: { q: nameFixed },
            extra: { product_name: nameFixed, site_id }
          });
          const catResponse = await axios.get(domainDiscoveryUrl, {
            params: { q: nameFixed },
            headers: { Authorization: `Bearer ${credential.access_token}` },
            timeout: 30000
          });
          logMercadoLibreEndpointTrace({
            stage: "categories.domain_discovery.response",
            endpoint: domainDiscoveryUrl,
            productId: product.id,
            response: catResponse.data,
            extra: { site_id }
          });

          const rawCategories = catResponse.data || [];
          categories = rawCategories.map(cat => ({
            category_id: cat.category_id,
            category_name: cat.category_name,
            domain_id: cat.domain_id,
            domain_name: cat.domain_name,
            path: cat.domain_name || ''
          }));
        } catch (catErr) {
          logger.error(`Error al obtener categorías para "${nameFixed}": ${catErr.message}`);
          continue;
        }
      }

      const categoriesWithAttrs = [];
      
      for (const cat of categories) {
        if (!cat.category_id) continue;
        const categoryWarnings = [];

        const categoryCacheKey = `${cat.category_id}__${requestFingerprint}__${resolvedResponseDetail}`;

        // === Obtener atributos de la categoría ===
        let attributes = [];
        let categoryInfo = null;
        try {
          const attrUrl = `https://api.mercadolibre.com/categories/${cat.category_id}/attributes`;
          const categoryUrl = `https://api.mercadolibre.com/categories/${cat.category_id}`;
          logMercadoLibreEndpointTrace({
            stage: "categories.attributes.request",
            endpoint: attrUrl,
            categoryId: cat.category_id,
            extra: { site_id }
          });
          logMercadoLibreEndpointTrace({
            stage: "categories.detail.request",
            endpoint: categoryUrl,
            categoryId: cat.category_id,
            extra: { site_id }
          });
          const [attrResponse, categoryResponse] = await Promise.all([
            axios.get(attrUrl, {
              headers: { Authorization: `Bearer ${credential.access_token}` },
              timeout: 20000
            }),
            axios.get(categoryUrl, {
              headers: { Authorization: `Bearer ${credential.access_token}` },
              timeout: 20000
            })
          ]);
          logMercadoLibreEndpointTrace({
            stage: "categories.attributes.response",
            endpoint: attrUrl,
            categoryId: cat.category_id,
            response: attrResponse.data
          });
          logMercadoLibreEndpointTrace({
            stage: "categories.detail.response",
            endpoint: categoryUrl,
            categoryId: cat.category_id,
            response: categoryResponse.data
          });
          attributes = attrResponse.data || [];
          categoryInfo = categoryResponse.data || null;
        } catch (attrErr) {
          logger.error(`Error al cargar atributos para categoría ${cat.category_id}: ${attrErr.message}`);
        }

        // === NUEVO: Listing types permitidos por usuario + categoría ===
        let listingTypesForCategory = [];
        try {
          if (mlUserId) {
            const listingTypesCacheKey = `listing_types_${site_id}_${cat.category_id}`;
            listingTypesCalls++;
            logMercadoLibreEndpointTrace({
              stage: "pricing.available_listing_types.request",
              endpoint: `https://api.mercadolibre.com/users/${mlUserId}/available_listing_types`,
              categoryId: cat.category_id,
              params: { category_id: cat.category_id },
              extra: { user_id: mlUserId }
            });
            const userLtResponse = await axios.get(
              `https://api.mercadolibre.com/users/${mlUserId}/available_listing_types`,
              {
                params: { category_id: cat.category_id },
                headers: { Authorization: `Bearer ${credential.access_token}` },
                timeout: 12000
              }
            );
            logMercadoLibreEndpointTrace({
              stage: "pricing.available_listing_types.response",
              endpoint: `https://api.mercadolibre.com/users/${mlUserId}/available_listing_types`,
              categoryId: cat.category_id,
              response: userLtResponse.data,
              extra: { user_id: mlUserId }
            });

            const availableData = userLtResponse.data?.available || userLtResponse.data || [];
            listingTypesForCategory = normalizeSupportedListingTypes(availableData, site_id);

            saveToCache(`credential_${credential_id}`, 'category_listing_types', listingTypesCacheKey, listingTypesForCategory, 1800);

          }
        } catch (ltError) {
          logger.warn(`No se pudieron obtener listing types para categoría ${cat.category_id}: ${ltError.message}`);
          listingTypesForCategory = [];
        }
        let listingResolution = null;
        let effectiveListingType = null;
        if (requestedListingTypeId) {
          const requestedListingAvailable = listingTypesForCategory.length === 0
            || listingTypesForCategory.some(item => item.value === requestedListingTypeId);
          if (!requestedListingAvailable) {
            return res.status(422).json({
              success: false,
              error: "El listing_type_id seleccionado no está disponible para la categoría o credencial.",
              product_id: product.id,
              category_id: cat.category_id,
              requested_listing_type_id: requestedListingTypeId,
              available_listing_type_ids: listingTypesForCategory.map(item => item.value)
            });
          }
          effectiveListingType = requestedListingTypeId;
          listingResolution = {
            listing_type_id: effectiveListingType,
            fallback_applied: false,
            note: "Tipo de publicación seleccionado por cliente.",
            requested_listing_type_id: requestedListingTypeId
          };
        } else {
          try {
            listingResolution = resolveListingTypeByStrategy(selectedStrategy, listingTypesForCategory);
            effectiveListingType = listingResolution.listing_type_id;
          } catch (listingError) {
            logger.warn(`No se pudo resolver listing type para categoría ${cat.category_id}: ${listingError.message}`);
            // Fallback defensivo cuando ML no devolvió tipos válidos
            effectiveListingType = "gold_special";
            listingResolution = {
              listing_type_id: effectiveListingType,
              fallback_applied: true,
              note: "No se pudieron validar tipos de publicación para esta categoría. Se aplicó fallback por defecto.",
              error: listingError.message
            };
          }
        }
        let userShippingPreferences = null;
        let categoryShippingPreferences = null;

        if (mlUserId) {
          try {
            [userShippingPreferences, categoryShippingPreferences] = await Promise.all([
              MercadoLibreCapabilitiesService.getUserShippingPreferences(credential, mlUserId),
              MercadoLibreCapabilitiesService.getCategoryShippingPreferences(credential, cat.category_id)
            ]);
          } catch (shippingPreferencesError) {
            logger.warn(`[ML SHIPPING PREFS] No se pudieron cargar preferencias oficiales para categoría ${cat.category_id}: ${shippingPreferencesError.message}`);
          }
        }

        const shippingSelection = buildMarketplaceShippingSelection({
          userPreferences: userShippingPreferences,
          categoryPreferences: categoryShippingPreferences
        });

        let filteredShippingModes = Array.isArray(shippingSelection?.shippingModes) ? shippingSelection.shippingModes : [];
        let logisticTypesForCategory = Array.isArray(shippingSelection?.logisticTypes) ? shippingSelection.logisticTypes : [];
        let availableShippingCombos = Array.isArray(shippingSelection?.combos) ? shippingSelection.combos : [];
        let effectiveShippingMode = null;
        let effectiveLogisticType = null;

        logger.info(`[ML SHIPPING PREFS] category=${cat.category_id} product=${product.id}`, {
          credential_id,
          user_modes: Array.isArray(userShippingPreferences?.modes) ? userShippingPreferences.modes : [],
          category_logistics: Array.isArray(categoryShippingPreferences?.logistics) ? categoryShippingPreferences.logistics : [],
          category_restricted: categoryShippingPreferences?.restricted ?? null,
          category_me2_restrictions: categoryShippingPreferences?.me2_restrictions ?? null,
          filtered_modes_from_preferences: filteredShippingModes.map(sm => sm.value),
          filtered_logistics_from_preferences: logisticTypesForCategory.map(lt => lt.value),
          filtered_combos_from_preferences: availableShippingCombos
        });

        if (filteredShippingModes.length === 0) {
          categoryWarnings.push('shipping_modes_empty_by_preferences');
        }

        if (availableShippingCombos.length === 0) {
          categoryWarnings.push('shipping_combinations_empty_from_marketplace');
        }

        availableShippingCombos = finalizeShippingCombos(
          availableShippingCombos.filter(combo =>
            filteredShippingModes.length === 0 || filteredShippingModes.some(modeEntry => modeEntry.value === combo.shipping_mode)
          )
        );

        const supportedShippingResolution = await filterSupportedMarketplaceShippingCombosForProduct({
          credential,
          product: { ...product, price: productPrice ?? product.price },
          categoryId: cat.category_id,
          listingType: effectiveListingType,
          combos: availableShippingCombos
        });
        availableShippingCombos = supportedShippingResolution.combos;
        categoryWarnings.push(...supportedShippingResolution.warnings);

        const shippingComboResolution = selectPreferredShippingCombo({
          requestedMode: requestedShippingMode,
          requestedLogisticType: requestedLogisticType,
          availableCombos: availableShippingCombos,
          availableModes: filteredShippingModes
        });

        const hasRequestedLogisticType = requestedLogisticType !== undefined && requestedLogisticType !== null && String(requestedLogisticType).trim() !== "";
        const hasRequestedShippingSelection = Boolean(requestedShippingMode || hasRequestedLogisticType);

        if (hasRequestedLogisticType && !shippingComboResolution.combo) {
          return res.status(422).json({
            success: false,
            error: "La combinación shipping_mode/logistic_type seleccionada no está permitida para la categoría o credencial.",
            product_id: product.id,
            category_id: cat.category_id,
            requested_shipping_mode: requestedShippingMode,
            requested_logistic_type: requestedLogisticType,
            available_shipping_combinations: availableShippingCombos
          });
        }

        if (shippingComboResolution.selection) {
          effectiveShippingMode = shippingComboResolution.selection.shipping_mode;
          effectiveLogisticType = shippingComboResolution.selection.logistic_type || null;
        } else if (hasRequestedShippingSelection) {
          return res.status(422).json({
            success: false,
            error: "No se pudo resolver la combinación shipping_mode/logistic_type seleccionada.",
            product_id: product.id,
            category_id: cat.category_id,
            requested_shipping_mode: requestedShippingMode,
            requested_logistic_type: requestedLogisticType
          });
        }
        categoryWarnings.push(...shippingComboResolution.warnings);
        const effectiveShippingResolutionState = shippingComboResolution.selection?.shipping_resolution_state
          || inferShippingResolutionStateFromCapabilities({
            shippingModes: filteredShippingModes,
            shippingCombos: availableShippingCombos
          });
        if (!shippingComboResolution.selection) {
          categoryWarnings.push(`shipping_resolution_inferred:${effectiveShippingResolutionState}`);
        }
        if (normalizedInstallments.requested) {
          categoryWarnings.push("installments_request_ignored_backend_resolves_by_listing_type");
        }
        if (shippingMeasurementInput && !dimensionsFormatted) {
          categoryWarnings.push("shipping_input_invalid_package_data");
        }
        if (packageAnalysis && packageAnalysis.volumetric_ratio >= 8) {
          categoryWarnings.push(
            `shipping_billable_weight_high:actual_${Math.round(packageAnalysis.weight_grams)}g_vs_volumetric_${Math.round(packageAnalysis.volumetric_weight_grams)}g`
          );
        }
        if (economicInputs.product_cost === null) {
          categoryWarnings.push("profitability_unknown_missing_purchase_price");
        }

        // === 💰 Obtener pricing/comisiones ===
        const campaignTagRequested = normalizeCampaignTagValue(normalizedInstallments?.campaign_tag);
        let pricingBillableWeight = Number.isFinite(Number(packageAnalysis?.billable_weight_grams))
          ? Math.round(Number(packageAnalysis.billable_weight_grams))
          : null;
        let {
          pricing,
          pricing_options,
          campaignTags,
          campaignTagsByListingType
        } = await loadPricingOptionsForCategory({
          cat,
          product,
          productPrice,
          effectiveListingType,
          effectiveShippingMode,
          effectiveLogisticType,
          listingTypesForCategory,
          requestFingerprint,
          pricingBillableWeight,
          campaignTagRequested
        });

        // === 📦 NUEVO: Calcular costos de envío ===
        let shipping = null;

        const hasShippingInput = productPrice !== null && !!(dimensionsFormatted || product?.ml_item_id || product?.item_id);
        if (hasShippingInput) {
          // ✅ CORRECCIÓN: Incluir listing_type_id, logistic_type y shipping_mode en la clave
          const shippingBasis = dimensionsFormatted || product?.ml_item_id || product?.item_id;
          const shippingCacheKey = `shipping_${site_id}_${cat.category_id}_${shippingBasis}_${requestFingerprint}_${effectiveListingType}_${effectiveLogisticType}_${effectiveShippingMode}`;
          
          logger.info(`[SHIPPING] Cache key: ${shippingCacheKey}`);
          
          try {
            shippingCalls += 2; // 2 llamadas API
            
            shipping = await OAuthController.calculateMercadoLibreShippingCosts(
              credential,
              { ...product, price: productPrice },
              cat.category_id,
              site_id,
              effectiveListingType,
              effectiveLogisticType,
              effectiveShippingMode,
              { bypassCache: true }
            );

            saveToCache(`credential_${credential_id}`, 'shipping_costs', shippingCacheKey, shipping, 900);
            
          } catch (shippingErr) {
            logger.warn(`Error calculando shipping para ${cat.category_id}: ${shippingErr.message}`);
            shipping = { 
              error: 'No se pudo calcular', 
              message: shippingErr.message 
            };
          }
        }
        const derivedShippingBillableWeight = derivePricingBillableWeight(shipping);
        if (
          productPrice !== null &&
          site_id === "MLA" &&
          !Number.isFinite(Number(pricingBillableWeight)) &&
          Number.isFinite(Number(derivedShippingBillableWeight)) &&
          Number(derivedShippingBillableWeight) > 0
        ) {
          pricingBillableWeight = Math.round(Number(derivedShippingBillableWeight));
          const recalculatedPricing = await loadPricingOptionsForCategory({
            cat,
            product,
            productPrice,
            effectiveListingType,
            effectiveShippingMode,
            effectiveLogisticType,
            listingTypesForCategory,
            requestFingerprint,
            pricingBillableWeight,
            campaignTagRequested
          });
          pricing = recalculatedPricing.pricing;
          pricing_options = recalculatedPricing.pricing_options;
          campaignTags = recalculatedPricing.campaignTags;
          campaignTagsByListingType = recalculatedPricing.campaignTagsByListingType;
        }
        const shippingRequested = hasShippingInput;
        const shippingSummary = shipping?.shipping_summary || null;
        const sellerShippingView = buildSellerShippingView(shippingSummary);
        const sellerShippingCost = shippingSummary?.seller_shipping_cost ?? null;
        if (pricing && !pricing.error) {
          pricing.shipping_requested = shippingRequested;
          if (shippingRequested && Number.isFinite(Number(sellerShippingCost))) {
            pricing.seller_shipping_cost = Number(sellerShippingCost);
            pricing.net_amount_after_shipping = parseFloat(
              (Number(pricing.net_amount || 0) - Number(sellerShippingCost || 0)).toFixed(2)
            );
            pricing.shipping_scenario = shippingSummary?.scenario || null;
            pricing.shipping_subsidy = toNumberOrZero(shippingSummary?.shipping_subsidy);
            pricing.seller_shipping = sellerShippingView;
            if (pricing.warning) delete pricing.warning;
          } else if (shippingRequested && (!shipping || shipping.error)) {
            categoryWarnings.push("pricing_incomplete_shipping_not_calculated");
            pricing.warning = "Estimación incompleta: no se pudo calcular shipping.";
          } else if (!shippingRequested) {
            categoryWarnings.push("pricing_incomplete_shipping_not_requested");
            pricing.warning = "Estimación incompleta: falta cálculo de shipping para neto final.";
          }
        }
        if (pricing && !pricing.error) {
          const profitability = buildProfitabilityMetrics({
            pricing,
            shippingSummary,
            productPrice,
            economicInputs
          });
          if (profitability) {
            pricing.profitability = profitability;
          }
        }
        const economicSummary = buildEconomicSummary({
          productId: product.id,
          categoryId: cat.category_id,
          categoryName: cat.category_name,
          listingTypeId: effectiveListingType,
          strategy: selectedStrategy,
          price: productPrice,
          pricing,
          resolvedInstallments: null,
          sellerShippingView,
          profitability: pricing?.profitability || null,
          economicInputs,
          warnings: categoryWarnings
        });

        // === Construir objeto de categoría completo ===
        const installmentTerm = Array.isArray(categoryInfo?.sale_terms)
          ? categoryInfo.sale_terms.find(st => st?.id === "INSTALLMENTS")
          : null;
        const installmentAllowedValues = Array.isArray(installmentTerm?.values)
          ? installmentTerm.values
              .map(v => Number(v?.id ?? v?.name ?? v?.value_name))
              .filter(Number.isFinite)
              .sort((a, b) => a - b)
          : [];
        const maxInstallmentsAllowed = installmentAllowedValues.length > 0
          ? installmentAllowedValues[installmentAllowedValues.length - 1]
          : null;

        const resolvedInstallments = buildAutomaticInstallmentsResolution({
          siteId: site_id,
          listingTypeId: effectiveListingType,
          requestedCampaignTag: normalizeCampaignTagValue(normalizedInstallments?.campaign_tag),
          campaignTagsByListingType
        });
        const categoryEconomicSummary = economicSummary
          ? {
              ...economicSummary,
              installments: {
                enabled: Boolean(resolvedInstallments?.enabled),
                interest_free: Boolean(resolvedInstallments?.interest_free),
                max_installments: resolvedInstallments?.max_installments ?? null,
                seller_fee_focus: true
              }
            }
          : null;
        const shippingCombinations = finalizeShippingCombos(availableShippingCombos);

        const shippingOptions = buildShippingOptionsFromCombos(shippingCombinations).map(option => ({
          ...option,
          is_default: option.shipping_mode === effectiveShippingMode
            && option.logistic_type === effectiveLogisticType
        }));

        const packageAnalysisView = packageAnalysis ? {
          actual_weight_grams: Math.round(packageAnalysis.weight_grams),
          volumetric_weight_grams: Math.round(packageAnalysis.volumetric_weight_grams),
          calculated_volumetric_weight_grams: Math.round(packageAnalysis.calculated_volumetric_weight_grams),
          volumetric_weight_source: packageAnalysis.volumetric_weight_source,
          billable_weight_grams: Math.round(packageAnalysis.billable_weight_grams),
          volumetric_ratio: Number(packageAnalysis.volumetric_ratio.toFixed(2))
        } : null;
        const quoteBlock = {
          price: productPrice,
          pricing: productPrice !== null ? buildPricingSummary(pricing) : null,
          pricing_options: productPrice !== null ? buildPricingOptionsSummary(pricing_options) : [],
          shipping: hasShippingInput ? buildCompactShippingView(shipping, sellerShippingView) : null,
          package_analysis: packageAnalysisView,
          profitability: pricing?.profitability || null,
          economic_summary: categoryEconomicSummary,
          shipping_policy: hasShippingInput ? {
            requested_free_shipping: shipping?.requested_free_shipping ?? null,
            mandatory_free_shipping_detected: shipping?.mandatory_free_shipping_detected ?? false
          } : null
        };

        const categoryData = {
          response_format_version: "v2_compact",
          requested: {
            strategy: selectedStrategy,
            listing_type_id: requestedListingTypeId,
            shipping_mode: requestedShippingMode,
            logistic_type: requestedLogisticType,
            installments: normalizedInstallments,
            economic_inputs: economicInputs
          },
          resolved: {
            category_id: cat.category_id,
            listing_type_id: effectiveListingType,
            shipping_mode: effectiveShippingMode,
            logistic_type: effectiveLogisticType,
            shipping_resolution_state: effectiveShippingResolutionState,
            shipping_ui: buildShippingUi(effectiveShippingMode, effectiveLogisticType, effectiveShippingResolutionState),
            strategy: selectedStrategy
          },
          category_id: cat.category_id,
          category_name: cat.category_name,
          domain_id: cat.domain_id,
          domain_name: cat.domain_name,
          path: cat.path,
          listing_types: listingTypesForCategory,
          shipping_modes: filteredShippingModes,
          shipping_modes_scope: "valid_modes_for_this_product_and_category",
          shipping_modes_filtered_by_product: true,
          shipping_modes_count: filteredShippingModes.length,
          logistic_types: logisticTypesForCategory,
          shipping_options: shippingOptions,
          defaults: {
            strategy: selectedStrategy,
            listing_type_id: effectiveListingType,
            shipping_mode: effectiveShippingMode,
            logistic_type: effectiveLogisticType,
            shipping_resolution_state: effectiveShippingResolutionState,
            logistic_model: deriveLogisticModel(effectiveShippingMode, effectiveLogisticType, effectiveShippingResolutionState),
            shipping_operation: deriveShippingOperation(effectiveShippingMode, effectiveLogisticType, effectiveShippingResolutionState),
            shipping_ui: buildShippingUi(effectiveShippingMode, effectiveLogisticType, effectiveShippingResolutionState),
            installments: resolvedInstallments,
            sale_terms_preview: buildInstallmentsSaleTermsPreview(resolvedInstallments)
          },
          installments_rules: {
            source: resolvedInstallments.source,
            scope: "category",
            user_can_choose: false,
            requires_strategy_conversion_for_interest_free: false,
            strategy_selected: selectedStrategy,
            enabled: resolvedInstallments.enabled,
            interest_free: resolvedInstallments.interest_free,
            max_installments_requested: normalizedInstallments.max_installments ?? null,
            max_installments_allowed: maxInstallmentsAllowed,
            max_installments_resolved: resolvedInstallments.max_installments ?? null,
            allowed_values: installmentAllowedValues.length > 0 ? installmentAllowedValues : null,
            campaign_tags_available: campaignTags.length > 0 ? campaignTags : null,
            campaign_tags_by_listing_type: {
              gold_pro: campaignTagsByListingType.gold_pro || [],
              gold_special: campaignTagsByListingType.gold_special || [],
              free: campaignTagsByListingType.free || []
            },
            campaign_tag_requested: resolvedInstallments.campaign_tag_requested,
            campaign_tag_applied: resolvedInstallments.campaign_tag_applied,
            request_ignored: normalizedInstallments.requested,
            seller_fee_focus: true,
            note: resolvedInstallments.note
          },
          selection_warnings: categoryWarnings,
          listing_resolution: listingResolution,
          attributes,
          ...(categoryInfo && { category_settings: categoryInfo.settings || {} }),
          quote: quoteBlock,
          ...(shippingCombinations.length > 0 && { shipping_combinations: shippingCombinations }),
          ...(hasShippingInput && { shipping_policy: quoteBlock.shipping_policy })
        };

        const categoryPayload = buildMlSuggestedCategoryPayload(categoryData, resolvedResponseDetail);
        saveToCache(`credential_${credential_id}`, `category_attributes_${site_id}_v8`, categoryCacheKey, categoryPayload);
        categoriesWithAttrs.push(categoryPayload);
      }

      saveToCache(`credential_${credential_id}`, `product_suggestion_${site_id}_v8`, productCacheKey, categoriesWithAttrs);

      suggestions.push(
        buildMlSuggestedProductSuggestion({
          product,
          credentialId: credential_id,
          marketplaceId: marketplace_id,
          selectedStrategy,
          normalizedInstallments,
          strategyWarnings,
          categories: categoriesWithAttrs
        })
      );
    }

    const shippingRequested = products.some(
      p =>
        p.price !== undefined &&
        p.price !== null &&
        (buildShippingMeasurementInput(p) || p.item_id !== undefined || p.ml_item_id !== undefined)
    );
    const allCategoriesFlattened = suggestions.flatMap(s => Array.isArray(s.categories) ? s.categories : []);
    const firstCategoryWithInstallments = allCategoriesFlattened.find(
      c => Array.isArray(c?.installments_rules?.allowed_values) && c.installments_rules.allowed_values.length > 0
    );
    const firstCategoryWithCampaigns = allCategoriesFlattened.find(
      c => c?.installments_rules?.campaign_tags_by_listing_type
    );
    const firstCategoryWithResolvedInstallments = allCategoriesFlattened.find(
      c => c?.defaults?.installments
    );
    const uiInstallmentsAllowedValues = firstCategoryWithInstallments?.installments_rules?.allowed_values || null;
    const uiMaxInstallmentsAllowed = firstCategoryWithInstallments?.installments_rules?.max_installments_allowed ?? null;
    const uiCampaignTagsByListingType = firstCategoryWithCampaigns?.installments_rules?.campaign_tags_by_listing_type || {
      gold_pro: [],
      gold_special: [],
      free: []
    };
    const uiResolvedInstallments = firstCategoryWithResolvedInstallments?.defaults?.installments || {
      source: "official_listing_type_policy",
      enabled: false,
      interest_free: false,
      max_installments: null,
      campaign_tag_requested: normalizeCampaignTagValue(normalizedInstallments?.campaign_tag),
      campaign_tag_applied: null,
      available_campaign_tags: [],
      seller_fee_focus: true,
      note: "Resolución automática por categoría/listing_type."
    };
    if (hasExplicitSelections) {
      const results = suggestions.map((suggestion) => {
        const category = Array.isArray(suggestion.categories) ? suggestion.categories[0] || null : null;
        return {
          product_id: suggestion.product_id,
          credential_id: suggestion.credential_id,
          marketplace_id: suggestion.marketplace_id,
          selection: category ? {
            category_id: category.category_id,
            category_name: category.category_name,
            listing_type_id: category.resolved?.listing_type_id || null,
            shipping_mode: category.resolved?.shipping_mode || null,
            logistic_type: category.resolved?.logistic_type || null,
            shipping_ui: category.resolved?.shipping_ui || null,
            strategy: category.resolved?.strategy || selectedStrategy
          } : null,
          pricing: category?.quote?.pricing ? {
            sale_fee_amount: category.quote.pricing.sale_fee_amount,
            listing_fee_amount: category.quote.pricing.listing_fee_amount,
            total_fee_amount: category.quote.pricing.total_fee_amount,
            fee_percentage: category.quote.pricing.fee_percentage,
            net_amount_before_shipping: category.quote.pricing.net_amount_before_shipping,
            net_amount_after_shipping: category.quote.pricing.net_amount_after_shipping
          } : null,
          shipping: category?.quote?.shipping?.selected_summary ? {
            scenario: category.quote.shipping.selected_summary.scenario,
            free_shipping: category.quote.shipping.selected_summary.free_shipping,
            mandatory_free_shipping: category.quote.shipping.selected_summary.mandatory_free_shipping,
            seller_shipping_cost: category.quote.shipping.selected_summary.seller_shipping_cost,
            shipping_subsidy: category.quote.shipping.selected_summary.shipping_subsidy,
            shipping_mode: category.quote.shipping.selected_summary.shipping_mode,
            logistic_type: category.quote.shipping.selected_summary.logistic_type,
            shipping_ui: category.quote.shipping.shipping_ui || null
          } : null,
          package_analysis: category?.quote?.package_analysis || null,
          profitability: category?.quote?.profitability ? {
            product_cost: category.quote.profitability.product_cost_basis,
            total_cost_basis: category.quote.profitability.total_cost_basis,
            net_amount_without_shipping: category.quote.profitability.net_amount_without_shipping,
            net_amount_with_shipping: category.quote.profitability.net_amount_with_shipping,
            estimated_profit: category.quote.profitability.final_profit,
            margin_percent: category.quote.profitability.real_margin_percentage,
            recommended_minimum_price: category.quote.profitability.recommended_minimum_price,
            estimated_break_even_price: category.quote.profitability.estimated_break_even_price,
            profitability_status: category.quote.profitability.profitability_status
          } : null,
          warnings: [
            ...(suggestion.selection_context?.warnings || []),
            ...(category?.selection_warnings || [])
          ]
        };
      });

      return res.status(200).json({
        success: true,
        response_format_version: "v1_calculation",
        results,
        count: results.length,
        stats: {
          total_products: products.length,
          cache_hits: cacheHits,
          api_calls: apiCalls,
          pricing_calls: pricingCalls,
          listing_types_calls: listingTypesCalls,
          shipping_validation_calls: shippingValidationCalls,
          shipping_calls: shippingCalls,
          cache_hit_rate: products.length > 0
            ? ((cacheHits / products.length) * 100).toFixed(2) + '%'
            : '0%',
          pricing_requested: products.some(p => p.price !== undefined && p.price !== null),
          shipping_requested: shippingRequested
        },
        warnings: shippingRequested
          ? []
          : ["Estimación incompleta: shipping_requested=false, neto final puede variar por costo de envío."]
      });
    }

    return res.status(200).json({
      success: true,
      response_format_version: resolvedResponseDetail === "full" ? "v2_compact" : "v2_essential",
      selection_model: {
        strategies: [
          {
            value: ML_STRATEGY.MARGIN,
            label: "Ganar más por producto",
            description: "Menor comisión"
          },
          {
            value: ML_STRATEGY.CONVERSION,
            label: "Vender más rápido",
            description: "Mayor exposición"
          }
        ],
        strategy: selectedStrategy,
        installments: uiResolvedInstallments,
        installments_rules: {
          source: uiResolvedInstallments.source,
          scope: "request",
          user_can_choose: false,
          requires_strategy_conversion_for_interest_free: false,
          strategy_selected: selectedStrategy,
          enabled: uiResolvedInstallments.enabled,
          interest_free: uiResolvedInstallments.interest_free,
          max_installments_requested: normalizedInstallments.max_installments ?? null,
          max_installments_allowed: uiMaxInstallmentsAllowed,
          max_installments_resolved: uiResolvedInstallments.max_installments ?? null,
          allowed_values: uiInstallmentsAllowedValues,
          campaign_tags_by_listing_type: uiCampaignTagsByListingType,
          campaign_tag_requested: uiResolvedInstallments.campaign_tag_requested,
          campaign_tag_applied: uiResolvedInstallments.campaign_tag_applied,
          request_ignored: normalizedInstallments.requested,
          seller_fee_focus: true,
          note: uiResolvedInstallments.note
        },
        selection_scope: {
          strategy: "request",
          installments: "category",
          shipping_mode_requested: "request",
          logistic_type_requested: "request",
          listing_type_effective: "category",
          shipping_mode_effective: "category",
          logistic_type_effective: "category"
        },
        sale_terms_preview: buildInstallmentsSaleTermsPreview(uiResolvedInstallments),
        ui_hints: {
          show_installments_select: false,
          installments_options: [],
          show_campaign_tag_select: false,
          campaign_tag_options_by_listing_type: uiCampaignTagsByListingType
        },
        warnings: strategyWarnings
      },
      suggestions,
      count: suggestions.length,
      stats: {
        total_products: products.length,
        cache_hits: cacheHits,
        api_calls: apiCalls,
        pricing_calls: pricingCalls,
        listing_types_calls: listingTypesCalls,
        shipping_validation_calls: shippingValidationCalls,
        shipping_calls: shippingCalls,
        cache_hit_rate: products.length > 0 
          ? ((cacheHits / products.length) * 100).toFixed(2) + '%'
          : '0%',
        pricing_requested: products.some(p => p.price !== undefined && p.price !== null),
        shipping_requested: shippingRequested
      },
      warnings: shippingRequested
        ? []
        : ["Estimación incompleta: shipping_requested=false, neto final puede variar por costo de envío."]
    });

  } catch (error) {
    logger.error(`❌ Error general en mercadoLibreSuggestedCategoriesWithAttributes: ${error.message}`, {
      stack: error.stack,
      body: req.body
    });
    return res.status(500).json({
      success: false,
      error: "Error interno al procesar categorías con atributos, pricing y shipping de MercadoLibre."
    });
  }
},
async clearMercadoLibreCache(req, res) {
  const { marketplace_id } = req.params;
  
  try {
    const count = clearMarketplaceCache(marketplace_id);
    logger.info(`Caché limpiado para marketplace ${marketplace_id} (${count} entradas)`);
    
    return res.status(200).json({
      success: true,
      message: `Caché de marketplace ${marketplace_id} limpiado correctamente`,
      entries_cleared: count
    });
  } catch (error) {
    logger.error(`Error al limpiar caché del marketplace: ${error.message}`);
    return res.status(500).json({
      success: false,
      error: "Error al limpiar el caché del marketplace"
    });
  }
},

/**
 * Limpiar caché de un site específico de MercadoLibre
 */
async clearMercadoLibreSiteCache(req, res) {
  const { marketplace_id, site_id } = req.params;
  
  try {
    const count = clearMarketplaceCache(marketplace_id, site_id);
    logger.info(`Caché limpiado para marketplace ${marketplace_id} site ${site_id} (${count} entradas)`);
    
    return res.status(200).json({
      success: true,
      message: `Caché de marketplace ${marketplace_id} site ${site_id} limpiado correctamente`,
      entries_cleared: count
    });
  } catch (error) {
    logger.error(`Error al limpiar caché del site: ${error.message}`);
    return res.status(500).json({
      success: false,
      error: "Error al limpiar el caché del site"
    });
  }
},

/**
 * Obtener estadísticas del caché
 */
async getMercadoLibreCacheStats(req, res) {
  try {
    const stats = getCacheStats();
    
    return res.status(200).json({
      success: true,
      stats: {
        total_keys: stats.keys,
        hits: stats.hits,
        misses: stats.misses,
        hit_rate: stats.keys > 0 ? ((stats.hits / (stats.hits + stats.misses)) * 100).toFixed(2) + '%' : '0%'
      }
    });
  } catch (error) {
    logger.error(`Error al obtener estadísticas del caché: ${error.message}`);
    return res.status(500).json({
      success: false,
      error: "Error al obtener estadísticas del caché"
    });
  }
},
  /*async falabellaSuggestedCategoriesWithAttributes(req, res) {
    logger.info(`Datos recibidos para categorías sugeridas con atributos en Falabella:\n ${JSON.stringify(req.body)}`);

    const { marketplace_id, products } = req.body;
    const user_id = req.user?.id;

    if (!Array.isArray(products) || products.length === 0) {
      return res.status(400).json({
        success: false,
        error: "Se requiere un array no vacío de productos con 'id' y 'name'."
      });
    }

    try {
      // === PASO 1: Aplicar Rate Limit por usuario ===
      try {
        await marketplaceRateLimiter.consume(user_id);
      } catch (rateLimitError) {
        logger.warn(`Rate limit excedido para usuario ${user_id}`);
        return res.status(429).json({
          success: false,
          error: "Demasiadas solicitudes. Por favor, espera un momento."
        });
      }

      // === PASO 2: Obtener Credenciales ===
      const credential = await MarketplaceCredentialRepository.findByMarketplaceAndUser(
        marketplace_id,
        user_id
      );

      if (!credential) {
        return res.status(400).json({
          success: false,
          error: "Credenciales no encontradas"
        });
      }

      const baseUrl = "https://sellercenter-api.falabella.com";
      const userId = credential.seller_email;
      const apiKey = credential.api_key;

      if (!userId || !apiKey) {
        return res.status(500).json({
          success: false,
          error: "Faltan credenciales de Falabella (seller_email o api_key)"
        });
      }

      const suggestions = [];
      let cacheHits = 0;
      let apiCalls = 0;

      // === PASO 3: Procesar Cada Producto ===
      for (const product of products) {
        if (!product.id || !product.name) {
          logger.warn(`Producto inválido omitido: ${JSON.stringify(product)}`);
          continue;
        }

        const nameFixed = product.name.trim();

        // === PASO 4: Verificar Caché GLOBAL para este Producto ===
        // Clave: {marketplace_id}_product_suggestion_{nombre_producto}
        const cachedProductResult = getFromCache(marketplace_id, 'product_suggestion', nameFixed);

        if (cachedProductResult) {
          // ✅ CACHE HIT - Usar datos del caché (cualquier usuario puede usarlo)
          logger.info(`[CACHE HIT] Producto "${nameFixed}" en marketplace ${marketplace_id} (compartido)`);
          cacheHits++;
          
          suggestions.push({
            product_id: product.id,
            categories: cachedProductResult
          });
          continue; // Saltar a siguiente producto
        }

        // ❌ CACHE MISS - Hacer llamada a API
        logger.info(`[CACHE MISS] Producto "${nameFixed}" en marketplace ${marketplace_id}`);
        apiCalls++;

        const categories = [];

        // === PASO 5: Obtener Categorías Sugeridas ===
        const paramsSuggest = {
          UserID: userId,
          Version: "1.0",
          Action: "GetCategorySuggestion",
          Format: "JSON",
          Name: nameFixed,
          Timestamp: timestampMinus03(),
        };

        const keysSuggest = Object.keys(paramsSuggest).sort();
        const canonicalQuerySuggest = keysSuggest
          .map(k => `${rfc3986Encode(k)}=${rfc3986Encode(String(paramsSuggest[k]))}`)
          .join("&");
        const signatureSuggest = rfc3986Encode(
          crypto.createHmac("sha256", apiKey).update(canonicalQuerySuggest).digest("hex")
        );
        const urlSuggest = `${baseUrl}?${canonicalQuerySuggest}&Signature=${signatureSuggest}`;

        let suggestionResponse;
        try {
          suggestionResponse = await axios.get(urlSuggest, { timeout: 20000 });
        } catch (err) {
          logger.error(`Error al obtener sugerencias para "${nameFixed}":`, err.message);
          continue;
        }

        const dataSuggest = suggestionResponse.data;
        let suggestedItems = [];

        if (dataSuggest.SuccessResponse?.Body?.SuggestedCategory) {
          const raw = dataSuggest.SuccessResponse.Body.SuggestedCategory;
          suggestedItems = Array.isArray(raw) ? raw : [raw];
        }

        // === PASO 6: Obtener Atributos para Cada Categoría ===
        for (const item of suggestedItems) {
          if (!item.CategoryId || !item.CategoryName) continue;

          const categoryId = item.CategoryId.toString();

          // === PASO 7: Verificar Caché GLOBAL para esta Categoría ===
          // Clave: {marketplace_id}_category_attributes_{category_id}
          const cachedCategory = getFromCache(marketplace_id, 'category_attributes', categoryId);

          if (cachedCategory) {
            // ✅ CACHE HIT - Usar atributos del caché (compartido entre usuarios)
            logger.info(`[CACHE HIT] Categoría ${categoryId} en marketplace ${marketplace_id} (compartido)`);
            categories.push(cachedCategory);
            continue;
          }

          // ❌ CACHE MISS - Hacer llamada a API
          logger.info(`[CACHE MISS] Categoría ${categoryId} en marketplace ${marketplace_id}`);

          // Obtener atributos
          const paramsAttrs = {
            UserID: userId,
            Version: "1.0",
            Action: "GetCategoryAttributes",
            Format: "JSON",
            PrimaryCategory: categoryId,
            Timestamp: timestampMinus03(),
          };

          const keysAttrs = Object.keys(paramsAttrs).sort();
          const canonicalQueryAttrs = keysAttrs
            .map(k => `${rfc3986Encode(k)}=${rfc3986Encode(String(paramsAttrs[k]))}`)
            .join("&");
          const signatureAttrs = rfc3986Encode(
            crypto.createHmac("sha256", apiKey).update(canonicalQueryAttrs).digest("hex")
          );
          const urlAttrs = `${baseUrl}?${canonicalQueryAttrs}&Signature=${signatureAttrs}`;

          let attributes = [];
          try {
            const attrResponse = await axios.get(urlAttrs, { timeout: 20000 });
            const attrData = attrResponse.data;

            if (attrData.SuccessResponse?.Body?.Attribute) {
              const rawAttrs = attrData.SuccessResponse.Body.Attribute;
              const attrList = Array.isArray(rawAttrs) ? rawAttrs : [rawAttrs];

              attributes = attrList
                .filter(attr => attr.Name && attr.Label)
                .map(attr => ({
                  id: attr.FeedName || attr.Name,
                  name: attr.Label,
                  label: attr.Label,
                  is_mandatory: attr.isMandatory === "1" || attr.isMandatory === true,
                  description: attr.Description || '',
                  attribute_type: attr.AttributeType || 'string',
                  example_value: attr.ExampleValue || '',
                  value_type:
                    attr.AttributeType === 'option' || attr.AttributeType === 'multi_option'
                      ? 'list'
                      : attr.AttributeType === 'numberfield'
                        ? 'number'
                        : 'string',
                  values: attr.Options?.Option
                    ? (Array.isArray(attr.Options.Option)
                        ? attr.Options.Option.map(opt => ({ id: opt.id, name: opt.Name }))
                        : [{ id: attr.Options.Option.id, name: attr.Options.Option.Name }])
                    : [],
                  tags: {
                    required: attr.isMandatory === "1" || attr.isMandatory === true,
                    catalog_required: attr.isMandatory === "1" || attr.isMandatory === true,
                    hidden: false
                  }
                }))
                .sort((a, b) => (a.is_mandatory ? 0 : 1) - (b.is_mandatory ? 0 : 1));
            }
          } catch (attrErr) {
            logger.warn(`Error al cargar atributos para categoría ${categoryId}:`, attrErr.message);
          }

          // === PASO 8: Guardar Categoría en Caché GLOBAL ===
          const categoryData = {
            id: categoryId,
            name: item.CategoryName,
            path: item.SuggestedCategory || "",
            search_term: item.Name || "",
            attributes
          };

          saveToCache(marketplace_id, 'category_attributes', categoryId, categoryData);
          categories.push(categoryData);
        }

        // === PASO 9: Guardar Resultado del Producto en Caché GLOBAL ===
        saveToCache(marketplace_id, 'product_suggestion', nameFixed, categories);

        suggestions.push({
          product_id: product.id,
          categories
        });
      }

      // === PASO 10: Retornar Resultado con Estadísticas ===
      return res.status(200).json({
        success: true,
        suggestions,
        count: suggestions.length,
        stats: {
          total_products: products.length,
          cache_hits: cacheHits,
          api_calls: apiCalls,
          cache_hit_rate: products.length > 0 
            ? ((cacheHits / products.length) * 100).toFixed(2) + '%'
            : '0%'
        }
      });

    } catch (error) {
      logger.error(`❌ Error general en falabellaSuggestedCategoriesWithAttributes: ${error.message}`);
      
      if (error.response?.data?.ErrorResponse?.Head) {
        const head = error.response.data.ErrorResponse.Head;
        const errorCode = head.ErrorCode;
        let errorMessage = head.ErrorMessage;
        let statusCode = 500;

        if (errorCode === "7") {
          errorMessage = "Firma inválida (E007). Verifica API Key y seller_email.";
          statusCode = 401;
        } else if (errorCode === "9") {
          errorMessage = 'Acceso denegado (E009). Verifica rol "Seller API Product Access".';
          statusCode = 403;
        } else if ([3, 4].includes(Number(errorCode))) {
          errorMessage = "Error de timestamp (E003/E004).";
          statusCode = 400;
        }

        return res.status(statusCode).json({ success: false, error: errorMessage });
      }

      return res.status(500).json({
        success: false,
        error: "Error interno al procesar categorías con atributos."
      });
    }
  },*/
  /*async falabellaSuggestedCategoriesWithAttributes(req, res) {
  logger.info(`Datos recibidos para categorías sugeridas con atributos en Falabella:\n ${JSON.stringify(req.body)}`);

  // ← CAMBIO: Recibir credential_id en lugar de marketplace_id
  const { credential_id, products } = req.body;
  const user_id = req.user?.id;

  if (!credential_id) {
    return res.status(400).json({
      success: false,
      error: "credential_id es requerido"
    });
  }

  if (!Array.isArray(products) || products.length === 0) {
    return res.status(400).json({
      success: false,
      error: "Se requiere un array no vacío de productos con 'id' y 'name'."
    });
  }

  try {
    // === PASO 1: Aplicar Rate Limit por usuario ===
    try {
      await marketplaceRateLimiter.consume(user_id);
    } catch (rateLimitError) {
      logger.warn(`Rate limit excedido para usuario ${user_id}`);
      return res.status(429).json({
        success: false,
        error: "Demasiadas solicitudes. Por favor, espera un momento."
      });
    }

    // === PASO 2: Obtener Credencial ESPECÍFICA por ID ← CAMBIO
    const credential = await MarketplaceCredentialRepository.findById(credential_id);

    if (!credential) {
      return res.status(404).json({
        success: false,
        error: "Credencial no encontrada"
      });
    }

    // Verificar propiedad
    if (credential.user_id !== user_id) {
      return res.status(403).json({
        success: false,
        error: "No autorizado"
      });
    }

    const marketplace_id = credential.marketplace_id; // ← Obtener marketplace_id de la credencial

    const baseUrl = "https://sellercenter-api.falabella.com";
    const userId = credential.seller_email;
    const apiKey = credential.api_key;

    if (!userId || !apiKey) {
      return res.status(500).json({
        success: false,
        error: "Faltan credenciales de Falabella (seller_email o api_key)"
      });
    }

    // ... RESTO DEL CÓDIGO IGUAL ...
    const suggestions = [];
    let cacheHits = 0;
    let apiCalls = 0;

    for (const product of products) {
      if (!product.id || !product.name) {
        logger.warn(`Producto inválido omitido: ${JSON.stringify(product)}`);
        continue;
      }

      const nameFixed = product.name.trim();

      // Usar credential_id en la clave de caché para diferenciar
      const cachedProductResult = getFromCache(`credential_${credential_id}`, 'product_suggestion', nameFixed);

      if (cachedProductResult) {
        logger.info(`[CACHE HIT] Producto "${nameFixed}" en credential ${credential_id}`);
        cacheHits++;
        
        suggestions.push({
          product_id: product.id,
          credential_id: credential_id,
          marketplace_id: marketplace_id,
          categories: cachedProductResult
        });
        continue;
      }

      logger.info(`[CACHE MISS] Producto "${nameFixed}" en credential ${credential_id}`);
      apiCalls++;

      const categories = [];

      const paramsSuggest = {
        UserID: userId,
        Version: "1.0",
        Action: "GetCategorySuggestion",
        Format: "JSON",
        Name: nameFixed,
        Timestamp: timestampMinus03(),
      };

      const keysSuggest = Object.keys(paramsSuggest).sort();
      const canonicalQuerySuggest = keysSuggest
        .map(k => `${rfc3986Encode(k)}=${rfc3986Encode(String(paramsSuggest[k]))}`)
        .join("&");
      const signatureSuggest = rfc3986Encode(
        crypto.createHmac("sha256", apiKey).update(canonicalQuerySuggest).digest("hex")
      );
      const urlSuggest = `${baseUrl}?${canonicalQuerySuggest}&Signature=${signatureSuggest}`;
      
      let suggestionResponse;
      try {
        suggestionResponse = await axios.get(urlSuggest);
        logger.info(`Categorías sugeridas:\n ${JSON.stringify(suggestionResponse.data)}`);
      } catch (err) {
        logger.error(`Error al obtener sugerencias para "${nameFixed}": ${JSON.stringify(err.message)}`);
        continue;
      }

      const dataSuggest = suggestionResponse.data;
      let suggestedItems = [];

      if (dataSuggest.SuccessResponse?.Body?.SuggestedCategory) {
        const raw = dataSuggest.SuccessResponse.Body.SuggestedCategory;
        suggestedItems = Array.isArray(raw) ? raw : [raw];
      }

      for (const item of suggestedItems) {
        if (!item.CategoryId || !item.CategoryName) continue;

        const categoryId = item.CategoryId.toString();

        const cachedCategory = getFromCache(`credential_${credential_id}`, 'category_attributes', categoryId);

        if (cachedCategory) {
          logger.info(`[CACHE HIT] Categoría ${categoryId} en credential ${credential_id}`);
          categories.push(cachedCategory);
          continue;
        }

        logger.info(`[CACHE MISS] Categoría ${categoryId} en credential ${credential_id}`);

        const paramsAttrs = {
          UserID: userId,
          Version: "1.0",
          Action: "GetCategoryAttributes",
          Format: "JSON",
          PrimaryCategory: categoryId,
          Timestamp: timestampMinus03(),
        };

        const keysAttrs = Object.keys(paramsAttrs).sort();
        const canonicalQueryAttrs = keysAttrs
          .map(k => `${rfc3986Encode(k)}=${rfc3986Encode(String(paramsAttrs[k]))}`)
          .join("&");
        const signatureAttrs = rfc3986Encode(
          crypto.createHmac("sha256", apiKey).update(canonicalQueryAttrs).digest("hex")
        );
        const urlAttrs = `${baseUrl}?${canonicalQueryAttrs}&Signature=${signatureAttrs}`;

        let attributes = [];
        try {
          const attrResponse = await axios.get(urlAttrs);
          const attrData = attrResponse.data;
          //logger.info(`Categoría obtenida: \n ${JSON.stringify(attrData)}`);
          if (attrData.SuccessResponse?.Body?.Attribute) {
            const rawAttrs = attrData.SuccessResponse.Body.Attribute;
            const attrList = Array.isArray(rawAttrs) ? rawAttrs : [rawAttrs];

            attributes = attrList
              .filter(attr => attr.Name && attr.Label)
              .map(attr => ({
                id: attr.FeedName || attr.Name,
                name: attr.Label,
                label: attr.Label,
                is_mandatory: attr.isMandatory === "1" || attr.isMandatory === true,
                description: attr.Description || '',
                attribute_type: attr.AttributeType || 'string',
                example_value: attr.ExampleValue || '',
                value_type:
                  attr.AttributeType === 'option' || attr.AttributeType === 'multi_option'
                    ? 'list'
                    : attr.AttributeType === 'numberfield'
                      ? 'number'
                      : 'string',
                values: attr.Options?.Option
                  ? (Array.isArray(attr.Options.Option)
                      ? attr.Options.Option.map(opt => ({ id: opt.id, name: opt.Name }))
                      : [{ id: attr.Options.Option.id, name: attr.Options.Option.Name }])
                  : [],
                tags: {
                  required: attr.isMandatory === "1" || attr.isMandatory === true,
                  catalog_required: attr.isMandatory === "1" || attr.isMandatory === true,
                  hidden: false
                }
              }))
              .sort((a, b) => (a.is_mandatory ? 0 : 1) - (b.is_mandatory ? 0 : 1));
          }
        } catch (attrErr) {
          logger.warn(`Error al cargar atributos para categoría ${categoryId}:`, attrErr.message);
        }

        const categoryData = {
          id: categoryId,
          name: item.CategoryName,
          path: item.SuggestedCategory || "",
          search_term: item.Name || "",
          attributes
        };

        saveToCache(`credential_${credential_id}`, 'category_attributes', categoryId, categoryData);
        categories.push(categoryData);
      }

      saveToCache(`credential_${credential_id}`, 'product_suggestion', nameFixed, categories);

      suggestions.push({
        product_id: product.id,
        credential_id: credential_id,
        marketplace_id: marketplace_id,
        categories
      });
    }

    return res.status(200).json({
      success: true,
      suggestions,
      count: suggestions.length,
      stats: {
        total_products: products.length,
        cache_hits: cacheHits,
        api_calls: apiCalls,
        cache_hit_rate: products.length > 0 
          ? ((cacheHits / products.length) * 100).toFixed(2) + '%'
          : '0%'
      }
    });

  } catch (error) {
    logger.error(`❌ Error general en falabellaSuggestedCategoriesWithAttributes: ${error.message}`);
    
    if (error.response?.data?.ErrorResponse?.Head) {
      const head = error.response.data.ErrorResponse.Head;
      const errorCode = head.ErrorCode;
      let errorMessage = head.ErrorMessage;
      let statusCode = 500;

      if (errorCode === "7") {
        errorMessage = "Firma inválida (E007). Verifica API Key y seller_email.";
        statusCode = 401;
      } else if (errorCode === "9") {
        errorMessage = 'Acceso denegado (E009). Verifica rol "Seller API Product Access".';
        statusCode = 403;
      } else if ([3, 4].includes(Number(errorCode))) {
        errorMessage = "Error de timestamp (E003/E004).";
        statusCode = 400;
      }

      return res.status(statusCode).json({ success: false, error: errorMessage });
    }

    return res.status(500).json({
      success: false,
      error: "Error interno al procesar categorías con atributos."
    });
  }
},*/
async falabellaSuggestedCategoriesWithAttributes(req, res) {
  logger.info(`Datos recibidos para categorías sugeridas con atributos y pricing en Falabella:\n ${JSON.stringify(req.body)}`);

  const { credential_id, products } = req.body;
  const user_id = req.user?.id;

  // === VALIDACIONES ===
  if (!credential_id) {
    return res.status(400).json({ success: false, error: "credential_id es requerido" });
  }
  if (!Array.isArray(products) || products.length === 0) {
    return res.status(400).json({
      success: false,
      error: "Se requiere un array no vacío de productos con 'id' y 'name'."
    });
  }

  try {
    // === Rate Limit ===
    try {
      await marketplaceRateLimiter.consume(user_id);
    } catch (rateLimitError) {
      logger.warn(`Rate limit excedido para usuario ${user_id}`);
      return res.status(429).json({ success: false, error: "Demasiadas solicitudes" });
    }

    // === Obtener Credencial ===
    const credential = await MarketplaceCredentialRepository.findById(credential_id);
    if (!credential) {
      return res.status(404).json({ success: false, error: "Credencial no encontrada" });
    }
    if (credential.user_id !== user_id) {
      return res.status(403).json({ success: false, error: "No autorizado" });
    }

    const marketplace_id = credential.marketplace_id;
    const baseUrl = "https://sellercenter-api.falabella.com";
    const userId = credential.seller_email;
    const apiKey = credential.api_key;

    if (!userId || !apiKey) {
      return res.status(500).json({ success: false, error: "Faltan credenciales de Falabella" });
    }

    const suggestions = [];
    let cacheHits = 0, apiCalls = 0, pricingCalls = 0, treeCalls = 0;
    const treeData = await OAuthController.fetchFalabellaCategoryTree(baseUrl, userId, apiKey);
    const allCategories = OAuthController.flattenFalabellaCategoryTree(treeData);

    // === PROCESAR CADA PRODUCTO ===
    for (const product of products) {
      if (!product.id || !product.name) continue;

      const nameFixed = product.name.trim();
      const productPrice = (product.price !== undefined && product.price !== null && !isNaN(product.price))
        ? parseFloat(product.price) : null;

      // === Cache de producto ===
      const cachedProductResult = getFromCache(`credential_${credential_id}`, 'product_suggestion', nameFixed);
      if (Array.isArray(cachedProductResult) && cachedProductResult.length > 0) {
        cacheHits++;
        suggestions.push({ product_id: product.id, credential_id, marketplace_id, categories: cachedProductResult });
        continue;
      }

      apiCalls++;
      const categories = [];

      // === GetCategorySuggestion ===
      const paramsSuggest = {
        UserID: userId, Version: "1.0", Action: "GetCategorySuggestion", Format: "JSON",
        Name: nameFixed, Timestamp: timestampMinus03(),
      };
      const keysSuggest = Object.keys(paramsSuggest).sort();
      const canonicalQuerySuggest = keysSuggest
        .map(k => `${rfc3986Encode(k)}=${rfc3986Encode(String(paramsSuggest[k]))}`)
        .join("&");
      const signatureSuggest = rfc3986Encode(
        crypto.createHmac("sha256", apiKey).update(canonicalQuerySuggest).digest("hex")
      );
      const urlSuggest = `${baseUrl}?${canonicalQuerySuggest}&Signature=${signatureSuggest}`;

      let suggestionResponse;
      try {
        suggestionResponse = await axios.get(urlSuggest);
        logger.info(`categoría sugerida: \n ${JSON.stringify(suggestionResponse.data)}`);
      } catch (err) {
        logger.error(`Error GetCategorySuggestion para "${nameFixed}": ${err.message}`);
        continue;
      }

      const dataSuggest = suggestionResponse.data;
      let suggestedItems = [];
      if (dataSuggest.SuccessResponse?.Body?.SuggestedCategory) {
        const raw = dataSuggest.SuccessResponse.Body.SuggestedCategory;
        suggestedItems = Array.isArray(raw) ? raw : [raw];
      }

      for (const item of suggestedItems) {
        if (!item.CategoryId || !item.CategoryName) continue;
        const categoryId = item.CategoryId.toString();

        // === Cache de categoría ===
        const cachedCategory = getFromCache(`credential_${credential_id}`, 'category_attributes', categoryId);
        if (cachedCategory) {
          categories.push(cachedCategory);
          continue;
        }

        // === GetCategoryAttributes ===
        const paramsAttrs = {
          UserID: userId, Version: "1.0", Action: "GetCategoryAttributes", Format: "JSON",
          PrimaryCategory: categoryId, Timestamp: timestampMinus03(),
        };
        const keysAttrs = Object.keys(paramsAttrs).sort();
        const canonicalQueryAttrs = keysAttrs
          .map(k => `${rfc3986Encode(k)}=${rfc3986Encode(String(paramsAttrs[k]))}`)
          .join("&");
        const signatureAttrs = rfc3986Encode(
          crypto.createHmac("sha256", apiKey).update(canonicalQueryAttrs).digest("hex")
        );
        const urlAttrs = `${baseUrl}?${canonicalQueryAttrs}&Signature=${signatureAttrs}`;
        let attributes = [];

        try {
          const attrResponse = await axios.get(urlAttrs);
          const attrData = attrResponse.data;
          if (attrData.SuccessResponse?.Body?.Attribute) {
            const rawAttrs = attrData.SuccessResponse.Body.Attribute;
            const attrList = Array.isArray(rawAttrs) ? rawAttrs : [rawAttrs];
            attributes = attrList
              .map(mapFalabellaCategoryAttribute)
              .filter(Boolean)
              .sort((a, b) => (a.is_mandatory ? 0 : 1) - (b.is_mandatory ? 0 : 1));
            logger.info(`[FALABELLA][ATTRIBUTES] Categoría ${categoryId}: ${attributes.length} atributo(s) mapeado(s)`);
          } else if (attrData.ErrorResponse) {
            logger.warn(`[FALABELLA][ATTRIBUTES] Error GetCategoryAttributes para ${categoryId}: ${JSON.stringify(attrData.ErrorResponse)}`);
          } else {
            logger.warn(`[FALABELLA][ATTRIBUTES] Categoría ${categoryId} sin Attribute en respuesta`);
          }
        } catch (attrErr) {
          logger.warn(`Error GetCategoryAttributes para ${categoryId}: ${attrErr.message}`);
        }

        // === 💰 NUEVO: Obtener pricing/comisión con auto-mapeo ===
        let pricing = null;
        if (productPrice !== null) {
          const pricingCacheKey = `pricing_${categoryId}_${item.CategoryName}_${productPrice}`;
          const cachedPricing = getFromCache(`credential_${credential_id}`, 'category_pricing', pricingCacheKey);

          if (cachedPricing) {
            pricing = cachedPricing;
          } else {
            try {
              pricingCalls++;

              // 🔹 Paso 1: Buscar comisión en BD por category_id o global_identifier
              let commission = await CategoryCommissionRepository.findByCategory(
                marketplace_id,
                {
                  categoryId: categoryId,
                  categoryName: item.CategoryName,
                  globalIdentifier: item.SuggestedCategory
                }
              );

              if (!commission) {
                const commissionBySuggestion = await CategoryCommissionRepository.findByFalabellaSuggestion(
                  marketplace_id,
                  {
                    categoryId,
                    categoryName: item.CategoryName,
                    globalIdentifier: item.SuggestedCategory
                  }
                );

                if (commissionBySuggestion) {
                  await CategoryCommissionRepository.updateCommissionIdentifiers(
                    commissionBySuggestion.id,
                    {
                      category_id: categoryId,
                      global_identifier: item.SuggestedCategory,
                      category_name_api: item.CategoryName
                    }
                  );
                  commission = commissionBySuggestion;
                  logger.info(`[AUTO-MAP] ✅ Registro actualizado por sugerencia Falabella: ID=${commissionBySuggestion.id}`);
                }
              }

              // 🔹 Paso 2: Si NO existe, consultar GetCategoryTree para auto-mapear
              if (!commission) {
                logger.info(`[AUTO-MAP] Categoría ${categoryId} no encontrada, consultando GetCategoryTree...`);
                treeCalls++;

                // 🔹 Paso 3: Normalizar nombres para coincidir con el formato de la BD
                const treeMatch = await OAuthController.findCategoryInTree(treeData, categoryId);
logger.info(`categoría encontrada desde el arbol: \n ${JSON.stringify(treeMatch)}`);

// 🔹 Verificar que treeMatch exista y tenga propiedades válidas
if (treeMatch && Object.keys(treeMatch).length > 0) {
  logger.debug(`[AUTO-MAP] ✅ Encontrado en árbol: ${JSON.stringify(treeMatch)}`);
  
  // 🔹 Paso 3: Buscar en BD por ruta de niveles (level1-4)
  const commissionByPath = await CategoryCommissionRepository.findByCategoryPathWithLevels(
    marketplace_id,
    {
      level1: treeMatch.level1,
      level2: treeMatch.level2,
      level3: treeMatch.level3,
      level4: treeMatch.level4
    }
  );
logger.info(`comisión encontrada en la bd: \n ${JSON.stringify(commissionByPath)}`);
  let commissionToUse = commissionByPath;

  if (!commissionToUse) {
    logger.info(`[AUTO-MAP] Buscando comisión con fallback por categoría/nombre para ${categoryId}`);
    commissionToUse = await CategoryCommissionRepository.findByCategoryWithFallback(
      marketplace_id,
      {
        categoryId,
        categoryName: item.CategoryName,
        globalIdentifier: item.SuggestedCategory,
        level1: treeMatch.level1,
        level2: treeMatch.level2,
        level3: treeMatch.level3
      }
    );
    logger.info(`comisión fallback encontrada en la bd: \n ${JSON.stringify(commissionToUse)}`);
  }

  if (!commissionToUse) {
    logger.info(`[AUTO-MAP] Buscando comisión con fallback parcial por ruta para ${categoryId}`);
    commissionToUse = await CategoryCommissionRepository.findByCategoryWithFallback(
      marketplace_id,
      {
        categoryId,
        globalIdentifier: item.SuggestedCategory,
        level1: treeMatch.level1,
        level2: treeMatch.level2,
        level3: treeMatch.level3,
        categoryName: null
      }
    );
    logger.info(`comisión fallback parcial encontrada en la bd: \n ${JSON.stringify(commissionToUse)}`);
  }

  if (commissionToUse) {
    // 🔹 Paso 4: Actualizar el registro con los identificadores de API
    await CategoryCommissionRepository.updateCommissionIdentifiers(
      commissionToUse.id,
      {
        category_id: categoryId,
        global_identifier: item.SuggestedCategory,
        category_name_api: item.CategoryName
      }
    );
    
    commission = commissionToUse;
    logger.info(`[AUTO-MAP] ✅ Registro actualizado: ID=${commissionToUse.id}`);
  } else {
    logger.warn(`[AUTO-MAP] ⚠️ No se encontró comisión en BD para esta categoría`);
  }
} else {
  logger.error(`[AUTO-MAP] ❌ treeMatch es null o undefined: ${treeMatch}`);
}
              }

              // 🔹 Paso 5: Calcular pricing si hay comisión
              if (commission) {
                pricing = CategoryCommissionRepository.calculatePricing(commission, productPrice);
                logger.debug(`[PRICING] Calculado para ${categoryId}: ${pricing.fee_percentage}%`);
              } else {
                // Fallback: sin comisión
                pricing = {
                  sale_fee_amount: null,
                  listing_fee_amount: 0,
                  total_fee_amount: null,
                  fee_percentage: null,
                  net_amount: null,
                  currency: 'CLP',
                  warning: `Comisión no configurada para "${item.CategoryName}"`,
                  source: 'tabla_local'
                };
                logger.warn(`[PRICING] Sin comisión para ${categoryId}: ${item.CategoryName}`);
              }

              // 💾 Cache de pricing (24h)
              saveToCache(`credential_${credential_id}`, 'category_pricing', pricingCacheKey, pricing, 86400);

            } catch (pricingErr) {
              logger.warn(`Error calculando pricing para ${categoryId}: ${pricingErr.message}`);
              pricing = { error: 'Cálculo no disponible', sale_fee_amount: null, fee_percentage: null, currency: 'CLP' };
            }
          }
        }

        // === Construir categoryData ===
        const categoryData = {
          id: categoryId,
          name: item.CategoryName,
          path: item.SuggestedCategory || "",
          search_term: item.Name || "",
          attributes,
          ...(productPrice !== null && { pricing })
        };

        saveToCache(`credential_${credential_id}`, 'category_attributes', categoryId, categoryData);
        categories.push(categoryData);
      }

      if (categories.length > 0) {
        saveToCache(`credential_${credential_id}`, 'product_suggestion', nameFixed, categories);
      }
      suggestions.push({ product_id: product.id, credential_id, marketplace_id, categories });
    }

    return res.status(200).json({
      success: true,
      all_categories: allCategories,
      all_categories_count: allCategories.length,
      suggestions,
      count: suggestions.length,
      stats: {
        total_products: products.length,
        cache_hits: cacheHits,
        api_calls: apiCalls,
        pricing_calls: pricingCalls,
        tree_calls: treeCalls,
        cache_hit_rate: products.length > 0 ? ((cacheHits / products.length) * 100).toFixed(2) + '%' : '0%',
        pricing_requested: products.some(p => p.price !== undefined && p.price !== null)
      }
    });

  } catch (error) {
    logger.error(`❌ Error en falabellaSuggestedCategoriesWithAttributes: ${error.message}`);
    if (error.response?.data?.ErrorResponse?.Head) {
      const head = error.response.data.ErrorResponse.Head;
      const errorCode = head.ErrorCode;
      let errorMessage = head.ErrorMessage, statusCode = 500;
      if (errorCode === "7") { errorMessage = "Firma inválida (E007)"; statusCode = 401; }
      else if (errorCode === "9") { errorMessage = "Acceso denegado (E009)"; statusCode = 403; }
      else if ([3, 4].includes(Number(errorCode))) { errorMessage = "Error de timestamp (E003/E004)"; statusCode = 400; }
      return res.status(statusCode).json({ success: false, error: errorMessage });
    }
    return res.status(500).json({ success: false, error: "Error interno al procesar categorías con pricing de Falabella." });
  }
},
/**
 * Obtiene el árbol completo de categorías de Falabella
 * @returns {Object} Respuesta de GetCategoryTree
 */
async fetchFalabellaCategoryTree(baseUrl, userId, apiKey) {
  const cacheNamespace = `falabella_user_${userId}`;
  const cacheKey = 'category_tree';
  const cachedTree = getFromCache(cacheNamespace, 'tree', cacheKey);
  if (cachedTree) {
    return cachedTree;
  }

  const params = {
    UserID: userId,
    Version: "1.0",
    Action: "GetCategoryTree",
    Format: "JSON",
    Timestamp: timestampMinus03(),
  };
  
  const keys = Object.keys(params).sort();
  const canonicalQuery = keys
    .map(k => `${rfc3986Encode(k)}=${rfc3986Encode(String(params[k]))}`)
    .join("&");
  const signature = rfc3986Encode(
    crypto.createHmac("sha256", apiKey).update(canonicalQuery).digest("hex")
  );
  const url = `${baseUrl}?${canonicalQuery}&Signature=${signature}`;
  
  const response = await axios.get(url, { timeout: 30000 });  
  const tree = response.data?.SuccessResponse?.Body?.Categories?.Category || [];
  saveToCache(cacheNamespace, 'tree', cacheKey, tree, 86400);
  return tree;
},

/**
 * Aplana el árbol de categorías de Falabella para búsqueda en UI
 * @param {Array|Object} nodes
 * @param {Array<string>} path
 * @returns {Array<Object>}
 */
flattenFalabellaCategoryTree(nodes, path = []) {
  const nodeList = Array.isArray(nodes) ? nodes : (nodes ? [nodes] : []);
  const flattened = [];

  for (const node of nodeList) {
    const currentName = String(node?.Name || '').trim();
    const currentId = String(node?.CategoryId || '').trim();
    const currentPath = currentName ? [...path, currentName] : [...path];

    if (currentId && currentName) {
      flattened.push({
        category_id: currentId,
        category_name: currentName,
        path: currentPath.join(' > '),
        domain_id: node?.DomainId || null,
        domain_name: node?.DomainName || null
      });
    }

    if (node?.Children?.Category) {
      flattened.push(
        ...OAuthController.flattenFalabellaCategoryTree(node.Children.Category, currentPath)
      );
    }
  }

  return flattened;
},

/**
 * Busca recursivamente un CategoryId en el árbol de categorías
 * @returns {Object|null} { level1, level2, level3, level4, api_name } o null
 */
async findCategoryInTree(nodes, targetCategoryId, path = []) {
  const nodeList = Array.isArray(nodes) ? nodes : [nodes];
  
  for (const node of nodeList) {
    const currentPath = [...path, node.Name];
    
    // Si coincide el CategoryId, retornar la ruta
    if (node.CategoryId?.toString() === targetCategoryId) {
      return {
        level1: currentPath[0] || null,
        level2: currentPath[1] || null,
        level3: currentPath[2] || null,
        level4: currentPath[3] || node.Name, // Último nivel disponible
        api_name: node.Name
      };
    }
    
    // Recursividad para hijos
    if (node.Children?.Category) {
      const result = await OAuthController.findCategoryInTree(node.Children.Category, targetCategoryId, currentPath);
      if (result) return result;
    }
  }
  
  return null;
},
async falabellaCategories(req, res) {
    logger.info(
      "Datos recibidos al obtener las categorías de un producto en falabella:",
    );
    logger.info(JSON.stringify(req.body));

    const { productName, marketplace_id } = req.body;
    const user_id = req.user?.id;

    try {
      const credential =
        await MarketplaceCredentialRepository.findByMarketplaceAndUser(
          marketplace_id,
          user_id,
        );

      if (!credential) {
        return res.status(400).json({
          success: false,
          error: "Credenciales no encontradas",
        });
      }
      const baseUrl = "https://sellercenter-api.falabella.com";
      const userId = credential.seller_email; /*'evelyn@klint.cl'*/
      const apiKey = credential.api_key; /*'79c1b4e70aedbccd614cb3815f524aca2ea0c220'*/
      const nameFixed = productName.trim();

      if (!userId || !apiKey) {
        return res
          .status(500)
          .json({ success: false, error: "Faltan env vars Falabella" });
      }

      const params = {
        UserID: userId,
        Version: "1.0",
        Action: "GetCategorySuggestion",
        Format: "JSON",
        Name: nameFixed,
        Timestamp: timestampMinus03(), // o usa -03:00 si tu cuenta lo exige
      };

      // 1) ordenar
      const keys = Object.keys(params).sort();

      // 2) construir query ENCODEADA (esto se firma)
      const canonicalQuery = keys
        .map((k) => `${rfc3986Encode(k)}=${rfc3986Encode(String(params[k]))}`)
        .join("&");

      // 3) firma HMAC SHA256 HEX (igual PHP hash_hmac(..., false))
      const signatureHex = crypto
        .createHmac("sha256", apiKey)
        .update(canonicalQuery)
        .digest("hex");

      // 4) Falabella/PHP hace rawurlencode(signature)
      const signature = rfc3986Encode(signatureHex);

      const url = `${baseUrl}?${canonicalQuery}&Signature=${signature}`;
      const response = await axios.get(url, { timeout: 20000 });

      const data = response.data;
      const categories = [];

      logger.info(`Categorias obtenidas:, ${JSON.stringify(data)}`);

      // ✅ Procesar respuesta de Falabella para GetCategorySuggestion
      if (data.SuccessResponse?.Body?.SuggestedCategory) {
        const suggested = data.SuccessResponse.Body.SuggestedCategory;

        // Manejar tanto objeto único como array (aunque normalmente es objeto único)
        const items = Array.isArray(suggested) ? suggested : [suggested];

        items.forEach((item) => {
          if (item.CategoryId && item.CategoryName) {
            categories.push({
              id: item.CategoryId.toString(), // ID numérico
              name: item.CategoryName, // Nombre amigable
              path: item.SuggestedCategory || "", // Path/código jerárquico (ej: G12020103)
              search_term: item.Name || "", // Término de búsqueda que generó la sugerencia
            });
          }
        });
      }

      return res.status(200).json({
        success: true,
        categories: categories,
        count: categories.length,
      });
    } catch (error) {
      logger.error(`❌ Falabella Categories error:, ${error.message}`);

      if (error.response) {
        logger.error("❌ Respuesta de error:");
        logger.error(JSON.stringify(error.response.data, null, 2));
      }

      // ✅ Mensajes de error específicos según código
      let errorMessage = error.message || "Error interno";
      let statusCode = 500;

      if (error.response?.data?.ErrorResponse?.Head) {
        const errorCode = error.response.data.ErrorResponse.Head.ErrorCode;
        const errorMsg = error.response.data.ErrorResponse.Head.ErrorMessage;

        if (errorCode === "7") {
          errorMessage =
            "Firma inválida (E007). Verifica que la API Key sea correcta y que el correo electrónico (UserID) sea el de tu cuenta de Seller Center.";
          statusCode = 401;
        } else if (errorCode === "9") {
          errorMessage =
            'Acceso denegado (E009). Verifica que tu usuario tenga el rol "Seller API Product Access" en Seller Center.';
          statusCode = 403;
        } else if (errorCode === "3") {
          errorMessage =
            "Timestamp expirado (E003). Por favor intenta nuevamente.";
          statusCode = 400;
        } else if (errorCode === "4") {
          errorMessage = "Formato de timestamp inválido (E004).";
          statusCode = 400;
        } else {
          errorMessage = `${errorMsg} (Código: ${errorCode})`;
        }
      }

      return res.status(statusCode).json({
        success: false,
        error: errorMessage,
        error_code: error.response?.data?.ErrorResponse?.Head?.ErrorCode,
      });
    }
  },

  // controllers/marketplace/falabellaController.js
  async falabellaAttributes(req, res) {
    logger.info(
      "Datos recibidos al obtener los atributos de una categoría en falabella:",
    );
    logger.info(JSON.stringify(req.body));

    const { category_id, marketplace_id } = req.body;
    const user_id = req.user?.id;

    try {
      const credential =
        await MarketplaceCredentialRepository.findByMarketplaceAndUser(
          marketplace_id,
          user_id,
        );

      if (!credential) {
        return res.status(400).json({
          success: false,
          error: "Credenciales no encontradas",
        });
      }

      const baseUrl = "https://sellercenter-api.falabella.com";
      const userId = credential.seller_email;
      const apiKey = credential.api_key;

      if (!userId || !apiKey || !category_id) {
        return res.status(400).json({
          success: false,
          error: "Faltan datos requeridos: category_id, seller_email o api_key",
        });
      }

      // ✅ Parámetros para GetCategoryAttributes
      const params = {
        UserID: userId,
        Version: "1.0",
        Action: "GetCategoryAttributes",
        Format: "JSON",
        PrimaryCategory: category_id.toString(), // ✅ ID de la categoría
        Timestamp: timestampMinus03(),
      };

      // 1) ordenar alfabéticamente
      const keys = Object.keys(params).sort();

      // 2) construir query ENCODEADA (esto se firma)
      const canonicalQuery = keys
        .map((k) => `${rfc3986Encode(k)}=${rfc3986Encode(String(params[k]))}`)
        .join("&");

      // 3) firma HMAC SHA256 HEX
      const signatureHex = crypto
        .createHmac("sha256", apiKey)
        .update(canonicalQuery)
        .digest("hex");

      // 4) encodear la firma
      const signature = rfc3986Encode(signatureHex);

      const url = `${baseUrl}?${canonicalQuery}&Signature=${signature}`;
      
      logger.info(`🔍 URL para atributos: ${url}`);

      const response = await axios.get(url, { timeout: 20000 });

    const data = response.data;
    const attributes = [];

    logger.info(`Atributos obtenidos: ${JSON.stringify(data)}`);

    // ✅ Procesar respuesta REAL de Falabella para GetCategoryAttributes
    if (data.SuccessResponse?.Body?.Attribute) {
      const attrs = data.SuccessResponse.Body.Attribute;
      
      // Manejar array o objeto único
      const items = Array.isArray(attrs) ? attrs : [attrs];

      items.forEach((attr) => {
        if (attr.Name && attr.Label) {
          attributes.push({
            id: attr.FeedName || attr.Name, // FeedName es el verdadero identificador para XMLs
            name: attr.Label, // Nombre legibles
            label: attr.Label,
            is_mandatory: attr.isMandatory === "1" || attr.isMandatory === true,
            description: attr.Description || '',
            attribute_type: attr.AttributeType || 'string',
            example_value: attr.ExampleValue || '',
            value_type: 
              attr.AttributeType === 'option' || attr.AttributeType === 'multi_option'
                ? 'list'
                : attr.AttributeType === 'numberfield'
                  ? 'number'
                  : 'string',
            values: attr.Options?.Option 
              ? (Array.isArray(attr.Options.Option) 
                  ? attr.Options.Option.map(opt => ({ 
                      id: opt.id,       // ✅ Campo real: id
                      name: opt.Name    // ✅ Campo real: Name
                    }))
                  : [{ id: attr.Options.Option.id, name: attr.Options.Option.Name }])
              : [],
            tags: {
              required: attr.isMandatory === "1" || attr.isMandatory === true,
              catalog_required: attr.isMandatory === "1" || attr.isMandatory === true
            }
          });
        }
      });
    }

        // ✅ Ordenar: requeridos primero
        const sortedAttributes = attributes.sort((a, b) => {
          const aReq = a.is_mandatory ? 0 : 1;
          const bReq = b.is_mandatory ? 0 : 1;
          return aReq - bReq;
        });

      return res.status(200).json({
        success: true,
        attributes: sortedAttributes,
        count: sortedAttributes.length,
      });
    } catch (error) {
      logger.error(`❌ Falabella Attributes error: ${error.message}`);

      if (error.response) {
        logger.error("❌ Respuesta de error:");
        logger.error(JSON.stringify(error.response.data, null, 2));
      }

      let errorMessage = error.message || "Error interno";
      let statusCode = 500;

      if (error.response?.data?.ErrorResponse?.Head) {
        const errorCode = error.response.data.ErrorResponse.Head.ErrorCode;
        const errorMsg = error.response.data.ErrorResponse.Head.ErrorMessage;

        if (errorCode === "57") {
          errorMessage = "No hay atributos para esta categoría (E057)";
          statusCode = 404;
        } else if (errorCode === "7") {
          errorMessage =
            "Firma inválida (E007). Verifica que la API Key sea correcta.";
          statusCode = 401;
        } else if (errorCode === "9") {
          errorMessage =
            'Acceso denegado (E009). Verifica que tu usuario tenga el rol "Seller API Product Access".';
          statusCode = 403;
        } else if (errorCode === "3") {
          errorMessage = "Timestamp expirado (E003).";
          statusCode = 400;
        } else if (errorCode === "4") {
          errorMessage = "Formato de timestamp inválido (E004).";
          statusCode = 400;
        } else {
          errorMessage = `${errorMsg} (Código: ${errorCode})`;
        }
      }

      return res.status(statusCode).json({
        success: false,
        error: errorMessage,
        error_code: error.response?.data?.ErrorResponse?.Head?.ErrorCode,
      });
    }
  },

async falabellaProductStatus(req, res) {
  logger.info(`${req.user?.name || "Unknown"} - Consulta status del producto publicado en Falabella`);
  logger.info("Datos recibidos:");
  logger.info(JSON.stringify(req.body));

  const { sku, marketplace_id } = req.body;
  const user_id = req.user?.id;

  // ✅ VALIDACIÓN temprana de parámetros requeridos
  if (!sku || !marketplace_id) {
    const hasTypo = req.body.marketplsce_id !== undefined;
    return res.status(400).json({
      success: false,
      error: hasTypo 
        ? 'Parámetro incorrecto: "marketplsce_id" (typo). Debe ser "marketplace_id"'
        : 'Faltan parámetros requeridos: sku y marketplace_id'
    });
  }

  try {
    const credential = await MarketplaceCredentialRepository.findByMarketplaceAndUser(
      marketplace_id,
      user_id,
    );

    if (!credential) {
      return res.status(400).json({
        success: false,
        error: "Credenciales no encontradas para este marketplace y usuario",
      });
    }

    const baseUrl = "https://sellercenter-api.falabella.com";
    const userId = credential.seller_email;
    const apiKey = credential.api_key;

    if (!userId || !apiKey) {
      return res.status(400).json({
        success: false,
        error: "Faltan credenciales: seller_email o api_key",
      });
    }

    // ✅ PARÁMETROS CORRECTOS para búsqueda EXACTA por SKU
    const params = {
      UserID: userId,
      Version: "1.0",
      Action: "GetProducts",
      Format: "JSON",
      Timestamp: timestampMinus03(),
      SellerSku: sku // ✅ ARRAY JSON para búsqueda EXACTA
    };

    // 1) Ordenar alfabéticamente
    const keys = Object.keys(params).sort();

    // 2) Construir query ENCODEADA (esto se firma)
    const canonicalQuery = keys
      .map((k) => `${rfc3986Encode(k)}=${rfc3986Encode(String(params[k]))}`)
      .join("&");

    // 3) Firma HMAC SHA256 HEX
    const signatureHex = crypto
      .createHmac("sha256", apiKey)
      .update(canonicalQuery)
      .digest("hex");

    // 4) Encodear la firma
    const signature = rfc3986Encode(signatureHex);

    const url = `${baseUrl}?${canonicalQuery}&Signature=${signature}`;
    
    logger.info(`🔍 URL para estado del producto: ${url}`);

    const response = await axios.get(url, { timeout: 20000 });

    const data = response.data;
    logger.info(`Estado obtenido: ${JSON.stringify(data)}`);

    // ✅ PROCESAR RESPUESTA CORRECTAMENTE (estructura real de Falabella)
    let productStatus = null;
    
    if (data.SuccessResponse?.Body?.Products?.Product) {
      // Normalizar a array (puede ser objeto único o array)
      const products = Array.isArray(data.SuccessResponse.Body.Products.Product)
        ? data.SuccessResponse.Body.Products.Product
        : [data.SuccessResponse.Body.Products.Product];
      
      // Buscar producto EXACTO por SKU
      const product = products.find(p => p.SellerSku === sku);
      
      if (product) {
        // ✅ EXTRAER BusinessUnit (puede ser objeto o array)
        let businessUnit = product.BusinessUnits?.BusinessUnit;
        if (Array.isArray(businessUnit)) {
          businessUnit = businessUnit[0]; // Tomar primera unidad de negocio
        }
        
        // ✅ Estructura limpia para el frontend
        productStatus = {
          sku: product.SellerSku,
          name: product.Name || 'Sin nombre',
          brand: product.Brand || 'Genérica',
          status: businessUnit?.Status || 'unknown', // 'active', 'inactive', 'deleted'
          stock: parseInt(businessUnit?.Stock || '0', 10),
          price: parseFloat(businessUnit?.Price || '0'),
          published: businessUnit?.IsPublished === '1' || businessUnit?.IsPublished === 1,
          qc_status: product.QCStatus || 'pending', // 'approved', 'pending', 'rejected'
          category: product.PrimaryCategory || '',
          last_updated: product.LastUpdateDate || null,
          url: product.Url || null,
          main_image: product.MainImage || null,
          content_score: parseInt(product.ContentScore || '0', 10)
        };
      }
    }

    // ✅ RESPUESTA OPTIMIZADA PARA FRONTEND
    return res.status(200).json({
      success: true,
      found: !!productStatus,
      product: productStatus, // ✅ Nombre consistente con otros endpoints
      message: productStatus 
        ? `Producto encontrado en Falabella (estado: ${productStatus.status})`
        : `Producto con SKU "${sku}" no encontrado en Falabella`
    });
  } catch (error) {
    logger.error(`❌ Falabella status error: ${error.message}`);

    if (error.response) {
      logger.error("❌ Respuesta de error:");
      logger.error(JSON.stringify(error.response.data, null, 2));
    }

    let errorMessage = error.message || "Error interno";
    let statusCode = 500;

    if (error.response?.data?.ErrorResponse?.Head) {
      const errorCode = error.response.data.ErrorResponse.Head.ErrorCode;
      const errorMsg = error.response.data.ErrorResponse.Head.ErrorMessage;

      if (errorCode === "7") {
        errorMessage = "Firma inválida (E007). Verifica API Key y formato de timestamp";
        statusCode = 401;
      } else if (errorCode === "9") {
        errorMessage = 'Acceso denegado (E009). Verifica rol "Seller API Product Access"';
        statusCode = 403;
      } else if (errorCode === "3") {
        errorMessage = "Timestamp expirado (E003).";
        statusCode = 400;
      } else if (errorCode === "70") {
        errorMessage = "SKU no válido o datos corruptos en la lista (E070).";
        statusCode = 400;
      } else {
        errorMessage = `${errorMsg} (Código: ${errorCode})`;
      }
    }

    return res.status(statusCode).json({
      success: false,
      error: errorMessage,
      error_code: error.response?.data?.ErrorResponse?.Head?.ErrorCode,
    });
  }
},
async falabellaFeedStatus(req, res) {
  logger.info(`${req.user?.name || "Unknown"} - Consulta estado de feed en Falabella`);
  logger.info("Datos recibidos:");
  logger.info(JSON.stringify(req.body));

  const { feed_id, marketplace_id } = req.body;
  const user_id = req.user?.id;

  // ✅ VALIDACIÓN temprana de parámetros requeridos
  if (!feed_id || !marketplace_id) {
    return res.status(400).json({
      success: false,
      error: 'Faltan parámetros requeridos: feed_id y marketplace_id'
    });
  }

  try {
    const credential = await MarketplaceCredentialRepository.findByMarketplaceAndUser(
      marketplace_id,
      user_id,
    );

    if (!credential) {
      return res.status(400).json({
        success: false,
        error: "Credenciales no encontradas para este marketplace y usuario",
      });
    }

    const baseUrl = "https://sellercenter-api.falabella.com";
    const userId = credential.seller_email;
    const apiKey = credential.api_key;

    if (!userId || !apiKey) {
      return res.status(400).json({
        success: false,
        error: "Faltan credenciales: seller_email o api_key",
      });
    }

    // ✅ PARÁMETROS para FeedStatus (igual que falabellaCategories que funciona)
    const params = {
      UserID: userId,
      Version: "1.0",
      Action: "FeedStatus",
      Format: "JSON",
      Timestamp: timestampMinus03(),
      FeedID: feed_id // ✅ UUID del feed a consultar
    };

    // 1) Ordenar alfabéticamente
    const keys = Object.keys(params).sort();

    // 2) Construir query ENCODEADA (esto se firma)
    const canonicalQuery = keys
      .map((k) => `${rfc3986Encode(k)}=${rfc3986Encode(String(params[k]))}`)
      .join("&");

    logger.info(`[FalabellaFeedStatus] 🔍 String to sign (ENCODEADO):`);
    logger.info(canonicalQuery);

    // 3) Firma HMAC SHA256 HEX
    const signatureHex = crypto
      .createHmac("sha256", apiKey)
      .update(canonicalQuery)
      .digest("hex");

    logger.info(`[FalabellaFeedStatus] ✅ Firma generada (HEX): ${signatureHex.substring(0, 16)}...`);

    // 4) Encodear la firma
    const signature = rfc3986Encode(signatureHex);

    // 5) Construir URL final
    const url = `${baseUrl}?${canonicalQuery}&Signature=${signature}`;
    
    logger.info(`[FalabellaFeedStatus] 🌐 URL para consulta de feed:`);
    logger.info(url);

    // ✅ Realizar solicitud a Falabella
    const response = await axios.get(url, { timeout: 10000 });

    const data = response.data;
    logger.info(`[FalabellaFeedStatus] 📊 Respuesta de Falabella:`);
    logger.info(JSON.stringify(data, null, 2));

    // ✅ Procesar respuesta exitosa
    if (data.SuccessResponse?.Body?.Feed) {
      const feed = data.SuccessResponse.Body.Feed;
      
      // Estructura limpia para el frontend
      const feedStatus = {
        feed_id: feed.FeedID || feed_id,
        status: feed.Status || 'unknown', // Queued, Processing, Canceled, Finished, Error
        action: feed.Action || 'unknown',
        source: feed.Source || 'unknown',
        total_records: parseInt(feed.TotalRecords || '0', 10),
        processed_records: parseInt(feed.ProcessedRecords || '0', 10),
        failed_records: parseInt(feed.FailedRecords || '0', 10),
        created_at: feed.CreatedAt || null,
        updated_at: feed.UpdatedAt || null,
        errors: feed.FeedErrors?.Error || [],
        warnings: feed.FeedWarnings?.Warning || []
      };

      return res.status(200).json({
        success: true,
        feed: feedStatus,
        message: `Feed ${feedStatus.status.toLowerCase()}`
      });
    }

    // ✅ Manejar respuesta sin datos (feed no encontrado)
    return res.status(404).json({
      success: false,
      error: `Feed con ID "${feed_id}" no encontrado`,
      error_code: "FEED_NOT_FOUND"
    });

  } catch (error) {
    logger.error(`[FalabellaFeedStatus] ❌ Error consultando estado de feed:`, error.message);

    if (error.response) {
      logger.error("❌ Respuesta de error de Falabella:");
      logger.error(JSON.stringify(error.response.data, null, 2));
    }

    let errorMessage = error.message || "Error interno";
    let statusCode = 500;
    let errorCode = null;

    if (error.response?.data?.ErrorResponse?.Head) {
      const head = error.response.data.ErrorResponse.Head;
      errorCode = head.ErrorCode;
      errorMessage = head.ErrorMessage || `Error ${errorCode}`;

      // Mapeo de códigos de error específicos
      if (errorCode === "12") {
        errorMessage = "ID de feed no válido (E012). Verifica que el FeedID sea un UUID correcto";
        statusCode = 400;
      } else if (errorCode === "7") {
        errorMessage = "Firma inválida (E007). Verifica API Key y formato de timestamp";
        statusCode = 401;
      } else if (errorCode === "9") {
        errorMessage = 'Acceso denegado (E009). Verifica rol "Seller API Product Access"';
        statusCode = 403;
      } else if (errorCode === "3") {
        errorMessage = "Timestamp expirado (E003).";
        statusCode = 400;
      } else if (errorCode === "1") {
        errorMessage = "Parámetro FeedID es obligatorio (E001)";
        statusCode = 400;
      }
    }

    return res.status(statusCode).json({
      success: false,
      error: errorMessage,
      error_code: errorCode || 'UNKNOWN_ERROR',
      feed_id: feed_id
    });
  }
},
async clearFalabellaMarketplaceCache(req, res) {
  const { marketplace_id } = req.params;
  
  try {
    clearMarketplaceCache(marketplace_id);
    logger.info(`Caché limpiado para marketplace ${marketplace_id}`);
    
    return res.status(200).json({
      success: true,
      message: `Caché de marketplace ${marketplace_id} limpiado correctamente`
    });
  } catch (error) {
    logger.error(`Error al limpiar caché del marketplace: ${error.message}`);
    return res.status(500).json({
      success: false,
      error: "Error al limpiar el caché del marketplace"
    });
  }
},

/**
 * Limpiar caché global (todas las plataformas)
 */
async clearAllMarketplacesCache(req, res) {
  try {
    clearAllCache();
    logger.info(`Caché global limpiado`);
    
    return res.status(200).json({
      success: true,
      message: "Caché global limpiado correctamente"
    });
  } catch (error) {
    logger.error(`Error al limpiar caché global: ${error.message}`);
    return res.status(500).json({
      success: false,
      error: "Error al limpiar el caché global"
    });
  }
}
};

module.exports = OAuthController;
