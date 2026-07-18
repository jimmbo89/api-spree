// services/FalabellaOrderReconciliationService.js
const logger = require('../../config/logger');
const {
  MarketplaceCredentialRepository,
  MarketplaceWebhookEventRepository,
  MarketplaceRepository,
  ProductPublishingTaskRepository,
  ProductMarketplaceLinkRepository
} = require('../repositories');
const MarketplaceWebhookController = require('../controllers/MarketplaceWebhookController');
const FalabellaAdapter = require('./adapters/FalabellaAdapter');

const CONFIG = {
  ORDER_RECONCILE_ENABLED: String(process.env.FB_RECONCILE_ENABLED || 'false').toLowerCase() === 'true',
  PUBLICATION_RECONCILE_ENABLED: String(process.env.FB_PUBLICATION_RECONCILE_ENABLED || 'false').toLowerCase() === 'true',
  INTERVAL_MINUTES: parseInt(process.env.FB_RECONCILE_INTERVAL_MINUTES || '60', 10),
  LOOKBACK_MINUTES: parseInt(process.env.FB_RECONCILE_LOOKBACK_MINUTES || '180', 10),
  LIMIT: parseInt(process.env.FB_RECONCILE_LIMIT || '100', 10),
  MAX_PAGES: parseInt(process.env.FB_RECONCILE_MAX_PAGES || '5', 10),
  STATUSES: (process.env.FB_RECONCILE_STATUSES || 'pending')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  PUBLICATION_LOOKBACK_MINUTES: parseInt(process.env.FB_PUBLICATION_RECONCILE_LOOKBACK_MINUTES || '4320', 10),
  PUBLICATION_MIN_AGE_MINUTES: parseInt(process.env.FB_PUBLICATION_RECONCILE_MIN_AGE_MINUTES || '20', 10),
  PUBLICATION_NOT_FOUND_TIMEOUT_MINUTES: parseInt(process.env.FB_PUBLICATION_RECONCILE_NOT_FOUND_TIMEOUT_MINUTES || '720', 10),
  PUBLICATION_MAX_NOT_FOUND_ATTEMPTS: parseInt(process.env.FB_PUBLICATION_RECONCILE_MAX_NOT_FOUND_ATTEMPTS || '4', 10),
  PUBLICATION_STATUS_ATTEMPTS: parseInt(process.env.FB_PUBLICATION_RECONCILE_STATUS_ATTEMPTS || '2', 10),
  PUBLICATION_STATUS_DELAY_MS: parseInt(process.env.FB_PUBLICATION_RECONCILE_STATUS_DELAY_MS || '1500', 10),
  PUBLICATION_LIMIT: parseInt(process.env.FB_PUBLICATION_RECONCILE_LIMIT || '50', 10),
  PUBLICATION_STATUSES: (process.env.FB_PUBLICATION_RECONCILE_STATUSES || 'processing')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
};

let intervalHandle = null;
let running = false;
let cachedFalabellaMarketplaceId = null;

function formatTimestampISO(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const tz = '+0000';
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}${tz}`
  );
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function parseMaybeJSON(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    return null;
  }
}

function normalizeTaskDetails(details) {
  if (!details) return {};
  if (typeof details === 'object') return details;
  const parsed = parseMaybeJSON(details);
  return parsed || {};
}

function getTaskAgeMinutes(task, now = new Date()) {
  const referenceDate = new Date(task?.createdAt || task?.published_at || task?.updatedAt || now);
  if (Number.isNaN(referenceDate.getTime())) {
    return 0;
  }

  return Math.max(0, Math.floor((now.getTime() - referenceDate.getTime()) / 60000));
}

function resolveFalabellaSellerSku(task, link) {
  const candidates = [
    link?.external_id,
    task?.external_id,
    task?.payload?.sku,
    task?.payload?.SellerSku,
    task?.payload?.seller_sku,
    task?.api_response?.sku,
    task?.api_response?.SellerSku,
    task?.api_response?.seller_sku,
    task?.product?.sku
  ];

  for (const candidate of candidates) {
    const normalized = String(candidate || '').trim();
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function buildPublicationReconcileSummary(productStatus) {
  if (!productStatus) {
    return { found: false, status: null };
  }

  return {
    found: productStatus.found === true,
    status: productStatus.status || null,
    qc_status: productStatus.qc_status || null,
    is_published: productStatus.is_published ?? null,
    has_image: productStatus.has_image ?? null,
    url: productStatus.url || null,
    product_errors: Array.isArray(productStatus.product_errors) ? productStatus.product_errors.length : 0
  };
}

function determinePublicationLifecycle(productStatus) {
  const status = normalizeText(productStatus?.status);
  const qcStatus = normalizeText(productStatus?.qc_status);
  const productErrors = Array.isArray(productStatus?.product_errors) ? productStatus.product_errors : [];

  if (!productStatus || productStatus.found === false) {
    return { status: 'processing', isFinal: false, errorMessage: null };
  }

  if (productErrors.length > 0) {
    return {
      status: 'failed',
      isFinal: true,
      errorMessage: productErrors.map((err) => {
        const field = err?.field ? `${err.field}: ` : '';
        return `${field}${err?.message || 'unknown error'}`;
      }).join(' | ')
    };
  }

  if (qcStatus === 'rejected' || ['inactive', 'deleted'].includes(status)) {
    return {
      status: 'failed',
      isFinal: true,
      errorMessage: qcStatus === 'rejected'
        ? `qc_status: ${qcStatus}`
        : `status: ${status || 'unknown'}`
    };
  }

  if (['active', 'live'].includes(status)) {
    return { status: 'published', isFinal: true, errorMessage: null };
  }

  return { status: 'processing', isFinal: false, errorMessage: null };
}

async function fetchFalabellaPublicationStatusWithRetry(adapter, sellerSku, options = {}) {
  const attempts = Math.max(1, Number(options.attempts || 2));
  const delayMs = Math.max(0, Number(options.delayMs || 1500));
  const logPrefix = options.logPrefix || '[FB Publication Reconcile]';

  let lastStatus = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    lastStatus = await adapter.fetchProductStatus(sellerSku);
    const summary = buildPublicationReconcileSummary(lastStatus);

    logger.info(`${logPrefix} Consulta ${attempt}/${attempts} para SKU ${sellerSku}: ${JSON.stringify(summary)}`);

    const isResolved =
      summary.found &&
      (
        summary.status ||
        summary.qc_status ||
        summary.is_published !== null ||
        summary.has_image !== null ||
        summary.url
      );

    if (isResolved || attempt === attempts) {
      return lastStatus;
    }

    logger.warn(`${logPrefix} Falabella aún no expone un estado concluyente para SKU ${sellerSku}; reintento en ${delayMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  return lastStatus;
}

async function resolveFalabellaMarketplaceId() {
  if (cachedFalabellaMarketplaceId) {
    return cachedFalabellaMarketplaceId;
  }

  const marketplaces = await MarketplaceRepository.findAll();
  const falabella = Array.isArray(marketplaces)
    ? marketplaces.find((marketplace) => {
        const domain = normalizeText(marketplace?.domain);
        const name = normalizeText(marketplace?.name);
        return domain.includes('falabella') || name.includes('falabella');
      })
    : null;

  if (falabella?.id) {
    cachedFalabellaMarketplaceId = falabella.id;
    return cachedFalabellaMarketplaceId;
  }

  cachedFalabellaMarketplaceId = 4;
  logger.warn('[FB Publication Reconcile] No se pudo resolver el marketplace Falabella por nombre/dominio, usando id=4');
  return cachedFalabellaMarketplaceId;
}

async function updatePublicationReconcileMetadata(task, details, metadata, options = {}) {
  const nextDetails = {
    ...details,
    reconciliation: {
      ...(details?.reconciliation || {}),
      ...metadata
    }
  };

  await ProductPublishingTaskRepository.updateTask(task, {
    ...options,
    error_details: nextDetails
  });
}

const FalabellaOrderReconciliationService = {
  start() {
    if (!CONFIG.ORDER_RECONCILE_ENABLED && !CONFIG.PUBLICATION_RECONCILE_ENABLED) {
      logger.info('[FB Reconcile] Deshabilitado por configuracion');
      return;
    }

    if (intervalHandle) {
      logger.warn('[FB Reconcile] Ya esta iniciado');
      return;
    }

    this.runOnce().catch((err) => {
      logger.error('[FB Reconcile] Error en ejecucion inicial:', err.message);
    });

    const intervalMs = CONFIG.INTERVAL_MINUTES * 60 * 1000;
    intervalHandle = setInterval(() => {
      this.runOnce().catch((err) => {
        logger.error('[FB Reconcile] Error en ejecucion programada:', err.message);
      });
    }, intervalMs);

    logger.info(`[FB Reconcile] Iniciado. Intervalo: ${CONFIG.INTERVAL_MINUTES} min`);
  },

  stop() {
    if (intervalHandle) {
      clearInterval(intervalHandle);
      intervalHandle = null;
      logger.info('[FB Reconcile] Detenido');
    }
  },

  async runOnce() {
    if (running) {
      logger.debug('[FB Reconcile] Ciclo en ejecucion, omitido');
      return;
    }

    running = true;

    try {
      if (CONFIG.ORDER_RECONCILE_ENABLED) {
        await this._reconcileOrders();
      }

      if (CONFIG.PUBLICATION_RECONCILE_ENABLED) {
        await this._reconcileFalabellaPublications();
      }
    } finally {
      running = false;
    }
  },

  async _reconcileOrders() {
    const credentials = await MarketplaceCredentialRepository.findAllActiveFalabella();
    if (!credentials || credentials.length === 0) {
      logger.info('[FB Reconcile][Orders] No hay credenciales activas');
      return;
    }

    const now = new Date();
    const from = new Date(now.getTime() - CONFIG.LOOKBACK_MINUTES * 60 * 1000);
    const createdAfter = formatTimestampISO(from);
    const createdBefore = formatTimestampISO(now);

    for (const credential of credentials) {
      await this._reconcileOrdersForCredential(credential, createdAfter, createdBefore);
    }
  },

  async _reconcileOrdersForCredential(credential, createdAfter, createdBefore) {
    const statuses = CONFIG.STATUSES.length > 0 ? CONFIG.STATUSES : [null];

    for (const status of statuses) {
      let offset = 0;
      let page = 0;
      let keepGoing = true;

      while (keepGoing && page < CONFIG.MAX_PAGES) {
        const data = await MarketplaceWebhookController._fetchFalabellaOrdersV2({
          credential,
          createdAfter,
          createdBefore,
          offset,
          limit: CONFIG.LIMIT,
          status
        });

        if (!data) break;

        const orderIds = MarketplaceWebhookController._parseFalabellaOrderIds(data);
        if (orderIds.length === 0) break;

        for (const orderId of orderIds) {
          const existing = await MarketplaceWebhookEventRepository.findByMarketplaceAndExternalId(
            'falabella',
            orderId,
            ['processed', 'processed_with_errors']
          );

          if (existing) continue;

          const payload = {
            seller_id: credential.seller_id || null,
            seller_email: credential.seller_email || null,
            event: 'reconcile',
            status: status || null,
            created_after: createdAfter,
            created_before: createdBefore
          };

          const eventResult = await MarketplaceWebhookEventRepository.createUnique({
            marketplace: 'falabella',
            topic: 'reconcile',
            resource: `orders/${orderId}`,
            event_id: `reconcile:${orderId}`,
            external_id: String(orderId),
            marketplace_user_id: credential.seller_id || credential.seller_email || null,
            status: 'received',
            payload
          });

          if (!eventResult.created) continue;

          await MarketplaceWebhookController._processFalabellaEvent({
            event: eventResult.record,
            payload,
            orderId
          });
        }

        if (orderIds.length < CONFIG.LIMIT) {
          keepGoing = false;
        } else {
          offset += CONFIG.LIMIT;
          page += 1;
        }
      }
    }
  },

  async _reconcileFalabellaPublications() {
    const falabellaMarketplaceId = await resolveFalabellaMarketplaceId();
    if (!falabellaMarketplaceId) {
      logger.warn('[FB Publication Reconcile] No se pudo resolver el marketplace Falabella');
      return;
    }

    const now = new Date();
    const from = new Date(now.getTime() - CONFIG.PUBLICATION_LOOKBACK_MINUTES * 60 * 1000);
    const startDate = formatTimestampISO(from);
    const endDate = formatTimestampISO(now);

    const tasks = await ProductPublishingTaskRepository.findPublishedProducts({
      marketplaceId: falabellaMarketplaceId,
      startDate,
      endDate,
      includeProcessing: true
    });

    const candidates = (Array.isArray(tasks) ? tasks : [])
      .filter((task) => CONFIG.PUBLICATION_STATUSES.includes(normalizeText(task?.status)))
      .sort((a, b) => {
        const left = new Date(a?.updatedAt || a?.createdAt || 0).getTime();
        const right = new Date(b?.updatedAt || b?.createdAt || 0).getTime();
        return left - right;
      })
      .slice(0, CONFIG.PUBLICATION_LIMIT);

    logger.info(
      `[FB Publication Reconcile] Candidatos=${candidates.length} marketplace_id=${falabellaMarketplaceId} ventana=${CONFIG.PUBLICATION_LOOKBACK_MINUTES}m`
    );

    for (const task of candidates) {
      await this._reconcileFalabellaPublicationTask(task, falabellaMarketplaceId, now);
    }
  },

  async _reconcileFalabellaPublicationTask(task, falabellaMarketplaceId, now = new Date()) {
    const latestTask = await ProductPublishingTaskRepository.findById(task.id);
    if (!latestTask) {
      logger.warn(`[FB Publication Reconcile] Task ${task.id} no encontrada al revalidar`);
      return;
    }

    if (normalizeText(latestTask.status) !== 'processing') {
      logger.info(
        `[FB Publication Reconcile] Task ${latestTask.id} ya no esta en processing (${latestTask.status}), se omite`
      );
      return;
    }

    const ageMinutes = getTaskAgeMinutes(latestTask, now);
    if (ageMinutes < CONFIG.PUBLICATION_MIN_AGE_MINUTES) {
      logger.debug(
        `[FB Publication Reconcile] Task ${latestTask.id} sku=${latestTask.external_id || latestTask.product?.sku || 'n/a'} ` +
        `aun es reciente (${ageMinutes}m < ${CONFIG.PUBLICATION_MIN_AGE_MINUTES}m), se omite`
      );
      return;
    }

    const credential = latestTask.credential || null;
    if (!credential || !credential.seller_email || !credential.api_key) {
      logger.warn(`[FB Publication Reconcile] Task ${latestTask.id} sin credencial Falabella valida, se omite`);
      return;
    }

    const adapter = new FalabellaAdapter(
      falabellaMarketplaceId,
      latestTask.company_id,
      latestTask.branch_id || null,
      latestTask.user_id || null,
      credential
    );

    const credentialStatus = await adapter.ensureValidCredentials();
    if (!credentialStatus?.valid) {
      logger.warn(
        `[FB Publication Reconcile] Task ${latestTask.id} credencial invalida: ${credentialStatus?.message || 'unknown'}`
      );
      return;
    }

    const link = await ProductMarketplaceLinkRepository.findByProductAndMarketplace(
      latestTask.product_id,
      falabellaMarketplaceId,
      latestTask.company_id,
      latestTask.branch_id,
      latestTask.credential_id || credential?.id || null,
      latestTask.user_id || null
    );

    const sellerSku = resolveFalabellaSellerSku(latestTask, link);
    if (!sellerSku) {
      logger.warn(`[FB Publication Reconcile] Task ${latestTask.id} no tiene SellerSku resolvible`);
      return;
    }

    logger.info(
      `[FB Publication Reconcile] Revisando task=${latestTask.id} sku=${sellerSku} age=${ageMinutes}m status=${latestTask.status}`
    );

    const productStatus = await fetchFalabellaPublicationStatusWithRetry(adapter, sellerSku, {
      attempts: CONFIG.PUBLICATION_STATUS_ATTEMPTS,
      delayMs: CONFIG.PUBLICATION_STATUS_DELAY_MS,
      logPrefix: '[FB Publication Reconcile]'
    });

    logger.info(
      `[FB Publication Reconcile] Respuesta Falabella task=${latestTask.id} sku=${sellerSku}: ${JSON.stringify(buildPublicationReconcileSummary(productStatus))}`
    );

    const details = normalizeTaskDetails(latestTask.error_details);
    const currentAttempts = Number(details?.reconciliation?.not_found_count || 0);

    if (!productStatus || productStatus.found === false) {
      const nextAttempts = currentAttempts + 1;
      const metadata = {
        last_checked_at: now.toISOString(),
        last_known_status: 'not_found',
        not_found_count: nextAttempts,
        last_sku_checked: sellerSku,
        marketplace_id: falabellaMarketplaceId
      };

      await updatePublicationReconcileMetadata(latestTask, details, metadata);

      if (
        ageMinutes >= CONFIG.PUBLICATION_NOT_FOUND_TIMEOUT_MINUTES &&
        nextAttempts >= CONFIG.PUBLICATION_MAX_NOT_FOUND_ATTEMPTS
      ) {
        const timeoutMessage =
          `Falabella no expuso el producto ${sellerSku} tras ${nextAttempts} verificaciones y ${ageMinutes} minutos`;

        logger.warn(`[FB Publication Reconcile] Task ${latestTask.id} cerrada por timeout: ${timeoutMessage}`);

        await ProductPublishingTaskRepository.updateTask(latestTask, {
          status: 'failed',
          error_message: timeoutMessage,
          error_details: {
            ...details,
            reconciliation: {
              ...(details?.reconciliation || {}),
              ...metadata,
              terminal_reason: 'not_found_timeout'
            }
          },
          api_response: productStatus?.raw || latestTask.api_response || null
        });

        if (link) {
          await link.update({
            status: 'failed',
            last_synced_at: now
          });
        }
      } else {
        logger.info(
          `[FB Publication Reconcile] Task ${latestTask.id} sigue en processing: Falabella aun no lo expone y se conserva el estado`
        );
      }

      return;
    }

    const lifecycle = determinePublicationLifecycle(productStatus);
    const metadata = {
      last_checked_at: now.toISOString(),
      last_known_status: productStatus.status || null,
      qc_status: productStatus.qc_status || null,
      is_published: productStatus.is_published ?? null,
      has_image: productStatus.has_image ?? null,
      last_sku_checked: sellerSku,
      marketplace_id: falabellaMarketplaceId
    };

    if (lifecycle.status === 'processing') {
      await ProductPublishingTaskRepository.updateTask(latestTask, {
        error_details: {
          ...details,
          marketplace_item_state: productStatus,
          marketplace_display_status: productStatus.status || null,
          reconciliation: {
            ...(details?.reconciliation || {}),
            ...metadata
          }
        },
        api_response: productStatus.raw || latestTask.api_response || null
      });

      logger.info(
        `[FB Publication Reconcile] Task ${latestTask.id} sigue en processing por estado intermedio de Falabella`
      );
      return;
    }

    const nextTaskStatus = lifecycle.status;
    const nextErrorDetails = {
      ...details,
      marketplace_item_state: productStatus,
      marketplace_display_status: productStatus.status || null,
      reconciliation: {
        ...(details?.reconciliation || {}),
        ...metadata,
        terminal_reason: lifecycle.isFinal ? nextTaskStatus : 'processing'
      }
    };

    await ProductPublishingTaskRepository.updateTask(latestTask, {
      status: nextTaskStatus,
      error_message: lifecycle.errorMessage,
      error_details: nextErrorDetails,
      api_response: productStatus.raw || latestTask.api_response || null,
      external_url: productStatus.url || latestTask.external_url || null
    });

    if (link) {
      await link.update({
        status: nextTaskStatus === 'published' ? 'active' : nextTaskStatus,
        external_url: productStatus.url || link.external_url,
        published_stock: productStatus.stock ?? link.published_stock,
        published_payload: productStatus.raw || link.published_payload,
        last_synced_at: now
      });
    } else if ((latestTask.company_id != null || latestTask.branch_id != null) && sellerSku) {
      try {
        await ProductMarketplaceLinkRepository.upsert({
          product_id: latestTask.product_id,
          marketplace_id: falabellaMarketplaceId,
          credential_id: latestTask.credential_id || credential?.id || null,
          user_id: latestTask.user_id || null,
          company_id: latestTask.company_id != null ? latestTask.company_id : null,
          branch_id: latestTask.branch_id != null ? latestTask.branch_id : null,
          status: nextTaskStatus === 'published' ? 'active' : nextTaskStatus,
          external_id: sellerSku,
          external_url: productStatus.url || null,
          published_stock: productStatus.stock ?? null,
          published_payload: productStatus.raw || null,
          last_synced_at: now
        });
        logger.info(
          `[FB Publication Reconcile] Link fallback actualizado para task=${latestTask.id} sku=${sellerSku}`
        );
      } catch (linkError) {
        logger.warn(
          `[FB Publication Reconcile] No se pudo crear link fallback para task ${latestTask.id}: ${linkError.message}`
        );
      }
    }

    logger.info(
      `[FB Publication Reconcile] Task ${latestTask.id} actualizada a ${nextTaskStatus} por consulta directa a Falabella`
    );
  }
};

module.exports = FalabellaOrderReconciliationService;
