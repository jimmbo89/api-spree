#!/usr/bin/env node

require('dotenv').config();

const { v4: uuidv4 } = require('uuid');
const db = require('../app/models');
const logger = require('../config/logger');
const PoolRepository = require('../app/repositories/PoolRepository');
const WarehouseRepository = require('../app/repositories/WarehouseRepository');
const WarehouseProductRepository = require('../app/repositories/WarehouseProductRepository');
const MarketplaceCredentialRepository = require('../app/repositories/MarketplaceCredentialRepository');
const JobRepository = require('../app/repositories/JobRepository');
const JobProductRepository = require('../app/repositories/JobProductRepository');
const ProductPublishingTaskRepository = require('../app/repositories/ProductPublishingTaskRepository');
const ProductMarketplaceLinkRepository = require('../app/repositories/ProductMarketplaceLinkRepository');
const LogRepository = require('../app/repositories/LogRepository');
const { buildMercadoLibreSimulationResponse } = require('../app/services/MarketplaceSimulationService');

const DEFAULT_CONTEXT = {
  userId: 32,
  companyId: 24,
  credentialId: 5,
  productsToPublish: 2
};

function clone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = {};

  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const raw = arg.slice(2);
    const eq = raw.indexOf('=');
    if (eq === -1) {
      options[raw] = 'true';
      continue;
    }
    const key = raw.slice(0, eq).trim();
    const value = raw.slice(eq + 1);
    options[key] = value;
  }

  return options;
}

function parseIdList(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((num) => Number.isFinite(num) && num > 0);
}

function resolveContext(options = {}) {
  return {
    userId: Number(options.user_id || options.userId || DEFAULT_CONTEXT.userId),
    companyId: Number(options.company_id || options.companyId || DEFAULT_CONTEXT.companyId),
    credentialId: Number(options.credential_id || options.credentialId || DEFAULT_CONTEXT.credentialId),
    productsToPublish: Number(options.count || options.products_to_publish || options.productsToPublish || DEFAULT_CONTEXT.productsToPublish),
    productIds: parseIdList(options.products || options.product_ids || options.productIds)
  };
}

function pickPrimaryPool(pools, fallbackWarehouses = [], userId, companyId) {
  if (Array.isArray(pools) && pools.length > 0) {
    const withPrimary = pools.find((pool) => pool.primary_warehouse);
    if (withPrimary) return withPrimary;
    return pools[0];
  }

  if (fallbackWarehouses.length > 0) {
    return {
      id: null,
      name: 'fallback_pool',
      description: 'Pool construido desde almacenes activos',
      company_id: companyId,
      user_id: userId,
      is_active: true,
      warehouses: fallbackWarehouses.map((warehouse, index) => ({
        warehouse_id: warehouse.id,
        name: warehouse.name,
        code: warehouse.code || null,
        type: warehouse.type || 'central',
        description: warehouse.description || null,
        image: warehouse.image || null,
        is_primary: index === 0,
        position: index + 1,
        id: `fallback-${warehouse.id}`
      })),
      primary_warehouse: {
        warehouse_id: fallbackWarehouses[0].id,
        name: fallbackWarehouses[0].name,
        code: fallbackWarehouses[0].code || null,
        type: fallbackWarehouses[0].type || 'central',
        description: fallbackWarehouses[0].description || null,
        image: fallbackWarehouses[0].image || null,
        is_primary: true,
        position: 1,
        id: `fallback-${fallbackWarehouses[0].id}`
      },
      warehouse_count: fallbackWarehouses.length
    };
  }

  return null;
}

async function runMercadoLibrePublishingSimulation(options = {}) {
  const context = resolveContext(options);
  const closeDb = options.closeDb !== false;
  await db.sequelize.authenticate();

  try {
    const credential = await MarketplaceCredentialRepository.findById(context.credentialId);
    if (!credential) {
      throw new Error(`Credential ${context.credentialId} not found`);
    }

    const marketplace = credential.marketplace;
    if (!marketplace) {
      throw new Error(`Marketplace for credential ${context.credentialId} not found`);
    }

    const pools = await PoolRepository.findFiltered({
      companyId: context.companyId,
      userId: context.userId,
      isActive: true
    });

    let fallbackWarehouses = [];
    let selectedPool = pickPrimaryPool(pools, fallbackWarehouses, context.userId, context.companyId);

    if (!selectedPool) {
      fallbackWarehouses = await WarehouseRepository.getActiveWarehouses(context.companyId, null);
      selectedPool = pickPrimaryPool([], fallbackWarehouses, context.userId, context.companyId);
    }

    if (!selectedPool) {
      throw new Error(`No pool/warehouse available for company ${context.companyId}`);
    }

    const warehouseIds = Array.isArray(selectedPool.warehouses)
      ? selectedPool.warehouses.map((w) => w.warehouse_id).filter(Boolean)
      : [];

    if (warehouseIds.length === 0) {
      throw new Error('Selected pool has no warehouse_ids');
    }

    const warehouseProducts = await WarehouseProductRepository.findProductsByWarehouseIds({
      companyId: context.companyId,
      warehouseIds
    });

    const allProducts = Array.isArray(warehouseProducts)
      ? warehouseProducts.filter((p) => p && p.id)
      : [];

    let selectedProducts;
    if (context.productIds.length > 0) {
      selectedProducts = context.productIds
        .map((productId) => allProducts.find((product) => Number(product.id) === Number(productId)))
        .filter(Boolean);
    } else {
      selectedProducts = allProducts
        .sort((a, b) => Number(a.id) - Number(b.id))
        .slice(0, context.productsToPublish);
    }

    if (selectedProducts.length < context.productsToPublish) {
      throw new Error(
        `Need at least ${context.productsToPublish} products, found ${selectedProducts.length}`
      );
    }

    const batchId = uuidv4();
    const now = new Date();

    const job = await JobRepository.create({
      user_id: context.userId,
      company_id: context.companyId,
      batch_id: batchId,
      job_type: 'publish',
      mode: 'publish',
      draft_name: `sim-ml-${batchId.slice(0, 8)}`,
      publication_step: 5,
      config: {
        simulate_marketplace: true,
        pool: clone(selectedPool),
        marketplaces: [{
          id: marketplace.id,
          marketplace_id: marketplace.id,
          credential_id: credential.id,
          name: marketplace.name,
          domain: marketplace.domain,
          country: credential.country,
          simulate_marketplace: true
        }],
        products: selectedProducts.map((product) => ({ id: product.id })),
        mode: 'publish',
        publication_step: 5,
        draft_name: `sim-ml-${batchId.slice(0, 8)}`,
        _generated_from: 'scripts/simulateMercadoLibrePublishingFlow.js'
      },
      total_products: selectedProducts.length
    });

    await LogRepository.create({
      user_id: context.userId,
      action: 'publishing_task.simulation_started',
      description: `Simulacion MercadoLibre iniciada para ${selectedProducts.length} productos`,
      ip_address: '127.0.0.1',
      user_agent: 'simulateMercadoLibrePublishingFlow.js',
      status: 'success',
      meta: {
        job_id: job.id,
        batch_id: batchId,
        company_id: context.companyId,
        user_id: context.userId,
        credential_id: credential.id,
        marketplace_id: marketplace.id
      }
    });

    await JobRepository.startProcessing(job.id);

    const productSummaries = [];
    let processed = 0;
    let successful = 0;
    let errorsCount = 0;

    for (const product of selectedProducts) {
      const productPayload = clone(product);
      const marketplacePayload = {
        id: marketplace.id,
        marketplace_id: marketplace.id,
        credential_id: credential.id,
        name: marketplace.name,
        domain: marketplace.domain,
        country: credential.country,
        simulate_marketplace: true,
        source: 'script'
      };

      const jobProduct = await JobProductRepository.create({
        job_id: job.id,
        product_id: product.id,
        marketplace_id: marketplace.id,
        credential_id: credential.id,
        product_payload: productPayload,
        marketplace_payload: marketplacePayload,
        status: 'pending'
      });

      const simulation = buildMercadoLibreSimulationResponse({
        productData: productPayload,
        marketplace,
        credential,
        warehouse: {
          id: selectedPool.primary_warehouse?.warehouse_id || warehouseIds[0],
          company_id: context.companyId,
          branch_id: selectedPool.primary_warehouse?.branch_id || null
        }
      });

      const task = await ProductPublishingTaskRepository.create({
        product_id: product.id,
        marketplace_id: marketplace.id,
        credential_id: credential.id,
        warehouse_id: selectedPool.primary_warehouse?.warehouse_id || warehouseIds[0],
        branch_id: selectedPool.primary_warehouse?.branch_id || null,
        company_id: context.companyId,
        user_id: context.userId,
        batch_id: batchId,
        date: now,
        status: 'published',
        draft_name: job.draft_name,
        publishing_mode: 'publish',
        payload: productPayload,
        external_id: simulation.external_id,
        external_url: simulation.external_url,
        published_at: now,
        api_response: simulation.data,
        attempt_count: 1
      });

      await JobProductRepository.update(jobProduct, {
        status: 'success',
        external_id: simulation.external_id,
        external_url: simulation.external_url,
        error_message: null,
        error_details: null,
        attempt_count: 1,
        last_attempt_at: now,
        task_id: task.id
      });

      await ProductMarketplaceLinkRepository.upsert({
        product_id: product.id,
        marketplace_id: marketplace.id,
        credential_id: credential.id,
        company_id: context.companyId,
        branch_id: selectedPool.primary_warehouse?.branch_id || null,
        status: 'published',
        external_id: simulation.external_id,
        external_url: simulation.external_url,
        last_synced_at: now
      });

      await LogRepository.create({
        user_id: context.userId,
        action: 'publishing_task.simulated_product_published',
        description: `Producto ${product.id} simulado como publicado en MercadoLibre`,
        ip_address: '127.0.0.1',
        user_agent: 'simulateMercadoLibrePublishingFlow.js',
        status: 'success',
        meta: {
          job_id: job.id,
          task_id: task.id,
          job_product_id: jobProduct.id,
          product_id: product.id,
          marketplace_id: marketplace.id,
          credential_id: credential.id,
          external_id: simulation.external_id
        }
      });

      processed += 1;
      successful += 1;

      await JobRepository.updateProgress(job.id, {
        processed,
        successful,
        errors_count: errorsCount
      });

      productSummaries.push({
        product_id: product.id,
        product_name: product.name,
        job_product_id: jobProduct.id,
        task_id: task.id,
        external_id: simulation.external_id,
        external_url: simulation.external_url
      });
    }

    await JobRepository.complete(job.id, {
      successful,
      errors_count: errorsCount,
      error_summary: null
    });

    await LogRepository.create({
      user_id: context.userId,
      action: 'publishing_task.simulation_completed',
      description: `Simulacion MercadoLibre completada: ${successful}/${selectedProducts.length} productos`,
      ip_address: '127.0.0.1',
      user_agent: 'simulateMercadoLibrePublishingFlow.js',
      status: 'success',
      meta: {
        job_id: job.id,
        batch_id: batchId,
        company_id: context.companyId,
        user_id: context.userId,
        credential_id: credential.id,
        marketplace_id: marketplace.id,
        successful,
        errors_count: errorsCount
      }
    });

    const summary = {
      job_id: job.id,
      batch_id: batchId,
      company_id: context.companyId,
      user_id: context.userId,
      credential_id: credential.id,
      marketplace_id: marketplace.id,
      marketplace_name: marketplace.name,
      pool_id: selectedPool.id || null,
      warehouse_ids: warehouseIds,
      products: productSummaries
    };

    return summary;
  } finally {
    if (closeDb) {
      await db.sequelize.close().catch(() => {});
    }
  }
}

if (require.main === module) {
  const options = parseArgs();
  runMercadoLibrePublishingSimulation(options)
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
    })
    .catch((error) => {
      logger.error(`[simulateMercadoLibrePublishingFlow] ${error.message}`);
      console.error(JSON.stringify({
        success: false,
        error: error.message
      }, null, 2));
      process.exitCode = 1;
    });
}

module.exports = {
  runMercadoLibrePublishingSimulation,
  parseArgs,
  parseIdList
};
