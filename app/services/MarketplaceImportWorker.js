'use strict';

const crypto = require('crypto');
const logger = require('../../config/logger');
const MarketplaceImportService = require('./MarketplaceImportService');
const { MarketplaceImportRepository } = require('../repositories');

class MarketplaceImportWorker {
  static start() {
    if (this.timer) return;
    this.workerId = `${process.pid}-${crypto.randomUUID()}`;
    this.pollMs = Math.max(Number(process.env.MARKETPLACE_IMPORT_POLL_MS) || 5000, 1000);
    this.leaseMs = Math.max(Number(process.env.MARKETPLACE_IMPORT_LEASE_MS) || 120000, 30000);
    this.timer = setInterval(() => this.tick(), this.pollMs);
    this.tick();
  }

  static stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.workerId = null;
  }

  static async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const deleted = await MarketplaceImportRepository.deleteExpired();
      if (deleted) logger.info(`[MarketplaceImportWorker] Operaciones expiradas eliminadas: ${deleted}`);
      const operation = await MarketplaceImportRepository.claimNext(this.workerId, this.leaseMs);
      if (operation) {
        logger.info(`[MarketplaceImportWorker] Iniciando operación ${operation.id}`);
        await MarketplaceImportService.run(operation.id, this.workerId);
        logger.info(`[MarketplaceImportWorker] Finalizó operación ${operation.id}`);
      }
    } catch (error) {
      logger.error(`[MarketplaceImportWorker] Error: ${error.message}`, error);
    } finally {
      this.running = false;
    }
  }
}

MarketplaceImportWorker.timer = null;
MarketplaceImportWorker.running = false;
MarketplaceImportWorker.workerId = null;

module.exports = MarketplaceImportWorker;
