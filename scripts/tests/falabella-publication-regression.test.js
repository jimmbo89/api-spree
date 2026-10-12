const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const models = require('../../app/models');
const repos = require('../../app/repositories');
const controller = require('../../app/controllers/MarketplaceWebhookController');
const publicationController = require('../../app/controllers/ProductPublishingTaskController');
const PublishingService = require('../../app/services/PublishingService');
const worker = require('../../app/services/JobBackgroundProcessor');
const reconciliation = require('../../app/services/FalabellaOrderReconciliationService');
const Adapter = require('../../app/services/adapters/FalabellaAdapter');
const { humanizeFalabellaMessage } = require('../../app/utils/marketplaceErrorHumanizer');
const tasks = repos.ProductPublishingTaskRepository;

test.beforeEach(t => {
  const query = t.mock.method(models.sequelize, 'query', async () => { throw new Error('BD deshabilitada en estas pruebas'); });
  const get = t.mock.method(axios, 'get', async () => { throw new Error('Red deshabilitada en estas pruebas'); });
  t.after(() => {
    assert.equal(query.mock.callCount(), 0, 'No deben ejecutarse consultas reales');
    assert.equal(get.mock.callCount(), 0, 'No deben ejecutarse solicitudes reales');
  });
});

function taskRecord(overrides = {}) {
  return {
    id: 422, product_id: 60, marketplace_id: 4, credential_id: 34,
    company_id: 17, branch_id: 1, batch_id: 'batch-test', external_id: 'TEST-SKU',
    status: 'processing', payload: { sku: 'TEST-SKU', images: ['https://example.com/image.jpg'] },
    error_details: { action: 'ProductCreate', feed_id: 'PRODUCT-FEED' },
    async update(data) { Object.assign(this, data); return this; },
    ...overrides
  };
}

function mockTaskStorage(t, row) {
  // Serializa transacciones como el bloqueo de fila usado en producción.
  let queue = Promise.resolve();
  t.mock.method(models.sequelize, 'transaction', callback => {
    const current = queue.then(() => callback({ LOCK: { UPDATE: 'UPDATE' } }));
    queue = current.catch(() => {});
    return current;
  });
  t.mock.method(models.ProductPublishingTask, 'findByPk', async () => row);
}

const baseStatus = { found: true, status: 'active', qc_status: 'approved', is_published: true, has_image: true, product_errors: [] };
for (const [name, changes, expectedTask, expectedLink] of [
  ['aprobado y publicado', {}, 'published', 'active'],
  ['aprobado pero aún no publicado', { is_published: false }, 'pending', 'pending'],
  ['en revisión aunque IsPublished sea 1', { qc_status: 'pending' }, 'pending', 'pending'],
  ['rechazo real sin publicación', { qc_status: 'rejected', is_published: false }, 'failed', 'rejected'],
  ['rechazo de QC aunque haya imágenes pendientes', { qc_status: 'rejected', is_published: false, has_image: false, images_pending: true }, 'failed', 'rejected'],
  ['inactivo aunque haya imágenes pendientes', { status: 'inactive', images_pending: true }, 'failed', 'inactive']
]) {
  test(`Falabella: tarea y link coinciden para ${name}`, () => {
    const status = { ...baseStatus, ...changes };
    assert.equal(controller._determineFalabellaTaskLifecycle(status, { hasImage: status.has_image }).status, expectedTask);
    assert.equal(controller._resolveFalabellaMarketplaceDisplayStatus(status), expectedLink);
    assert.notEqual(controller._resolveFalabellaJobProductStatus(expectedTask), 'pending');
  });
}

test('una marca inválida no se oculta por imágenes pendientes; QC tiene mensaje humano', () => {
  const result = controller._determineFalabellaTaskLifecycle({ ...baseStatus, images_pending: true }, {
    realErrors: [{ field: 'Brand', message: 'You have chosen an invalid brand: "Acrimet"' }]
  });
  assert.equal(result.status, 'failed');
  assert.match(humanizeFalabellaMessage(result.errorMessage), /soporte técnico de Falabella/);
  const message = humanizeFalabellaMessage('qc_status: rejected');
  assert.match(message, /revisión de calidad/);
  assert.doesNotMatch(message, /qc_status|webhook|rejected/);
});

test('Falabella no se muestra activa con URL o ShopSku si IsPublished es 0', () => {
  const state = {
    found: true,
    status: 'active',
    qc_status: 'approved',
    is_published: false,
    url: 'https://www.falabella.com/falabella-cl/product/123',
    shop_sku: '123',
    has_image: true,
    product_errors: []
  };

  assert.equal(publicationController._resolveFalabellaMarketplaceDisplayStatus(state), 'not_published');
  assert.equal(publicationController._resolveFalabellaMarketplaceDisplayStatus({ ...state, is_published: true }), 'active');
});

for (const status of ['processing', 'published', 'failed']) {
  test(`la respuesta del envío no sobrescribe la tarea ${status} ni sus imágenes`, async t => {
    const row = taskRecord({ status, error_message: 'Mensaje confirmado', api_response: { confirmed: true } });
    row.error_details.image_sync = { success: true, request_id: 'IMAGE-FEED' };
    mockTaskStorage(t, row);
    await tasks.recordFalabellaSubmission({ id: row.id }, {
      feed_id: 'PRODUCT-FEED', image_sync: null, action: 'ProductCreate'
    });
    assert.equal(row.status, status);
    assert.equal(row.error_message, 'Mensaje confirmado');
    assert.equal(row.api_response.confirmed, true);
    assert.equal(row.error_details.image_sync.request_id, 'IMAGE-FEED');
  });
}

test('Falabella no propaga el resultado a intentos históricos; otros marketplaces conservan su ruta', async t => {
  const fanout = t.mock.method(tasks, 'fanoutPublicationState', async () => 0);
  await tasks.updateTask(taskRecord(), { status: 'failed', error_details: { error_code: 'feed_failed' } });
  assert.equal(fanout.mock.callCount(), 0);
  await tasks.updateTask(taskRecord({ error_details: {}, marketplace_id: 3 }), { status: 'published' });
  assert.equal(fanout.mock.callCount(), 1);
});

test('el respaldo directo sube imágenes y el webhook concurrente no las duplica', async t => {
  const row = taskRecord();
  mockTaskStorage(t, row);
  let finishUpload;
  let startUpload;
  const started = new Promise(resolve => { startUpload = resolve; });
  const adapter = { uploadProductImages: t.mock.fn(async () => {
    startUpload();
    await new Promise(resolve => { finishUpload = resolve; });
    return { success: true, request_id: 'IMAGE-FEED', images_count: 1 };
  }) };
  const options = PublishingService.falabellaPublishOptions(row, adapter);
  const submission = options.uploadImages(row.external_id, row.payload.images);
  await started;
  const webhook = await controller._acquireFalabellaImageSyncLock(row, 'webhook');
  assert.equal(webhook.acquired, false);
  assert.equal(webhook.inProgress, true);
  finishUpload();
  await submission;
  const repeated = await options.uploadImages(row.external_id, row.payload.images);
  assert.equal(repeated.success, true);
  assert.equal(repeated.request_id, 'IMAGE-FEED');
  assert.equal(adapter.uploadProductImages.mock.callCount(), 1);
});

test('si el webhook sube imágenes primero, el respaldo respeta el bloqueo', async t => {
  const row = taskRecord();
  mockTaskStorage(t, row);
  const adapter = { uploadProductImages: t.mock.fn() };
  const lock = await controller._acquireFalabellaImageSyncLock(row, 'webhook');
  assert.equal(lock.acquired, true);
  const options = PublishingService.falabellaPublishOptions(row, adapter);
  assert.equal((await options.uploadImages(row.external_id, row.payload.images)).pending, true);
  // Un FeedID que llegó durante la carga no se pierde al finalizarla.
  await tasks.recordFalabellaSubmission(row, { feed_id: 'NEW-FEED' });
  await controller._finalizeFalabellaImageSyncState(row, lock.taskDetails, { success: true, request_id: 'IMAGE-FEED' }, 'webhook');
  assert.equal(row.error_details.feed_id, 'NEW-FEED');
  assert.equal((await options.uploadImages(row.external_id, row.payload.images)).success, true);
  assert.equal(adapter.uploadProductImages.mock.callCount(), 0);
});

test('una carga fallida libera el bloqueo para que el respaldo pueda recuperarla', async t => {
  const row = taskRecord();
  mockTaskStorage(t, row);
  let attempts = 0;
  const adapter = { uploadProductImages: async () => {
    if (++attempts === 1) throw new Error('simulated failure');
    return { success: true, request_id: 'RETRY-IMAGE' };
  } };
  const options = PublishingService.falabellaPublishOptions(row, adapter);
  assert.equal((await options.uploadImages(row.external_id, row.payload.images)).success, false);
  assert.equal(row.error_details.image_sync.in_progress, false);
  assert.equal((await options.uploadImages(row.external_id, row.payload.images)).success, true);
  assert.equal(attempts, 2);
});

for (const existing of [false, true]) {
  test(`el adapter conserva carga de imágenes para producto ${existing ? 'en catálogo' : 'nuevo'}`, async t => {
    const credential = { seller_email: 'test@example.com', api_key: 'test-only', seller_id: 'TEST' };
    const adapter = new Adapter(4, 17, 1, 30, credential);
    adapter.credential = credential;
    adapter.ensureValidCredentials = async () => ({ valid: true });
    adapter.hydrateAttributesForPublish = async payload => payload;
    adapter.validateProduct = () => ({ valid: true });
    adapter.buildProductXml = () => '<Request />';
    adapter.findExistingProductBySellerSku = async () => existing ? { sku: 'TEST-SKU' } : null;
    adapter.fetchProductStatus = async () => ({ found: true, has_image: false, status: 'active' });
    const action = existing ? 'ProductUpdate' : 'ProductCreate';
    adapter.pollFeedStatus = async () => ({ timedOut: false, feed: { Action: action, Status: 'Finished', ProcessedRecords: '1', FailedRecords: '0' } });
    t.mock.method(axios, 'post', async url => {
      assert.ok(url.includes(`Action=${action}`));
      return { data: '<SuccessResponse><RequestId>TEST-FEED</RequestId></SuccessResponse>' };
    });
    const calls = [];
    const result = await adapter.publish({ sku: 'TEST-SKU', images: ['https://example.com/image.jpg'] }, {
      onFeedAccepted: async feed => { calls.push('accepted'); assert.equal(feed.action, action); },
      uploadImages: async () => { calls.push('images'); return { success: true, request_id: 'IMAGE-FEED' }; }
    });
    assert.equal(result.success, true);
    assert.deepEqual(calls, ['accepted', 'images']);
    assert.doesNotMatch(result.message, /webhook|FeedID|FeedStatus|RequestId/);
  });
}

for (const taskStatus of ['pending', 'published', 'failed']) {
  test(`el worker respeta la confirmación ${taskStatus} que llegó durante el envío`, async t => {
    const row = taskRecord({ status: taskStatus });
    const job = { id: 264, batch_id: row.batch_id, company_id: 17, user_id: 30,
      config: { pool: { primary_warehouse: { warehouse_id: 1 }, company_id: 17, user_id: 30 } } };
    const jobProduct = { id: 1, product_id: 60, credential_id: 34, marketplace_id: 4,
      product_payload: { id: 60 }, marketplace_payload: { domain: 'falabella.cl' } };
    t.mock.method(repos.JobRepository, 'findById', async () => job);
    t.mock.method(repos.JobRepository, 'findByBatchId', async () => job);
    t.mock.method(repos.JobRepository, 'recalculateProgress', async () => {});
    t.mock.method(tasks, 'findById', async () => row);
    t.mock.method(repos.JobProductRepository, 'findByProductAndMarketplace', async () => jobProduct);
    t.mock.method(repos.JobProductRepository, 'update', async (_task, data) => Object.assign(jobProduct, data));
    const publish = t.mock.method(PublishingService, 'publishProduct', async () => ({ success: true, task_id: row.id }));
    await worker._processProduct(jobProduct, job.id);
    assert.equal(jobProduct.status, controller._resolveFalabellaJobProductStatus(taskStatus));
    assert.equal(jobProduct.task_id, row.id);
    if (taskStatus === 'pending') {
      t.mock.method(repos.JobProductRepository, 'findAllByJob', async (_id, options) => jobProduct.status === options.status ? [jobProduct] : []);
      t.mock.method(worker, '_checkJobCompletion', async () => {});
      await controller._recalculateFalabellaJobProgressFromTask(row);
      await worker._processJob(job);
      assert.equal(publish.mock.callCount(), 1);
    }
  });
}

test('imágenes del payload no confirman imágenes recibidas por Falabella', async t => {
  const row = taskRecord();
  row.error_details.image_sync = { success: false, in_progress: true, request_id: 'IMAGE-FEED' };
  const link = { ...row, published_payload: row.payload, async update(data) { Object.assign(this, data); } };
  t.mock.method(tasks, 'findById', async () => row);
  t.mock.method(tasks, 'findLatestByExternalIdAndContext', async () => row);
  t.mock.method(tasks, 'updateTask', async (_task, data) => Object.assign(row, data));
  t.mock.method(repos.ProductMarketplaceLinkRepository, 'findByMarketplaceExternalId', async () => link);
  t.mock.method(repos.ProductMarketplaceLinkRepository, 'findByExternalIdAndCredential', async () => link);
  t.mock.method(repos.JobRepository, 'findByBatchId', async () => null);
  const result = await controller._persistFalabellaProductState({
    credential: { id: 34, marketplace_id: 4 }, sellerSku: row.external_id, task: row,
    product: { SellerSku: row.external_id, Status: 'active', QCStatus: 'approved', IsPublished: '0', MainImage: '' }, payload: {}
  });
  assert.equal(result.snapshot.has_image, false);
  assert.equal(result.snapshot.images_pending, true);
  assert.equal(row.status, 'processing');
  assert.equal(link.status, 'processing');
  assert.equal(row.error_details.image_sync.request_id, 'IMAGE-FEED');
});

test('un feed de un intento anterior no altera el nuevo intento del mismo SKU', async t => {
  const old = taskRecord({ id: 421 });
  t.mock.method(tasks, 'findById', async () => old);
  t.mock.method(tasks, 'findLatestByExternalIdAndContext', async () => taskRecord());
  const update = t.mock.method(tasks, 'updateTask', async () => { throw new Error('No debe actualizar'); });
  await controller._processFeedResultForTask(old, {}, { Status: 'Finished', FailedRecords: '1' }, 'OLD-FEED', 'onFeedCompleted');
  assert.equal(update.mock.callCount(), 0);
});

for (const published of [false, true]) {
  test(`la conciliación respeta IsPublished=${Number(published)} y actualiza el proceso`, async t => {
    const row = taskRecord({ status: 'pending', createdAt: new Date(Date.now() - 86400000),
      credential: { id: 34, seller_email: 'test@example.com', api_key: 'test-only' } });
    const link = { ...row, published_payload: {}, async update(data) { Object.assign(this, data); } };
    t.mock.method(tasks, 'findById', async () => row);
    t.mock.method(tasks, 'updateTask', async (_task, data) => Object.assign(row, data));
    t.mock.method(repos.ProductMarketplaceLinkRepository, 'findByProductAndMarketplace', async () => link);
    t.mock.method(Adapter.prototype, 'ensureValidCredentials', async () => ({ valid: true }));
    t.mock.method(Adapter.prototype, 'fetchProductStatus', async () => ({ ...baseStatus, is_published: published }));
    const sync = t.mock.method(controller, '_recalculateFalabellaJobProgressFromTask', async task => {
      assert.equal(task.status, published ? 'published' : 'pending');
    });
    await reconciliation._reconcileFalabellaPublicationTask(row, 4);
    assert.equal(row.status, published ? 'published' : 'pending');
    assert.equal(link.status, published ? 'active' : 'pending');
    assert.equal(sync.mock.callCount(), 1);
  });
}

test('la advertencia de autorización de marca es humana y conserva el original técnico', () => {
  const adapter = new Adapter(4, 17, 1, 30, {});
  const original = 'Selling this brand requires an approval. Please get in contact with Falabella';
  const result = adapter.buildFeedDrivenResult({
    transformedProduct: { sku: 'TEST-SKU' }, requestId: 'TEST-FEED', timedOut: false,
    feed: { Status: 'Finished', FailedRecords: '0', FeedWarnings: [{ Message: original }] }
  });
  assert.match(result.warning_message, /soporte técnico/);
  assert.doesNotMatch(result.warning_message, /Selling|requires|webhook|FeedID/);
  assert.equal(result.warnings[0].original_message, original);
});

test('flujo completo: imágenes, revisión, activo y proceso cerrado sin reabrirlo por avisos tardíos', async t => {
  const row = taskRecord();
  row.external_id = row.payload.sku = 'ACR-860-CRISTAL';
  row.payload.brand = 'JUST HOME';
  row.error_details.image_sync = { success: true, request_id: 'IMAGE-FEED' };
  const link = { published_payload: row.payload, async update(data) { Object.assign(this, data); } };
  const jobProduct = { id: 1, status: 'processing' };
  const job = { id: 264, total_products: 1, status: 'processing', get() { return { ...this }; } };
  t.mock.method(tasks, 'findById', async () => row);
  t.mock.method(tasks, 'findLatestByExternalIdAndContext', async () => row);
  t.mock.method(repos.ProductMarketplaceLinkRepository, 'findByExternalIdAndCredential', async () => link);
  t.mock.method(repos.JobRepository, 'findByBatchId', async () => job);
  t.mock.method(models.Job, 'findByPk', async () => job);
  t.mock.method(repos.JobRepository, 'update', async (_job, data) => Object.assign(job, data));
  t.mock.method(repos.JobProductRepository, 'findByProductAndMarketplace', async () => jobProduct);
  t.mock.method(repos.JobProductRepository, 'update', async (_row, data) => Object.assign(jobProduct, data));
  t.mock.method(repos.JobProductRepository, 'getStatsByJob', async () => ({
    processed: Number(['success', 'error'].includes(jobProduct.status)),
    successful: Number(jobProduct.status === 'success'), errors: Number(jobProduct.status === 'error'),
    processing: Number(jobProduct.status === 'processing'), pending: 0
  }));
  for (const [qc, published, image, expectedTask, expectedLink, expectedJob] of [
    // Log 23/09: líneas 11415/11417 (sin imágenes, QC rejected); 11826 (approved, IsPublished=0).
    ['rejected', null, '', 'failed', 'rejected', 'completed_with_errors'],
    ['approved', '0', 'https://example.com/image.jpg', 'pending', 'pending', 'processing'],
    // Caso contractual de GetProducts: el último evento del log NO expone IsPublished.
    // https://developers.falabella.com/docs/products/getproducts
    ['approved', '1', 'https://example.com/image.jpg', 'published', 'active', 'completed']
  ]) {
    await controller._persistFalabellaProductState({
      credential: { id: 34, marketplace_id: 4 }, sellerSku: row.external_id, task: row, payload: {},
      product: { SellerSku: row.external_id, Status: 'active', QCStatus: qc, IsPublished: published, MainImage: image }
    });
    assert.equal(row.status, expectedTask);
    assert.equal(link.status, expectedLink);
    assert.equal(job.status, expectedJob);
    assert.equal(job.percentage, ['completed', 'completed_with_errors'].includes(expectedJob) ? 100 : 0);
  }
  await controller._processFeedResultForTask(row, {}, { Status: 'Processing' }, 'IMAGE-FEED', 'onFeedCreated');
  assert.equal(row.status, 'published');
  assert.equal(link.status, 'active');
  assert.equal(job.status, 'completed');
  assert.equal(row.error_details.feed_id, 'PRODUCT-FEED');
});
