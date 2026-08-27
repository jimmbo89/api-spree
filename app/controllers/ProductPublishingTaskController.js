// src/controllers/ProductPublishingTaskController.js
const logger = require('../../config/logger');
const { v4: uuidv4 } = require('uuid');
const { sequelize, Job } = require('../models');
const { Op } = require('sequelize');
const {
  ProductPublishingTaskRepository,
  ProductRepository,
  MarketplaceRepository,
  WarehouseRepository,
  CompanyRepository,
  UserRepository,
  LogRepository,
  WarehouseProductRepository,
  MarketplaceCredentialRepository,
  UserMarketplaceCredentialRepository,
  ProductMarketplaceLinkRepository,
  PoolRepository,
  UserAclScopeRepository,
  ProductCategoryRepository,
  JobRepository,
  JobProductRepository
} = require('../repositories');
const MercadoLibreAdapter = require('../services/adapters/MercadoLibreAdapter');
const FalabellaAdapter = require('../services/adapters/FalabellaAdapter');
const MarketplaceTransformer = require('../services/MarketplaceTransformer');
const PublishingService = require('../services/PublishingService');
const { getRequestMetadata } = require('../util/requestUtil');
const PublishingAdapterFactory = require('../services/adapters/PublishingAdapterFactory');
const MercadoLibreCapabilitiesService = require('../services/MercadoLibreCapabilitiesService');
const PublicationAuditService = require('../services/PublicationAuditService');

function normalizeWarningEntry(warning) {
  if (typeof warning === 'string') {
    const message = warning.trim();
    return {
      field: 'warning',
      message: message || 'Sin detalle',
      value: null
    };
  }

  if (!warning || typeof warning !== 'object') return null;

  return {
    field: warning.field || warning.code || 'unknown',
    message: warning.message || warning.error || warning.detail || 'Sin detalle',
    value: warning.value ?? null
  };
}

function buildWarningArtifacts(result) {
  const normalizedWarnings = Array.isArray(result?.warnings)
    ? result.warnings.map(normalizeWarningEntry).filter(Boolean)
    : [];
  const fallbackMessage = result?.warning_message || result?.error || result?.message || null;

  if (normalizedWarnings.length > 0) {
    return {
      hasWarnings: true,
      warningMessage: `Advertencias del marketplace: ${normalizedWarnings.map(w => {
        const field = w.field ? `${w.field}` : '';
        const message = w.message || 'Sin detalle';
        return field ? `${field}: ${message}` : message;
      }).join('; ')}`,
      warningDetails: {
        has_warnings: true,
        warnings: normalizedWarnings,
        published_successfully: true
      },
      warnings: normalizedWarnings
    };
  }

  if (result?.has_warnings) {
    return {
      hasWarnings: true,
      warningMessage: fallbackMessage ? `Advertencias del marketplace: ${fallbackMessage}` : 'Advertencias del marketplace',
      warningDetails: {
        has_warnings: true,
        warnings: fallbackMessage ? [{
          field: 'marketplace',
          message: fallbackMessage,
          value: null
        }] : [],
        published_successfully: true
      },
      warnings: fallbackMessage ? [{
        field: 'marketplace',
        message: fallbackMessage,
        value: null
      }] : []
    };
  }

  return {
    hasWarnings: false,
    warningMessage: null,
    warningDetails: null,
    warnings: null
  };
}

function logMarketplaceCredentialSecrets(credentials = []) {
  credentials.forEach((credential) => {
    const mpName = credential.marketplace?.name || credential.marketplace?.type || 'Marketplace';
    logger.warn('[marketplaces-pools][DEBUG_CREDENTIALS] Credencial descifrada', {
      marketplace: mpName,
      marketplace_id: credential.marketplace?.id || null,
      credential_id: credential.id,
      seller_id: credential.seller_id || null,
      seller_email: credential.seller_email || null,
      access_token: credential.access_token || null,
      refresh_token: credential.refresh_token || null,
      api_key: credential.api_key || null
    });
  });
}

function normalizeErrorDetails(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
      return {};
    }
  }
  return {};
}

function buildProductMarketplaceLinkScope(pool = {}) {
  const primaryWarehouse = pool?.primary_warehouse || {};

  if (pool?.company_id != null) {
    return {
      company_id: pool.company_id,
      branch_id: null
    };
  }

  if (primaryWarehouse?.branch_id != null) {
    return {
      company_id: null,
      branch_id: primaryWarehouse.branch_id
    };
  }

  return {
    company_id: null,
    branch_id: null
  };
}

function normalizePublishedPayload(rawPayload) {
  if (!rawPayload) return null;

  let parsed = rawPayload;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch (error) {
      return null;
    }
  }

  if (parsed && typeof parsed === 'object' && parsed.payload && typeof parsed.payload === 'object') {
    parsed = parsed.payload;
  }

  return parsed && typeof parsed === 'object' ? parsed : null;
}

function firstNonEmptyPublishedPayload(...payloads) {
  for (const payload of payloads) {
    const normalized = normalizePublishedPayload(payload);
    if (normalized && typeof normalized === 'object' && Object.keys(normalized).length > 0) {
      return normalized;
    }
  }
  return null;
}

function resolveFalabellaFeedId(task, marketplaceLink = null) {
  const sources = [
    normalizeErrorDetails(task?.error_details),
    normalizePublishedPayload(task?.api_response),
    normalizePublishedPayload(task?.payload),
    normalizePublishedPayload(marketplaceLink?.published_payload)
  ].filter(Boolean);

  for (const source of sources) {
    const feedIdCandidates = [
      source.feed_id,
      source.feedId,
      source.FeedID,
      source.FeedId,
      source.request_id,
      source.requestId,
      source.feed?.FeedID,
      source.feed?.FeedId,
      source.feed?.feed_id,
      source.data?.feed_id,
      source.data?.feed?.FeedID
    ];

    for (const candidate of feedIdCandidates) {
      const normalized = String(candidate || '').trim();
      if (normalized) {
        return normalized;
      }
    }
  }

  return null;
}

function normalizeProductImages(images) {
  if (!images) return [];

  if (Array.isArray(images)) {
    return images
      .flatMap((image) => normalizeProductImages(image))
      .filter((image) => image !== null && image !== undefined && image !== '');
  }

  if (typeof images === 'string') {
    const trimmed = images.trim();
    if (!trimmed) return [];

    if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
      try {
        return normalizeProductImages(JSON.parse(trimmed));
      } catch (error) {
        return [trimmed];
      }
    }

    return [trimmed];
  }

  if (typeof images === 'object') {
    const values = Object.values(images);
    return values.flatMap((image) => normalizeProductImages(image));
  }

  return [];
}

function extractPublishedStock(payload) {
  if (!payload || typeof payload !== 'object') return null;
  // ✅ Incluir versiones en minúscula Y mayúscula (Falabella usa Price/Stock)
  const directFields = [
    payload.available_quantity,
    payload.stock,
    payload.Stock, // ✅ Falabella
    payload.publishStock,
    payload.initial_quantity,
    payload.totalPublishingStock,
    payload.totalStock
  ];

  for (const value of directFields) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.round(parsed);
    }
  }

  // ✅ Buscar también en BusinessUnits (estructura de respuesta Falabella)
  const businessUnit = Array.isArray(payload?.BusinessUnits?.BusinessUnit)
    ? payload.BusinessUnits.BusinessUnit[0]
    : payload?.BusinessUnits?.BusinessUnit || null;
  
  if (businessUnit?.Stock !== undefined && businessUnit?.Stock !== null) {
    const parsed = Number(businessUnit.Stock);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.round(parsed);
    }
  }

  const variations = Array.isArray(payload.variations)
    ? payload.variations
    : Array.isArray(payload.items)
      ? payload.items
      : [];

  if (variations.length === 0) return null;

  const totals = variations
    .map((variation) => {
      const value =
        variation?.available_quantity ??
        variation?.stock ??
        variation?.Stock ?? // ✅ Falabella
        variation?.publishStock ??
        variation?.initial_quantity ??
        variation?.quantity;
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
    })
    .filter((value) => value !== null);

  if (totals.length === 0) return null;
  return totals.reduce((sum, value) => sum + value, 0);
}

function extractPublishedPrice(payload) {
  if (!payload || typeof payload !== 'object') return null;

  // ✅ Incluir versiones en minúscula Y mayúscula (Falabella usa Price)
  const directFields = [
    payload.price,
    payload.Price, // ✅ Falabella
    payload.final_price,
    payload.list_price,
    payload.base_price
  ];

  for (const value of directFields) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  // ✅ Buscar también en BusinessUnits (estructura de respuesta Falabella)
  const businessUnit = Array.isArray(payload?.BusinessUnits?.BusinessUnit)
    ? payload.BusinessUnits.BusinessUnit[0]
    : payload?.BusinessUnits?.BusinessUnit || null;
  
  if (businessUnit?.Price !== undefined && businessUnit?.Price !== null) {
    const parsed = Number(businessUnit.Price);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  const variations = Array.isArray(payload.variations)
    ? payload.variations
    : Array.isArray(payload.items)
      ? payload.items
      : [];

  if (variations.length === 0) return null;

  const firstWithPrice = variations.find((variation) => {
    const parsed = Number(variation?.price ?? variation?.Price); // ✅ Falabella
    return Number.isFinite(parsed) && parsed >= 0;
  });

  if (!firstWithPrice) return null;
  const parsed = Number(firstWithPrice.price ?? firstWithPrice.Price);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
/*function extractPublishedStock(payload) {
  if (!payload || typeof payload !== 'object') return null;

  const directFields = [
    payload.available_quantity,
    payload.stock,
    payload.publishStock,
    payload.initial_quantity,
    payload.totalPublishingStock,
    payload.totalStock
  ];

  for (const value of directFields) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.round(parsed);
    }
  }

  const variations = Array.isArray(payload.variations)
    ? payload.variations
    : Array.isArray(payload.items)
      ? payload.items
      : [];

  if (variations.length === 0) return null;

  const totals = variations
    .map((variation) => {
      const value =
        variation?.available_quantity ??
        variation?.stock ??
        variation?.publishStock ??
        variation?.initial_quantity ??
        variation?.quantity;
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
    })
    .filter((value) => value !== null);

  if (totals.length === 0) return null;
  return totals.reduce((sum, value) => sum + value, 0);
}

function extractPublishedPrice(payload) {
  if (!payload || typeof payload !== 'object') return null;

  const directFields = [
    payload.price,
    payload.final_price,
    payload.list_price,
    payload.base_price
  ];

  for (const value of directFields) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  const variations = Array.isArray(payload.variations)
    ? payload.variations
    : Array.isArray(payload.items)
      ? payload.items
      : [];

  if (variations.length === 0) return null;

  const firstWithPrice = variations.find((variation) => {
    const parsed = Number(variation?.price);
    return Number.isFinite(parsed) && parsed >= 0;
  });

  if (!firstWithPrice) return null;
  const parsed = Number(firstWithPrice.price);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}*/

function resolveMarketplaceKey(marketplace = {}) {
  const domain = String(marketplace?.domain || '').toLowerCase();
  const name = String(marketplace?.name || '').toLowerCase();

  if (domain.includes('mercadolibre') || name.includes('mercado libre') || name.includes('mercadolibre')) {
    return 'mercadolibre';
  }

  if (domain.includes('falabella') || name.includes('falabella')) {
    return 'falabella';
  }

  return 'unknown';
}

function buildPublishedStatusOptions() {
  return [
    { id: 'active', name: 'Activa', marketplaces: ['mercadolibre', 'falabella'], shared: true },
    { id: 'deleted', name: 'Eliminada', marketplaces: ['mercadolibre', 'falabella'], shared: true },
    { id: 'paused', name: 'Pausada', marketplaces: ['mercadolibre'], shared: false },
    { id: 'under_review', name: 'En revisión', marketplaces: ['mercadolibre', 'falabella'], shared: false },
    { id: 'closed', name: 'Cerrada', marketplaces: ['mercadolibre'], shared: false },
    { id: 'inactive', name: 'Inactiva', marketplaces: ['falabella'], shared: false },
    { id: 'pending', name: 'Pendiente', marketplaces: ['falabella'], shared: false },
    { id: 'failed', name: 'Fallida', marketplaces: ['falabella'], shared: false },
    { id: 'rejected', name: 'Rechazada', marketplaces: ['falabella'], shared: false },
    { id: 'not_published', name: 'No publicada', marketplaces: ['falabella'], shared: false }, // ✅ NUEVO
    { id: 'sold_out', name: 'Sin stock', marketplaces: ['falabella'], shared: false },
    { id: 'image_missing', name: 'Sin imagen', marketplaces: ['falabella'], shared: false },
    { id: 'unknown', name: 'Desconocido', marketplaces: ['mercadolibre', 'falabella'], shared: false }
  ];
}

function extractMercadoLibreState(task) {
  const stateSources = [
    task?.error_details?.marketplace_item_state?.status,
    task?.error_details?.status,
    task?.api_response?.status,
    task?.marketplace_status,
    task?.status
  ];

  for (const value of stateSources) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function extractPublishedMarketplaceStatus(task, marketplaceLink) {
  const stateSources = [
    marketplaceLink?.status,
    task?.error_details?.marketplace_item_state?.status,
    task?.error_details?.status,
    task?.api_response?.status,
    task?.status
  ];

  for (const value of stateSources) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized) {
      return normalized;
    }
  }

  return 'unknown';
}

function classifyMarketplaceState(status) {
  const normalized = String(status || '').trim().toLowerCase();

  if (!normalized) {
    return 'unknown';
  }

  // ✅ Estados que cuentan como "activo" (visible en marketplace)
  if (normalized === 'active' || normalized === 'live') {
    return 'active';
  }

  // ✅ Estados que cuentan como "inactivo" (no visible)
  if (normalized === 'deleted' || normalized === 'closed' || normalized === 'inactive') {
    return 'deleted';
  }

  // ✅ Estados específicos de Falabella
  if (normalized === 'pending') {
    return 'under_review';
  }

  if (normalized === 'rejected') {
    return 'rejected';
  }

  if (normalized === 'not_published') {
    return 'not_published';
  }

  if (normalized === 'failed' || normalized === 'error') {
    return 'failed';
  }

  if (normalized === 'processing') {
    return 'processing';
  }

  return 'unknown';
}

function resolveFalabellaMarketplaceDisplayStatus(productStatus, { taskStatus = null, hasImage = true } = {}) {
  const normalizedTaskStatus = String(taskStatus || '').trim().toLowerCase();

  if (!productStatus || typeof productStatus !== 'object') {
    if (normalizedTaskStatus === 'failed' || normalizedTaskStatus === 'error') {
      return 'failed';
    }
    if (normalizedTaskStatus === 'pending') {
      return 'pending';
    }
    return 'processing';
  }

  if (productStatus.found === false) {
    if (normalizedTaskStatus === 'failed' || normalizedTaskStatus === 'error') {
      return 'failed';
    }
    return 'pending';
  }

  const status = String(productStatus.status || '').trim().toLowerCase();
  const qcStatus = String(productStatus.qc_status || '').trim().toLowerCase();
  const isPublished = productStatus.is_published;
  const productErrors = Array.isArray(productStatus.product_errors) ? productStatus.product_errors : [];
  const hasPublicUrl = typeof productStatus.url === 'string' && productStatus.url.trim().length > 0;
  const hasShopSku = typeof productStatus.shop_sku === 'string' && productStatus.shop_sku.trim().length > 0;
  const qcApproved = ['approved', 'active', 'live'].includes(qcStatus);
  const strongPublishSignal = hasPublicUrl || hasShopSku || isPublished === true;

  const looksPublished = ['active', 'live'].includes(status)
    && hasImage !== false
    && productErrors.length === 0
    && (
      (qcApproved && strongPublishSignal)
      || (isPublished === true && qcStatus !== 'rejected')
    );

  if (looksPublished) {
    return 'active';
  }

  if (qcStatus === 'pending') {
    return 'under_review';
  }

  if (qcStatus === 'rejected') {
    return 'rejected';
  }

  if (['inactive', 'deleted'].includes(status)) {
    return status;
  }

  if (status === 'active' && isPublished === false) {
    return 'not_published';
  }

  if (taskStatus === 'pending') {
    return 'pending';
  }

  if (taskStatus === 'processing') {
    return 'processing';
  }

  if (normalizedTaskStatus === 'failed' || normalizedTaskStatus === 'error') {
    return 'failed';
  }

  if (normalizedTaskStatus === 'pending') {
    return 'pending';
  }

  if (normalizedTaskStatus === 'processing') {
    return 'processing';
  }

  if (!status || status === 'unknown') {
    if (normalizedTaskStatus === 'failed' || normalizedTaskStatus === 'error') {
      return 'failed';
    }
    if (normalizedTaskStatus === 'pending') {
      return 'pending';
    }
    if (normalizedTaskStatus === 'processing') {
      return 'processing';
    }
    return 'failed';
  }

  return status || 'failed';
}

function buildMercadoLibreItemStateSnapshotFromItem(item, source = 'manual_update') {
  const status = String(item?.status || '').trim().toLowerCase() || null;
  const subStatus = Array.isArray(item?.sub_status)
    ? item.sub_status.map((value) => String(value).trim()).filter(Boolean)
    : item?.sub_status
      ? [String(item.sub_status).trim()].filter(Boolean)
      : [];

  return {
    marketplace: 'mercado_libre',
    status,
    sub_status: subStatus,
    sub_status_text: subStatus.join(', '),
    verified: true,
    item_found: true,
    note: source,
    attempts: 0,
    updated_at: new Date().toISOString()
  };
}

function isMercadoLibrePictureProcessingSnapshot(snapshot) {
  return snapshot?.status === 'paused'
    && Array.isArray(snapshot.sub_status)
    && snapshot.sub_status.some((value) => String(value).toLowerCase() === 'picture_download_pending');
}

function normalizeMlEditRequestValue(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return value;
}

function normalizeFalabellaEditRequestValue(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return value;
}

function buildFalabellaPublicationNote(productState) {
  if (!productState) return null;

  // ✅ EXTRAER ERRORES REALES DEL RAW RESPONSE
  const rawProduct = productState.raw || {};
  const realErrors = FalabellaAdapter.extractRealFalabellaErrors(rawProduct);

  // ✅ PRIORIDAD 1: Si hay errores REALES de Falabella, mostrarlos TAL CUAL
  if (realErrors && realErrors.length > 0) {
    const errorMessages = realErrors.map(err => {
      // Mostrar SOLO el mensaje exacto que devuelve Falabella
      return `[${err.source.toUpperCase()}] ${err.message}`;
    }).join('\n');
    
    return `❌ ERRORES DE FALABELLA:\n${errorMessages}`;
  }

  // ✅ PRIORIDAD 2: Si hay feed_errors guardados, mostrarlos
  const feedErrors = productState.feed_errors || [];
  if (feedErrors.length > 0) {
    const errorMessages = feedErrors.map(err => {
      const msg = err.Message || err.message || String(err);
      const field = err.Field || err.field || '';
      return field ? `${field}: ${msg}` : msg;
    }).join('; ');
    
    return `❌ ERROR DE FALABELLA: ${errorMessages}`;
  }

  // ✅ PRIORIDAD 3: Si hay error_message genérico, mostrarlo
  if (productState.error_message) {
    return `❌ ${productState.error_message}`;
  }

  return null;
}

function extractFalabellaRawMessages(source) {
  if (!source || typeof source !== 'object') return [];

  const messages = [];
  const pushText = (value) => {
    if (typeof value !== 'string') return;
    const text = value.trim();
    if (text) messages.push(text);
  };

  const visit = (value) => {
    if (!value) return;
    if (typeof value === 'string') {
      pushText(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value === 'object') {
      [
        value.QCMessage,
        value.qc_message,
        value.QCReason,
        value.qc_reason,
        value.ErrorMessage,
        value.error_message,
        value.Reason,
        value.reason,
        value.Message,
        value.message,
        value.Detail,
        value.detail,
        value.Error,
        value.error
      ].forEach(pushText);

      if (value.Error || value.Errors || value.Warning || value.Warnings) {
        visit(value.Error || value.Errors || value.Warning || value.Warnings);
      }
    }
  };

  [
    source.QCMessage,
    source.qc_message,
    source.QCReason,
    source.qc_reason,
    source.ErrorMessage,
    source.error_message,
    source.Reason,
    source.reason,
    source.Message,
    source.message,
    source.Detail,
    source.detail,
    source.FeedErrors,
    source.FeedWarnings,
    source.Errors,
    source.Warnings,
    source.Issues,
    source.Messages
  ].forEach(visit);

  return [...new Set(messages)];
}

function buildFalabellaPublicationNoteExact(productState) {
  if (!productState) return null;

  const exactMessages = [
    ...extractFalabellaRawMessages(productState.raw || {}),
    ...extractFalabellaRawMessages(productState.feed_status || {}),
    ...extractFalabellaRawMessages(productState.product_status || {}),
    ...extractFalabellaRawMessages(productState)
  ];

  const uniqueMessages = [...new Set(exactMessages)];
  return uniqueMessages.length > 0 ? uniqueMessages.join('\n') : null;
}

function buildFalabellaPublishedStateSnapshot(product, sellerSku) {
  // ✅ Manejar diferentes estructuras de respuesta de GetProducts de Falabella
  let businessUnit = null;

  if (Array.isArray(product?.BusinessUnits?.BusinessUnit)) {
    businessUnit = product.BusinessUnits.BusinessUnit[0];
  } else if (product?.BusinessUnits?.BusinessUnit && typeof product.BusinessUnits.BusinessUnit === 'object') {
    businessUnit = product.BusinessUnits.BusinessUnit;
  } else if (Array.isArray(product?.BusinessUnit)) {
    businessUnit = product.BusinessUnit[0];
  } else if (product?.BusinessUnit && typeof product.BusinessUnit === 'object') {
    businessUnit = product.BusinessUnit;
  }

  const rawStatus = String(businessUnit?.Status || product?.status || 'unknown').trim().toLowerCase() || 'unknown';

  // ✅ Extraer IsPublished según documentación oficial Falabella
  const isPublishedRaw = businessUnit?.IsPublished ?? product?.IsPublished ?? null;
  const isPublished = isPublishedRaw !== null
    ? (String(isPublishedRaw).trim() === '1' || isPublishedRaw === 1 || isPublishedRaw === true)
    : null;

  // ✅ Extraer QCStatus según documentación oficial
  const qcStatus = String(businessUnit?.QCStatus || product?.QCStatus || product?.qc_status || '').trim().toLowerCase() || null;

  // ✅ NUEVO: Extraer errores específicos del producto
  const productErrors = product?.Errors?.Error || product?.errors || [];
  const normalizedErrors = Array.isArray(productErrors) 
    ? productErrors 
    : (productErrors ? [productErrors] : []);

  // ✅ Determinar estado REAL de publicación
  let realStatus = rawStatus;
  if (rawStatus === 'active') {
    if (isPublished === false) {
      realStatus = 'not_published';
    } else if (qcStatus === 'rejected') {
      realStatus = 'rejected';
    } else if (qcStatus === 'pending') {
      realStatus = 'pending';
    }
  }

  return {
    sku: String(product?.SellerSku || sellerSku || '').trim(),
    status: realStatus,
    raw_status: rawStatus,
    is_published: isPublished,
    qc_status: qcStatus,
    has_image: FalabellaAdapter.hasFalabellaImage(product),
    price: businessUnit?.Price !== undefined && businessUnit?.Price !== null
      ? Number(businessUnit.Price)
      : null,
    available_quantity: businessUnit?.Stock !== undefined && businessUnit?.Stock !== null
      ? Number(businessUnit.Stock)
      : null,
    permalink: product?.Url || product?.url || null,
    url: product?.Url || product?.url || null,
    shop_sku: product?.ShopSku || product?.shop_sku || null,
    // ✅ NUEVO: Incluir errores específicos del producto
    product_errors: normalizedErrors.map(err => ({
      code: err.Code || err.code || null,
      message: err.Message || err.message || String(err),
      field: err.Field || err.field || null
    })),
    raw: product
  };
}

function formatDateKey(dateValue) {
  if (!(dateValue instanceof Date) || Number.isNaN(dateValue.getTime())) {
    return null;
  }

  const year = dateValue.getFullYear();
  const month = String(dateValue.getMonth() + 1).padStart(2, '0');
  const day = String(dateValue.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseDateKey(dateInput, fallbackDate) {
  if (dateInput === null || dateInput === undefined || dateInput === '') {
    return formatDateKey(fallbackDate);
  }

  const raw = String(dateInput).trim();
  const datePart = raw.includes('T') ? raw.split('T')[0] : raw.slice(0, 10);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return null;
    return formatDateKey(parsed);
  }

  return datePart;
}

function formatDateTimeDisplay(dateValue) {
  if (!dateValue) return null;

  const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
  if (Number.isNaN(date.getTime())) return null;

  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');

  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

function normalizeDateRange(startDateInput, endDateInput) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);

  const startDate = parseDateKey(startDateInput, monthStart);
  const endDate = parseDateKey(endDateInput, monthEnd);

  if (!startDate) {
    throw new Error('start_date_invalid');
  }
  if (!endDate) {
    throw new Error('end_date_invalid');
  }

  if (startDate > endDate) {
    throw new Error('date_range_invalid');
  }

  return { startDate, endDate };
}

const ProductPublishingTaskController = {
  // 1. Registrar publicación (simula envío a API)
async warehouseMarketplaces(req, res) {
  logger.info(`${req.user?.name || 'Unknown'} - Lista ruta combinada de almacenes y marketplaces`);

  const { company_id, status, user_id } = req.body;
  const authUserId = Number(req.user?.id || 0) || null;
  const authCompanyId = Number(req.user?.company_id || 0) || null;
  const bodyCompanyId = company_id ? Number(company_id) : null;
  const bodyUserId = user_id ? Number(user_id) : null;
  const userId = bodyUserId || authUserId;
  const companyId = authCompanyId || bodyCompanyId;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  if (authCompanyId && bodyCompanyId && authCompanyId !== bodyCompanyId) {
    return res.status(403).json({
      success: false,
      message: 'companyContextMismatch'
    });
  }

  if (!companyId) {
    return res.status(400).json({
      success: false,
      message: 'company_id_required'
    });
  }

  if (companyId) {
    const company = await CompanyRepository.findById(companyId);
    if (!company) {
      logger.info(`WarehouseController->list: Compañía no encontrada con ID ${companyId}`);
      return res.status(400).json({ success: false, message: "companyNotFound" });
    }
  }

  try {
    const aclScopes = await UserAclScopeRepository.findByUserAndCompany(userId, companyId);
    const allowedPoolIds = [...new Set(
      aclScopes
        .filter((scope) => scope.pool_id)
        .map((scope) => Number(scope.pool_id))
        .filter((poolId) => Number.isFinite(poolId))
    )];
    const allowedWarehouseIds = [...new Set(
      aclScopes
        .filter((scope) => scope.warehouse_id)
        .map((scope) => Number(scope.warehouse_id))
        .filter((warehouseId) => Number.isFinite(warehouseId))
    )];

    const pools = await PoolRepository.findFiltered({
      companyId,
      isActive: true,
      poolIds: allowedPoolIds,
      warehouseIds: allowedWarehouseIds
    });

    const credentials = await UserMarketplaceCredentialRepository.findActiveCredentialsByUserAndCompany(userId, companyId, null);

    // 3. ✅ RENOVAR TOKENS EXPIRADOS ANTES DE TRANSFORMAR
    const refreshedCredentials = await ProductPublishingTaskController.refreshExpiredTokens(credentials, userId);
    logMarketplaceCredentialSecrets(refreshedCredentials);

    // 4. Transformar resultados (igual que antes, pero con credenciales actualizadas)
    /*const marketplaces = refreshedCredentials.map(credential => {
      const mp = credential.marketplace;

      // Opcional: limpiar espacios en domain
      if (typeof mp.domain === 'string') {
        mp.domain = mp.domain.trim();
      }

      return {
        id: credential.id,
        name: credential.name || `${mp.name} (${credential.seller_email || 'Sin nombre'})`,
        description: mp.description || 'Integración con marketplace',
        marketplace_id: mp.id,
        marketplace_name: mp.name,
        type: mp.type,
        domain: mp.domain,
        config: mp.config,
        active: mp.active,
        client_id: mp.client_id,
        client_secret: mp.client_secret,
        redirect_uri: mp.redirect_uri,
        scopes: mp.scopes,
        createdAt: mp.createdAt,
        updatedAt: mp.updatedAt,
        credential_id: credential.id,
        access_token: credential.access_token ? 'Token existente' : null,
        seller_id: credential.seller_id,
        seller_email: credential.seller_email,
        api_key: credential.api_key,
        expires_at: credential.expires_at,
        is_expired: credential.expires_at ? new Date(credential.expires_at) < new Date() : false,
        country: credential.country,
        fieldMappings: credential.fieldMappings
      };
    });*/
     const marketplaces = await Promise.all(refreshedCredentials.map(async (credential) => {
      const mp = credential.marketplace;

      // Limpiar espacios en domain
      if (typeof mp.domain === 'string') {
        mp.domain = mp.domain.trim();
      }

      // ✅ Base del objeto marketplace
      const marketplaceData = {
        id: credential.id,
        name: credential.name || `${mp.name} (${credential.seller_email || 'Sin nombre'})`,
        description: mp.description || 'Integración con marketplace',
        marketplace_id: mp.id,
        marketplace_name: mp.name,
        type: mp.type,
        domain: mp.domain,
        config: mp.config,
        active: mp.active,
        client_id: mp.client_id,
        client_secret: mp.client_secret,
        redirect_uri: mp.redirect_uri,
        scopes: mp.scopes,
        createdAt: mp.createdAt,
        updatedAt: mp.updatedAt,
        credential_id: credential.id,
        access_token: credential.access_token ? 'Token existente' : null,
        seller_id: credential.seller_id,
        seller_email: credential.seller_email,
        api_key: credential.api_key,
        expires_at: credential.expires_at,
        is_expired: credential.expires_at ? new Date(credential.expires_at) < new Date() : false,
        country: credential.country,
        fieldMappings: credential.fieldMappings
      };

      // ✅ NUEVO: Agregar opciones dinámicas SOLO si es MercadoLibre
      /*if (MercadoLibreCapabilitiesService.isMercadoLibreCredential(credential)) {
        try {
          // Obtener capabilities en paralelo (no bloqueante para el resto)
          const [listingTypes, shippingModes, logisticTypes] = await Promise.all([
            MercadoLibreCapabilitiesService.getAvailableListingTypes(credential),
            MercadoLibreCapabilitiesService.getAvailableShippingModes(credential),
            MercadoLibreCapabilitiesService.getAvailableLogisticTypes(credential)
          ]);

          marketplaceData.options = {
            listing_types: listingTypes,
            shipping_modes: shippingModes,
            logistic_types: logisticTypes,
            source: 'dynamic', // Indicar que son opciones dinámicas
            ml_user_id: MercadoLibreCapabilitiesService.getMercadoLibreUserId(credential)
          };
          
          logger.debug(`[warehouseMarketplaces] Capabilities cargadas para credencial ML ${credential.id}`);
          
        } catch (capError) {
          logger.warn(`[warehouseMarketplaces] Error cargando capabilities para ML ${credential.id}: ${capError.message}`);
          // Fallback a opciones estáticas
          marketplaceData.options = {
            listing_types: MercadoLibreCapabilitiesService.getFallbackListingTypes(),
            shipping_modes: MercadoLibreCapabilitiesService.getFallbackShippingModes(),
            logistic_types: MercadoLibreCapabilitiesService.getFallbackLogisticTypes(),
            source: 'fallback',
            warning: 'No se pudieron cargar opciones dinámicas'
          };
        }
      } else {
        // Para otros marketplaces, usar opciones estáticas o vacío
        marketplaceData.options = {
          listing_types: [],
          shipping_modes: [],
          logistic_types: [],
          source: 'static',
          note: 'Este marketplace usa configuración manual'
        };
      }*/

      return marketplaceData;
    }));
    const categories = await ProductCategoryRepository.findActive();

    res.status(200).json({ 
      success: true, 
      pools: pools, 
      marketplaces: marketplaces, 
      categories: categories 
    });
  } catch (error) {
    logger.error('ProductCategoryController->warehouseMarketplaces: ' + error.message);
    res.status(500).json({ 
      success: false,  
      message: 'Error interno del servidor', 
      details: error.message 
    });
  }
},

// Nuevo endpoint: combina marketplaces-pools + productos según product_id
async warehouseMarketplacesWithProduct(req, res) {
  logger.info(`${req.user?.name || 'Unknown'} - Lista ruta combinada de almacenes, marketplaces y productos por product_id`);

  const { company_id, product_id, user_id } = req.body;
  const authUserId = Number(req.user?.id || 0) || null;
  const authCompanyId = Number(req.user?.company_id || 0) || null;
  const bodyCompanyId = company_id ? Number(company_id) : null;
  const bodyUserId = user_id ? Number(user_id) : null;
  const userId = bodyUserId || authUserId;
  const companyId = authCompanyId || bodyCompanyId;

  if (!userId) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  if (authCompanyId && bodyCompanyId && authCompanyId !== bodyCompanyId) {
    return res.status(403).json({
      success: false,
      message: 'companyContextMismatch'
    });
  }

  if (!companyId) {
    return res.status(400).json({
      success: false,
      message: 'company_id_required'
    });
  }

  if (companyId) {
    const company = await CompanyRepository.findById(companyId);
    if (!company) {
      logger.info(`WarehouseController->list: Compañía no encontrada con ID ${companyId}`);
      return res.status(400).json({ success: false, message: "companyNotFound" });
    }
  }

  try {
    const aclScopes = await UserAclScopeRepository.findByUserAndCompany(userId, companyId);
    const allowedPoolIds = [...new Set(
      aclScopes
        .filter((scope) => scope.pool_id)
        .map((scope) => Number(scope.pool_id))
        .filter((poolId) => Number.isFinite(poolId))
    )];
    const allowedWarehouseIds = [...new Set(
      aclScopes
        .filter((scope) => scope.warehouse_id)
        .map((scope) => Number(scope.warehouse_id))
        .filter((warehouseId) => Number.isFinite(warehouseId))
    )];

    let pools = await PoolRepository.findFiltered({
      companyId,
      isActive: true,
      poolIds: allowedPoolIds,
      warehouseIds: allowedWarehouseIds
    });

    const credentials = await UserMarketplaceCredentialRepository.findActiveCredentialsByUserAndCompany(userId, companyId, null);
    const refreshedCredentials = await ProductPublishingTaskController.refreshExpiredTokens(credentials, userId);

    const marketplaces = refreshedCredentials.map(credential => {
      const mp = credential.marketplace;

      if (typeof mp.domain === 'string') {
        mp.domain = mp.domain.trim();
      }

      return {
        id: credential.id,
        name: credential.name || `${mp.name} (${credential.seller_email || 'Sin nombre'})`,
        description: mp.description || 'Integración con marketplace',
        marketplace_id: mp.id,
        marketplace_name: mp.name,
        type: mp.type,
        domain: mp.domain,
        config: mp.config,
        active: mp.active,
        client_id: mp.client_id,
        client_secret: mp.client_secret,
        redirect_uri: mp.redirect_uri,
        scopes: mp.scopes,
        createdAt: mp.createdAt,
        updatedAt: mp.updatedAt,
        credential_id: credential.id,
        access_token: credential.access_token ? 'Token existente' : null,
        seller_id: credential.seller_id,
        seller_email: credential.seller_email,
        api_key: credential.api_key,
        expires_at: credential.expires_at,
        is_expired: credential.expires_at ? new Date(credential.expires_at) < new Date() : false,
        country: credential.country,
        fieldMappings: credential.fieldMappings
      };
    });

    const categories = await ProductCategoryRepository.findActive();

    // Determinar pool con mayor stock del product_id
    let selectedPoolId = null;
    let selectedWarehouseIds = [];

    if (Array.isArray(pools) && pools.length > 0) {
      const allWarehouseIds = [
        ...new Set(
          pools.flatMap(pool => (pool.warehouses || []).map(w => w.warehouse_id).filter(Boolean))
        )
      ];

      const stockByWarehouse = await WarehouseProductRepository.getProductStockByWarehouseIds({
        productId: product_id,
        warehouseIds: allWarehouseIds
      });

      let maxStock = -1;
      for (const pool of pools) {
        let poolStock = 0;
        if (Array.isArray(pool.warehouses)) {
          for (const w of pool.warehouses) {
            poolStock += stockByWarehouse[w.warehouse_id] || 0;
          }
        }

        if (poolStock > maxStock) {
          maxStock = poolStock;
          selectedPoolId = pool.id;
        }
      }

      if (selectedPoolId == null && pools.length > 0) {
        selectedPoolId = pools[0].id;
      }

      pools = pools.map(pool => ({
        ...pool,
        is_selected: pool.id === selectedPoolId
      }));

      const selectedPool = pools.find(p => p.id === selectedPoolId);
      selectedWarehouseIds = (selectedPool?.warehouses || [])
        .map(w => w.warehouse_id)
        .filter(Boolean);
    }

    let products = [];
    if (selectedWarehouseIds.length > 0) {
      products = await WarehouseProductRepository.findProductsByWarehouseIds({
        companyId,
        warehouseIds: selectedWarehouseIds
      });

      products = products.map(product => ({
        ...product,
        is_selected: product.id === Number(product_id)
      }));
    }

    res.status(200).json({
      success: true,
      pools,
      marketplaces,
      categories,
      products
    });
  } catch (error) {
    logger.error('ProductCategoryController->warehouseMarketplacesWithProduct: ' + error.message);
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor',
      details: error.message
    });
  }
},

/**
 * Verifica y renueva automáticamente tokens expirados para marketplaces que lo requieran
 * @param {Array} credentials - Lista de credenciales con marketplace incluido
 * @param {number} userId - ID del usuario propietario
 * @returns {Promise<Array>} - Lista de credenciales (algunas con tokens renovados)
 */
async refreshExpiredTokens(credentials, userId) {
  // Marketplaces que requieren validación de token (no API key como Falabella)
  
  const refreshPromises = credentials.map(async (credential) => {
    try {
      if (credential.active === false || Number(credential.active) === 0) {
        logger.debug(`[refreshExpiredTokens] Credential ${credential.id} inactiva; se omite refresh automatico`);
        return credential;
      }

      const mp = credential.marketplace;
      const mpName = mp?.domain || '';
      
      // ✅ Solo procesar marketplaces basados en token
      const isTokenBased = mpName.includes("mercadolibre");
      if (!isTokenBased) {
        return credential; // Falabella y otros con API key no necesitan refresh
      }
      
      // ✅ Verificar si el token está expirado o ausente
      const isExpired = credential.expires_at 
        ? new Date(credential.expires_at) < new Date() 
        : true;
      
      const hasNoToken = !credential.access_token;
      
      if (isExpired || hasNoToken) {
        logger.info(`[warehouseMarketplaces] Token expirado/ausente para credential ${credential.id}. Intentando refresh...`);

        const refreshed = await ProductPublishingTaskController.refreshSingleCredential(
          credential,
          mp,
          userId,
          true
        );

        if (refreshed && refreshed.id) {
          logger.info(`[warehouseMarketplaces] ✅ Token renovado para credential ${credential.id}`);
          return refreshed;
        }

        logger.warn(`[warehouseMarketplaces] ⚠️ No se pudo renovar credential ${credential.id}`);
      }
      
      return credential; // Retornar original si no hubo cambios o falló el refresh
    } catch (error) {
      // ✅ NO bloquear el flujo: loggear y continuar con la credencial original
      logger.error(`[warehouseMarketplaces] Error al refresh credential ${credential?.id}: ${error.message}`);
      return credential;
    }
  });
  
  // ✅ Ejecutar en paralelo con aislamiento de errores
  const results = await Promise.all(refreshPromises);
  return results;
},

/**
 * ✅ Verifica y renueva token expirado para UNA credencial específica
 * @param {Object} credential - Credencial a validar/renovar
 * @param {Object} marketplace - Marketplace asociado
 * @param {number} userId - ID del usuario
 * @returns {Promise<Object>} - Credencial actualizada o original
 */
  async refreshSingleCredential(credential, marketplace, userId, forceRefresh = false) {
    try {
      if (credential?.active === false || Number(credential?.active) === 0) {
        logger.debug(`[refreshSingleCredential] Credential ${credential.id} inactiva; se omite refresh automatico`);
        return credential;
      }

      const mpName = marketplace?.domain || '';
    
    // ✅ Solo marketplaces basados en token (no API key)
    if (!mpName.includes('mercadolibre')) {
      logger.debug(`[refreshSingleCredential] Marketplace ${mpName} no requiere token refresh`);
      return credential;
    }
    
    // ✅ Verificar expiración
    const isExpired = credential.expires_at 
      ? new Date(credential.expires_at) < new Date() 
      : true;
    
    const hasNoToken = !credential.access_token;
    
    if (!forceRefresh && !isExpired && !hasNoToken) {
      return credential; // Token válido
    }
    
    logger.info(`[refreshSingleCredential] 🔑 Token expirado/ausente para credential ${credential.id}. Renovando...`);

    // ✅ Crear adapter y renovar
    credential.marketplace = credential.marketplace || marketplace;

    const adapter = PublishingAdapterFactory.getAdapter(
      marketplace,
      null, // companyId
      null, // branchId
      userId,
      credential
    );
    
    if (!adapter || typeof adapter.ensureValidCredentials !== 'function') {
      logger.warn(`[refreshSingleCredential] Adapter no soporta refresh para ${mpName}`);
      return credential;
    }
    adapter.auditContext = {
      actor_type: 'user',
      actor_id: userId,
      actor_name: `Usuario ${userId}`,
      source: 'product_publishing',
      triggered_by: 'user'
    };
    
    if (forceRefresh && credential.refresh_token && typeof adapter.refreshAccessToken === 'function') {
      adapter.credential = credential;
      await adapter.refreshAccessToken();
      logger.info(`[refreshSingleCredential] Token forzado renovado exitosamente para credential ${credential.id}`);

      const updated = await MarketplaceCredentialRepository.findById(credential.id);
      if (updated) {
        updated.marketplace = marketplace;
        return updated;
      }

      return adapter.credential || credential;
    }

    const status = await adapter.ensureValidCredentials();
    
    if (status.valid) {
      logger.info(`[refreshSingleCredential] ✅ Token renovado exitosamente para credential ${credential.id}`);

      // ✅ Recargar credencial actualizada desde BD
      const updated = await MarketplaceCredentialRepository.findById(credential.id);
      if (updated) {
        updated.marketplace = marketplace;
        return updated;
      }
    } else if (status.auth_required) {
      logger.warn(`[refreshSingleCredential] ⚠️ Credential ${credential.id} requiere re-autorización: ${status.auth_url}`);
      throw new Error(`auth_required:${status.auth_url}`);
    } else {
      logger.warn(`[refreshSingleCredential] ⚠️ No se pudo renovar credential ${credential.id}: ${status.error || 'unknown'}`);
    }
    
    return credential;
    
  } catch (error) {
    logger.error(`[refreshSingleCredential] Error al renovar credential ${credential?.id}: ${error.message}`);
    throw error; // Propagar error para que el endpoint lo maneje
  }
},
async store(req, res) {
  logger.info(`${req.user?.name || 'Unknown'} - Solicitud de publicación en ${req.body.mode} iniciada`);
  logger.info(`Datos recibidos:\n ${JSON.stringify(req.body, null, 2)}`);

  const { products, marketplaces, pool: rawPool, mode, draft_name, economic_config, publication_step } = req.body;
  const user_id = req.user.id;
  const company_id = req.user.company_id;
  const metadata = getRequestMetadata(req);


    // IDs fijos para testing (los que proporcionaste)
    const SIM_JOB_ID = 6;
    const SIM_BATCH_ID = 'c5a4e469-5b04-4772-88e7-684d980c5122';

  // === VALIDACIONES ===
  // Validar que mode tenga un valor válido (validación redundante por seguridad)
  const validModes = ['draft', 'publish', 'quick', 'advanced', 'manual'];
  if (!mode || !validModes.includes(mode)) {
    return res.status(400).json({ 
      success: false, 
      msg: "modo_invalido",
      details: `El campo "mode" es obligatorio y debe ser uno de: ${validModes.join(', ')}`,
      received_value: mode
    });
  }
  
  if (!Array.isArray(products) || products.length === 0) {
    return res.status(400).json({ 
      success: false, 
      msg: "productos_requeridos",
      details: "El campo 'products' es obligatorio y debe contener al menos un producto"
    });
  }

  // ✅ marketplaces es opcional solo cuando mode === 'draft'
  const isDraft = mode === 'draft';
  if (!isDraft && (!Array.isArray(marketplaces) || marketplaces.length === 0)) {
    return res.status(400).json({ 
      success: false, 
      msg: "marketplaces_requeridos",
      details: "El campo 'marketplaces' es obligatorio cuando el modo no es 'draft'. Debe contener al menos un marketplace"
    });
  }

  // === NUEVO: Validar publication_step ===
  const step = publication_step !== undefined ? parseInt(publication_step) : 3; // Default: 3 (Resumen completado)
  if (!Number.isInteger(step) || step < 0 || step > 5) {
    return res.status(400).json({
      success: false,
      msg: "publication_step_invalid",
      details: "El paso debe ser un entero entre 0 y 5"
    });
  }

  const batch_id = uuidv4();

  // === Normalizar pool seleccionado ===
  let pool = rawPool || null;
  if (pool && !pool.primary_warehouse && Array.isArray(pool.warehouses) && pool.warehouses.length > 0) {
    pool.primary_warehouse = pool.warehouses[0];
  }

  const poolId = pool?.id || pool?.pool_id || null;

  if (!pool || !pool.primary_warehouse) {
    // Fallback: buscar un almacén activo de la empresa
    const activeWarehouses = await WarehouseRepository.getActiveWarehouses(company_id, null);
    if (!Array.isArray(activeWarehouses) || activeWarehouses.length === 0) {
      return res.status(400).json({
        success: false,
        msg: "pool_required",
        details: "Debe seleccionar un pool con primary_warehouse o tener un almacén activo disponible"
      });
    }

    const fallback = activeWarehouses[0];
    pool = {
      primary_warehouse: {
        warehouse_id: fallback.id,
        branch_id: null
      },
      warehouses: [
        { warehouse_id: fallback.id, branch_id: null }
      ]
    };
  }

  // ✅ Validar marketplaces solo si se enviaron (para verificar que existen)
  let marketplaceIds = [];
  if (Array.isArray(marketplaces) && marketplaces.length > 0) {
    marketplaceIds = [...new Set(marketplaces.map(mp => Number(mp.marketplace_id || mp.id)))];
    const validation = await MarketplaceRepository.findByIds(marketplaceIds);
    if (!validation.valid) {
      return res.status(400).json({ 
        success: false, 
        msg: "marketplaces_no_encontrados",
        details: "Algunos marketplaces no existen o no están disponibles",
        invalid_ids: validation.invalid_ids || marketplaceIds
      });
    }
  }

  // ✅ Determinar job_type según el modo
  const actualMode = isDraft ? 'quick' : mode;
  const job_type = isDraft ? 'draft' : 'publish';

  // ✅ Calcular total de productos × marketplaces para el job
  const totalExpected = products.length * (marketplaces?.length || 0);

  // ✅ Crear job padre
  // 🔑 IMPORTANTE: Guardar TODOS los datos originales del frontend + campos calculados
  const jobRecord = await JobRepository.create({
    user_id: req.user.id,
    company_id: req.user.company_id,
    job_type: job_type,
    mode: actualMode,
    batch_id: batch_id,
    publication_step: step,  // ← NUEVO: Guardar paso de la publicación
    total_products: totalExpected,  // ← ✅ Pasar total esperado
    config: {
      // 🔑 GUARDAR DATOS ORIGINALES DEL FRONTEND (exactamente como llegan)
      ...req.body,  // ← Esto incluye: products, marketplaces, pool, mode, economic_config, draft_name, publication_step, etc.
      
      // 🔑 CAMPOS CALCULADOS/ADICIONALES (para uso interno)
      pool_id: poolId,  // ← ID del pool calculado
      _processed_at: new Date().toISOString(),  // ← Timestamp de procesamiento
      _total_expected: totalExpected  // ← Total calculado
    }
  });

  // 🔑 Extraer el ID (jobRecord es un objeto con propiedad 'id')
  const jobId = jobRecord?.id;

  // ✅ Validar que jobId sea válido
  if (!jobId || isNaN(jobId)) {
    logger.error('[Controller] jobId inválido:', { jobRecord });
    return res.status(500).json({
      success: false,
      msg: "job_creation_failed",
      details: "No se pudo obtener el ID del job creado"
    });
  }

  // ✅ Crear JobProducts para cada combinación producto × credential
  // Solo crear si hay marketplaces (en modo draft puede no haber)
  if (Array.isArray(marketplaces) && marketplaces.length > 0) {
    for (const product of products) {
      for (const mpConfig of marketplaces) {
        const jobProduct = await JobProductRepository.create({
          job_id: jobId,  // ← ✅ jobId ya es un número
          product_id: product.id,
          marketplace_id: mpConfig.marketplace_id,
          credential_id: mpConfig.id,
          product_payload: product ? JSON.parse(JSON.stringify(product)) : null,
          marketplace_payload: mpConfig ? JSON.parse(JSON.stringify(mpConfig)) : null,
          status: 'pending',
          attempt_count: 0
        });

        const marketplaceDomain = String(mpConfig?.domain || mpConfig?.marketplace_name || '').toLowerCase();
        const isFalabellaMarketplace = marketplaceDomain.includes('falabella');

        if (isFalabellaMarketplace) {
          const linkScope = buildProductMarketplaceLinkScope(pool);
          try {
            await ProductMarketplaceLinkRepository.upsert({
              product_id: product.id,
              marketplace_id: mpConfig.marketplace_id,
              credential_id: mpConfig.id,
              user_id: req.user.id,
              ...linkScope,
              status: 'pending',
              external_id: null,
              external_url: null,
              published_stock: null,
              published_payload: null,
              last_synced_at: new Date()
            });
          } catch (linkError) {
            logger.error(
              `[Controller] No se pudo crear link inicial Falabella product=${product.id} marketplace=${mpConfig.marketplace_id}: ${linkError.message}`
            );
          }
        }
      }
    }
  }

  // ✅ Log de creación
  await LogRepository.create({
    user_id: metadata.user_id,
    action: 'publishing_job.created',
    description: `Job creado: ${jobId} - ${products.length} productos × ${marketplaces?.length || 0} marketplaces`,
    ip_address: metadata.ip_address,
    user_agent: metadata.user_agent,
    status: 'success',
    meta: {
      job_id: jobId,
      batch_id,
      product_count: products.length,
      marketplace_count: Array.isArray(marketplaces) ? marketplaces.length : 0,
      mode: actualMode,
      total_expected: totalExpected
    }
  });

  if (isDraft) {
    await PublicationAuditService.recordDraftCreated(req, jobRecord, {
      products,
      marketplaces: Array.isArray(marketplaces) ? marketplaces : []
    });
  } else {
    await PublicationAuditService.recordProcessEvent(req, jobRecord, 'process.created', {
      description: `Proceso #${jobId} creado para publicación`,
      new_value: {
        products_count: products.length,
        marketplaces_count: Array.isArray(marketplaces) ? marketplaces.length : 0,
        total_expected: totalExpected
      }
    });
    await PublicationAuditService.recordProcessEvent(req, jobRecord, 'process.started', {
      description: `Proceso #${jobId} iniciado`,
      new_value: { status: 'pending' }
    });
  }

  // ✅ Responder inmediatamente (background job)
  return res.status(202).json({
    success: true,
    message: isDraft 
      ? "Borrador guardado exitosamente" 
      : "Publicación en proceso en segundo plano",
    job_id: jobId,  // ← ✅ jobId es número, NO jobId.id
    batch_id: batch_id,
    tasks_count: totalExpected,
    status: 'pending'
  });
},
  async publishDraft(req, res) {
  logger.info(`${req.user?.name || 'Unknown'} - Publicando draft`);
  logger.info(`Datos recibidos:\n ${JSON.stringify(req.body)}`);

  const metadata = getRequestMetadata(req);

  const isJobFlow = req.body && (req.body.job_id || req.body.action);
  if (isJobFlow) {
    const {
      job_id,
      action,
      products,
      marketplaces,
      pool: rawPool,
      mode,
      draft_name,
      economic_config,
      publication_step
    } = req.body;

    const company_id = req.user.company_id;

    try {
      if (!['update', 'publish'].includes(action)) {
        return res.status(400).json({ 
          success: false, 
          msg: "accion_invalida",
          details: "El campo 'action' debe ser 'update' o 'publish'"
        });
      }
      if (!Array.isArray(products) || products.length === 0) {
        return res.status(400).json({ 
          success: false, 
          msg: "productos_requeridos",
          details: "El campo 'products' es obligatorio y debe contener al menos un producto"
        });
      }

      // ✅ marketplaces es opcional cuando action === 'update' (solo se actualiza el borrador)
      // ✅ marketplaces es requerido cuando action === 'publish' (se va a publicar)
      if (action === 'publish' && (!Array.isArray(marketplaces) || marketplaces.length === 0)) {
        return res.status(400).json({ 
          success: false, 
          msg: "marketplaces_requeridos",
          details: "El campo 'marketplaces' es obligatorio cuando la acción es 'publish'. Debe contener al menos un marketplace"
        });
      }

      const jobInstance = await Job.findByPk(job_id);
      if (!jobInstance || jobInstance.company_id !== company_id) {
        return res.status(404).json({ success: false, msg: "draft_not_found" });
      }
      const job = jobInstance.get({ plain: true });
      // `get({ plain: true })` shares nested JSON values with Sequelize's instance.
      // Keep an independent state so auditing compares against pre-update config.
      const previousJob = {
        ...job,
        config: JSON.parse(JSON.stringify(job.config || {}))
      };

      if (job.job_type !== 'draft') {
        return res.status(400).json({
          success: false,
          msg: "not_a_draft",
          details: "El job no es un borrador"
        });
      }

      const step = publication_step !== undefined
        ? parseInt(publication_step)
        : (job.publication_step ?? 3);

      if (!Number.isInteger(step) || step < 0 || step > 5) {
        return res.status(400).json({
          success: false,
          msg: "publication_step_invalid",
          details: "El paso debe ser un entero entre 0 y 5"
        });
      }

      // Normalizar mode
      const normalizeMode = (value) => {
        if (!value) return value;
        if (value === 'draft') return 'quick';
        return value;
      };
      const actualMode = normalizeMode(mode || job.mode || 'quick');

      // Normalizar pool
      let pool = rawPool || job?.config?.pool || null;
      if (pool && !pool.primary_warehouse && Array.isArray(pool.warehouses) && pool.warehouses.length > 0) {
        pool.primary_warehouse = pool.warehouses[0];
      }

      const poolId = pool?.id || pool?.pool_id || null;

      if (!pool || !pool.primary_warehouse) {
        const activeWarehouses = await WarehouseRepository.getActiveWarehouses(company_id, null);
        if (!Array.isArray(activeWarehouses) || activeWarehouses.length === 0) {
          return res.status(400).json({
            success: false,
            msg: "pool_required",
            details: "Debe seleccionar un pool con primary_warehouse o tener un almacén activo disponible"
          });
        }

        const fallback = activeWarehouses[0];
        pool = {
          primary_warehouse: {
            warehouse_id: fallback.id,
            branch_id: null
          },
          warehouses: [
            { warehouse_id: fallback.id, branch_id: null }
          ]
        };
      }

      // ✅ Validar marketplaces solo si se enviaron (para action === 'publish' o si hay marketplaces)
      let normalizedMarketplaces = [];
      if (Array.isArray(marketplaces) && marketplaces.length > 0) {
        const marketplaceIds = [...new Set(marketplaces.map(mp => Number(mp.marketplace_id || mp.marketplace?.id || mp.marketplaceId || mp.id)))];
        const validation = await MarketplaceRepository.findByIds(marketplaceIds);
        if (!validation.valid) {
          return res.status(400).json({ 
          success: false, 
          msg: "marketplaces_no_encontrados",
          details: "Algunos marketplaces no existen o no están disponibles"
        });
        }

        normalizedMarketplaces = marketplaces.map(mpConfig => {
          const marketplaceId = Number(mpConfig.marketplace_id || mpConfig.marketplace?.id || mpConfig.marketplaceId || mpConfig.id);
          const credentialId = Number(mpConfig.credential_id || mpConfig.id);

          return {
            original: mpConfig,
            marketplace_id: marketplaceId,
            credential_id: credentialId
          };
        });

        const invalidMarketplace = normalizedMarketplaces.find(mp => !mp.marketplace_id || !mp.credential_id);
        if (invalidMarketplace) {
          return res.status(400).json({
            success: false,
            msg: "marketplace_or_credential_invalid"
          });
        }

        // ✅ REFRESCO PREVENTIVO DE TOKENS (antes de publicar)
        // Esto evita errores de autenticación durante la publicación en background
      if (action === 'publish') {
        const credentialIds = normalizedMarketplaces.map(mp => mp.credential_id);
        const accessibleCredentials = await UserMarketplaceCredentialRepository.findActiveCredentialsByUserAndCompany(
          metadata.user_id,
          company_id,
          null
        );
        const accessibleCredentialIds = new Set(
          (Array.isArray(accessibleCredentials) ? accessibleCredentials : [])
            .map(cred => Number(cred.id))
            .filter(id => Number.isInteger(id) && id > 0)
        );
        const unauthorizedCredentialIds = credentialIds.filter(id => !accessibleCredentialIds.has(Number(id)));

        if (unauthorizedCredentialIds.length > 0) {
          return res.status(403).json({
            success: false,
            msg: 'credentials_not_allowed',
            details: `Las credenciales ${unauthorizedCredentialIds.join(', ')} no están asignadas al usuario en esta empresa`
          });
        }

        const credentials = await MarketplaceCredentialRepository.findByIds(credentialIds);

          if (credentials.length > 0) {
            logger.info(`[publishDraft] 🔄 Refrescando ${credentials.length} credenciales antes de publicar...`);

            // ✅ Refrescar tokens expirados (sin bloquear si falla)
            const refreshedCredentials = await ProductPublishingTaskController.refreshExpiredTokens(
              credentials,
              metadata.user_id
            );

            // ✅ Verificar si alguna credencial requiere re-autorización
            const authRequired = refreshedCredentials.filter(cred => {
              const mpDomain = cred.marketplace?.domain || '';
              // Solo verificar marketplaces basados en token (MercadoLibre)
              if (!mpDomain.includes('mercadolibre')) {
                return false; // API key no expira
              }
              const isExpired = cred.expires_at ? new Date(cred.expires_at) < new Date() : true;
              const hasNoToken = !cred.access_token;
              return isExpired || hasNoToken;
            });

            if (authRequired.length > 0) {
              const authUrls = authRequired.map(cred => ({
                credential_id: cred.id,
                marketplace_name: cred.marketplace?.name || 'Marketplace',
                marketplace_domain: cred.marketplace?.domain || '',
                auth_url: cred.marketplace?.auth_url || null
              }));

              logger.warn(`[publishDraft] ⚠️ ${authUrls.length} credenciales requieren re-autorización`);

              // ✅ Retornar información de re-autorización al frontend
              return res.status(401).json({
                success: false,
                msg: "auth_required",
                details: "Algunas credenciales requieren re-autorización antes de publicar",
                credentials_requiring_auth: authUrls
              });
            }

            logger.info(`[publishDraft] ✅ Tokens refrescados exitosamente`);
          }
        }
      }

      const job_type = action === 'publish' ? 'publish' : 'draft';
      const totalExpected = products.length * (normalizedMarketplaces.length || 0);

      // Actualizar job padre
      const configMode = mode || job.mode || actualMode;
      const configBody = { ...req.body };
      delete configBody.job_id;
      delete configBody.action;

      const newConfig = {
        ...configBody,
        pool,
        mode: configMode,
        publication_step: step,
        draft_name: draft_name ?? job.draft_name,
        economic_config: economic_config ?? job.config?.economic_config,
        pool_id: poolId,
        _processed_at: new Date().toISOString(),
        _total_expected: totalExpected
      };

      const updatedJob = await JobRepository.update(jobInstance, {
        job_type,
        mode: actualMode,
        draft_name: draft_name ?? job.draft_name,
        publication_step: step,
        total_products: totalExpected,
        status: 'pending',
        processed: 0,
        successful: 0,
        errors_count: 0,
        percentage: 0,
        started_at: null,
        completed_at: null,
        error_summary: null,
        config: newConfig
      });

      // Sincronizar JobProducts
      const existingJobProducts = await JobProductRepository.findAll({
        where: { job_id: job_id }
      });

      const existingMap = new Map();
      existingJobProducts.forEach(jp => {
        const key = `${jp.product_id}-${jp.marketplace_id}-${jp.credential_id || ''}`;
        existingMap.set(key, jp);
      });

      const newMap = new Map();
      const toCreate = [];
      const toUpdate = [];

      // ✅ Solo procesar JobProducts si hay marketplaces (action === 'update' sin marketplaces no crea JobProducts)
      if (normalizedMarketplaces.length > 0) {
        for (const product of products) {
          for (const mpConfig of normalizedMarketplaces) {
            const marketplaceId = mpConfig.marketplace_id;
            const credentialId = mpConfig.credential_id;

            const key = `${product.id}-${marketplaceId}-${credentialId}`;
            newMap.set(key, true);

            const payload = {
              product_payload: product ? JSON.parse(JSON.stringify(product)) : null,
              marketplace_payload: mpConfig?.original ? JSON.parse(JSON.stringify(mpConfig.original)) : null
            };

            if (existingMap.has(key)) {
              toUpdate.push({ jobProduct: existingMap.get(key), payload });
            } else {
              toCreate.push({
                job_id: job_id,
                product_id: product.id,
                marketplace_id: marketplaceId,
                credential_id: credentialId,
                ...payload,
                status: 'pending',
                attempt_count: 0
              });
            }
          }
        }
      }

      const toDeleteIds = existingJobProducts
        .filter(jp => !newMap.has(`${jp.product_id}-${jp.marketplace_id}-${jp.credential_id || ''}`))
        .map(jp => jp.id);

      const resetFields = {
        status: 'pending',
        attempt_count: 0,
        error_message: null,
        error_details: null,
        external_id: null,
        external_url: null,
        last_attempt_at: null
      };

      for (const item of toUpdate) {
        await JobProductRepository.update(item.jobProduct.id, {
          ...resetFields,
          ...item.payload
        });
      }

      for (const item of toCreate) {
        await JobProductRepository.create(item);
      }

      if (toDeleteIds.length > 0) {
        await JobProductRepository.deleteMany({
          id: { [Op.in]: toDeleteIds }
        });
      }

      await LogRepository.create({
        user_id: metadata.user_id,
        action: action === 'publish' ? 'publishing_draft.publish' : 'publishing_draft.update',
        description: `Draft ${job_id} ${action === 'publish' ? 'publicado' : 'actualizado'} (${products.length} productos × ${normalizedMarketplaces.length} marketplaces)`,
        ip_address: metadata.ip_address,
        user_agent: metadata.user_agent,
        status: 'success',
        meta: {
          job_id: job_id,
          batch_id: job.batch_id,
          total_expected: totalExpected,
          action
        }
      });

      await PublicationAuditService.recordDraftDiff(req, previousJob, updatedJob);
      if (action === 'publish') {
        await PublicationAuditService.recordDraftExecuted(req, updatedJob);
        await PublicationAuditService.recordProcessEvent(req, updatedJob, 'process.created', {
          description: `Proceso #${updatedJob.id} creado desde borrador`,
          new_value: {
            status: updatedJob.status,
            total_products: updatedJob.total_products
          }
        });
        await PublicationAuditService.recordProcessEvent(req, updatedJob, 'process.started', {
          description: `Proceso #${updatedJob.id} iniciado por publicación`,
          new_value: { status: updatedJob.status }
        });
      }

      return res.status(202).json({
        success: true,
        message: action === 'publish'
          ? "Publicación en proceso en segundo plano"
          : "Borrador guardado exitosamente",
        job_id: job_id,
        batch_id: job.batch_id,
        tasks_count: totalExpected,
        status: 'pending'
      });

    } catch (error) {
      logger.error('Error publicando/actualizando draft:', error.message);
      await LogRepository.create({
        user_id: metadata?.user_id,
        action: 'publishing_draft.error',
        description: `Error: ${error.message}`,
        ip_address: metadata?.ip_address,
        user_agent: metadata?.user_agent,
        status: 'error',
        meta: { job_id, action }
      });
      return res.status(500).json({
        success: false,
        msg: "internal_error",
        error: error.message
      });
    }
  }

  const { task_id, mode } = req.body;
  const user_id = req.user.id;

  try {
    // 1. Obtener tarea draft
    const task = await ProductPublishingTaskRepository.findById(task_id);
    if (!task) {
      return res.status(404).json({ success: false, msg: "task_not_found" });
    }

    if (task.status !== 'draft') {
      return res.status(400).json({ 
        success: false, 
        msg: "task_not_draft",
        current_status: task.status
      });
    }

    // 2. Validar entidades
    const marketplace = await MarketplaceRepository.findById(task.marketplace_id);
    const warehouse = await WarehouseRepository.findById(task.warehouse_id);
    const product = await ProductRepository.findById(task.product_id);
    let credential = await MarketplaceCredentialRepository.findById(task.credential_id);

    if (!marketplace || !warehouse || !product || !credential) {
      return res.status(400).json({ 
        success: false, 
        msg: "related_entity_not_found" 
      });
    }

    // 3. ✅ RENOVAR TOKEN SI ES NECESARIO (antes de publicar)
    try {
      credential = await ProductPublishingTaskController.refreshSingleCredential(
        credential,
        marketplace,
        user_id
      );
    } catch (refreshError) {
      if (refreshError.message.startsWith('auth_required:')) {
        const auth_url = refreshError.message.replace('auth_required:', '');
        return res.status(401).json({
          success: false,
          msg: "auth_required",
          auth_url: auth_url
        });
      }
      throw refreshError;
    }

    // 4. Actualizar tarea a pending
    await ProductPublishingTaskRepository.updateStatus(task, 'pending', {
      publishing_mode: mode || task.publishing_mode,
      attempt_count: (task.attempt_count || 0) + 1
    });

    // 5. ✅ REPUBLICAR con credencial actualizada
    const result = await PublishingService.republishProduct(
      task,
      marketplace,
      credential,
      user_id
    );

    // 6. Actualizar task
    const warningArtifacts = buildWarningArtifacts(result);
    const hasWarnings = warningArtifacts.hasWarnings;
    const draftStatus = result.status || (hasWarnings ? 'published_with_warnings' : (result.success ? 'published' : 'failed'));
    const warningMessage = warningArtifacts.warningMessage;
    const warningDetails = warningArtifacts.warningDetails;

    await ProductPublishingTaskRepository.updateTask(task, {
      status: draftStatus,
      error_message: result.success ? warningMessage : result.error,
      error_details: result.success ? warningDetails : result.details,
      external_id: result.success ? result.external_id : task.external_id,
      external_url: result.success ? (result.external_url || result.data?.permalink) : task.external_url,
      attempt_count: (task.attempt_count || 0) + 1,
      last_attempt_at: new Date(),
      api_response: result.data || task.api_response,
      published_at: result.success ? new Date() : task.published_at
    });

    // 7. Logs y respuesta
    if (result.success) {
      await LogRepository.create({
        user_id: metadata.user_id,
        action: 'publishing_task.draft_published',
        description: `Draft ${task_id} publicado exitosamente`,
        ip_address: metadata.ip_address,
        user_agent: metadata.user_agent,
        status: 'success',
        meta: { task_id, product_id: task.product_id, external_id: result.external_id }
      });

      return res.status(200).json({
        success: true,
        message: "Publicación exitosa",
        data: {
          task_id: task.id,
          product_id: task.product_id,
          external_id: result.external_id,
          external_url: result.external_url || result.data?.permalink,
          status: draftStatus,
          has_warnings: hasWarnings,
          warnings: warningArtifacts.warnings
        }
      });
    } else {
      await LogRepository.create({
        user_id: metadata.user_id,
        action: 'publishing_task.draft_publish_failed',
        description: `Draft ${task_id} falló: ${result.error}`,
        ip_address: metadata.ip_address,
        user_agent: metadata.user_agent,
        status: 'error',
        meta: { task_id, product_id: task.product_id, error: result.error }
      });

      return res.status(200).json({
        success: false,
        message: "Publicación fallida",
        data: {
          task_id: task.id,
          product_id: task.product_id,
          error: result.error,
          error_details: result.details,
          attempt_count: (task.attempt_count || 0) + 1
        }
      });
    }

  } catch (error) {
    logger.error('Error publicando draft:', error.message);
    await LogRepository.create({
      user_id: metadata?.user_id,
      action: 'publishing_task.draft_publish_error',
      description: `Error: ${error.message}`,
      ip_address: metadata?.ip_address,
      user_agent: metadata?.user_agent,
      status: 'error',
      meta: { task_id }
    });
    return res.status(500).json({ 
      success: false, 
      msg: "internal_error",
      error: error.message 
    });
  }
},
  async listDrafts(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Listando drafts`);
    
    const { company_id, user_id } = req.body;
    const userId = user_id || req.user.id;

    try {
      const drafts = await ProductPublishingTaskRepository.findDraftsByUser(userId, company_id);

      const grouped = {};
      drafts.forEach(draft => {
        if (!grouped[draft.batch_id]) {
          grouped[draft.batch_id] = {
            batch_id: draft.batch_id,
            draft_name: draft.draft_name,
            created_at: draft.createdAt,
            products: []
          };
        }
        grouped[draft.batch_id].products.push({
          id: draft.id,
          product_id: draft.product_id,
          marketplace_id: draft.marketplace_id,
          marketplace_name: draft.marketplace?.name,
          credential_id: draft.credential_id,
          credential_name: draft.credential?.name,
          product_name: draft.product?.name,
          status: draft.status
        });
      });

      return res.status(200).json({
        success: true,
        drafts: Object.values(grouped)
      });

    } catch (error) {
      logger.error('Error listando drafts:', error.message);
      return res.status(500).json({
        success: false,
        msg: "internal_error",
        error: error.message
      });
    }
  },

  /**
   * Obtiene un borrador por batch_id o job_id para edición
   * POST /api/publishing-draft-get
   * Body: { batch_id: 'uuid', job_id: 123 } (al menos uno)
   */
  async getDraft(req, res) {
    const { batch_id, job_id } = req.body;
    const { company_id } = req.user;
    const metadata = getRequestMetadata(req);

    try {
      // 1. Validar que al menos un identificador sea proporcionado
      if (!batch_id && !job_id) {
        return res.status(400).json({
          success: false,
          msg: "missing_identifier",
          details: "Debe proporcionar batch_id o job_id"
        });
      }

      // 2. Obtener job usando batch_id (PRIORITARIO) o job_id
      let job;
      if (batch_id) {
        job = await JobRepository.findByBatchId(batch_id, company_id);
      } else {
        job = await JobRepository.findById(job_id);
        
        // Validar que pertenece a la empresa
        if (job && job.company_id !== company_id) {
          job = null;
        }
      }
      
      if (!job) {
        return res.status(404).json({
          success: false,
          msg: "draft_not_found"
        });
      }

      // 3. Validar que es un draft
      if (job.job_type !== 'draft') {
        return res.status(400).json({
          success: false,
          msg: "not_a_draft",
          details: "El job no es un borrador"
        });
      }

      // 4. Validar integridad de datos (productos existen)
      const productIds = job.config?.products?.map(p => p.id) || [];
      if (productIds.length > 0) {
        const existingProducts = await ProductRepository.findByIds(productIds);
        
        if (existingProducts.length !== productIds.length) {
          const missingIds = productIds.filter(id => 
            !existingProducts.find(p => p.id === id)
          );
          
          logger.warn(`[getDraft] Productos faltantes en borrador ${job.id}:`, missingIds);
          
          // Retornar warning al frontend
          return res.status(200).json({
            success: true,
            data: {
              job_id: job.id,
              batch_id: job.batch_id,
              draft_name: job.draft_name,
              mode: job.mode,
              publication_step: job.publication_step,
              pool: job.config?.pool,
              products: [],
              marketplaces: [],
              economic_config: job.config?.economic_config,
              created_at: job.createdAt,
              updated_at: job.updatedAt
            },
            warnings: {
              missing_products: missingIds,
              message: `Algunos productos ya no existen (${missingIds.length}). Se recomienda revisar.`
            }
          });
        }
      }

      // 5. Validar que las credenciales siguen activas
      const credentialIds = job.config?.marketplaces?.map(m => m.id) || [];
      if (credentialIds.length > 0) {
        const existingCredentials = await MarketplaceCredentialRepository.findByIds(credentialIds);
        
        if (existingCredentials.length !== credentialIds.length) {
          const missingCreds = credentialIds.filter(id => 
            !existingCredentials.find(c => c.id === id)
          );
          
          logger.warn(`[getDraft] Credenciales faltantes en borrador ${job.id}:`, missingCreds);
        }
      }

      // 6. Obtener job_products relacionados
      const jobProducts = await JobProductRepository.findAll({
        where: { job_id: job.id }
      });

      // ✅ Parsear config si es string JSON
      let parsedConfig = job.config;
      if (typeof job.config === 'string') {
        try {
          parsedConfig = JSON.parse(job.config);
        } catch (e) {
          logger.warn(`Error al parsear config del draft ${job.id}: ${e.message}`);
          parsedConfig = {};
        }
      }

      // 7. Reconstruir datos para el frontend
      // 🔑 IMPORTANTE: Devolver el config COMPLETO tal cual se guardó + datos enriquecidos
      const draftData = {
        job_id: job.id,
        batch_id: job.batch_id,
        draft_name: job.draft_name,
        mode: job.mode,
        publication_step: job.publication_step,
        created_at: job.createdAt,
        updated_at: job.updatedAt,

        // 🔑 CONFIG COMPLETO PARSEADO (datos originales del frontend)
        config: parsedConfig,

        // 🔑 DATOS ENRIQUECIDOS (para conveniencia del frontend)
        products: jobProducts.map(jp => {
          // ✅ Parsear product_payload si es string
          let productPayload = jp.product_payload;
          if (typeof jp.product_payload === 'string') {
            try {
              productPayload = JSON.parse(jp.product_payload);
            } catch (e) {
              logger.warn(`Error al parsear product_payload: ${e.message}`);
            }
          }
          return {
            id: jp.product_id,
            ...productPayload
          };
        }),
        marketplaces: jobProducts
          .map(jp => {
            // ✅ Parsear marketplace_payload si es string
            let mpPayload = jp.marketplace_payload;
            if (typeof jp.marketplace_payload === 'string') {
              try {
                mpPayload = JSON.parse(jp.marketplace_payload);
              } catch (e) {
                logger.warn(`Error al parsear marketplace_payload: ${e.message}`);
              }
            }
            return mpPayload;
          })
          .filter((mp, index, self) =>
            mp && index === self.findIndex(m => m?.id === mp.id)
          ),
        total_products: jobProducts.length
      };

      // 8. Registrar log de acceso
      await LogRepository.create({
        user_id: metadata.user_id,
        action: 'publishing_draft.loaded',
        description: `Borrador ${job.id} cargado para edición`,
        ip_address: metadata.ip_address,
        user_agent: metadata.user_agent,
        status: 'success',
        meta: {
          job_id: job.id,
          batch_id: job.batch_id,
          publication_step: job.publication_step
        }
      });

      return res.status(200).json({
        success: true,
        data: draftData
      });

    } catch (error) {
      logger.error('[Controller] Error al obtener borrador:', error);
      return res.status(500).json({
        success: false,
        msg: "error_fetching_draft",
        error: error.message
      });
    }
  },

  /**
   * Lista todos los borradores de un usuario/empresa
   * POST /api/publishing-draft-list
   * Body: { company_id, user_id } (user_id es opcional, si no se pasa usa req.user.id)
   */
  async listDraftsByUser(req, res) {
    const { company_id, user_id } = req.body;
    const userId = user_id || req.user.id;
    const companyId = company_id || req.user.company_id;
    const metadata = getRequestMetadata(req);

    try {
      // 1. Validar que se proporcione company_id
      if (!companyId) {
        return res.status(400).json({
          success: false,
          msg: "company_id_required",
          details: "Debe proporcionar company_id"
        });
      }

      // 2. Obtener jobs tipo draft del usuario/empresa
      const drafts = await JobRepository.findAll({
        company_id: companyId,
        user_id: userId,
        job_type: 'draft',
        status: 'pending',
        limit: 100,
        includeDetails: true
      });

      // 3. Enriquecer con información adicional
      const enrichedDrafts = await Promise.all(
        drafts.map(async (draft) => {
          // 🔑 USAR REPOSITORIOS: Obtener conteo de job_products
          const { total: totalProducts, statusCounts } = await JobProductRepository.getStatusCounts(draft.id);

          // 🔑 USAR REPOSITORIOS: Obtener nombres de productos y marketplaces
          const productIds = draft.config?.products?.map(p => p.id) || [];
          const products = productIds.length > 0
            ? await ProductRepository.findByIds(productIds)
            : [];

          const marketplaceIds = draft.config?.marketplaces?.map(m => m.id) || [];
          const marketplaces = marketplaceIds.length > 0
            ? await MarketplaceCredentialRepository.findByIds(marketplaceIds)
            : [];

          // ✅ Parsear config si es string JSON
          let parsedConfig = draft.config;
          if (typeof draft.config === 'string') {
            try {
              parsedConfig = JSON.parse(draft.config);
            } catch (e) {
              logger.warn(`Error al parsear config del draft ${draft.id}: ${e.message}`);
              parsedConfig = {};
            }
          }

          return {
            job_id: draft.id,
            batch_id: draft.batch_id,
            draft_name: draft.draft_name,
            mode: draft.mode,
            publication_step: draft.publication_step,
            created_at: draft.createdAt,
            updated_at: draft.updatedAt,

            // 🔑 CONFIG COMPLETO PARSEADO (datos originales del frontend)
            config: parsedConfig,

            // 🔑 DATOS ENRIQUECIDOS (para conveniencia del frontend)
            products: {
              total: products.length,
              items: products.map(p => ({
                id: p.id,
                name: p.name,
                sku: p.sku
              }))
            },
            marketplaces: {
              total: marketplaces.length,
              items: marketplaces.map(m => ({
                id: m.id,
                name: m.name || m.seller_email,
                marketplace_name: m.marketplace?.name || 'Marketplace'
              }))
            },
            stats: {
              total_products: totalProducts,
              pending: statusCounts['pending'] || 0,
              success: statusCounts['success'] || 0,
              error: statusCounts['error'] || 0
            }
          };
        })
      );

      // 4. Registrar log
      await LogRepository.create({
        user_id: metadata.user_id,
        action: 'publishing_draft.list',
        description: `Listado de borradores: ${enrichedDrafts.length} encontrados`,
        ip_address: metadata.ip_address,
        user_agent: metadata.user_agent,
        status: 'success',
        meta: {
          company_id: companyId,
          user_id: userId,
          draft_count: enrichedDrafts.length
        }
      });

      return res.status(200).json({
        success: true,
        drafts: enrichedDrafts,
        count: enrichedDrafts.length
      });

    } catch (error) {
      logger.error('[Controller] Error al listar borradores:', error);
      return res.status(500).json({
        success: false,
        msg: "error_listing_drafts",
        error: error.message
      });
    }
  },
  async updateStatus(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Actualiza estado de tarea`);
    const { id, status, error_message, error_details, api_response, external_id, external_url, published_at } = req.body;
    const metadata = getRequestMetadata(req);

    try {
      const task = await ProductPublishingTaskRepository.findById(id);
      if (!task) return res.status(404).json({ success: false, msg: "task_not_found" });

      const updateData = {};
      if (error_message !== undefined) updateData.error_message = error_message;
      if (error_details !== undefined) updateData.error_details = error_details;
      if (api_response !== undefined) updateData.api_response = api_response;
      if (external_id !== undefined) updateData.external_id = external_id;
      if (external_url !== undefined) updateData.external_url = external_url;
      if (published_at !== undefined) updateData.published_at = published_at;

      const updated = await ProductPublishingTaskRepository.updateStatus(
        task,
        status,
        updateData
      );

      await LogRepository.create({
        user_id: metadata.user_id,
        action: 'publishing_task.update_status',
        description: `Tarea ${id} actualizada a: ${status}`,
        ip_address: metadata.ip_address,
        user_agent: metadata.user_agent,
        status: 'success',
        meta: { id, status }
      });

      return res.status(200).json({ 
        success: true,
        message: "Estado actualizado", 
        task: { 
          id: updated.id, 
          status: updated.status,
          external_id: updated.external_id,
          error_message: updated.error_message
        } 
      });
    } catch (error) {
      logger.error('Error actualizando estado:', error.message);
      return res.status(500).json({ 
        success: false,
        msg: "internal_error",
        error: error.message 
      });
    }
  },

  async list(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Lista tareas`);
    const { company_id, user_id, status, batch_id } = req.body;

    try {
      let tasks;
      if (batch_id) {
        tasks = await ProductPublishingTaskRepository.findByBatchId(batch_id);
      } else if (status) {
        tasks = await ProductPublishingTaskRepository.findByCompanyAndStatus(company_id, status);
      } else {
        tasks = await ProductPublishingTaskRepository.findAllByCompany(company_id, user_id);
      }

       const mapped = tasks.map(t => ({
      id: t.id,
      product_id: t.product_id,
      product_name: t.product?.name || 'N/A',
      product_image: t.product?.images?.[0] || 'products/default.jpg',  // ← ✅ Safe access
      marketplace_id: t.marketplace_id,
      marketplace_name: t.marketplace?.name || 'N/A',
      credential_id: t.credential_id,
      credential_name: t.credential?.name || 'N/A',
      warehouse_id: t.warehouse_id,
      company_id: t.company_id,
      user_id: t.user_id,
      user_name: t.user?.name || 'N/A',
      batch_id: t.batch_id,
      status: t.status,
      draft_name: t.draft_name,
      payload: t.payload,
      publishing_mode: t.publishing_mode,
      error_message: t.error_message,
      error_details: t.error_details,
      api_response: t.api_response,
      external_id: t.external_id,
      external_url: t.external_url,
      published_at: t.published_at,
      attempt_count: t.attempt_count,
      created_at: t.createdAt,
      updated_at: t.updatedAt,
      // ✅ Campo calculado para identificar warnings fácilmente
      has_warnings: t.status === 'published_with_warnings' || 
                    (t.error_details && typeof t.error_details === 'object' && t.error_details.has_warnings === true) ||
                    (Array.isArray(t.error_details?.warnings) && t.error_details.warnings.length > 0)
    }));

      // ✅ Agrupar por batch_id si existe
      const grouped = {};
      mapped.forEach(task => {
        if (!grouped[task.batch_id]) {
          grouped[task.batch_id] = {
            batch_id: task.batch_id,
            tasks: [],
            summary: {
              total: 0,
              published: 0,
              published_with_warnings: 0,  // ✅ Nuevo contador para warnings
              failed: 0,
              draft: 0,
              pending: 0,
              processing: 0
            }
          };
        }
        grouped[task.batch_id].tasks.push(task);
        grouped[task.batch_id].summary.total++;

        switch(task.status) {
          case 'published': grouped[task.batch_id].summary.published++; break;
          case 'published_with_warnings': 
            grouped[task.batch_id].summary.published_with_warnings++; 
            break;
          case 'failed': grouped[task.batch_id].summary.failed++; break;
          case 'draft': grouped[task.batch_id].summary.draft++; break;
          case 'pending': grouped[task.batch_id].summary.pending++; break;
          case 'processing': grouped[task.batch_id].summary.processing++; break;
        }
      });

      return res.status(200).json({ 
        success: true,
        publishing_tasks: batch_id ? mapped : Object.values(grouped) 
      });
    } catch (error) {
      logger.error(`Error listando tareas: ${error.message}`);
      return res.status(500).json({ 
        success: false,
        msg: "internal_error",
        error: error.message 
      });
    }
  },
async retryBatch(req, res) {
  logger.info(`${req.user?.name || 'Unknown'} - Republicando productos`);
  logger.info(`Datos recibidos: \n ${JSON.stringify(req.body)}`);

  const { tasks } = req.body;
  const user_id = req.user.id;
  const results = [];

  const normalizeRetryPayload = (rawPayload) => {
    if (!rawPayload) return null;
    let parsed = rawPayload;

    if (typeof parsed === 'string') {
      try {
        parsed = JSON.parse(parsed);
      } catch (e) {
        return null;
      }
    }

    if (parsed && typeof parsed === 'object' && parsed.payload && typeof parsed.payload === 'object') {
      parsed = parsed.payload;
    }

    return (parsed && typeof parsed === 'object') ? parsed : null;
  };

  for (const { task_id, job_id, payload: incomingPayload } of tasks) {
    try {
      // 1. Obtener task
      const task = await ProductPublishingTaskRepository.findById(task_id);
      if (!task) {
        results.push({ task_id, success: false, error: 'task_not_found' });
        continue;
      }

      // 2. Obtener marketplace y credential
      const marketplace = await MarketplaceRepository.findById(task.marketplace_id);
      let credential = await MarketplaceCredentialRepository.findById(task.credential_id);

      if (!marketplace || !credential) {
        results.push({ task_id, success: false, error: 'marketplace_or_credential_not_found' });
        continue;
      }

      // 3. ✅ RENOVAR TOKEN SI ES NECESARIO
      try {
        credential = await ProductPublishingTaskController.refreshSingleCredential(
          credential,
          marketplace,
          user_id
        );
      } catch (refreshError) {
        logger.warn(`[retryBatch] No se pudo renovar token para task ${task_id}: ${refreshError.message}`);
        results.push({
          task_id,
          success: false,
          error: refreshError.message.startsWith('auth_required') ? 'auth_required' : refreshError.message,
          error_details: refreshError.message.startsWith('auth_required')
            ? { auth_url: refreshError.message.split(':')[1] }
            : null
        });
        continue; // Continuar con el siguiente task
      }

      // 4. ✅ Resolver payload efectivo para reintento
      const effectivePayload = normalizeRetryPayload(incomingPayload) || normalizeRetryPayload(task.payload);
      if (!effectivePayload) {
        results.push({
          task_id,
          success: false,
          error: 'invalid_retry_payload',
          error_details: ['payload inválido o vacío para reintento']
        });
        continue;
      }

      // Persistir payload efectivo para trazabilidad del retry
      if (normalizeRetryPayload(incomingPayload)) {
        await ProductPublishingTaskRepository.updatePayload(task, effectivePayload);
      }

      task.payload = effectivePayload;

      logger.info(`[retryBatch] Task ${task_id} payload keys: ${Object.keys(effectivePayload).join(', ')}`);

      // 5. ✅ REPUBLICAR con credencial actualizada
      const result = await PublishingService.republishProduct(
        task,
        marketplace,
        credential,
        user_id
      );

      // 6. ✅ Actualizar JobProduct si hay job_id
      const warningArtifacts = buildWarningArtifacts(result);

      if (job_id) {
        try {
          // Buscar JobProduct por job_id + product_id + marketplace_id + credential_id
          const jobProduct = await JobProductRepository.findByProductAndMarketplace(
            job_id,
            task.product_id,
            task.marketplace_id,
            task.credential_id
          );

          if (jobProduct) {
            // Determinar status para JobProduct (mapeo desde ProductPublishingTask)
            const jobProductStatus = result.status === 'published' || result.status === 'published_with_warnings'
              ? 'success'
              : result.status === 'processing'
                ? 'processing'
                : result.status === 'failed'
                  ? 'error'
                  : jobProduct.status;

            await JobProductRepository.update(jobProduct, {
              status: jobProductStatus,
              external_id: result.external_id || jobProduct.external_id,
              external_url: result.external_url || jobProduct.external_url,
              error_message: result.success ? warningArtifacts.warningMessage : (result.error || jobProduct.error_message),
              error_details: result.success ? warningArtifacts.warningDetails : (result.error_details || result.details || jobProduct.error_details),
              attempt_count: (jobProduct.attempt_count || 0) + 1,
              last_attempt_at: new Date()
            });

            logger.info(`[retryBatch] JobProduct ${jobProduct.id} actualizado: ${jobProductStatus}`);
          }

          // 6. ✅ Actualizar progreso del Job
          await JobRepository.recalculateProgress(job_id);

        } catch (jobError) {
          logger.warn(`[retryBatch] Error actualizando Job/JobProduct: ${jobError.message}`);
          // No bloquear el flujo, continuar
        }
      }

      results.push({
        task_id,
        success: result.success,
        external_id: result.external_id,
        error: result.success ? warningArtifacts.warningMessage : result.error,
        error_details: result.success ? warningArtifacts.warningDetails : (result.error_details || result.details),
        has_warnings: warningArtifacts.hasWarnings,
        warnings: warningArtifacts.warnings,
        status: result.status  // ← ✅ Incluir status para que el front sepa el estado real
      });

    } catch (error) {
      logger.error(`[retryBatch] Error republicando task ${task_id}:`, error);

      const currentTask = await ProductPublishingTaskRepository.findById(task_id);
      await ProductPublishingTaskRepository.updateTask(currentTask || { id: task_id }, {
        status: 'failed',
        error_message: error.message,
        attempt_count: ((currentTask?.attempt_count) || 0) + 1,
        last_attempt_at: new Date()
      });

      // ✅ Actualizar JobProduct en caso de error
      if (job_id) {
        try {
          const jobProduct = await JobProductRepository.findByProductAndMarketplace(
            job_id,
            currentTask?.product_id || task.product_id,
            currentTask?.marketplace_id || task.marketplace_id,
            currentTask?.credential_id || task.credential_id
          );

          if (jobProduct) {
            await JobProductRepository.update(jobProduct, {
              status: 'error',
              error_message: error.message,
              attempt_count: (jobProduct.attempt_count || 0) + 1,
              last_attempt_at: new Date()
            });

            await JobRepository.recalculateProgress(job_id);
          }
        } catch (jobError) {
          logger.warn(`[retryBatch] Error actualizando JobProduct en error: ${jobError.message}`);
        }
      }

      results.push({
        task_id,
        success: false,
        error: error.message,
        error_details: error.response?.data || null
      });
    }
  }

  const successCount = results.filter(r => r.success).length;

  return res.json({
    success: true,
    total: results.length,
    successful: successCount,
    failed: results.length - successCount,
    results
  });
},
async publishedProducts(req, res) {
  logger.info(`${req.user?.name || 'Unknown'} - Lista productos publicados`);
  const metadata = getRequestMetadata(req);

  try {
    const {
      company_id: bodyCompanyId,
      user_id: bodyUserId,
      marketplace_id: bodyMarketplaceId,
      product_id: bodyProductId,
      status: bodyStatus,
      start_date,
      end_date,
      use_manteiners: useManteiners = false
    } = req.body || {};

    const companyId = bodyCompanyId ? Number(bodyCompanyId) : req.user.company_id;
    const userId = bodyUserId ? Number(bodyUserId) : null;
    const marketplaceId = bodyMarketplaceId ? Number(bodyMarketplaceId) : null;
    const productId = bodyProductId ? Number(bodyProductId) : null;
    const selectedStatus = bodyStatus ? String(bodyStatus).trim().toLowerCase() : null;
    const useManteinersFlag = Boolean(useManteiners);

    logger.info(`[publishedProducts] use_manteiners=${useManteinersFlag}`);

    if (bodyCompanyId && !Number.isFinite(companyId)) {
      return res.status(400).json({ success: false, msg: 'company_id_invalid' });
    }
    if (bodyUserId && !Number.isFinite(userId)) {
      return res.status(400).json({ success: false, msg: 'user_id_invalid' });
    }
    if (bodyMarketplaceId && !Number.isFinite(marketplaceId)) {
      return res.status(400).json({ success: false, msg: 'marketplace_id_invalid' });
    }
    if (bodyProductId && !Number.isFinite(productId)) {
      return res.status(400).json({ success: false, msg: 'product_id_invalid' });
    }

    let marketplaces = [];
    let products = [];
    let statusOptions = buildPublishedStatusOptions();

    const { startDate, endDate } = normalizeDateRange(start_date, end_date);

    // ✅ 🔑 CORRECCIÓN: Incluir tareas con status "processing" para Falabella
    const tasks = await ProductPublishingTaskRepository.findPublishedProducts({
      companyId,
      userId,
      marketplaceId,
      productId,
      startDate,
      endDate,
      includeProcessing: true // ✅ NUEVO: incluir processing
    });

    if (useManteinersFlag) {
      if (userId != null) {
        const credentials = await UserMarketplaceCredentialRepository.findActiveCredentialsByUserAndCompany(
          userId,
          companyId ?? null,
          null
        );
        const marketplaceIds = [
          ...new Set(
            (Array.isArray(credentials) ? credentials : [])
              .map((credential) => credential?.marketplace_id || credential?.marketplace?.id)
              .filter(Boolean)
              .map((id) => Number(id))
              .filter((id) => Number.isFinite(id) && id > 0)
          )
        ];

        if (marketplaceIds.length > 0) {
          const marketplacesResult = await MarketplaceRepository.findByIds(marketplaceIds);
          const marketplacesData = Array.isArray(marketplacesResult.marketplaces)
            ? marketplacesResult.marketplaces
            : [];

          marketplaces = marketplacesData.map((marketplace) => ({
            id: marketplace.id || null,
            name: marketplace.name || 'N/A',
            domain: marketplace.domain || null
          }));
        }
      } else {
        const marketplaceMap = new Map();
        for (const task of tasks) {
          const marketplace = task.marketplace || {};
          const marketplaceIdValue = Number(task.marketplace_id || marketplace.id || 0);
          if (!Number.isFinite(marketplaceIdValue) || marketplaceIdValue <= 0 || marketplaceMap.has(marketplaceIdValue)) {
            continue;
          }

          marketplaceMap.set(marketplaceIdValue, {
            id: marketplaceIdValue,
            name: marketplace.name || 'N/A',
            domain: marketplace.domain || null
          });
        }

        marketplaces = Array.from(marketplaceMap.values());
      }

      const companyProducts = await ProductRepository.findFiltered({
        companyId,
        userId: userId || undefined
      });

      products = (Array.isArray(companyProducts) ? companyProducts : []).map((product) => {
        const productImages = normalizeProductImages(product.images);
        return {
          id: product.id || null,
          name: product.name || 'N/A',
          sku: product.sku || null,
          image: productImages.length > 0 ? productImages[0] : 'products/default.jpg'
        };
      });

      statusOptions = buildPublishedStatusOptions();
    }

    const uniqueByExternalId = new Map();
    for (const task of tasks) {
      const externalId = String(task.external_id || '').trim();
      if (!externalId) continue;

      const dedupeKey = [
        externalId,
        task.marketplace_id || '',
        task.credential_id || '',
        task.user_id || '',
        task.product_id || ''
      ].join(':');

      if (!uniqueByExternalId.has(dedupeKey)) {
        uniqueByExternalId.set(dedupeKey, task);
      }
    }

    const publishedProducts = [];
    const statusSummary = {
    total: 0,
    active: 0,
    under_review: 0,
    pending: 0,
    rejected: 0,
    not_published: 0,
    failed: 0,
    inactive: 0,
    deleted: 0,
    unknown: 0,
    processing: 0
  };

    for (const task of uniqueByExternalId.values()) {
      const marketplace = task.marketplace || {};
      const product = task.product || {};
      const credential = task.credential || {};
      const marketplaceLink = await ProductMarketplaceLinkRepository.findByMarketplaceExternalId(
        task.marketplace_id,
        task.external_id,
        task.company_id || companyId || null,
        task.branch_id || null,
        task.credential_id || null,
        task.user_id || null
      );

      // ✅ DETECTAR MARKETPLACE
      const marketplaceKey = resolveMarketplaceKey(marketplace);

      // ✅ CALCULAR marketplace_status (ESTADO REAL)
      let marketplaceStatus;
      let isPublished = null;
      let qcStatus = null;

      if (marketplaceKey === 'falabella') {
        const errorDetails = task.error_details || {};
        const snapshotState = errorDetails.marketplace_item_state || {};

        const snapshotStatus = String(snapshotState.status || '').trim().toLowerCase();
        const snapshotQcStatus = String(snapshotState.qc_status || '').trim().toLowerCase() || null;
        const snapshotIsPublished = snapshotState.is_published ?? null;
        const falabellaSnapshot = {
          found: true,
          status: snapshotStatus,
          qc_status: snapshotQcStatus,
          is_published: snapshotIsPublished,
          product_errors: Array.isArray(snapshotState.product_errors) ? snapshotState.product_errors : [],
          url: snapshotState.url || null,
          shop_sku: snapshotState.shop_sku || null
        };

        if (task.status === 'processing') {
          marketplaceStatus = resolveFalabellaMarketplaceDisplayStatus(falabellaSnapshot, {
            taskStatus: task.status,
            hasImage: snapshotState.has_image
          });
          isPublished = snapshotIsPublished;
          qcStatus = snapshotQcStatus;

          if (marketplaceStatus === 'processing') {
            const feedId = errorDetails.feed_id || null;
            const sentAt = errorDetails.sent_at || null;

            logger.debug(`[publishedProducts] Falabella tarea en processing para ${task.external_id}:`, {
              feedId,
              sentAt,
              taskStatus: task.status
            });
          }
        } else {
          // ✅ Falabella: estado REAL según Status + IsPublished + QCStatus
          const falabellaPayload = normalizePublishedPayload(marketplaceLink?.published_payload);
          const falabellaBU = falabellaPayload?.BusinessUnits?.BusinessUnit || {};

          const rawStatus = String(falabellaBU.Status || 'unknown').trim().toLowerCase();
          const isPublishedRaw = falabellaBU.IsPublished;
          isPublished = isPublishedRaw !== undefined && isPublishedRaw !== null
            ? (String(isPublishedRaw).trim() === '1' || isPublishedRaw === 1 || isPublishedRaw === true)
            : null;
          qcStatus = String(falabellaPayload?.QCStatus || falabellaBU.QCStatus || '').trim().toLowerCase() || null;
          const payloadHasUrl = typeof falabellaPayload?.Url === 'string' && falabellaPayload.Url.trim().length > 0;
          const payloadHasShopSku = typeof falabellaPayload?.ShopSku === 'string' && falabellaPayload.ShopSku.trim().length > 0;
          const payloadHasImage = Boolean(
            (typeof falabellaPayload?.MainImage === 'string' && falabellaPayload.MainImage.trim().length > 0)
            || falabellaPayload?.Images
          );
          const payloadHasErrors = Array.isArray(falabellaPayload?.product_errors) && falabellaPayload.product_errors.length > 0;
          const falabellaPublishedSnapshot = {
            found: true,
            status: rawStatus,
            qc_status: qcStatus,
            is_published: isPublished,
            product_errors: payloadHasErrors ? (falabellaPayload.product_errors || []) : [],
            url: falabellaPayload?.Url || null,
            shop_sku: falabellaPayload?.ShopSku || null
          };

          marketplaceStatus = resolveFalabellaMarketplaceDisplayStatus(falabellaPublishedSnapshot, {
            taskStatus: task.status,
            hasImage: payloadHasImage
          });

          logger.debug(`[publishedProducts] Falabella estado real para ${task.external_id}:`, {
            rawStatus,
            isPublished,
            qcStatus,
            marketplaceStatus
          });
        }
      } else {
        // ✅ MercadoLibre y otros: usar el método estándar
        marketplaceStatus = extractPublishedMarketplaceStatus(task, marketplaceLink);
      }

      const statusBucket = classifyMarketplaceState(marketplaceStatus);
      const normalizedMarketplaceStatus = String(marketplaceStatus || '').trim().toLowerCase();

      if (selectedStatus && normalizedMarketplaceStatus !== selectedStatus) {
        continue;
      }

      // ✅ Seleccionar payload correcto según marketplace
      let payloadForMetrics;
      if (marketplaceKey === 'falabella') {
        payloadForMetrics = firstNonEmptyPublishedPayload(
          marketplaceLink?.published_payload,
          task.api_response,
          task.payload
        ) || {};
      } else {
        const apiResponsePayload = normalizePublishedPayload(task.api_response);
        const taskPayload = normalizePublishedPayload(task.payload);
        payloadForMetrics = apiResponsePayload || taskPayload || {};
      }

      const productImages = normalizeProductImages(product.images);

      statusSummary.total += 1;
      statusSummary[statusBucket] = (statusSummary[statusBucket] || 0) + 1;

      // ✅ Construir objeto de respuesta LIMPIO
      const productResponse = {
        task_id: task.id,
        batch_id: task.batch_id || task.job?.batch_id || null,
        product_id: task.product_id,
        product_name: product.name || 'N/A',
        sku: product.sku || null,
        product_image: productImages.length > 0
          ? productImages[0]
          : 'products/default.jpg',
        product_images: productImages,
        external_id: task.external_id,
        external_url: task.external_url || null,
        marketplace_id: task.marketplace_id,
        marketplace_key: marketplaceKey,
        marketplace_name: credential.name || marketplace.name || 'N/A',
        marketplace_domain: marketplace.domain || null,
        marketplace_status: marketplaceStatus || (task.status === 'failed' ? 'failed' : 'processing'),
        publication_status: task.status,
        published_stock: extractPublishedStock(payloadForMetrics),
        published_price: extractPublishedPrice(payloadForMetrics),
        published_at: formatDateTimeDisplay(task.published_at || task.createdAt || task.updatedAt),
        published_at_iso: task.published_at || task.createdAt || task.updatedAt
          ? new Date(task.published_at || task.createdAt || task.updatedAt).toISOString()
          : null,
        user_id: task.user_id,
        user_name: task.user?.name || 'N/A',
        user_email: task.user?.email || null,
        user_avatar: task.user?.image || null,
        company_id: task.company_id,
        credential_id: task.credential_id,
        last_synced_at: formatDateTimeDisplay(task.updatedAt),
        last_synced_at_iso: task.updatedAt ? new Date(task.updatedAt).toISOString() : null,
        live_verification: null
      };

      // ✅ Agregar información adicional SOLO para Falabella
      if (marketplaceKey === 'falabella') {
        productResponse.is_published = isPublished;
        productResponse.qc_status = qcStatus;
        productResponse.feed_id = resolveFalabellaFeedId(task, marketplaceLink);
        
        // ✅ 🔑 Mantener sent_at solo cuando exista información de envío
        if (task.status === 'processing' || task.status === 'pending') {
          const errorDetails = task.error_details || {};
          productResponse.sent_at = errorDetails.sent_at || null;
          productResponse.publication_note = marketplaceStatus === 'under_review'
            ? 'Producto en revisión por Falabella...'
            : 'Producto enviado a Falabella, esperando exposición...';
        } else {
          productResponse.publication_note = buildFalabellaPublicationNoteExact({
            raw: marketplaceLink?.published_payload || task.api_response || task.payload || null
          });
        }
      }

      publishedProducts.push(productResponse);
    }

    return res.status(200).json({
      success: true,
      count: publishedProducts.length,
      statusOptions,
      ...(useManteinersFlag ? { marketplaces, marketplaces_count: marketplaces.length, products, products_count: products.length } : {}),
      status_summary: statusSummary,
      published_products: publishedProducts
    });
  } catch (error) {
    if (error.message === 'start_date_invalid' || error.message === 'end_date_invalid' || error.message === 'date_range_invalid') {
      return res.status(400).json({
        success: false,
        msg: 'invalid_date_range',
        error: error.message
      });
    }

    logger.error(`Error listando productos publicados:\n ${error.message}`);
    return res.status(500).json({
      success: false,
      msg: 'internal_error',
      error: error.message
    });
  }
},
  // Agregar método destroy al controlador
  async updateMercadoLibreItem(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Actualiza item Mercado Libre`);
    logger.info(`Datos recibidos:\n ${JSON.stringify(req.body, null, 2)}`);
    const metadata = getRequestMetadata(req);

    try {
      const {
        company_id: bodyCompanyId,
        user_id: bodyUserId,
        marketplace_id: bodyMarketplaceId,
        credential_id: bodyCredentialId,
        branch_id: bodyBranchId,
        external_id: bodyExternalId,
        status,
        price,
        available_quantity
      } = req.body || {};

      const companyId = bodyCompanyId ? Number(bodyCompanyId) : req.user.company_id;
      const userId = bodyUserId ? Number(bodyUserId) : req.user.id;
      const marketplaceId = bodyMarketplaceId ? Number(bodyMarketplaceId) : null;
      const credentialId = bodyCredentialId ? Number(bodyCredentialId) : null;
      const branchId = bodyBranchId ? Number(bodyBranchId) : null;
      const externalId = String(bodyExternalId || '').trim();

      if (bodyCompanyId && !Number.isFinite(companyId)) {
        return res.status(400).json({ success: false, msg: 'company_id_invalid' });
      }
      if (bodyUserId && !Number.isFinite(userId)) {
        return res.status(400).json({ success: false, msg: 'user_id_invalid' });
      }
      if (!Number.isFinite(marketplaceId) || !marketplaceId) {
        return res.status(400).json({ success: false, msg: 'marketplace_id_required' });
      }
      if (!Number.isFinite(credentialId) || !credentialId) {
        return res.status(400).json({ success: false, msg: 'credential_id_required' });
      }
      if (!externalId) {
        return res.status(400).json({ success: false, msg: 'external_id_required' });
      }

      const hasStatus = status !== undefined && status !== null && String(status).trim() !== '';
      const hasPrice = price !== undefined && price !== null && String(price).trim() !== '';
      const hasQuantity = available_quantity !== undefined && available_quantity !== null && String(available_quantity).trim() !== '';

      if (!hasStatus && !hasPrice && !hasQuantity) {
        return res.status(400).json({ success: false, msg: 'no_changes', error: 'Debe enviar al menos uno de: status, price, available_quantity' });
      }

      const marketplace = await MarketplaceRepository.findById(marketplaceId);
      if (!marketplace) {
        return res.status(404).json({ success: false, msg: 'marketplace_not_found' });
      }

      if (!String(marketplace.domain || '').toLowerCase().includes('mercadolibre')) {
        return res.status(400).json({ success: false, msg: 'unsupported_marketplace', error: 'Este endpoint solo aplica para Mercado Libre' });
      }

      const credential = await MarketplaceCredentialRepository.findById(credentialId);
      if (!credential) {
        return res.status(404).json({ success: false, msg: 'credential_not_found' });
      }

      if (Number(credential.company_id) !== Number(companyId)) {
        return res.status(403).json({
          success: false,
          msg: 'credential_company_mismatch'
        });
      }

      const credentialAccess = await UserMarketplaceCredentialRepository.findByUserAndCompany(userId, companyId, null);
      const canUseCredential = Array.isArray(credentialAccess)
        ? credentialAccess.some((access) => Number(access.marketplace_credential_id) === Number(credentialId) && Number(access.status) === 1)
        : false;

      if (!canUseCredential) {
        return res.status(403).json({
          success: false,
          msg: 'credential_not_allowed'
        });
      }

      const preflightAdapter = new MercadoLibreAdapter(
        marketplace.id,
        companyId,
        branchId,
        userId,
        credential
      );
      preflightAdapter.auditContext = {
        actor_type: 'user',
        actor_id: userId,
        actor_name: req.user?.name || req.user?.email || `Usuario ${userId}`,
        source: 'product_publication_edit_preflight',
        triggered_by: 'user'
      };

      const credentialStatus = await preflightAdapter.ensureValidCredentials();
      if (!credentialStatus?.valid) {
        if (credentialStatus?.auth_required) {
          return res.status(401).json({
            success: false,
            msg: 'auth_required',
            auth_url: credentialStatus.auth_url || null,
            message: credentialStatus.message || 'Token expirado o inválido. Requiere reautorización.'
          });
        }

        return res.status(400).json({
          success: false,
          msg: 'credential_invalid',
          error: credentialStatus?.error || 'No se pudo validar la credencial'
        });
      }

      let refreshedCredential = (await MarketplaceCredentialRepository.findById(credentialId)) || credential;

      const task = await ProductPublishingTaskRepository.findLatestByExternalIdAndContext({
        marketplaceId,
        externalId,
        companyId,
        branchId,
        credentialId
      });

      if (!task) {
        return res.status(404).json({
          success: false,
          msg: 'publication_not_found',
          error: 'No se encontró una publicación local editable para ese external_id'
        });
      }

      const adapter = new MercadoLibreAdapter(
        marketplace.id,
        companyId,
        branchId,
        userId,
        refreshedCredential
      );
      adapter.auditContext = {
        actor_type: 'user',
        actor_id: userId,
        actor_name: req.user?.name || req.user?.email || `Usuario ${userId}`,
        source: 'product_publication_edit',
        triggered_by: 'user'
      };

      let result = await adapter.updateItem({
        itemId: externalId,
        status: normalizeMlEditRequestValue(status),
        price: normalizeMlEditRequestValue(price),
        available_quantity: normalizeMlEditRequestValue(available_quantity)
      });

      logger.info(`[updateMercadoLibreItem] Respuesta Mercado Libre inicial:\n ${JSON.stringify(result, null, 2)}`);

      if (!result.success && result.error === 'auth_required') {
        try {
          refreshedCredential = await ProductPublishingTaskController.refreshSingleCredential(
            credential,
            marketplace,
            userId,
            true
          );

          const retryAdapter = new MercadoLibreAdapter(
            marketplace.id,
            companyId,
            branchId,
            userId,
            refreshedCredential
          );
          retryAdapter.auditContext = {
            actor_type: 'user',
            actor_id: userId,
            actor_name: req.user?.name || req.user?.email || `Usuario ${userId}`,
            source: 'product_publication_edit_retry',
            triggered_by: 'user'
          };

          const retryResult = await retryAdapter.updateItem({
            itemId: externalId,
            status: normalizeMlEditRequestValue(status),
            price: normalizeMlEditRequestValue(price),
            available_quantity: normalizeMlEditRequestValue(available_quantity)
          });

          logger.info(`[updateMercadoLibreItem] Respuesta Mercado Libre reintento:\n ${JSON.stringify(retryResult, null, 2)}`);

          if (retryResult.success) {
            result = retryResult;
          } else {
            return res.status(retryResult.status_code && retryResult.status_code >= 400 && retryResult.status_code < 600 ? retryResult.status_code : 401).json({
              success: false,
              msg: retryResult.error === 'item_closed_relist_required' ? 'relist_required' : 'auth_required',
              error: retryResult.error,
              details: retryResult.details || null,
              auth_url: retryResult.error === 'auth_required' ? (retryResult.auth_url || null) : null
            });
          }
        } catch (retryRefreshError) {
          if (retryRefreshError.message.startsWith('auth_required:')) {
            return res.status(401).json({
              success: false,
              msg: 'auth_required',
              auth_url: retryRefreshError.message.replace('auth_required:', '')
            });
          }

          throw retryRefreshError;
        }
      }

      if (!result.success) {
        if (result.error === 'item_not_found') {
          return res.status(404).json({
            success: false,
            msg: 'item_not_found',
            error: 'El item ya no existe en Mercado Libre'
          });
        }

        if (result.error === 'item_closed_relist_required') {
          return res.status(409).json({
            success: false,
            msg: 'relist_required',
            error: 'El item está cerrado. Para volver a publicarlo debes hacer relist.',
            current_status: result.details?.status || 'closed',
            relist_required: true
          });
        }

        if (result.error === 'auth_required') {
          return res.status(401).json({
            success: false,
            msg: 'auth_required',
            error: result.error,
            details: result.details || null,
            auth_url: result.auth_url || null
          });
        }

        return res.status(result.status_code && result.status_code >= 400 && result.status_code < 600 ? result.status_code : 400).json({
          success: false,
          msg: 'update_failed',
          error: result.error,
          details: result.details || null
        });
      }

      const updatedItem = result.data || {};
      const marketplaceStateSnapshot = buildMercadoLibreItemStateSnapshotFromItem(updatedItem, 'manual_update');
      const isActive = marketplaceStateSnapshot.status === 'active';
      const shouldKeepWarning = marketplaceStateSnapshot.status && !isActive;
      const isPictureProcessing = isMercadoLibrePictureProcessingSnapshot(marketplaceStateSnapshot);
      const currentDetails = normalizeErrorDetails(task.error_details);
      const mergedDetails = {
        ...currentDetails,
        marketplace_item_state: marketplaceStateSnapshot,
        manual_update: {
          requested_changes: result.requested_changes,
          updated_at: new Date().toISOString()
        }
      };

      const taskUpdate = {
        api_response: updatedItem,
        error_message: shouldKeepWarning
          ? `ML item status: ${marketplaceStateSnapshot.status}${marketplaceStateSnapshot.sub_status_text ? ` (${marketplaceStateSnapshot.sub_status_text})` : ''}`
          : null,
        error_details: shouldKeepWarning ? mergedDetails : null
      };

      if (isActive && ['published_with_warnings', 'processing'].includes(task.status)) {
        taskUpdate.status = 'published';
      } else if (shouldKeepWarning && task.status === 'published') {
        taskUpdate.status = isPictureProcessing ? 'processing' : 'published_with_warnings';
      }

      await ProductPublishingTaskRepository.updateTask(task, taskUpdate);

      const link = await ProductMarketplaceLinkRepository.findByMarketplaceExternalId(
        marketplaceId,
        externalId,
        task.company_id || companyId,
        task.branch_id || branchId || null,
        credentialId
      );

      if (link) {
        const previousPublishedState = {
          status: link.status,
          price: link.published_payload?.price ?? null,
          available_quantity: link.published_stock,
          external_url: link.external_url || null
        };
        const nextPublishedState = {
          status: isPictureProcessing ? 'processing' : (marketplaceStateSnapshot.status || link.status),
          price: updatedItem.price ?? previousPublishedState.price,
          available_quantity: extractPublishedStock(updatedItem),
          external_url: updatedItem.permalink || link.external_url || null
        };
        await link.update({
          status: nextPublishedState.status,
          external_url: nextPublishedState.external_url,
          published_stock: nextPublishedState.available_quantity,
          published_payload: updatedItem,
          last_synced_at: new Date(),
          user_id: userId
        });

        const publishedChanges = PublicationAuditService.getPublishedProductChanges(previousPublishedState, nextPublishedState);
        const actionForChange = (change) => {
          if (change.field === 'price') return 'published_product.price_changed';
          if (change.field === 'available_quantity' || change.field === 'published_stock') return 'published_product.stock_changed';
          if (change.field === 'status' && change.new_value === 'paused') return 'published_product.paused';
          if (change.field === 'status' && change.new_value === 'active') return 'published_product.reactivated';
          if (change.field === 'status' && ['closed', 'deleted'].includes(change.new_value)) return 'published_product.deleted';
          return 'published_product.marketplace_status_changed';
        };

        await Promise.all(publishedChanges.map((change) =>
          PublicationAuditService.recordPublishedProductFromRequest(req, task, actionForChange(change), {
            previous_value: { [change.field]: change.old_value },
            new_value: { [change.field]: change.new_value },
            changes: [change],
            description: `Publicacion ${externalId} actualizada desde Spree`,
            metadata: {
              source: 'spree_marketplace_edit',
              external_id: externalId,
              changed_fields: Object.keys(result.requested_changes || {})
            }
          })
        ));
      }

      await LogRepository.create({
        user_id: metadata.user_id,
        action: 'marketplace_item.update',
        description: `Item ML ${externalId} actualizado`,
        ip_address: metadata.ip_address,
        user_agent: metadata.user_agent,
        status: 'success',
        meta: {
          company_id: companyId,
          user_id: userId,
          marketplace_id: marketplaceId,
          credential_id: credentialId,
          external_id: externalId,
          changed_fields: Object.keys(result.requested_changes || {})
        }
      });

      return res.status(200).json({
        success: true,
        msg: 'marketplace_item_updated',
        changed_fields: Object.keys(result.requested_changes || {}),
        external_id: result.external_id || externalId,
        task_id: task.id,
        product_id: task.product_id,
        marketplace_id: marketplaceId,
        marketplace_name: credential.name || marketplace.name || 'N/A',
        marketplace_domain: marketplace.domain || null,
        marketplace_status: marketplaceStateSnapshot.status || taskUpdate.status || task.status || 'failed',
        publication_status: taskUpdate.status || task.status,
        item: {
          id: updatedItem.id || externalId,
          status: updatedItem.status || marketplaceStateSnapshot.status || null,
          price: updatedItem.price ?? null,
          available_quantity: updatedItem.available_quantity ?? null,
          permalink: updatedItem.permalink || null,
          sub_status: updatedItem.sub_status || []
        }
      });
    } catch (error) {
      logger.error('Error actualizando item Mercado Libre:');
      logger.error(`Body:\n ${JSON.stringify(req.body, null, 2)}`);
      logger.error(`Message: ${error.message}`);
      logger.error(`Stack: ${error.stack || 'no_stack'}`);
      if (error.response) {
        logger.error(`Status: ${error.response.status}`);
        logger.error(`Marketplace response:\n ${JSON.stringify(error.response.data, null, 2)}`);
      }
      await LogRepository.create({
        user_id: metadata?.user_id,
        action: 'marketplace_item.update',
        description: `Error: ${error.message}`,
        ip_address: metadata?.ip_address,
        user_agent: metadata?.user_agent,
        status: 'error',
        meta: {
          company_id: req.body?.company_id || req.user?.company_id,
          user_id: req.body?.user_id || req.user?.id,
          marketplace_id: req.body?.marketplace_id || null,
          credential_id: req.body?.credential_id || null,
          external_id: req.body?.external_id || null
        }
      });

      return res.status(500).json({
        success: false,
        msg: 'internal_error',
        error: error.message
      });
    }
  },

  async updateFalabellaItem(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Actualiza item Falabella`);
    logger.info(`Datos recibidos:\n ${JSON.stringify(req.body, null, 2)}`);
    const metadata = getRequestMetadata(req);

    try {
      const {
        company_id: bodyCompanyId,
        user_id: bodyUserId,
        marketplace_id: bodyMarketplaceId,
        credential_id: bodyCredentialId,
        branch_id: bodyBranchId,
        external_id: bodyExternalId,
        status,
        price,
        available_quantity
      } = req.body || {};

      const companyId = bodyCompanyId ? Number(bodyCompanyId) : req.user.company_id;
      const userId = bodyUserId ? Number(bodyUserId) : req.user.id;
      const marketplaceId = bodyMarketplaceId ? Number(bodyMarketplaceId) : null;
      const credentialId = bodyCredentialId ? Number(bodyCredentialId) : null;
      const branchId = bodyBranchId ? Number(bodyBranchId) : null;
      const externalId = String(bodyExternalId || '').trim();

      if (bodyCompanyId && !Number.isFinite(companyId)) return res.status(400).json({ success: false, msg: 'company_id_invalid' });
      if (bodyUserId && !Number.isFinite(userId)) return res.status(400).json({ success: false, msg: 'user_id_invalid' });
      if (!Number.isFinite(marketplaceId) || !marketplaceId) return res.status(400).json({ success: false, msg: 'marketplace_id_required' });
      if (!Number.isFinite(credentialId) || !credentialId) return res.status(400).json({ success: false, msg: 'credential_id_required' });
      if (!externalId) return res.status(400).json({ success: false, msg: 'external_id_required' });

      const hasStatus = status !== undefined && status !== null && String(status).trim() !== '';
      const hasPrice = price !== undefined && price !== null && String(price).trim() !== '';
      const hasQuantity = available_quantity !== undefined && available_quantity !== null && String(available_quantity).trim() !== '';

      if (!hasStatus && !hasPrice && !hasQuantity) {
        return res.status(400).json({
          success: false,
          msg: 'no_changes',
          error: 'Debe enviar al menos uno de: status, price, available_quantity'
        });
      }

      const marketplace = await MarketplaceRepository.findById(marketplaceId);
      if (!marketplace) {
        return res.status(404).json({ success: false, msg: 'marketplace_not_found' });
      }

      if (!String(marketplace.domain || '').toLowerCase().includes('falabella')) {
        return res.status(400).json({ success: false, msg: 'unsupported_marketplace', error: 'Este endpoint solo aplica para Falabella' });
      }

      const credential = await MarketplaceCredentialRepository.findById(credentialId);
      if (!credential) {
        return res.status(404).json({ success: false, msg: 'credential_not_found' });
      }

      const preflightAdapter = new FalabellaAdapter(
        marketplace.id,
        companyId,
        branchId,
        userId,
        credential
      );

      const credentialStatus = await preflightAdapter.ensureValidCredentials();
      if (!credentialStatus?.valid) {
        if (credentialStatus?.auth_required) {
          return res.status(401).json({
            success: false,
            msg: 'auth_required',
            auth_url: null,
            message: credentialStatus.message || 'Credenciales Falabella inválidas'
          });
        }

        return res.status(400).json({
          success: false,
          msg: 'credential_invalid',
          error: credentialStatus?.error || 'No se pudo validar la credencial'
        });
      }

      const task = await ProductPublishingTaskRepository.findLatestByExternalIdAndContext({
        marketplaceId,
        externalId,
        companyId,
        branchId,
        credentialId
      });

      if (!task) {
        return res.status(404).json({
          success: false,
          msg: 'publication_not_found',
          error: 'No se encontró una publicación local editable para ese external_id'
        });
      }

      const adapter = new FalabellaAdapter(
        marketplace.id,
        companyId,
        branchId,
        userId,
        credential
      );

      const changedFields = Object.entries({
        status: normalizeFalabellaEditRequestValue(status),
        price: normalizeFalabellaEditRequestValue(price),
        available_quantity: normalizeFalabellaEditRequestValue(available_quantity)
      })
        .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '')
        .map(([key]) => key);

      const result = await adapter.updateItem({
        sellerSku: externalId,
        status: normalizeFalabellaEditRequestValue(status),
        price: normalizeFalabellaEditRequestValue(price),
        available_quantity: normalizeFalabellaEditRequestValue(available_quantity)
      });

      logger.info(`[updateFalabellaItem] Respuesta Falabella inicial:\n ${JSON.stringify(result, null, 2)}`);

      if (!result.success) {
        if (result.error === 'auth_required') {
          return res.status(401).json({
            success: false,
            msg: 'auth_required',
            error: result.error,
            details: result.details || null,
            auth_url: null
          });
        }

        if (result.error === 'no_changes') {
          return res.status(400).json({
            success: false,
            msg: 'no_changes',
            error: 'Debe enviar al menos uno de: status, price, available_quantity'
          });
        }

        return res.status(result.status_code && result.status_code >= 400 && result.status_code < 600 ? result.status_code : 400).json({
          success: false,
          msg: 'update_failed',
          error: result.error,
          details: result.details || null
        });
      }

      // ✅ CORRECCIÓN CLAVE: Determinar si el feed terminó exitosamente
      const feedFinishedSuccessfully =
        result.success &&
        result.data?.feed_status === 'Finished' &&
        parseInt(result.data?.processed_records || '0', 10) > 0 &&
        parseInt(result.data?.failed_records || '0', 10) === 0;

      logger.info(`[updateFalabellaItem] Feed exitoso: ${feedFinishedSuccessfully}`);

      // ✅ CORRECCIÓN CRÍTICA: Obtener el link ANTES de construir el snapshot
      const link = await ProductMarketplaceLinkRepository.findByMarketplaceExternalId(
        marketplaceId,
        externalId,
        task.company_id || companyId,
        task.branch_id || branchId || null,
        credentialId,
        userId
      );

      // ✅ CORRECCIÓN CRÍTICA #2: Leer el payload ACTUAL del link (para hacer MERGE, no sobrescribir)
      const existingPublishedPayload = normalizePublishedPayload(link?.published_payload) || {};

      // ✅ Estado base: leer desde ProductMarketplaceLink (datos reales actualizados)
      const existingBusinessUnit = existingPublishedPayload?.BusinessUnits?.BusinessUnit || {};
      const currentState = {
        sku: externalId,
        status: link?.status || 'active',
        raw_status: existingBusinessUnit.Status || link?.status || 'active',
        price: existingBusinessUnit.Price != null
          ? Number(existingBusinessUnit.Price)
          : null,
        available_quantity: link?.published_stock != null
          ? Number(link.published_stock)
          : (existingBusinessUnit.Stock != null ? Number(existingBusinessUnit.Stock) : null),
        // ✅ PRESERVAR IsPublished y QCStatus del payload existente
        is_published: existingBusinessUnit.IsPublished !== undefined
          ? (String(existingBusinessUnit.IsPublished).trim() === '1' || existingBusinessUnit.IsPublished === 1 || existingBusinessUnit.IsPublished === true)
          : null,
        qc_status: existingPublishedPayload.QCStatus
          ? String(existingPublishedPayload.QCStatus).trim().toLowerCase()
          : null,
        permalink: link?.external_url || task.external_url || null
      };

      logger.info(`[updateFalabellaItem] Estado actual desde ProductMarketplaceLink:`, currentState);

      let currentProductState;
      let refreshedProduct = null;

      if (feedFinishedSuccessfully) {
        try {
          refreshedProduct = await adapter.findExistingProductBySellerSku(externalId);
        } catch (getError) {
          logger.warn(`[updateFalabellaItem] GetProducts post-feed falló: ${getError.message}`);
        }

        if (refreshedProduct) {
          currentProductState = buildFalabellaPublishedStateSnapshot(
            refreshedProduct.raw || refreshedProduct,
            externalId
          );
          logger.info(`[updateFalabellaItem] ✅ Feed confirmado y snapshot real desde GetProducts:`, {
            sku: currentProductState.sku,
            status: currentProductState.status,
            raw_status: currentProductState.raw_status,
            price: currentProductState.price,
            stock: currentProductState.available_quantity,
            is_published: currentProductState.is_published,
            qc_status: currentProductState.qc_status,
            has_image: currentProductState.has_image,
            changedFields
          });
        } else {
          const requestedStatus = hasStatus ? String(status).trim().toLowerCase() : null;
          const fallbackRawStatus = requestedStatus || currentState.raw_status || currentState.status;
          const fallbackStatus = requestedStatus === 'active' && currentState.is_published !== true && !currentState.permalink
            ? 'pending'
            : (currentState.raw_status === 'active' && currentState.is_published === false
                ? 'not_published'
                : (currentState.qc_status === 'rejected' ? 'rejected' : fallbackRawStatus));

          currentProductState = {
            sku: externalId,
            status: fallbackStatus,
            raw_status: fallbackRawStatus,
            price: hasPrice
              ? Number(price)
              : currentState.price,
            available_quantity: hasQuantity
              ? Number(available_quantity)
              : currentState.available_quantity,
            is_published: currentState.is_published,
            qc_status: currentState.qc_status,
            has_image: null,
            permalink: currentState.permalink,
            url: currentState.permalink,
            shop_sku: null,
            raw: null
          };

          logger.warn(`[updateFalabellaItem] Feed confirmado pero GetProducts no devolvió datos. Snapshot conservador:`, {
            sku: currentProductState.sku,
            status: currentProductState.status,
            raw_status: currentProductState.raw_status,
            price: currentProductState.price,
            stock: currentProductState.available_quantity,
            is_published: currentProductState.is_published,
            qc_status: currentProductState.qc_status,
            changedFields
          });
        }
      } else {
        // ✅ CASO 2: Feed no confirmado o con errores
        // Intentar GetProducts como fallback para obtener estado real
        try {
          refreshedProduct = await adapter.findExistingProductBySellerSku(externalId);
        } catch (getError) {
          logger.warn(`[updateFalabellaItem] GetProducts falló: ${getError.message}`);
        }

        if (refreshedProduct) {
          currentProductState = buildFalabellaPublishedStateSnapshot(
            refreshedProduct.raw || refreshedProduct,
            externalId
          );
          logger.info(`[updateFalabellaItem] Snapshot desde GetProducts:`, {
            sku: currentProductState.sku,
            status: currentProductState.status,
            raw_status: currentProductState.raw_status,
            price: currentProductState.price,
            stock: currentProductState.available_quantity,
            is_published: currentProductState.is_published,
            qc_status: currentProductState.qc_status
          });
        } else {
          // Fallback último: usar estado actual del link + solo campos enviados
          currentProductState = {
            sku: externalId,
            status: hasStatus
              ? String(status).trim().toLowerCase()
              : (currentState.raw_status || currentState.status),
            raw_status: hasStatus
              ? String(status).trim().toLowerCase()
              : (currentState.raw_status || currentState.status),
            price: hasPrice
              ? Number(price)
              : currentState.price,
            available_quantity: hasQuantity
              ? Number(available_quantity)
              : currentState.available_quantity,
            is_published: currentState.is_published,
            qc_status: currentState.qc_status,
            permalink: currentState.permalink,
            raw: null
          };
          logger.warn(`[updateFalabellaItem] ⚠️ GetProducts no devolvió datos. Snapshot desde fallback:`, {
            sku: currentProductState.sku,
            status: currentProductState.status,
            raw_status: currentProductState.raw_status,
            price: currentProductState.price,
            stock: currentProductState.available_quantity,
            is_published: currentProductState.is_published,
            qc_status: currentProductState.qc_status
          });
        }
      }

      const marketplaceDisplayStatus = resolveFalabellaMarketplaceDisplayStatus(currentProductState, {
        taskStatus: task.status,
        hasImage: currentProductState.has_image
      });
      const isActive = marketplaceDisplayStatus === 'active';
      const shouldKeepWarning = currentProductState.status && !isActive;

      const currentDetails = normalizeErrorDetails(task.error_details);
      const mergedDetails = {
        ...currentDetails,
        marketplace_item_state: {
          marketplace: 'falabella',
          status: currentProductState.raw_status || currentProductState.status,
          raw_status: currentProductState.raw_status || currentProductState.status,
          qc_status: currentProductState.qc_status,
          is_published: currentProductState.is_published,
          stock: currentProductState.available_quantity,
          price: currentProductState.price,
          has_image: currentProductState.has_image ?? null,
          verified: feedFinishedSuccessfully,
          item_found: !!refreshedProduct || feedFinishedSuccessfully,
          display_status: marketplaceDisplayStatus,
          note: refreshedProduct ? 'get_products' : (feedFinishedSuccessfully ? 'feed_confirmed_without_get_products' : 'fallback'),
          updated_at: new Date().toISOString()
        },
        manual_update: {
          requested_changes: result.data || null,
          updated_at: new Date().toISOString()
        }
      };

      // ✅ CORRECCIÓN CRÍTICA #3: MERGE del payload en lugar de sobrescribir
      // Preservamos TODA la información existente (QCStatus, IsPublished, ProductData, Name, etc.)
      // y solo actualizamos los campos que cambiaron
      const mergedPayload = {
        ...existingPublishedPayload, // ✅ PRESERVAR todo el payload existente
        SellerSku: currentProductState.sku,
        BusinessUnits: {
          ...(existingPublishedPayload.BusinessUnits || {}),
          BusinessUnit: {
            ...(existingPublishedPayload.BusinessUnits?.BusinessUnit || {}),
            Status: currentProductState.raw_status || currentProductState.status,
            Price: currentProductState.price != null ? String(currentProductState.price) : existingBusinessUnit.Price,
            Stock: currentProductState.available_quantity != null ? String(currentProductState.available_quantity) : existingBusinessUnit.Stock,
            // ✅ PRESERVAR IsPublished y QCStatus del payload existente
            IsPublished: existingBusinessUnit.IsPublished,
            QCStatus: existingPublishedPayload.QCStatus
          }
        },
        // ✅ PRESERVAR todos los demás campos del payload existente:
        // Name, Brand, Description, ProductData, PrimaryCategory, etc.
        _feed_status: result.data,
        _updated_at: new Date().toISOString(),
        _last_update_fields: changedFields
      };

      // ✅ Si GetProducts devolvió datos completos, usarlos (tienen información fresca)
      const apiResponseToSave = refreshedProduct?.raw || mergedPayload;

      const taskUpdate = {
        api_response: apiResponseToSave,
        error_message: shouldKeepWarning
          ? `Falabella item status: ${currentProductState.status}${currentProductState.qc_status ? ` (${currentProductState.qc_status})` : ''}`
          : null,
        error_details: mergedDetails,
        external_id: externalId,
        external_url: currentProductState.permalink || task.external_url || null
      };

      if (feedFinishedSuccessfully && isActive) {
        taskUpdate.status = 'published';
      } else if (isActive && task.status === 'published_with_warnings') {
        taskUpdate.status = 'published';
      } else if (feedFinishedSuccessfully && !isActive) {
        taskUpdate.status = 'pending';
      } else if (shouldKeepWarning && task.status === 'published') {
        taskUpdate.status = 'published_with_warnings';
      }

      await ProductPublishingTaskRepository.updateTask(task, taskUpdate);

      // ✅ CORRECCIÓN CRÍTICA #4: Actualizar ProductMarketplaceLink con el payload MERGEADO
      // Esto preserva IsPublished, QCStatus, ProductData, etc.
      if (link) {
        const previousBusinessUnit = normalizePublishedPayload(link.published_payload)?.BusinessUnits?.BusinessUnit || {};
        const previousPublishedState = {
          status: link.status,
          price: previousBusinessUnit.Price != null ? Number(previousBusinessUnit.Price) : null,
          available_quantity: link.published_stock,
          external_url: link.external_url || null
        };
        const nextPublishedState = {
          status: marketplaceDisplayStatus || currentProductState.status || link.status,
          price: currentProductState.price,
          available_quantity: currentProductState.available_quantity,
          external_url: currentProductState.permalink || link.external_url || null
        };
        await link.update({
          status: nextPublishedState.status,
          external_url: nextPublishedState.external_url,
          published_stock: nextPublishedState.available_quantity,
          published_payload: apiResponseToSave, // ✅ Payload completo con MERGE
          last_synced_at: new Date(),
          user_id: userId
        });

        const publishedChanges = PublicationAuditService.getPublishedProductChanges(previousPublishedState, nextPublishedState);
        const actionForChange = (change) => {
          if (change.field === 'price') return 'published_product.price_changed';
          if (change.field === 'available_quantity' || change.field === 'published_stock') return 'published_product.stock_changed';
          if (change.field === 'status' && change.new_value === 'paused') return 'published_product.paused';
          if (change.field === 'status' && change.new_value === 'active') return 'published_product.reactivated';
          if (change.field === 'status' && ['closed', 'deleted', 'not_published'].includes(change.new_value)) return 'published_product.deleted';
          return 'published_product.marketplace_status_changed';
        };

        await Promise.all(publishedChanges.map((change) =>
          PublicationAuditService.recordPublishedProductFromRequest(req, task, actionForChange(change), {
            previous_value: { [change.field]: change.old_value },
            new_value: { [change.field]: change.new_value },
            changes: [change],
            description: `Publicacion ${externalId} actualizada desde Spree`,
            metadata: {
              source: 'spree_marketplace_edit',
              external_id: externalId,
              changed_fields: changedFields,
              feed_confirmed: feedFinishedSuccessfully
            }
          })
        ));

        logger.info(`[updateFalabellaItem] ✅ ProductMarketplaceLink actualizado:`, {
          published_stock: currentProductState.available_quantity,
          published_price: currentProductState.price,
          status: currentProductState.status,
          raw_status: currentProductState.raw_status,
          is_published: currentProductState.is_published,
          qc_status: currentProductState.qc_status
        });
      }

      await LogRepository.create({
        user_id: metadata.user_id,
        action: 'marketplace_item.update',
        description: `Item Falabella ${externalId} actualizado${feedFinishedSuccessfully ? ' (feed confirmado)' : ''}`,
        ip_address: metadata.ip_address,
        user_agent: metadata.user_agent,
        status: 'success',
        meta: {
          company_id: companyId,
          user_id: userId,
          marketplace_id: marketplaceId,
          credential_id: credentialId,
          external_id: externalId,
          changed_fields: changedFields,
          feed_confirmed: feedFinishedSuccessfully
        }
      });

      return res.status(200).json({
        success: true,
        msg: 'marketplace_item_updated',
        changed_fields: changedFields,
        external_id: externalId,
        task_id: task.id,
        product_id: task.product_id,
        marketplace_id: marketplaceId,
        marketplace_name: credential.name || marketplace.name || 'N/A',
        marketplace_domain: marketplace.domain || null,
        marketplace_key: 'falabella',
        marketplace_status: currentProductState.raw_status || currentProductState.status || taskUpdate.status || task.status || 'failed',
        publication_status: taskUpdate.status || task.status,
        feed_confirmed: feedFinishedSuccessfully,
        item: {
          sku: currentProductState.sku || externalId,
          status: currentProductState.status || null,
          raw_status: currentProductState.raw_status || null,
          is_published: currentProductState.is_published ?? null,
          qc_status: currentProductState.qc_status || null,
          price: currentProductState.price ?? null,
          available_quantity: currentProductState.available_quantity ?? null,
          permalink: currentProductState.permalink || null,
          feed_status: result.data?.feed_status || null,
          feed_id: result.data?.feed_id || null,
          sub_status: [],
          // ✅ NUEVO: Mensaje explicativo del estado real
          publication_note: buildFalabellaPublicationNoteExact(currentProductState)
        }
      });
    } catch (error) {
      logger.error('Error actualizando item Falabella:');
      logger.error(`Body:\n ${JSON.stringify(req.body, null, 2)}`);
      logger.error(`Message: ${error.message}`);
      logger.error(`Stack: ${error.stack || 'no_stack'}`);
      if (error.response) {
        logger.error(`Status: ${error.response.status}`);
        logger.error(`Marketplace response:\n ${JSON.stringify(error.response.data, null, 2)}`);
      }
      await LogRepository.create({
        user_id: metadata?.user_id,
        action: 'marketplace_item.update',
        description: `Error: ${error.message}`,
        ip_address: metadata?.ip_address,
        user_agent: metadata?.user_agent,
        status: 'error',
        meta: {
          company_id: req.body?.company_id || req.user?.company_id,
          user_id: req.body?.user_id || req.user?.id,
          marketplace_id: req.body?.marketplace_id || null,
          credential_id: req.body?.credential_id || null,
          external_id: req.body?.external_id || null
        }
      });

      return res.status(500).json({
        success: false,
        msg: 'internal_error',
        error: error.message
      });
    }
  },

async destroy(req, res) {
  const userName = req.user?.name || 'Anonymous';
  const task_id = req.body.id;
  logger.info(`${userName} - Elimina tarea de publicación ID ${task_id}`);
  logger.info("Datos recibidos:");
  logger.info(JSON.stringify({ body: req.body }));

  try {
    const task = await ProductPublishingTaskRepository.findById(task_id);
    if (!task) return res.status(404).json({ msg: "PublishingTaskNotFound" });

    // Verificar que el usuario tenga permiso para eliminar
    if (task.user_id !== req.user.id && task.company_id !== req.user.company_id) {
      return res.status(403).json({ msg: "Forbidden" });
    }

    if (task.status === 'draft') {
      await PublicationAuditService.recordPublishedProductFromRequest(req, task, 'publication_draft.products_removed', {
        module: 'publication_draft',
        resource_type: 'product_publishing_task',
        resource_id: task.id,
        previous_value: {
          product_id: task.product_id,
          marketplace_id: task.marketplace_id,
          credential_id: task.credential_id,
          status: task.status
        },
        description: `Producto eliminado del borrador de publicación`,
        metadata: {
          source: 'publishing_task_delete',
          task_id: task.id
        }
      });
    } else {
      await PublicationAuditService.recordPublishedProductFromRequest(req, task, 'published_product.deleted', {
        previous_value: {
          product_id: task.product_id,
          marketplace_id: task.marketplace_id,
          credential_id: task.credential_id,
          external_id: task.external_id,
          status: task.status
        },
        description: `Publicación eliminada en Spree`,
        metadata: {
          source: 'publishing_task_delete',
          task_id: task.id
        }
      });
    }

    await ProductPublishingTaskRepository.delete(task);
    
    
    return res.status(200).json({ 
      success: true,
      message: "Publicación eliminada correctamente", 
    });
  } catch (err) {
    logger.error("ProductPublishingTaskController->destroy: " + err.message);
    return res.status(500).json({ error: "ServerError", details: err.message });
  }
},

/**
 * Actualiza el payload de una tarea de publicación específica
 * PUT /api/publishing-tasks/:id/payload
 */
async updatePayload(req, res) {
  logger.info(`${req.user?.name || 'Unknown'} - Actualiza payload de tarea`);
  logger.info(`Datos recibidos: \n ${JSON.stringify(req.body)}`);
  const { payload, task_id } = req.body;
  const metadata = getRequestMetadata(req);

  try {
    // ✅ Buscar tarea con relaciones
    const task = await ProductPublishingTaskRepository.findById(task_id);
    if (!task) {
      return res.status(404).json({
        success: false,
        message: "task_not_found"
      });
    }
    // ✅ Validar que la tarea esté en estado editable
    // ✅ published_with_warnings es editable para permitir corregir warnings y republicar
    const editableStatuses = ['draft', 'failed', 'pending', 'published_with_warnings'];
    if (!editableStatuses.includes(task.status)) {
      return res.status(400).json({
        success: false,
        msg: "invalid_status",
        message: `No se puede editar el payload en estado: ${task.status}`
      });
    }

    // ✅ Actualizar payload vía repository
    const updatedTask = await ProductPublishingTaskRepository.updatePayload(
      task,
      payload
    );

    // ✅ Registrar auditoría
    await LogRepository.create({
      user_id: metadata.user_id,
      action: 'publishing_task.update_payload',
      description: `Payload actualizado para tarea ${task_id}`,
      ip_address: metadata.ip_address,
      user_agent: metadata.user_agent,
      status: 'success',
      meta: { 
        task_id,
        payload_keys: Object.keys(payload),
        updated_at: updatedTask.updatedAt
      }
    });

    await PublicationAuditService.recordDraftPayloadChanges(req, task, task.payload, updatedTask.payload);

    // ✅ Respuesta exitosa (solo campos esenciales para no saturar)
    return res.status(200).json({ 
      success: true,
      message: "Payload actualizado correctamente",
      task: { 
        task_id: updatedTask.id, 
        status: updatedTask.status,
        payload: updatedTask.payload,
        updated_at: updatedTask.updatedAt
      } 
    });

  } catch (error) {
    logger.error(`Error actualizando payload:\n ${JSON.stringify(error.message)}`);
    
    // ✅ Registrar error en auditoría
    await LogRepository.create({
      user_id: metadata.user_id,
      action: 'publishing_task.update_payload',
      description: `Error al actualizar payload: ${error.message}`,
      ip_address: metadata.ip_address,
      user_agent: metadata.user_agent,
      status: 'error',
      meta: { task_id, error: error.message }
    });

    return res.status(500).json({ 
      success: false,
      msg: "internal_error",
      error: error.message 
    });
  }
},
};

module.exports = ProductPublishingTaskController;
