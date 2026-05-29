#!/usr/bin/env node

require('dotenv').config();

const logger = require('../config/logger');
const { parseArgs } = require('./simulateMercadoLibrePublishingFlow');
const { runMercadoLibreWebhookPurchaseSimulation } = require('../app/services/MarketplaceWebhookSimulationService');

async function main() {
  const args = parseArgs();
  const summary = await runMercadoLibreWebhookPurchaseSimulation({
    userId: Number(args.user_id || args.userId || 32),
    companyId: Number(args.company_id || args.companyId || 24),
    credentialId: Number(args.credential_id || args.credentialId || 5),
    itemsCount: Number(args.items || args.count || args.itemsCount || 2)
  });

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  logger.error(`[simulateMercadoLibreWebhookPurchase] ${error.message}`);
  console.error(JSON.stringify({
    success: false,
    error: error.message
  }, null, 2));
  process.exitCode = 1;
});
