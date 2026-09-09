const test = require('node:test');
const assert = require('node:assert/strict');

const MarketplaceStockSyncService = require('../app/services/MarketplaceStockSyncService');
const {
  JobProductRepository,
  JobRepository,
  ProductMarketplaceLinkRepository,
  ProductPublishingTaskRepository,
  ProductVariantRepository,
  WarehouseProductVariantRepository
} = require('../app/repositories');

test('MarketplaceStockSyncService consolida el stock de un grupo de almacenes', async () => {
  const originalResolver = WarehouseProductVariantRepository.getTotalStockByVariantAndWarehouses;
  let receivedWarehouseIds = null;

  WarehouseProductVariantRepository.getTotalStockByVariantAndWarehouses = async (
    variantId,
    warehouseIds
  ) => {
    assert.equal(variantId, 42);
    receivedWarehouseIds = warehouseIds;
    return 7;
  };

  try {
    const stock = await MarketplaceStockSyncService._resolveStock({
      productId: 10,
      variantId: 42,
      warehouseId: 1,
      warehouseIds: [1, 2],
      stock: 1
    });

    assert.equal(stock, 7);
    assert.deepEqual(receivedWarehouseIds, [1, 2]);
  } finally {
    WarehouseProductVariantRepository.getTotalStockByVariantAndWarehouses = originalResolver;
  }
});

test('MarketplaceStockSyncService conserva el stock recibido para un solo almacén', async () => {
  const originalResolver = WarehouseProductVariantRepository.getTotalStockByVariantAndWarehouses;
  let called = false;

  WarehouseProductVariantRepository.getTotalStockByVariantAndWarehouses = async () => {
    called = true;
    return 99;
  };

  try {
    const stock = await MarketplaceStockSyncService._resolveStock({
      productId: 10,
      variantId: 42,
      warehouseId: 1,
      warehouseIds: [1],
      stock: 3
    });

    assert.equal(stock, 3);
    assert.equal(called, false);
  } finally {
    WarehouseProductVariantRepository.getTotalStockByVariantAndWarehouses = originalResolver;
  }
});

test('MarketplaceStockSyncService resuelve la credencial desde la publicación exacta', async () => {
  const originalFindByProduct = ProductMarketplaceLinkRepository.findByProduct;
  const originalFindByExternalId = ProductPublishingTaskRepository.findLatestPublishedByExternalIdAndContext;
  const originalFindByProductMarketplace = ProductPublishingTaskRepository.findLatestPublishedByProductMarketplaceAndCredential;
  const originalFindVariant = ProductVariantRepository.findById;
  const originalCreateJob = JobRepository.create;
  const originalCreateJobProduct = JobProductRepository.create;
  const createdProducts = [];
  let fallbackCalled = false;

  ProductMarketplaceLinkRepository.findByProduct = async () => ([{
    marketplace_id: 2,
    external_id: 'ML-123',
    credential_id: null,
    company_id: 10,
    branch_id: 3,
    published_payload: null
  }]);

  ProductPublishingTaskRepository.findLatestPublishedByExternalIdAndContext = async (context) => {
    assert.equal(context.externalId, 'ML-123');
    assert.equal(context.marketplaceId, 2);
    assert.equal(context.companyId, 10);
    assert.equal(context.branchId, 3);
    assert.equal(context.credentialId, null);
    return {
      credential_id: 77,
      external_id: 'ML-123',
      payload: { publishStock: 9 }
    };
  };

  ProductPublishingTaskRepository.findLatestPublishedByProductMarketplaceAndCredential = async () => {
    fallbackCalled = true;
    return null;
  };

  ProductVariantRepository.findById = async () => ({ sku: 'SKU-42' });
  JobRepository.create = async (data) => ({ id: 900, ...data });
  JobProductRepository.create = async (data) => {
    createdProducts.push(data);
    return data;
  };

  try {
    const job = await MarketplaceStockSyncService.enqueueStockSync({
      productId: 10,
      variantId: 42,
      warehouseId: 1,
      warehouseIds: [1],
      stock: 4,
      sourceMarketplaceId: 1,
      companyId: 10,
      branchId: 3
    });

    assert.equal(job.id, 900);
    assert.equal(fallbackCalled, false);
    assert.equal(createdProducts.length, 1);
    assert.equal(createdProducts[0].credential_id, 77);
    assert.equal(createdProducts[0].external_id, 'ML-123');
    assert.equal(createdProducts[0].product_payload.stock, 4);
  } finally {
    ProductMarketplaceLinkRepository.findByProduct = originalFindByProduct;
    ProductPublishingTaskRepository.findLatestPublishedByExternalIdAndContext = originalFindByExternalId;
    ProductPublishingTaskRepository.findLatestPublishedByProductMarketplaceAndCredential = originalFindByProductMarketplace;
    ProductVariantRepository.findById = originalFindVariant;
    JobRepository.create = originalCreateJob;
    JobProductRepository.create = originalCreateJobProduct;
  }
});
