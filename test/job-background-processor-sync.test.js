const test = require('node:test');
const assert = require('node:assert/strict');

const JobBackgroundProcessor = require('../app/services/JobBackgroundProcessor');
const MarketplaceStockSyncService = require('../app/services/MarketplaceStockSyncService');
const PublicationAuditService = require('../app/services/PublicationAuditService');
const JobController = require('../app/controllers/JobController');
const { Job } = require('../app/models');
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

test('JobBackgroundProcessor cierra un job pending que nunca fue tomado por el worker', async () => {
  const originalFindAll = JobRepository.findAll;
  const originalFail = JobRepository.fail;
  const originalRecordProcessSystemEvent = PublicationAuditService.recordProcessSystemEvent;
  const audits = [];
  const staleJob = {
    id: 265,
    status: 'pending',
    createdAt: new Date(Date.now() - (61 * 60 * 1000))
  };

  JobRepository.findAll = async () => [staleJob];
  JobRepository.fail = async (_jobId, reason, details) => ({
    ...staleJob,
    status: 'failed',
    error_summary: { message: reason, details }
  });
  PublicationAuditService.recordProcessSystemEvent = async (_job, action, data) => {
    audits.push({ action, data });
  };

  try {
    await JobBackgroundProcessor._processPendingJobs();

    assert.equal(audits.length, 1);
    assert.equal(audits[0].action, 'process.stopped');
    assert.equal(audits[0].data.metadata.reason, 'pending_timeout');
  } finally {
    JobRepository.findAll = originalFindAll;
    JobRepository.fail = originalFail;
    PublicationAuditService.recordProcessSystemEvent = originalRecordProcessSystemEvent;
  }
});

test('un job failed con productos pendientes no vuelve a aparecer como activo', async () => {
  const originalFindAll = JobRepository.findAll;
  const originalGetStatsByJob = JobProductRepository.getStatsByJob;
  const originalGetStatsByJobAndMarketplace = JobProductRepository.getStatsByJobAndMarketplace;
  const originalFindAllErrorsByJob = JobProductRepository.findAllErrorsByJob;
  let payload;

  JobRepository.findAll = async () => [{
    id: 265,
    user_id: 40,
    company_id: 19,
    batch_id: 'e52eee50-9eb7-4252-9459-ce6fe319ce56',
    job_type: 'publish',
    status: 'failed',
    createdAt: '2026-10-06T19:02:55.000Z'
  }];
  JobProductRepository.getStatsByJob = async () => ({
    total: 1,
    processed: 0,
    successful: 0,
    errors: 0,
    pending: 1,
    processing: 0,
    retrying: 0
  });
  JobProductRepository.getStatsByJobAndMarketplace = async () => [];
  JobProductRepository.findAllErrorsByJob = async () => [];

  try {
    await JobController.getActiveJobs(
      { body: { company_id: 19, user_id: 40 } },
      { json: (value) => { payload = value; } }
    );

    assert.deepEqual(payload.data.jobs, []);
  } finally {
    JobRepository.findAll = originalFindAll;
    JobProductRepository.getStatsByJob = originalGetStatsByJob;
    JobProductRepository.getStatsByJobAndMarketplace = originalGetStatsByJobAndMarketplace;
    JobProductRepository.findAllErrorsByJob = originalFindAllErrorsByJob;
  }
});

test('un job processing conserva la sincronización activa por marketplace', async () => {
  const originalFindAll = JobRepository.findAll;
  const originalGetStatsByJob = JobProductRepository.getStatsByJob;
  const originalGetStatsByJobAndMarketplace = JobProductRepository.getStatsByJobAndMarketplace;
  const originalFindAllErrorsByJob = JobProductRepository.findAllErrorsByJob;
  let payload;

  JobRepository.findAll = async () => [{
    id: 266,
    user_id: 40,
    company_id: 19,
    batch_id: 'active-batch-266',
    job_type: 'publish',
    status: 'processing',
    createdAt: new Date().toISOString()
  }];
  JobProductRepository.getStatsByJob = async () => ({
    total: 2,
    processed: 0,
    successful: 0,
    errors: 0,
    pending: 1,
    processing: 1,
    retrying: 0
  });
  JobProductRepository.getStatsByJobAndMarketplace = async () => [
    {
      marketplace_name: 'MercadoLibre Chile',
      credential_id: 55,
      total: 1,
      published: 0,
      failed: 0,
      pending: 0,
      processing: 1,
      retrying: 0,
      percentage: 0
    },
    {
      marketplace_name: 'Falabella',
      credential_id: 56,
      total: 1,
      published: 0,
      failed: 0,
      pending: 1,
      processing: 0,
      retrying: 0,
      percentage: 0
    }
  ];
  JobProductRepository.findAllErrorsByJob = async () => [];

  try {
    await JobController.getActiveJobs(
      { body: { company_id: 19, user_id: 40 } },
      { json: (value) => { payload = value; } }
    );

    assert.deepEqual(
      payload.data.jobs.map(({ marketplace_name, status, job_status }) => ({ marketplace_name, status, job_status })),
      [
        { marketplace_name: 'MercadoLibre Chile', status: 'processing', job_status: 'processing' },
        { marketplace_name: 'Falabella', status: 'processing', job_status: 'processing' }
      ]
    );
  } finally {
    JobRepository.findAll = originalFindAll;
    JobProductRepository.getStatsByJob = originalGetStatsByJob;
    JobProductRepository.getStatsByJobAndMarketplace = originalGetStatsByJobAndMarketplace;
    JobProductRepository.findAllErrorsByJob = originalFindAllErrorsByJob;
  }
});

test('la reconciliación de publicaciones no reabre un job failed', async () => {
  const originalFindByPk = Job.findByPk;
  const originalGetStatsByJob = JobProductRepository.getStatsByJob;
  const originalUpdate = JobRepository.update;
  const updates = [];
  const job = {
    id: 265,
    status: 'failed',
    total_products: 1,
    get() {
      return this;
    }
  };

  Job.findByPk = async () => job;
  JobProductRepository.getStatsByJob = async () => ({
    total: 1,
    processed: 0,
    successful: 0,
    errors: 0,
    pending: 1,
    processing: 0,
    retrying: 0
  });
  JobRepository.update = async (_job, data) => {
    updates.push(data);
    return job;
  };

  try {
    await JobRepository.recalculateProgress(265);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].status, 'failed');
  } finally {
    Job.findByPk = originalFindByPk;
    JobProductRepository.getStatsByJob = originalGetStatsByJob;
    JobRepository.update = originalUpdate;
  }
});

test('la reconciliación puede cerrar un job failed cuando la publicación terminó', async () => {
  const originalFindByPk = Job.findByPk;
  const originalGetStatsByJob = JobProductRepository.getStatsByJob;
  const originalUpdate = JobRepository.update;
  const updates = [];
  const job = {
    id: 267,
    status: 'failed',
    total_products: 1,
    get() {
      return this;
    }
  };

  Job.findByPk = async () => job;
  JobProductRepository.getStatsByJob = async () => ({
    total: 1,
    processed: 1,
    successful: 1,
    errors: 0,
    pending: 0,
    processing: 0,
    retrying: 0
  });
  JobRepository.update = async (_job, data) => {
    updates.push(data);
    return job;
  };

  try {
    await JobRepository.recalculateProgress(267);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].status, 'completed');
  } finally {
    Job.findByPk = originalFindByPk;
    JobProductRepository.getStatsByJob = originalGetStatsByJob;
    JobRepository.update = originalUpdate;
  }
});
