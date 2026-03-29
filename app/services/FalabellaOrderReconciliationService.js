// services/FalabellaOrderReconciliationService.js
const logger = require('../../config/logger');
const { MarketplaceCredentialRepository, MarketplaceWebhookEventRepository } = require('../repositories');
const MarketplaceWebhookController = require('../controllers/MarketplaceWebhookController');

const CONFIG = {
  ENABLED: String(process.env.FB_RECONCILE_ENABLED || 'false').toLowerCase() === 'true',
  INTERVAL_MINUTES: parseInt(process.env.FB_RECONCILE_INTERVAL_MINUTES || '60', 10),
  LOOKBACK_MINUTES: parseInt(process.env.FB_RECONCILE_LOOKBACK_MINUTES || '180', 10),
  LIMIT: parseInt(process.env.FB_RECONCILE_LIMIT || '100', 10),
  MAX_PAGES: parseInt(process.env.FB_RECONCILE_MAX_PAGES || '5', 10),
  STATUSES: (process.env.FB_RECONCILE_STATUSES || 'pending')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
};

let intervalHandle = null;
let running = false;

function formatTimestampISO(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const tz = '+0000';
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}${tz}`
  );
}

const FalabellaOrderReconciliationService = {
  start() {
    if (!CONFIG.ENABLED) {
      logger.info('[FB Reconcile] Deshabilitado por configuración');
      return;
    }

    if (intervalHandle) {
      logger.warn('[FB Reconcile] Ya está iniciado');
      return;
    }

    this.runOnce().catch((err) => {
      logger.error('[FB Reconcile] Error en ejecución inicial:', err.message);
    });

    const intervalMs = CONFIG.INTERVAL_MINUTES * 60 * 1000;
    intervalHandle = setInterval(() => {
      this.runOnce().catch((err) => {
        logger.error('[FB Reconcile] Error en ejecución programada:', err.message);
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
      logger.debug('[FB Reconcile] Ciclo en ejecución, omitido');
      return;
    }
    running = true;

    try {
      const credentials = await MarketplaceCredentialRepository.findAllActiveFalabella();
      if (!credentials || credentials.length === 0) {
        logger.info('[FB Reconcile] No hay credenciales activas');
        return;
      }

      const now = new Date();
      const from = new Date(now.getTime() - CONFIG.LOOKBACK_MINUTES * 60 * 1000);
      const createdAfter = formatTimestampISO(from);
      const createdBefore = formatTimestampISO(now);

      for (const credential of credentials) {
        await this._reconcileForCredential(credential, createdAfter, createdBefore);
      }
    } finally {
      running = false;
    }
  },

  async _reconcileForCredential(credential, createdAfter, createdBefore) {
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
  }
};

module.exports = FalabellaOrderReconciliationService;
