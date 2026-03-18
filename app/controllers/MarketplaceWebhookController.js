const logger = require("../../config/logger");
const axios = require("axios");
const crypto = require("crypto");
const { sequelize } = require("../models");
const {
  MarketplaceCredentialRepository,
  ProductMarketplaceLinkRepository,
  ProductVariantRepository,
  WarehouseProductRepository,
  WarehouseProductVariantRepository,
  InventoryMovementRepository,
  ProductPublishingTaskRepository,
  WarehouseRepository,
  ProductRepository,
  MarketplaceWebhookEventRepository
} = require("../repositories");
const MarketplaceStockSyncService = require("../services/MarketplaceStockSyncService");

const ML_MARKETPLACE_KEY = "mercadolibre";
const FB_MARKETPLACE_KEY = "falabella";

const MarketplaceWebhookController = {
  async mercadoLibre(req, res) {
    const payload = req.body || {};

    res.status(200).json({ success: true });

    setImmediate(() => {
      processMercadoLibreWebhook(payload).catch((err) => {
        logger.error(`[ML Webhook] Error en procesamiento async: ${err.message}`);
      });
    });
  },

  async falabella(req, res) {
    const payload = req.body || {};

    res.status(200).json({ success: true });

    setImmediate(() => {
      processFalabellaWebhook(payload).catch((err) => {
        logger.error(`[FB Webhook] Error en procesamiento async: ${err.message}`);
      });
    });
  }
};

async function processMercadoLibreWebhook(payload) {
  const { resource, topic, user_id } = payload || {};

  if (topic !== "orders") {
    logger.info(`[ML Webhook] Ignorado topic: ${topic}`);
    return;
  }

  const orderId = extractOrderId(resource);
  if (!orderId) {
    logger.warn(`[ML Webhook] Resource invalido: ${resource}`);
    return;
  }

  const eventResult = await MarketplaceWebhookEventRepository.createUnique({
    marketplace: ML_MARKETPLACE_KEY,
    topic,
    resource,
    external_id: String(orderId),
    marketplace_user_id: user_id != null ? String(user_id) : null,
    status: "received",
    payload
  });

  if (!eventResult.created) {
    logger.info(`[ML Webhook] Duplicado ignorado: ${resource}`);
    return;
  }

  const event = eventResult.record;

  const credential = await MarketplaceCredentialRepository.findByMLUserIdGlobal(user_id);
  if (!credential || !credential.access_token) {
    await MarketplaceWebhookEventRepository.updateById(event.id, {
      status: "error",
      error_message: "credential_not_found",
      processed_at: new Date()
    });
    logger.warn(`[ML Webhook] Credencial no encontrada para ml_user_id=${user_id}`);
    return;
  }

  const order = await fetchMercadoLibreOrder(orderId, credential.access_token);
  if (!order) {
    await MarketplaceWebhookEventRepository.updateById(event.id, {
      status: "error",
      error_message: "order_fetch_failed",
      processed_at: new Date()
    });
    return;
  }

  const items = Array.isArray(order.order_items) ? order.order_items : [];
  if (items.length === 0) {
    await MarketplaceWebhookEventRepository.updateById(event.id, {
      status: "processed_with_errors",
      error_message: "order_items_empty",
      processed_at: new Date()
    });
    return;
  }

  const errors = [];

  for (const orderItem of items) {
    try {
      await processOrderItem(orderItem, {
        orderId,
        marketplaceId: credential.marketplace_id,
        companyId: null,
        branchId: null
      });
    } catch (error) {
      errors.push(error.message);
      logger.error(`[ML Webhook] Item error order=${orderId}: ${error.message}`);
    }
  }

  await MarketplaceWebhookEventRepository.updateById(event.id, {
    status: errors.length > 0 ? "processed_with_errors" : "processed",
    error_message: errors.length > 0 ? errors.slice(0, 5).join(" | ") : null,
    processed_at: new Date()
  });
}

async function fetchMercadoLibreOrder(orderId, accessToken) {
  try {
    const response = await axios.get(
      `https://api.mercadolibre.com/orders/${orderId}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 10000
      }
    );
    return response.data;
  } catch (error) {
    logger.error(`[ML Webhook] Error obteniendo orden ${orderId}: ${error.message}`);
    return null;
  }
}

async function processFalabellaWebhook(payload) {
  const topicRaw =
    payload?.event ||
    payload?.event_type ||
    payload?.topic ||
    payload?.type ||
    null;

  const normalizedTopic = topicRaw ? String(topicRaw).toLowerCase() : null;
  if (normalizedTopic && !["onordercreated", "ordercreated"].includes(normalizedTopic)) {
    logger.info(`[FB Webhook] Ignorado topic: ${topicRaw}`);
    return;
  }

  const orderId = extractFalabellaOrderId(payload);
  if (!orderId) {
    logger.warn(`[FB Webhook] No se pudo extraer OrderId del payload`);
    return;
  }

  const resource = payload?.resource || `orders/${orderId}`;
  const topic = topicRaw || "onOrderCreated";

  const eventResult = await MarketplaceWebhookEventRepository.createUnique({
    marketplace: FB_MARKETPLACE_KEY,
    topic,
    resource,
    external_id: String(orderId),
    marketplace_user_id: getFalabellaSellerId(payload),
    status: "received",
    payload
  });

  if (!eventResult.created) {
    logger.info(`[FB Webhook] Duplicado ignorado: ${resource}`);
    return;
  }

  const event = eventResult.record;

  const credential = await resolveFalabellaCredential(payload);
  if (!credential || !credential.seller_email || !credential.api_key) {
    await MarketplaceWebhookEventRepository.updateById(event.id, {
      status: "error",
      error_message: "credential_not_found",
      processed_at: new Date()
    });
    logger.warn(`[FB Webhook] Credencial Falabella no encontrada`);
    return;
  }

  const orderData = await fetchFalabellaOrder(orderId, credential);
  if (!orderData) {
    await MarketplaceWebhookEventRepository.updateById(event.id, {
      status: "error",
      error_message: "order_fetch_failed",
      processed_at: new Date()
    });
    return;
  }

  const items = parseFalabellaOrderItems(orderData);
  if (items.length === 0) {
    await MarketplaceWebhookEventRepository.updateById(event.id, {
      status: "processed_with_errors",
      error_message: "order_items_empty",
      processed_at: new Date()
    });
    return;
  }

  const errors = [];

  for (const item of items) {
    try {
      await processFalabellaOrderItem(item, {
        orderId,
        marketplaceId: credential.marketplace_id,
        companyId: null,
        branchId: null
      });
    } catch (error) {
      errors.push(error.message);
      logger.error(`[FB Webhook] Item error order=${orderId}: ${error.message}`);
    }
  }

  await MarketplaceWebhookEventRepository.updateById(event.id, {
    status: errors.length > 0 ? "processed_with_errors" : "processed",
    error_message: errors.length > 0 ? errors.slice(0, 5).join(" | ") : null,
    processed_at: new Date()
  });
}

async function resolveFalabellaCredential(payload) {
  const sellerId = getFalabellaSellerId(payload);
  const sellerEmail =
    payload?.seller_email ||
    payload?.sellerEmail ||
    payload?.UserID ||
    payload?.user_id ||
    payload?.userId ||
    null;

  const byIdOrEmail = await MarketplaceCredentialRepository.findActiveFalabellaBySellerIdOrEmail({
    sellerId: sellerId || null,
    sellerEmail: sellerEmail || null
  });
  if (byIdOrEmail) return byIdOrEmail;

  return await MarketplaceCredentialRepository.findSingleActiveFalabella();
}

async function fetchFalabellaOrder(orderId, credential) {
  try {
    const timestamp = timestampMinus03();
    const params = {
      Action: "GetOrder",
      Format: "JSON",
      OrderId: String(orderId),
      Timestamp: timestamp,
      UserID: credential.seller_email.trim(),
      Version: "1.0"
    };

    const url = buildFalabellaSignedUrl(params, credential.api_key);
    const response = await axios.get(url, { timeout: 15000 });

    if (typeof response.data === "string") {
      try {
        return JSON.parse(response.data);
      } catch (e) {
        logger.error(`[FB Webhook] Respuesta no JSON para OrderId ${orderId}`);
        return null;
      }
    }

    return response.data;
  } catch (error) {
    logger.error(`[FB Webhook] Error obteniendo orden ${orderId}: ${error.message}`);
    return null;
  }
}

function parseFalabellaOrderItems(orderData) {
  const order =
    orderData?.SuccessResponse?.Body?.Order ||
    orderData?.SuccessResponse?.Body?.Orders?.Order ||
    null;

  const rawItems =
    order?.OrderItems?.OrderItem ||
    orderData?.SuccessResponse?.Body?.OrderItems?.OrderItem ||
    null;

  const items = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];

  return items.map((item) => ({
    sku:
      item?.SellerSku ||
      item?.SellerSKU ||
      item?.Sku ||
      item?.sku ||
      null,
    quantity: parseInt(item?.Quantity || item?.quantity || item?.Qty, 10) || 0
  }));
}

async function processFalabellaOrderItem(item, ctx) {
  const quantity = Number(item?.quantity || 0);
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error("invalid_quantity");
  }

  const sku = item?.sku;
  if (!sku) {
    throw new Error("sku_not_found");
  }

  let link = await ProductMarketplaceLinkRepository.findByMarketplaceExternalId(
    ctx.marketplaceId,
    sku
  );

  let productId = link?.product_id || null;
  if (!productId) {
    const variantBySku = await ProductVariantRepository.findBySku(sku);
    productId = variantBySku?.product_id || null;
  }

  if (!productId) {
    throw new Error(`product_not_found:${sku}`);
  }

  const variant = await resolveVariant(productId, sku);
  if (!variant) {
    throw new Error(`variant_not_found:${sku}`);
  }

  const warehouseId = await resolveWarehouseId({
    marketplaceId: ctx.marketplaceId,
    externalId: sku,
    productId,
    companyId: link?.company_id || null,
    branchId: link?.branch_id || null
  });

  if (!warehouseId) {
    throw new Error("warehouse_not_found");
  }

  const exitResult = await applyStockExit({
    productId,
    variantId: variant.id,
    warehouseId,
    quantity,
    orderId: ctx.orderId,
    listingId: sku,
    marketplaceKey: FB_MARKETPLACE_KEY,
    referencePrefix: "fb",
    reason: "falabella_sale"
  });

  await queueStockSync({
    productId,
    variantId: variant.id,
    warehouseId,
    stock: exitResult?.stockAfter,
    sourceMarketplaceId: ctx.marketplaceId,
    companyId: link?.company_id || null,
    branchId: link?.branch_id || null,
    logPrefix: "FB Webhook"
  });
}

async function processOrderItem(orderItem, ctx) {
  const quantity = Number(orderItem?.quantity || 0);
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error("invalid_quantity");
  }

  const listingId = getListingId(orderItem);
  if (!listingId) {
    throw new Error("listing_id_not_found");
  }

  const link = await ProductMarketplaceLinkRepository.findByMarketplaceExternalId(
    ctx.marketplaceId,
    listingId
  );
  if (!link) {
    throw new Error(`product_link_not_found:${listingId}`);
  }

  const productId = link.product_id;
  const sku = getSkuFromOrderItem(orderItem);

  const variant = await resolveVariant(productId, sku);
  if (!variant) {
    throw new Error(`variant_not_found:${sku || "no_sku"}`);
  }

  const warehouseId = await resolveWarehouseId({
    marketplaceId: ctx.marketplaceId,
    externalId: listingId,
    productId,
    companyId: link.company_id,
    branchId: link.branch_id
  });

  if (!warehouseId) {
    throw new Error("warehouse_not_found");
  }

  const exitResult = await applyStockExit({
    productId,
    variantId: variant.id,
    warehouseId,
    quantity,
    orderId: ctx.orderId,
    listingId,
    marketplaceKey: ML_MARKETPLACE_KEY,
    referencePrefix: "ml",
    reason: "mercadolibre_sale"
  });

  await queueStockSync({
    productId,
    variantId: variant.id,
    warehouseId,
    stock: exitResult?.stockAfter,
    sourceMarketplaceId: ctx.marketplaceId,
    companyId: link.company_id,
    branchId: link.branch_id,
    logPrefix: "ML Webhook"
  });
}

async function resolveVariant(productId, sku) {
  if (sku) {
    const bySku = await ProductVariantRepository.findBySku(sku);
    if (bySku && Number(bySku.product_id) === Number(productId)) {
      return bySku;
    }
  }

  const variants = await ProductVariantRepository.findByProductId(productId);
  if (variants.length === 1) {
    return variants[0];
  }

  return null;
}

async function resolveWarehouseId({ marketplaceId, externalId, productId, companyId, branchId }) {
  const lastTask = await ProductPublishingTaskRepository.findLatestByExternalId(
    marketplaceId,
    externalId
  );
  if (lastTask?.warehouse_id) {
    return lastTask.warehouse_id;
  }

  let finalCompanyId = companyId;
  let finalBranchId = branchId;

  if (!finalCompanyId && productId) {
    const product = await ProductRepository.findById(productId);
    finalCompanyId = product?.company_id || null;
  }

  if (!finalCompanyId && !finalBranchId) {
    return null;
  }

  const warehouses = await WarehouseRepository.findWarehousesByCompanyOrBranch(
    finalCompanyId,
    finalBranchId
  );

  if (!warehouses || warehouses.length === 0) {
    return null;
  }

  const active = warehouses.find((w) => w.status === "activo") || warehouses[0];
  return active?.id || null;
}

async function applyStockExit({
  productId,
  variantId,
  warehouseId,
  quantity,
  orderId,
  listingId,
  marketplaceKey,
  referencePrefix,
  reason
}) {
  const finalMarketplaceKey = marketplaceKey || "marketplace";
  const finalReferencePrefix = referencePrefix || finalMarketplaceKey;
  const transaction = await sequelize.transaction();

  try {
    const warehouseProduct = await WarehouseProductRepository.findByWarehouseAndProduct(
      warehouseId,
      productId
    );

    if (!warehouseProduct) {
      throw new Error("warehouse_product_not_found");
    }

    const wpVariant = await WarehouseProductVariantRepository.findByVariantAndWarehouseProduct(
      variantId,
      warehouseProduct.id
    );

    if (!wpVariant) {
      throw new Error("warehouse_product_variant_not_found");
    }

    const stockBefore = parseInt(wpVariant.stock, 10) || 0;
    if (stockBefore < quantity) {
      throw new Error(`insufficient_stock:${stockBefore}`);
    }

    const stockAfter = stockBefore - quantity;
    const updateData = { stock: stockAfter };

    if (stockAfter === 0) {
      updateData.price = null;
      updateData.promotional_price = null;
      updateData.local_sku = null;
      updateData.active = false;
      updateData.published = false;
    }

    await WarehouseProductVariantRepository.update(wpVariant, updateData, { transaction });

    let companyId = warehouseProduct.company_id || null;
    let branchId = warehouseProduct.branch_id || null;
    if (!companyId && !branchId) {
      const warehouse = await WarehouseRepository.findById(warehouseId);
      companyId = warehouse?.company_id || null;
      branchId = warehouse?.branch_id || null;
    }

    await InventoryMovementRepository.create({
      warehouse_id: warehouseId,
      product_id: productId,
      variant_id: variantId,
      company_id: companyId,
      branch_id: branchId,
      movement_type: "exit",
      quantity,
      stock_before: stockBefore,
      stock_after: stockAfter,
      unit_price: wpVariant.price || null,
      total_value: wpVariant.price ? wpVariant.price * quantity : null,
      reference_type: finalMarketplaceKey,
      reference_id: `${finalReferencePrefix}:${orderId}:${listingId}`,
      reason: reason || `${finalMarketplaceKey}_sale`,
      notes: `order:${orderId}`,
      user_id: null
    }, { transaction });

    await transaction.commit();
    return { stockAfter };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

async function queueStockSync({
  productId,
  variantId,
  warehouseId,
  stock,
  sourceMarketplaceId,
  companyId,
  branchId,
  logPrefix
}) {
  try {
    const job = await MarketplaceStockSyncService.enqueueStockSync({
      productId,
      variantId,
      warehouseId,
      stock,
      sourceMarketplaceId,
      companyId,
      branchId
    });

    if (!job) return;

    const prefix = logPrefix || "Webhook";
    logger.info(`[${prefix}] Job de sync creado: ${job.id}`);
  } catch (error) {
    const prefix = logPrefix || "Webhook";
    logger.warn(`[${prefix}] Error preparando sync: ${error.message}`);
  }
}

function extractOrderId(resource) {
  if (!resource || typeof resource !== "string") return null;
  const match = resource.match(/\/?orders\/(\d+)/);
  if (match && match[1]) return match[1];
  const parts = resource.split("/");
  return parts.length > 0 ? parts[parts.length - 1] : null;
}

function getListingId(orderItem) {
  return (
    orderItem?.item?.id ||
    orderItem?.item_id ||
    orderItem?.id ||
    null
  );
}

function getSkuFromOrderItem(orderItem) {
  return (
    orderItem?.item?.seller_custom_field ||
    orderItem?.item?.seller_sku ||
    orderItem?.seller_custom_field ||
    orderItem?.seller_sku ||
    null
  );
}

function extractFalabellaOrderId(payload) {
  return (
    payload?.OrderId ||
    payload?.order_id ||
    payload?.orderId ||
    payload?.data?.OrderId ||
    payload?.data?.order_id ||
    payload?.data?.orderId ||
    null
  );
}

function getFalabellaSellerId(payload) {
  return (
    payload?.seller_id ||
    payload?.sellerId ||
    payload?.SellerId ||
    payload?.SellerID ||
    payload?.user_id ||
    payload?.userId ||
    payload?.UserID ||
    null
  );
}

function rfc3986Encode(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => {
    return `%${c.charCodeAt(0).toString(16).toUpperCase()}`;
  });
}

function timestampMinus03(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}-03:00`
  );
}

function buildFalabellaSignedUrl(params, apiKey) {
  const sortedKeys = Object.keys(params).sort();
  const canonicalQuery = sortedKeys
    .map((k) => `${rfc3986Encode(k)}=${rfc3986Encode(String(params[k]))}`)
    .join("&");

  const signatureHex = crypto
    .createHmac("sha256", apiKey.trim())
    .update(canonicalQuery, "utf8")
    .digest("hex");

  const signatureEncoded = rfc3986Encode(signatureHex);
  const urlQueryString = `${canonicalQuery}&Signature=${signatureEncoded}`;

  return `https://sellercenter-api.falabella.com?${urlQueryString}`;
}

module.exports = MarketplaceWebhookController;
