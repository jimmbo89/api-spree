const test = require('node:test');
const assert = require('node:assert/strict');

const JobBackgroundProcessor = require('../app/services/JobBackgroundProcessor');
const MarketplaceStockSyncService = require('../app/services/MarketplaceStockSyncService');
const PublicationAuditService = require('../app/services/PublicationAuditService');
const {
  JobRepository,
  JobProductRepository
} = require('../app/repositories');

test('JobBackgroundProcessor procesa sincronización de stock sin pool de publicación y audita el destino', async () => {
  const originalFindById = JobRepository.findById;
  const originalUpdate = JobProductRepository.update;
  const originalProcessJobProduct = MarketplaceStockSyncService.processJobProduct;
  const originalRecordProcessSystemEvent = PublicationAuditService.recordProcessSystemEvent;
  const updates = [];
  const audits = [];

  JobRepository.findById = async () => ({
    id: 81,
    batch_id: 'sync-batch-81',
    job_type: 'sync',
    company_id: 10,
    user_id: null,
    config: {
      warehouse_id: 4,
      warehouse_ids: [4, 9],
      variant_id: 42,
      company_id: 10
    }
  });

  JobProductRepository.update = async (_jobProduct, data) => {
    updates.push(data);
  };

  MarketplaceStockSyncService.processJobProduct = async (jobProduct, job) => {
    assert.equal(jobProduct.credential_id, 17);
    assert.deepEqual(job.config.warehouse_ids, [4, 9]);
    assert.equal(job.config.job_id, 81);
    return { success: true };
  };

  PublicationAuditService.recordProcessSystemEvent = async (job, action, data) => {
    audits.push({ job, action, data });
  };

  try {
    const result = await JobBackgroundProcessor._processProduct({
      id: 901,
      product_id: 100,
      marketplace_id: 2,
      credential_id: 17,
      external_id: 'ML-123',
      product_payload: {
        variant_id: 42,
        warehouse_id: 4,
        warehouse_ids: [4, 9],
        stock: 6
      },
      marketplace_payload: {
        external_id: 'ML-123'
      }
    }, 81);

    assert.deepEqual(result, { success: true });
    assert.equal(updates[0].status, 'processing');
    assert.equal(updates[1].status, 'success');
    assert.equal(audits.length, 1);
    assert.equal(audits[0].action, 'stock_sync.succeeded');
    assert.equal(audits[0].data.metadata.credential_id, 17);
    assert.equal(audits[0].data.metadata.external_id, 'ML-123');
    assert.deepEqual(audits[0].data.metadata.warehouse_ids, [4, 9]);
  } finally {
    JobRepository.findById = originalFindById;
    JobProductRepository.update = originalUpdate;
    MarketplaceStockSyncService.processJobProduct = originalProcessJobProduct;
    PublicationAuditService.recordProcessSystemEvent = originalRecordProcessSystemEvent;
  }
});
