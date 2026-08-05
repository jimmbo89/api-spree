const fs = require('fs');
const path = require('path');
const Module = require('module');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const logger = require('../../config/logger');
const db = require('../models');
const MarketplaceCredentialRepository = require('../repositories/MarketplaceCredentialRepository');
const MarketplaceOrderRepository = require('../repositories/MarketplaceOrderRepository');
const MarketplaceOrderItemRepository = require('../repositories/MarketplaceOrderItemRepository');
const MarketplaceOrderFeeRepository = require('../repositories/MarketplaceOrderFeeRepository');
const MarketplaceWebhookEventRepository = require('../repositories/MarketplaceWebhookEventRepository');
const MarketplaceOrderEventRepository = require('../repositories/MarketplaceOrderEventRepository');
const ProductMarketplaceLinkRepository = require('../repositories/ProductMarketplaceLinkRepository');
const ProductPublishingTaskRepository = require('../repositories/ProductPublishingTaskRepository');
const ProductVariantRepository = require('../repositories/ProductVariantRepository');
const WarehouseProductRepository = require('../repositories/WarehouseProductRepository');
const WarehouseProductVariantRepository = require('../repositories/WarehouseProductVariantRepository');
const MarketplaceStockSyncService = require('../services/MarketplaceStockSyncService');
const JobRepository = require('../repositories/JobRepository');

const DEFAULT_CONTEXT = {
  userId: 32,
  companyId: 24,
  credentialId: 5,
  itemsCount: 2
};

function loadControllerInternals() {
  const controllerPath = path.resolve(__dirname, '../controllers/MarketplaceWebhookController.js');
  const source = `${fs.readFileSync(controllerPath, 'utf8')}\nmodule.exports.__internals = {\n  processMercadoLibreWebhook,\n  processMercadoLibreEvent,\n  fetchMercadoLibreOrderWithRetry,\n  fetchMercadoLibreShipmentWithRetry,\n  fetchMercadoLibreShipmentCostsWithRetry,\n  fetchMercadoLibreBillingInfoWithRetry,\n  fetchMercadoLibreOrderDiscountsWithRetry,\n  fetchMercadoLibreMessagesWithRetry,\n  resolveCompanyFromListing,\n  processOrderItem,\n  normalizeMercadoLibreShipmentCosts,\n  normalizeMercadoLibreOrderDiscounts,\n  buildMercadoLibreCustomerSnapshot,\n  buildMercadoLibreMessagesSnapshot\n};\n`;

  const controllerModule = new Module(controllerPath, module);
  controllerModule.filename = controllerPath;
  controllerModule.paths = Module._nodeModulePaths(path.dirname(controllerPath));
  controllerModule._compile(source, controllerPath);

  return controllerModule.exports;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function roundMoney(value) {
  return Math.max(0, Math.round(toNumber(value, 0)));
}

function buildMockAxiosGet({ orderData, shipmentData, shipmentCostsData, billingInfoData, discountsData, messagesData }) {
  return async function mockAxiosGet(url) {
    const normalizedUrl = String(url || '');

    if (normalizedUrl.includes(`/orders/billing-info/`) || normalizedUrl.includes(`/orders/${orderData.id}/billing_info`)) {
      return { data: billingInfoData };
    }

    if (normalizedUrl.includes(`/orders/${orderData.id}/discounts`)) {
      return { data: discountsData || { details: [] } };
    }

    if (normalizedUrl.includes(`/shipments/${shipmentData.id}/costs`)) {
      return { data: shipmentCostsData };
    }

    if (normalizedUrl.includes(`/shipments/${shipmentData.id}`)) {
      return { data: shipmentData };
    }

    if (normalizedUrl.includes(`/orders/${orderData.id}`)) {
      return { data: orderData };
    }

    if (normalizedUrl.includes(`/messages/packs/${orderData.pack_id}/sellers/${orderData.seller.id}`)) {
      return { data: messagesData };
    }

    const error = new Error(`mocked_mercadolibre_url_not_handled:${normalizedUrl}`);
    error.response = { status: 404 };
    throw error;
  };
}

function pickPublishedTasks(tasks, itemsCount) {
  return (Array.isArray(tasks) ? tasks : [])
    .filter((task) => task && task.external_id && task.product_id)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, itemsCount);
}

async function loadTaskProductData(task) {
  const variants = await ProductVariantRepository.findByProductId(task.product_id);

  return {
    task,
    product: task.product ? clone(task.product.toJSON ? task.product.toJSON() : task.product) : null,
    variants: Array.isArray(variants)
      ? variants.map((variant) => clone(variant.toJSON ? variant.toJSON() : variant))
      : []
  };
}

function extractWarehouseIdsFromTask(task) {
  const poolWarehouses = Array.isArray(task?.job?.config?.pool?.warehouses)
    ? task.job.config.pool.warehouses
    : [];

  const ids = poolWarehouses
    .map((warehouse) => Number(warehouse?.warehouse_id))
    .filter((id) => Number.isFinite(id) && id > 0);

  if (ids.length > 0) {
    return Array.from(new Set(ids));
  }

  if (task?.warehouse_id) {
    return [Number(task.warehouse_id)];
  }

  return [];
}

async function resolveAvailableVariantForTask(task, variants) {
  const warehouseIds = extractWarehouseIdsFromTask(task);
  if (warehouseIds.length === 0 || !Array.isArray(variants) || variants.length === 0) {
    return null;
  }

  for (const variant of variants) {
    let totalStock = 0;
    let unitPrice = 0;

    for (const warehouseId of warehouseIds) {
      const warehouseProduct = await WarehouseProductRepository.findByProductAndWarehouse(
        task.product_id,
        warehouseId
      );

      if (!warehouseProduct?.id) {
        continue;
      }

      const lot = await WarehouseProductVariantRepository.findByVariantAndWarehouseProduct(
        variant.id,
        warehouseProduct.id
      );

      if (!lot) {
        continue;
      }

      const stockInfo = await WarehouseProductVariantRepository.getTotalStockByVariantAndWarehouse(
        variant.id,
        warehouseProduct.id
      );

      totalStock += toNumber(stockInfo?.total_stock, 0);

      if (unitPrice <= 0) {
        const lotPrice = toNumber(
          lot?.price ?? lot?.promotional_price ?? lot?.purchase_price ?? 0,
          0
        );
        if (lotPrice > 0) {
          unitPrice = lotPrice;
        }
      }
    }

    if (totalStock > 0) {
      return {
        variant,
        totalStock,
        warehouseIds,
        unitPrice: unitPrice > 0
          ? unitPrice
          : Math.max(
              1000,
              toNumber(task?.product?.sale_price ?? task?.product?.price ?? task?.product?.purchase_price ?? 0, 0)
            )
      };
    }
  }

  return null;
}

async function seedStockForTask(task, taskData, desiredStock = 5) {
  const warehouseIds = extractWarehouseIdsFromTask(task);
  if (warehouseIds.length === 0 || !Array.isArray(taskData?.variants) || taskData.variants.length === 0) {
    return false;
  }

  const variant = taskData.variants[0];
  for (const warehouseId of warehouseIds) {
    const warehouseProduct = await WarehouseProductRepository.findByProductAndWarehouse(
      task.product_id,
      warehouseId
    );

    if (!warehouseProduct?.id) {
      continue;
    }

    const lot = await WarehouseProductVariantRepository.findByVariantAndWarehouseProduct(
      variant.id,
      warehouseProduct.id
    );

    if (lot) {
      const price = Math.max(
        1000,
        toNumber(
          taskData?.product?.sale_price ??
          taskData?.product?.price ??
          lot.price ??
          lot.promotional_price ??
          lot.purchase_price ??
          0,
          0
        )
      );

      await WarehouseProductVariantRepository.update(lot, {
        stock: desiredStock,
        price,
        purchase_price: lot.purchase_price && Number(lot.purchase_price) > 0
          ? lot.purchase_price
          : price
      });
      return true;
    }
  }

  return false;
}

function buildOrderItem({ publishedItem, index }) {
  const product = publishedItem.product || {};
  const variant = publishedItem.variant || {};
  const listingId = String(publishedItem.task.external_id);
  const sku = String(
    variant.sku ||
    variant.seller_sku ||
    variant.seller_custom_field ||
    product.sku ||
    product.seller_sku ||
    `SKU-${publishedItem.task.product_id}`
  );

  const unitPrice = roundMoney(
    publishedItem.unitPrice ??
    publishedItem.price ??
    product.sale_price ??
    product.price ??
    product.purchase_price ??
    variant.price ??
    0
  );

  const quantity = 1;
  const saleFee = Math.max(1, Math.round(unitPrice * 0.12));

  return {
    id: `${listingId}-${index + 1}`,
    quantity,
    unit_price: unitPrice,
    sale_fee: saleFee,
    item: {
      id: listingId,
      title: product.name || product.title || `Producto ${publishedItem.task.product_id}`,
      seller_custom_field: sku,
      seller_sku: sku
    }
  };
}

function buildOrderPayload({ orderId, sellerId, orderItems }) {
  const now = new Date();
  const totalItems = orderItems.reduce((sum, item) => sum + toNumber(item.quantity, 0), 0);
  const itemsTotal = orderItems.reduce((sum, item) => sum + (toNumber(item.unit_price) * toNumber(item.quantity)), 0);
  const shippingGross = 750;

  return {
    id: orderId,
    pack_id: `PACK-${orderId}`,
    seller_id: sellerId,
    seller: { id: sellerId },
    buyer: {
      id: `buyer-${orderId}`,
      first_name: 'Cliente',
      last_name: 'Simulado',
      nickname: `buyer-${orderId}`,
      email: `cliente-${orderId}@example.com`,
      phone: { number: '+56911112222' },
      billing_info: {
        id: `BILL-${orderId}`
      }
    },
    context: {
      site: 'MLC'
    },
    shipping: {
      id: `SHIP-${orderId}`,
      logistic_type: 'drop_off',
      free_shipping: false,
      shipping_cost: shippingGross,
      shipping_option: { name: 'Mercado Envíos' },
      receiver_name: 'Cliente Simulado',
      receiver_phone: '+56911112222',
      receiver_address: {
        street_name: 'Avenida Siempre Viva',
        street_number: '742',
        city_name: 'Santiago',
        state_name: 'Region Metropolitana',
        country_name: 'Chile',
        zip_code: '8320000'
      }
    },
    currency_id: 'CLP',
    status: 'paid',
    total_amount: itemsTotal + shippingGross,
    payments: [
      {
        status: 'approved',
        payment_type: 'credit_card',
        date_created: now.toISOString()
      }
    ],
    date_created: now.toISOString(),
    last_updated: now.toISOString(),
    order_items: orderItems
  };
}

function buildShipmentCostsPayload({ shippingId }) {
  return {
    shipment_id: shippingId,
    logistic_type: 'drop_off',
    gross_amount: 750,
    senders: [
      {
        cost: 500,
        discounts: [
          {
            promoted_amount: 0
          }
        ]
      }
    ],
    receiver: {
      cost: 250
    }
  };
}

function buildDiscountsPayload() {
  return {
    details: []
  };
}

function buildBillingInfoPayload({ orderId, buyer }) {
  return {
    billing_info: {
      buyer: {
        id: buyer.id,
        first_name: buyer.first_name,
        last_name: buyer.last_name,
        email: buyer.email
      },
      name: buyer.first_name,
      last_name: buyer.last_name,
      business_name: 'Cliente Simulado SPA',
      email: buyer.email,
      identification: {
        type: 'RUT',
        number: '12345678-9'
      },
      address: {
        address_line: 'Avenida Siempre Viva 742',
        street_name: 'Avenida Siempre Viva',
        street_number: '742',
        city_name: 'Santiago',
        municipality_name: 'Santiago',
        state: {
          name: 'Region Metropolitana',
          code: 'RM',
          id: 'RM'
        },
        zip_code: '8320000',
        country_id: 'CL',
        country_code: 'CL'
      },
      attributes: {
        cust_type: 'CO'
      },
      order_id: orderId
    }
  };
}

function buildMessagesPayload({ orderId }) {
  const now = new Date().toISOString();

  return {
    messages: [
      {
        message_id: `${orderId}-msg-1`,
        text: 'Compra confirmada, preparando despacho.',
        conversation_status: 'closed',
        message_date: {
          received: now
        },
        from: {
          role: 'seller'
        }
      },
      {
        message_id: `${orderId}-msg-2`,
        text: 'Gracias por su compra.',
        conversation_status: 'closed',
        message_date: {
          received: now
        },
        from: {
          role: 'buyer'
        }
      }
    ]
  };
}

function installTemporaryPatch(target, key, nextValue) {
  const previousValue = target[key];
  target[key] = nextValue;
  return () => {
    target[key] = previousValue;
  };
}

async function runMercadoLibreWebhookPurchaseSimulation({
  userId = DEFAULT_CONTEXT.userId,
  companyId = DEFAULT_CONTEXT.companyId,
  credentialId = DEFAULT_CONTEXT.credentialId,
  itemsCount = DEFAULT_CONTEXT.itemsCount
} = {}) {
  await db.sequelize.authenticate();

  const credential = await MarketplaceCredentialRepository.findById(credentialId);
  if (!credential) {
    throw new Error(`Credential ${credentialId} not found`);
  }

  const controller = loadControllerInternals();
  const webhookInternals = controller.__internals;
  if (!webhookInternals || typeof webhookInternals.processMercadoLibreWebhook !== 'function') {
    throw new Error('MarketplaceWebhookController internals not available');
  }

  const publishedTasks = await ProductPublishingTaskRepository.findByCompanyAndStatus(companyId, 'published');
  const candidateTasks = pickPublishedTasks(
    publishedTasks.filter((task) => Number(task.credential_id) === Number(credentialId)),
    Math.max(itemsCount * 3, itemsCount)
  );

  const items = [];
  for (const task of candidateTasks) {
    const taskData = await loadTaskProductData(task);
    const availableVariant = await resolveAvailableVariantForTask(task, taskData.variants);

    if (!availableVariant) {
      continue;
    }

    items.push({
      task,
      product: taskData.product,
      variant: clone(availableVariant.variant),
      totalStock: availableVariant.totalStock,
      warehouseIds: availableVariant.warehouseIds,
      unitPrice: availableVariant.unitPrice
    });

    if (items.length === itemsCount) {
      break;
    }
  }

  if (items.length < itemsCount) {
    for (const task of candidateTasks) {
      if (items.some((item) => Number(item.task.id) === Number(task.id))) {
        continue;
      }

      if (items.length === itemsCount) {
        break;
      }

      const taskData = await loadTaskProductData(task);
      const seeded = await seedStockForTask(task, taskData, 5);
      if (!seeded) {
        continue;
      }

      const availableVariant = await resolveAvailableVariantForTask(task, taskData.variants);
      if (!availableVariant) {
        continue;
      }

      items.push({
        task,
        product: taskData.product,
        variant: clone(availableVariant.variant),
        totalStock: availableVariant.totalStock,
        warehouseIds: availableVariant.warehouseIds,
        unitPrice: availableVariant.unitPrice,
        seededStock: true
      });
    }
  }

  if (items.length < itemsCount) {
    throw new Error(
      `Need at least ${itemsCount} published Mercado Libre products with stock for company ${companyId}, found ${items.length}`
    );
  }

  const orderId = `${Date.now()}${String(items[0].task.product_id).padStart(4, '0')}${String(items[1].task.product_id).padStart(4, '0')}`;
  const sellerId = Number(credential?.additional_data?.ml_user_id || credential?.seller_id || credential?.user_id || userId);
  const orderItems = items.map((publishedItem, index) => buildOrderItem({ publishedItem, index }));
  const orderData = buildOrderPayload({ orderId, sellerId, orderItems });
  const shipmentData = {
    id: orderData.shipping.id,
    logistic_type: orderData.shipping.logistic_type,
    free_shipping: orderData.shipping.free_shipping,
    receiver_name: orderData.shipping.receiver_name,
    receiver_phone: orderData.shipping.receiver_phone,
    receiver_address: clone(orderData.shipping.receiver_address),
    receiver: {
      name: orderData.shipping.receiver_name,
      phone: orderData.shipping.receiver_phone
    }
  };
  const shipmentCostsData = buildShipmentCostsPayload({ shippingId: shipmentData.id });
  const billingInfoData = buildBillingInfoPayload({ orderId, buyer: orderData.buyer });
  const discountsData = buildDiscountsPayload();
  const messagesData = buildMessagesPayload({ orderId });
  const payload = {
    _id: `sim-${orderId}-${Date.now()}`,
    topic: 'orders_v2',
    resource: `/orders/${orderId}`,
    user_id: sellerId,
    sent: new Date().toISOString()
  };

  const originalAxiosGet = axios.get;
  const originalFindByMarketplaceExternalId = ProductMarketplaceLinkRepository.findByMarketplaceExternalId.bind(ProductMarketplaceLinkRepository);
  const originalFindByExternalIdAndCredential = ProductMarketplaceLinkRepository.findByExternalIdAndCredential
    ? ProductMarketplaceLinkRepository.findByExternalIdAndCredential.bind(ProductMarketplaceLinkRepository)
    : null;

  const restoreAxios = installTemporaryPatch(
    axios,
    'get',
    buildMockAxiosGet({
      orderData,
      shipmentData,
      shipmentCostsData,
      billingInfoData,
      discountsData,
      messagesData
    })
  );

  const restoreMarketplaceLinkRepo = installTemporaryPatch(
    ProductMarketplaceLinkRepository,
    'findByMarketplaceExternalId',
    async (marketplaceId, externalId, companyFilter = null, branchFilter = null, credentialFilter = null) => {
      const translatedMarketplaceId = String(marketplaceId) === 'mercadolibre'
        ? credential.marketplace_id
        : marketplaceId;

      const direct = await originalFindByMarketplaceExternalId(
        translatedMarketplaceId,
        externalId,
        companyFilter,
        branchFilter,
        credentialFilter
      );
      if (direct) return direct;

      if (String(marketplaceId) === 'mercadolibre' && originalFindByExternalIdAndCredential) {
        return await originalFindByExternalIdAndCredential(
          credential.marketplace_id,
          externalId,
          credential.id
        );
      }

      return null;
    }
  );

  const restoreStockSync = installTemporaryPatch(
    MarketplaceStockSyncService,
    'enqueueStockSync',
    async ({ productId, variantId, warehouseId, stock, sourceMarketplaceId, companyId, branchId }) => {
      const links = await ProductMarketplaceLinkRepository.findByProduct(
        productId,
        companyId,
        branchId
      );

      const targets = (links || []).filter(
        (link) => Number(link.marketplace_id) !== Number(sourceMarketplaceId)
      );

      if (targets.length === 0) {
        return null;
      }

      return await JobRepository.create({
        user_id: userId,
        company_id: companyId,
        job_type: 'sync',
        status: 'pending',
        batch_id: uuidv4(),
        config: {
          source_marketplace_id: sourceMarketplaceId,
          warehouse_id: warehouseId,
          variant_id: variantId,
          stock,
          company_id: companyId,
          branch_id: branchId
        }
      });
    }
  );

  try {
    await webhookInternals.processMercadoLibreWebhook(payload, { timeoutMs: 120000 });

    const webhookEvent = await MarketplaceWebhookEventRepository.findByMarketplaceAndExternalId('mercadolibre', orderId);
    const savedOrder = await MarketplaceOrderRepository.findByMarketplaceOrderId('mercadolibre', orderId);
    const savedItems = savedOrder ? await MarketplaceOrderItemRepository.findByOrderId(savedOrder.id) : [];
    const savedFees = savedOrder ? await MarketplaceOrderFeeRepository.findByOrderId(savedOrder.id) : [];
    const savedEvents = savedOrder ? await MarketplaceOrderEventRepository.findByOrderId(savedOrder.id) : [];

    return {
      success: true,
      payload,
      order_id: orderId,
      webhook_event: webhookEvent ? {
        id: webhookEvent.id,
        status: webhookEvent.status,
        external_id: webhookEvent.external_id,
        event_id: webhookEvent.event_id
      } : null,
      order: savedOrder ? {
        id: savedOrder.id,
        marketplace_order_id: savedOrder.marketplace_order_id,
        order_status: savedOrder.order_status,
        payment_status: savedOrder.payment_status,
        company_id: savedOrder.company_id,
        branch_id: savedOrder.branch_id,
        total_amount: savedOrder.total_amount
      } : null,
      items: savedItems.map((item) => ({
        id: item.id,
        listing_id: item.listing_id,
        product_id: item.product_id,
        variant_id: item.variant_id,
        quantity: item.quantity,
        unit_price: item.unit_price,
        total_price: item.total_price
      })),
      fees: savedFees.map((fee) => ({
        id: fee.id,
        fee_type: fee.fee_type,
        amount: fee.amount,
        status: fee.status
      })),
      events: savedEvents.map((event) => ({
        id: event.id,
        event_type: event.event_type,
        previous_status: event.previous_status,
        new_status: event.new_status
      }))
    };
  } finally {
    restoreMarketplaceLinkRepo();
    restoreStockSync();
    restoreAxios();
    axios.get = originalAxiosGet;
    await db.sequelize.close().catch(() => {});
  }
}

module.exports = {
  runMercadoLibreWebhookPurchaseSimulation
};
