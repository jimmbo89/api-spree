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
      enabled: false,
      interest_free: false,
      max_installments: null,
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

const normalizeShippingScenarios = ({
  shippingMode,
  logisticType,
  buyerPays,
  sellerPays,
  requestedFreeShipping,
  mandatoryFreeShipping
}) => {
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

const buildProfitabilityMetrics = ({ pricing, shippingSummary, productPrice, productCost }) => {
  if (!pricing || pricing.error || !Number.isFinite(Number(productPrice))) return null;

  const price = toNumberOrZero(productPrice);
  const totalFee = toNumberOrZero(pricing.total_fee_amount);
  const listingCharge = toNumberOrZero(pricing.listing_fee_amount);
  const shippingCost = toNumberOrZero(shippingSummary?.seller_shipping_cost);
  const netWithoutShipping = price - totalFee;
  const netWithShipping = netWithoutShipping - shippingCost;
  const costBasis = toNumberOrZero(productCost);
  const utilityFinal = productCost === null ? null : netWithShipping - costBasis;
  const marginRaw = utilityFinal === null || price <= 0 ? null : (utilityFinal / price) * 100;
  const marginReal = marginRaw === null ? null : Number(clamp(marginRaw, -300, 300).toFixed(2));

  const profitable = utilityFinal === null ? null : utilityFinal >= 0;
  const criticalLoss = utilityFinal === null ? false : utilityFinal < 0 && (marginReal !== null && marginReal <= -30);
  const profitabilityStatus = utilityFinal === null
    ? "unknown_cost_basis"
    : profitable
      ? "profitable"
      : (criticalLoss ? "critical_loss" : "loss");

  const recommendedMinimumPrice = productCost === null
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
    // ✅ Parsear credential_id del state (formato: marketplaceId_userId_credentialId)
    const stateParts = state.split("_");
    const marketplaceId = stateParts[0];
    const userId = stateParts[1];
    const credentialId = stateParts[2];

    credentialIdForCleanup = credentialId; 
    
    // ✅ Buscar credencial específica por ID
    const credential = credentialId 
      ? await MarketplaceCredentialRepository.findById(credentialId)
      : await MarketplaceCredentialRepository.findByMarketplaceAndUser(marketplaceId, userId);

    logger.info("Credenciales básicas obtenidas para OAuth Mercado Libre");
    logger.info(JSON.stringify(credential));

    const marketplace = credential?.marketplace || {};

    if (!credential || !marketplace.client_id || !marketplace.client_secret) {
      throw new Error("Credenciales OAuth incompletas en la base de datos");
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

    const allCredentials = await MarketplaceCredentialRepository.findByUser(userId);

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
async calculateMercadoLibreShippingCosts(credential, product, categoryId, siteId, listingType = 'gold_special', logistic_type, shipping_mode) {
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
      const res = await axios.get('https://api.mercadolibre.com/users/me', {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 8000,
      });
      return res.data?.id || null;
    } catch (e) {
      return null;
    }
  };

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

  let dimensions = null;
  try {
    if (product?.package) {
      dimensions = OAuthController.formatDimensionsForAPI(product.package, { strict: false });
    }
  } catch (e) {
    dimensions = null;
  }
  const itemId = product?.ml_item_id || product?.item_id || null;
  const requestedFreeShipping =
    typeof product?.shipping?.free_shipping === "boolean"
      ? product.shipping.free_shipping
      : (typeof product?.free_shipping === "boolean" ? product.free_shipping : null);
  const mlUserIdFromCredential = getMercadoLibreUserIdFromCredential(credential);
  const mlUserId = mlUserIdFromCredential || (await fetchMercadoLibreUserId(credential?.access_token));

  const baseParams = {
    item_price: product.price,
    category_id: categoryId,
    listing_type_id: listingType,
    mode: shipping_mode || 'me2',
    condition: product.condition || 'new',
    logistic_type: logistic_type || 'drop_off',
    verbose: true
  };
  if (dimensions) baseParams.dimensions = dimensions;
  if (itemId) baseParams.item_id = itemId;

  // Si se tuvo que consultar a ML, persistir para próximas llamadas (best-effort)
  if (!mlUserIdFromCredential && mlUserId && credential?.id) {
    try {
      let additional = credential.additional_data;
      if (typeof additional === 'string') {
        try {
          additional = JSON.parse(additional);
        } catch (e) {
          additional = {};
        }
      }

      if (typeof additional !== 'object' || additional === null) additional = {};

      await MarketplaceCredentialRepository.updatePartial(credential.id, {
        additional_data: { ...additional, ml_user_id: mlUserId }
      });
    } catch (e) {
      logger.warn(`[ML] No se pudo persistir ml_user_id en additional_data para credencial ${credential.id}: ${e.message}`);
    }
  }

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
    // Consulta 1: Comprador paga el envío
    const buyerPaysResponse = await axios.get(
      `https://api.mercadolibre.com/users/${mlUserId}/shipping_options/free`,
      {
        params: { ...baseParams, free_shipping: false },
        headers: { Authorization: `Bearer ${credential.access_token}` },
        timeout: 15000
      }
    );

    // Consulta 2: Vendedor ofrece envío gratis (vende paga)
    const sellerPaysResponse = await axios.get(
      `https://api.mercadolibre.com/users/${mlUserId}/shipping_options/free`,
      {
        params: { ...baseParams, free_shipping: true },
        headers: { Authorization: `Bearer ${credential.access_token}` },
        timeout: 15000
      }
    );

    const buyerCoverage = buyerPaysResponse.data?.coverage?.all_country || {};
    const sellerCoverage = sellerPaysResponse.data?.coverage?.all_country || {};
    const buyerTags = Array.isArray(buyerPaysResponse.data?.tags) ? buyerPaysResponse.data.tags : [];
    const sellerTags = Array.isArray(sellerPaysResponse.data?.tags) ? sellerPaysResponse.data.tags : [];
    let mandatoryFreeShipping = ['mandatory_free_shipping'].some(tag =>
      buyerTags.includes(tag) || sellerTags.includes(tag)
    );
    if (!mandatoryFreeShipping && itemId) {
      try {
        const itemShippingCacheKey = `item_shipping_policy_${itemId}`;
        const cachedItemShipping = getFromCache(`credential_${credential?.id}`, 'item_shipping_policy', itemShippingCacheKey);
        let itemShippingData = cachedItemShipping;
        if (!itemShippingData) {
          const itemShippingResponse = await axios.get(
            `https://api.mercadolibre.com/items/${itemId}/shipping`,
            {
              headers: { Authorization: `Bearer ${credential.access_token}` },
              timeout: 12000
            }
          );
          itemShippingData = itemShippingResponse.data || null;
          saveToCache(`credential_${credential?.id}`, 'item_shipping_policy', itemShippingCacheKey, itemShippingData, 900);
        }
        const itemTags = Array.isArray(itemShippingData?.tags) ? itemShippingData.tags : [];
        if (itemTags.includes('mandatory_free_shipping')) {
          mandatoryFreeShipping = true;
        }
      } catch (itemShippingErr) {
        logger.warn(`[ML] No se pudo validar shipping policy del item ${itemId}: ${itemShippingErr.message}`);
      }
    }

    const result = {
      buyer_pays: {
        // Mantener compatibilidad: "cost" = list_cost
        cost: buyerCoverage.list_cost || 0,
        list_cost: buyerCoverage.list_cost || 0,
        currency_id: buyerCoverage.currency_id || getCurrencyIdFromSite(siteId),
        billable_weight: buyerCoverage.billable_weight,
        discount: buyerCoverage.discount,
        shipping_method_id: buyerCoverage.shipping_method_id,
        paid_by: 'buyer',
        free_shipping: false
      },
      seller_pays: {
        cost: sellerCoverage.list_cost || 0,
        list_cost: sellerCoverage.list_cost || 0,
        currency_id: sellerCoverage.currency_id || getCurrencyIdFromSite(siteId),
        billable_weight: sellerCoverage.billable_weight,
        discount: sellerCoverage.discount,
        shipping_method_id: sellerCoverage.shipping_method_id,
        paid_by: 'seller',
        free_shipping: true
      }
    };
    const normalized = normalizeShippingScenarios({
      shippingMode: baseParams.mode,
      logisticType: baseParams.logistic_type,
      buyerPays: result.buyer_pays,
      sellerPays: result.seller_pays,
      requestedFreeShipping,
      mandatoryFreeShipping
    });
    return {
      ...result,
      ...normalized,
      requested_free_shipping: requestedFreeShipping,
      mandatory_free_shipping_detected: mandatoryFreeShipping
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

// ✅ MÉTODO ACTUALIZADO - Ahora incluye shipping costs
async mercadoLibreSuggestedCategoriesWithAttributes(req, res) {
  logger.info(`Datos recibidos para categorías sugeridas con atributos, pricing y shipping en MercadoLibre:\n ${JSON.stringify(req.body)}`);

  const { credential_id, products, listing_type_id, logistic_type, shipping_mode, strategy, installments } = req.body;
  const user_id = req.user?.id || req.body.user_id;
  let selectedStrategy = normalizeStrategy(strategy, listing_type_id);
  const normalizedInstallments = normalizeInstallments(installments);
  const strategyWarnings = [];

  // Regla funcional: interés sin interés solo en estrategia CONVERSION.
  if (normalizedInstallments.interest_free && selectedStrategy !== ML_STRATEGY.CONVERSION) {
    selectedStrategy = ML_STRATEGY.CONVERSION;
    strategyWarnings.push("interest_free_installments_forces_conversion");
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
    let shippingModesCatalog = [];
    let logisticTypesCatalog = [];
    try {
      const [shippingModesResponse, logisticTypesResponse] = await Promise.all([
        MercadoLibreCapabilitiesService.getAvailableShippingModes(credential),
        MercadoLibreCapabilitiesService.getAvailableLogisticTypes(credential)
      ]);
      shippingModesCatalog = shippingModesResponse?.shipping_modes || [];
      logisticTypesCatalog = logisticTypesResponse?.logistic_types || [];
    } catch (capError) {
      logger.warn(`[ML OPTIONS] No se pudieron cargar shipping/logistic: ${capError.message}`);
      shippingModesCatalog = MercadoLibreCapabilitiesService.getFallbackShippingModes();
      logisticTypesCatalog = MercadoLibreCapabilitiesService.getFallbackLogisticTypes();
    }

    const pickDefaultListingType = (availableTypes, requestedType) => {
      if (!Array.isArray(availableTypes) || availableTypes.length === 0) return requestedType || 'gold_special';
      if (requestedType && availableTypes.some(t => t?.value === requestedType)) return requestedType;
      if (availableTypes.some(t => t?.value === 'gold_special')) return 'gold_special';
      return availableTypes[0].value;
    };

    const isLogisticCompatibleWithMode = (logisticEntry, mode) => {
      const compatibleMode = logisticEntry?.ml_metadata?.compatible_shipping_mode;
      if (!compatibleMode) return true;
      return compatibleMode === mode;
    };

    const pickDefaultShippingMode = (requestedMode) => {
      if (requestedMode && shippingModesCatalog.some(sm => sm.value === requestedMode)) return requestedMode;
      if (shippingModesCatalog.some(sm => sm.value === 'me2')) return 'me2';
      return shippingModesCatalog[0]?.value || 'me2';
    };

    const pickDefaultLogisticType = (requestedType, selectedShippingMode) => {
      const logisticsByMode = logisticTypesCatalog.filter(lt => isLogisticCompatibleWithMode(lt, selectedShippingMode));
      if (requestedType && logisticsByMode.some(lt => lt.value === requestedType)) return requestedType;
      if (logisticsByMode.some(lt => lt.value === 'drop_off')) return 'drop_off';
      if (logisticsByMode.some(lt => lt.value === 'default')) return 'default';
      return logisticsByMode[0]?.value || 'drop_off';
    };

    const suggestions = [];
    let cacheHits = 0;
    let apiCalls = 0;
    let pricingCalls = 0;
    let shippingCalls = 0;
    let listingTypesCalls = 0;
    let shippingValidationCalls = 0;

    // === PROCESAR CADA PRODUCTO ===
    for (const product of products) {
      if (!product.id || !product.name) {
        logger.warn(`Producto inválido omitido: ${JSON.stringify(product)}`);
        continue;
      }

      const nameFixed = product.name.trim();
      
      // Obtener price de cada producto
      const productPrice = (product.price !== undefined && product.price !== null && !isNaN(product.price))
        ? parseFloat(product.price)
        : null;
      const productCostBasis = resolveProductCostBasis(product);
      
      // Validar y formatear dimensiones si existen
      let dimensionsFormatted = null;
      if (product.package) {
        try {
          dimensionsFormatted = OAuthController.formatDimensionsForAPI(product.package, { strict: false });
          logger.info(`[Producto ${product.id}] Dimensiones formateadas: ${dimensionsFormatted}`);
        } catch (dimError) {
          logger.warn(`[Producto ${product.id}] No se pudieron formatear dimensiones (best-effort): ${dimError.message}`);
          dimensionsFormatted = "1x1x1,1";
        }
      }
      
      const productCondition = String(product.condition || "new").toLowerCase();
      const requestFingerprint = buildRequestFingerprint({
        credential_id,
        site_id,
        strategy: selectedStrategy,
        installments: normalizedInstallments,
        listing_type_id: listing_type_id || null,
        shipping_mode: shipping_mode || null,
        logistic_type: logistic_type || null,
        product: {
          id: product.id,
          name: nameFixed,
          condition: productCondition,
          price: productPrice,
          package: product.package || null,
          item_id: product.item_id || null,
          ml_item_id: product.ml_item_id || null
        }
      });
      const productCacheKey = `${nameFixed}__${requestFingerprint}`;
      const cachedProductResult = getFromCache(`credential_${credential_id}`, `product_suggestion_${site_id}_v4`, productCacheKey);

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

      let categories = [];

      // === Obtener categorías sugeridas ===
      try {
        const domainDiscoveryUrl = `https://api.mercadolibre.com/sites/${site_id}/domain_discovery/search`;
        const catResponse = await axios.get(domainDiscoveryUrl, {
          params: { q: nameFixed, limit: 3 },
          timeout: 20000
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

      const categoriesWithAttrs = [];
      
      for (const cat of categories) {
        if (!cat.category_id) continue;
        const categoryWarnings = [];

        // === Cache de categoría con atributos ===
        const categoryCacheKey = `${cat.category_id}__${requestFingerprint}`;
        const cachedCategory = getFromCache(`credential_${credential_id}`, `category_attributes_${site_id}_v4`, categoryCacheKey);

        if (cachedCategory) {
          logger.info(`[CACHE HIT] Categoría ${cat.category_id} en credential ${credential_id}`);
          categoriesWithAttrs.push(cachedCategory);
          continue;
        }

        logger.info(`[CACHE MISS] Categoría ${cat.category_id} en credential ${credential_id}`);

        // === Obtener atributos de la categoría ===
        let attributes = [];
        let categoryInfo = null;
        try {
          const attrUrl = `https://api.mercadolibre.com/categories/${cat.category_id}/attributes`;
          const categoryUrl = `https://api.mercadolibre.com/categories/${cat.category_id}`;
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
            const cachedListingTypes = getFromCache(`credential_${credential_id}`, 'category_listing_types', listingTypesCacheKey);

            if (cachedListingTypes && Array.isArray(cachedListingTypes)) {
              listingTypesForCategory = cachedListingTypes;
            } else {
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

              saveToCache(`credential_${credential_id}`, 'category_listing_types', listingTypesCacheKey, listingTypesForCategory, 1800);
            }

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
          // Fallback defensivo cuando ML no devolvió tipos válidos
          effectiveListingType = "gold_special";
          listingResolution = {
            listing_type_id: effectiveListingType,
            fallback_applied: true,
            note: "No se pudieron validar tipos de publicación para esta categoría. Se aplicó fallback por defecto.",
            error: listingError.message
          };
        }
        let filteredShippingModes = shippingModesCatalog;
        let effectiveShippingMode = pickDefaultShippingMode(shipping_mode);
        let logisticTypesForCategory = logisticTypesCatalog.filter(lt => isLogisticCompatibleWithMode(lt, effectiveShippingMode));
        let effectiveLogisticType = pickDefaultLogisticType(logistic_type, effectiveShippingMode);

        if (mlUserId && productPrice !== null && dimensionsFormatted) {
          const validCombos = [];
          const shippingModesCandidates = shippingModesCatalog.filter(sm => !['not_specified'].includes(sm.value));

          for (const modeEntry of shippingModesCandidates) {
            const modeValue = modeEntry.value;
            const logisticCandidates = logisticTypesCatalog.filter(
              lt => isLogisticCompatibleWithMode(lt, modeValue) && !['not_specified'].includes(lt.value)
            );

            for (const logisticEntry of logisticCandidates) {
              const logisticValue = logisticEntry.value;
              const comboCacheKey = `combo_${site_id}_${cat.category_id}_${requestFingerprint}_${effectiveListingType}_${modeValue}_${logisticValue}`;
              const cachedCombo = getFromCache(`credential_${credential_id}`, 'shipping_combo_validation', comboCacheKey);

              if (cachedCombo && typeof cachedCombo.valid === 'boolean') {
                if (cachedCombo.valid) {
                  validCombos.push({ shipping_mode: modeValue, logistic_type: logisticValue });
                }
                continue;
              }

              const comboParams = {
                dimensions: dimensionsFormatted,
                item_price: productPrice,
                category_id: cat.category_id,
                listing_type_id: effectiveListingType,
                mode: modeValue,
                condition: product.condition || 'new',
                logistic_type: logisticValue,
                verbose: true,
                free_shipping: false
              };

              let comboValid = false;
              try {
                shippingValidationCalls++;
                await axios.get(`https://api.mercadolibre.com/users/${mlUserId}/shipping_options/free`, {
                  params: comboParams,
                  headers: { Authorization: `Bearer ${credential.access_token}` },
                  timeout: 12000
                });
                comboValid = true;
              } catch (comboErr) {
                comboValid = false;
              }

              saveToCache(`credential_${credential_id}`, 'shipping_combo_validation', comboCacheKey, { valid: comboValid }, 900);
              if (comboValid) {
                validCombos.push({ shipping_mode: modeValue, logistic_type: logisticValue });
              }
            }
          }

          if (validCombos.length > 0) {
            const validModeSet = new Set(validCombos.map(c => c.shipping_mode));
            filteredShippingModes = shippingModesCatalog.filter(sm => validModeSet.has(sm.value));
            effectiveShippingMode = filteredShippingModes.some(sm => sm.value === shipping_mode)
              ? shipping_mode
              : (filteredShippingModes.some(sm => sm.value === 'me2') ? 'me2' : filteredShippingModes[0].value);

            const validLogisticSet = new Set(
              validCombos
                .filter(c => c.shipping_mode === effectiveShippingMode)
                .map(c => c.logistic_type)
            );
            logisticTypesForCategory = logisticTypesCatalog.filter(lt => validLogisticSet.has(lt.value));
            effectiveLogisticType = logisticTypesForCategory.some(lt => lt.value === logistic_type)
              ? logistic_type
              : (logisticTypesForCategory.some(lt => lt.value === 'drop_off')
                ? 'drop_off'
                : (logisticTypesForCategory.some(lt => lt.value === 'default')
                  ? 'default'
                  : logisticTypesForCategory[0].value));
          }
        }
        if (shipping_mode && shipping_mode !== effectiveShippingMode) {
          categoryWarnings.push(`shipping_mode_normalized:${shipping_mode}->${effectiveShippingMode}`);
        }
        if (logistic_type && logistic_type !== effectiveLogisticType) {
          categoryWarnings.push(`logistic_type_normalized:${logistic_type}->${effectiveLogisticType}`);
        }
        if (
          normalizedInstallments?.enabled &&
          normalizedInstallments?.interest_free &&
          strategyWarnings.includes("interest_free_installments_forces_conversion")
        ) {
          categoryWarnings.push("installments_interest_free_normalized_for_strategy");
        }

        // === 💰 Obtener pricing/comisiones ===
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
          const cachedCampaigns = getFromCache(`credential_${credential_id}`, 'special_installments_campaigns', campaignsCacheKey);
          if (cachedCampaigns) {
            campaignTags = Array.isArray(cachedCampaigns.tags) ? cachedCampaigns.tags : [];
            campaignTagsByListingType = cachedCampaigns.tags_by_listing_type || campaignTagsByListingType;
          } else {
            try {
              const campaignParams = {
                category_id: cat.category_id,
                channel: 'marketplace'
              };
              if (product?.brand) campaignParams.brand = String(product.brand);
              if (product?.model) campaignParams.model = String(product.model);

              const campaignsResponse = await axios.get(
                `https://api.mercadolibre.com/special_installments/campaigns`,
                {
                  params: campaignParams,
                  headers: { Authorization: `Bearer ${credential.access_token}` },
                  timeout: 12000
                }
              );

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
        }

        if (productPrice !== null) {
          const pricingCandidates = listingTypesForCategory.length > 0
            ? listingTypesForCategory
            : [{ value: effectiveListingType, title: effectiveListingType, description: effectiveListingType, ml_metadata: null }];

          for (const listingCandidate of pricingCandidates) {
            const pricingTypeId = listingCandidate.value;
            const pricingCacheKey = `pricing_${site_id}_${cat.category_id}_${requestFingerprint}_${pricingTypeId}`;
            const cachedPricingOption = getFromCache(`credential_${credential_id}`, 'category_pricing', pricingCacheKey);

            if (cachedPricingOption) {
              pricing_options.push(cachedPricingOption);
              continue;
            }

            try {
              pricingCalls++;
              const pricingUrl = `https://api.mercadolibre.com/sites/${site_id}/listing_prices`;
              const pricingParams = {
                price: productPrice,
                category_id: cat.category_id,
                listing_type_id: pricingTypeId
              };
              if (cat.domain_id) pricingParams.domain_id = cat.domain_id;

              const listingCampaignTags = Array.isArray(campaignTagsByListingType?.[pricingTypeId])
                ? campaignTagsByListingType[pricingTypeId]
                : [];
              const campaignTagRequested = normalizeCampaignTagValue(normalizedInstallments?.campaign_tag);
              const campaignTagSelected = campaignTagRequested && listingCampaignTags.includes(campaignTagRequested)
                ? campaignTagRequested
                : listingCampaignTags[0] || null;
              if (campaignTagSelected) pricingParams.tags = campaignTagSelected;

              const pricingResponse = await axios.get(pricingUrl, {
                params: pricingParams,
                headers: { Authorization: `Bearer ${credential.access_token}` },
                timeout: 15000
              });

              const fees = pricingResponse.data || {};
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

        // === 📦 NUEVO: Calcular costos de envío ===
        let shipping = null;

        const hasShippingInput = productPrice !== null && !!(dimensionsFormatted || product?.ml_item_id || product?.item_id);
        if (hasShippingInput) {
          // ✅ CORRECCIÓN: Incluir listing_type_id, logistic_type y shipping_mode en la clave
          const shippingBasis = dimensionsFormatted || product?.ml_item_id || product?.item_id;
          const shippingCacheKey = `shipping_${site_id}_${cat.category_id}_${shippingBasis}_${requestFingerprint}_${effectiveListingType}_${effectiveLogisticType}_${effectiveShippingMode}`;
          
          logger.info(`[SHIPPING] Cache key: ${shippingCacheKey}`);
          
          const cachedShipping = getFromCache(`credential_${credential_id}`, 'shipping_costs', shippingCacheKey);

          if (cachedShipping) {
            logger.info(`[CACHE HIT SHIPPING] Categoría ${cat.category_id} con config: ${effectiveListingType}/${effectiveLogisticType}/${effectiveShippingMode}`);
            shipping = cachedShipping;
          } else {
            try {
              shippingCalls += 2; // 2 llamadas API
              
              shipping = await OAuthController.calculateMercadoLibreShippingCosts(
                credential,
                { ...product, price: productPrice },
                cat.category_id,
                site_id,
                effectiveListingType,
                effectiveLogisticType,
                effectiveShippingMode
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
        }
        const shippingRequested = hasShippingInput;
        const shippingSummary = shipping?.shipping_summary || null;
        const sellerShippingCost = shippingSummary?.seller_shipping_cost ?? null;
        if (pricing && !pricing.error) {
          pricing.shipping_requested = shippingRequested;
          if (shippingRequested && Number.isFinite(Number(sellerShippingCost))) {
            pricing.seller_shipping_cost = Number(sellerShippingCost);
            pricing.net_amount_after_shipping = parseFloat(
              (Number(pricing.net_amount || 0) - Number(sellerShippingCost || 0)).toFixed(2)
            );
            pricing.shipping_scenario = shippingSummary?.scenario || null;
            pricing.shipping_who_pays = shippingSummary?.who_pays || null;
            pricing.buyer_shipping_cost = toNumberOrZero(shippingSummary?.buyer_shipping_cost);
            pricing.shipping_subsidy = toNumberOrZero(shippingSummary?.shipping_subsidy);
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
            productCost: productCostBasis
          });
          if (profitability) {
            pricing.profitability = profitability;
          }
        }

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

        const categoryData = {
          category_id: cat.category_id,
          category_name: cat.category_name,
          domain_id: cat.domain_id,
          domain_name: cat.domain_name,
          path: cat.path,
          listing_types: listingTypesForCategory,
          shipping_modes: filteredShippingModes,
          logistic_types: logisticTypesForCategory,
          defaults: {
            strategy: selectedStrategy,
            listing_type_id: effectiveListingType,
            shipping_mode: effectiveShippingMode,
            logistic_type: effectiveLogisticType,
            installments: normalizedInstallments,
            sale_terms_preview: buildInstallmentsSaleTermsPreview(normalizedInstallments)
          },
          installments_rules: {
            source: "backend_policy",
            scope: "category",
            user_can_choose: true,
            requires_strategy_conversion_for_interest_free: true,
            strategy_selected: selectedStrategy,
            enabled: normalizedInstallments.enabled,
            interest_free: normalizedInstallments.interest_free,
            max_installments_requested: normalizedInstallments.max_installments ?? null,
            max_installments_allowed: maxInstallmentsAllowed,
            allowed_values: installmentAllowedValues.length > 0 ? installmentAllowedValues : null,
            campaign_tags_available: campaignTags.length > 0 ? campaignTags : null,
            campaign_tags_by_listing_type: {
              gold_pro: campaignTagsByListingType.gold_pro || [],
              gold_special: campaignTagsByListingType.gold_special || [],
              free: campaignTagsByListingType.free || []
            },
            note: "Mercado Libre puede ajustar cuotas permitidas por categoría/listing_type/campaña/cuenta. Validación final ocurre en publicación."
          },
          selection_warnings: categoryWarnings,
          listing_resolution: listingResolution,
          attributes,
          ...(categoryInfo && { category_settings: categoryInfo.settings || {} }),
          ...(productPrice !== null && { pricing_options }),
          ...(productPrice !== null && { pricing }),
          ...(hasShippingInput && { shipping }),
          ...(hasShippingInput && { shipping_summary: shipping?.shipping_summary || null }),
          ...(hasShippingInput && { shipping_scenarios: shipping?.shipping_scenarios || null }),
          ...(hasShippingInput && { shipping_selected_scenario: shipping?.selected_scenario_key || null }),
          ...(hasShippingInput && { shipping_recommendations: {
            for_conversion: shipping?.mandatory_free_shipping_detected
              ? "mandatory_free_shipping"
              : "seller_free_shipping",
            for_margin: "buyer_pays_shipping"
          }}),
          ...(hasShippingInput && { shipping_policy: {
            requested_free_shipping: shipping?.requested_free_shipping ?? null,
            mandatory_free_shipping_detected: shipping?.mandatory_free_shipping_detected ?? false
          }})
        };

        saveToCache(`credential_${credential_id}`, `category_attributes_${site_id}_v4`, categoryCacheKey, categoryData);
        categoriesWithAttrs.push(categoryData);
      }

      saveToCache(`credential_${credential_id}`, `product_suggestion_${site_id}_v4`, productCacheKey, categoriesWithAttrs);

      suggestions.push({
        product_id: product.id,
        credential_id: credential_id,
        marketplace_id: marketplace_id,
        selection_context: {
          strategy: selectedStrategy,
          installments: normalizedInstallments,
          warnings: strategyWarnings
        },
        categories: categoriesWithAttrs
      });
    }

    const shippingRequested = products.some(
      p =>
        p.price !== undefined &&
        p.price !== null &&
        (p.package !== undefined || p.item_id !== undefined || p.ml_item_id !== undefined)
    );
    const allCategoriesFlattened = suggestions.flatMap(s => Array.isArray(s.categories) ? s.categories : []);
    const firstCategoryWithInstallments = allCategoriesFlattened.find(
      c => Array.isArray(c?.installments_rules?.allowed_values) && c.installments_rules.allowed_values.length > 0
    );
    const firstCategoryWithCampaigns = allCategoriesFlattened.find(
      c => c?.installments_rules?.campaign_tags_by_listing_type
    );
    const uiInstallmentsAllowedValues = firstCategoryWithInstallments?.installments_rules?.allowed_values || null;
    const uiMaxInstallmentsAllowed = firstCategoryWithInstallments?.installments_rules?.max_installments_allowed ?? null;
    const uiCampaignTagsByListingType = firstCategoryWithCampaigns?.installments_rules?.campaign_tags_by_listing_type || {
      gold_pro: [],
      gold_special: [],
      free: []
    };
    return res.status(200).json({
      success: true,
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
        installments: normalizedInstallments,
        installments_rules: {
          source: "backend_policy",
          scope: "request",
          user_can_choose: true,
          requires_strategy_conversion_for_interest_free: true,
          strategy_selected: selectedStrategy,
          enabled: normalizedInstallments.enabled,
          interest_free: normalizedInstallments.interest_free,
          max_installments_requested: normalizedInstallments.max_installments ?? null,
          max_installments_allowed: uiMaxInstallmentsAllowed,
          allowed_values: uiInstallmentsAllowedValues,
          campaign_tags_by_listing_type: uiCampaignTagsByListingType,
          note: "No hay endpoint estándar en este flujo que devuelva catálogo cerrado de cuotas por categoría. Se recomienda confirmar contra respuesta de publicación."
        },
        selection_scope: {
          strategy: "request",
          installments: "request",
          shipping_mode_requested: "request",
          logistic_type_requested: "request",
          listing_type_effective: "category",
          shipping_mode_effective: "category",
          logistic_type_effective: "category"
        },
        sale_terms_preview: buildInstallmentsSaleTermsPreview(normalizedInstallments),
        ui_hints: {
          show_installments_select: Array.isArray(uiInstallmentsAllowedValues) && uiInstallmentsAllowedValues.length > 0,
          installments_options: uiInstallmentsAllowedValues || [],
          show_campaign_tag_select: Object.values(uiCampaignTagsByListingType).some(v => Array.isArray(v) && v.length > 0),
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

    // === PROCESAR CADA PRODUCTO ===
    for (const product of products) {
      if (!product.id || !product.name) continue;

      const nameFixed = product.name.trim();
      const productPrice = (product.price !== undefined && product.price !== null && !isNaN(product.price))
        ? parseFloat(product.price) : null;

      // === Cache de producto ===
      const cachedProductResult = getFromCache(`credential_${credential_id}`, 'product_suggestion', nameFixed);
      if (cachedProductResult) {
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
            attributes = attrList.filter(attr => attr.Name && attr.Label).map(attr => ({
              id: attr.FeedName || attr.Name, name: attr.Label, label: attr.Label,
              is_mandatory: attr.isMandatory === "1" || attr.isMandatory === true,
              description: attr.Description || '', attribute_type: attr.AttributeType || 'string',
              example_value: attr.ExampleValue || '',
              value_type: ['option', 'multi_option'].includes(attr.AttributeType) ? 'list' :
                         attr.AttributeType === 'numberfield' ? 'number' : 'string',
              values: attr.Options?.Option
                ? (Array.isArray(attr.Options.Option)
                    ? attr.Options.Option.map(opt => ({ id: opt.id, name: opt.Name }))
                    : [{ id: attr.Options.Option.id, name: attr.Options.Option.Name }])
                : [],
              tags: { required: attr.isMandatory === "1", catalog_required: attr.isMandatory === "1", hidden: false }
            })).sort((a, b) => (a.is_mandatory ? 0 : 1) - (b.is_mandatory ? 0 : 1));
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
                  globalIdentifier: item.SuggestedCategory
                }
              );

              // 🔹 Paso 2: Si NO existe, consultar GetCategoryTree para auto-mapear
              if (!commission) {
                logger.info(`[AUTO-MAP] Categoría ${categoryId} no encontrada, consultando GetCategoryTree...`);
                treeCalls++;

                // Obtener árbol completo (se cachea en memoria si es necesario)
                const treeData = await OAuthController.fetchFalabellaCategoryTree(baseUrl, userId, apiKey);

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
  if (commissionByPath) {
    // 🔹 Paso 4: Actualizar el registro con los identificadores de API
    await CategoryCommissionRepository.updateCommissionIdentifiers(
      commissionByPath.id,
      {
        category_id: categoryId,
        global_identifier: item.SuggestedCategory,
        category_name_api: item.CategoryName
      }
    );
    
    commission = commissionByPath;
    logger.info(`[AUTO-MAP] ✅ Registro actualizado: ID=${commissionByPath.id}`);
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

      saveToCache(`credential_${credential_id}`, 'product_suggestion', nameFixed, categories);
      suggestions.push({ product_id: product.id, credential_id, marketplace_id, categories });
    }

    return res.status(200).json({
      success: true,
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
  
  const response = await axios.get(url);  
  //logger.info(`Arbol de categorías: \n ${JSON.stringify(response.data)}`);
  return response.data?.SuccessResponse?.Body?.Categories?.Category || [];
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
