#!/usr/bin/env node

require('dotenv').config();

const logger = require('../config/logger');
const { runMercadoLibrePublishingSimulation, parseArgs } = require('./simulateMercadoLibrePublishingFlow');
const { runMercadoLibreWebhookPurchaseSimulation } = require('../app/services/MarketplaceWebhookSimulationService');

async function main() {
  const args = parseArgs();
  const publishArgs = {
    user_id: args.user_id,
    company_id: args.company_id,
    credential_id: args.credential_id,
    count: args.count,
    products: args.products
  };

  const publishSummary = await runMercadoLibrePublishingSimulation({
    ...publishArgs,
    closeDb: false
  });
  const webhookSummary = await runMercadoLibreWebhookPurchaseSimulation({
    userId: Number(args.user_id || 32),
    companyId: Number(args.company_id || 24),
    credentialId: Number(args.credential_id || 5),
    itemsCount: Number(args.items || args.count || 2)
  });

  console.log(JSON.stringify({
    success: true,
    publish: publishSummary,
    webhook: webhookSummary
  }, null, 2));
}

main().catch((error) => {
  logger.error(`[simulateMercadoLibreFullFlow] ${error.message}`);
  console.error(JSON.stringify({
    success: false,
    error: error.message
  }, null, 2));
  process.exitCode = 1;
});
