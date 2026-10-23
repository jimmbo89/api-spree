'use strict';

const crypto = require('crypto');
const logger = require('../../config/logger');
const MarketplacePreviewService = require('./MarketplacePreviewService');
const MarketplaceImageService = require('./MarketplaceImageService');
const { MarketplacePreviewRepository } = require('../repositories');

class MarketplacePreviewWorker {
  static start() {
    if (this.timer) return;

    this.workerId = `${process.pid}-${crypto.randomUUID()}`;
    this.pollMs = Math.max(Number(process.env.MARKETPLACE_PREVIEW_POLL_MS) || 5000, 1000);
    this.leaseMs = Math.max(Number(process.env.MARKETPLACE_PREVIEW_LEASE_MS) || 120000, 30000);
    this.cleanupMs = Math.max(Number(process.env.MARKETPLACE_PREVIEW_IMAGE_CLEANUP_MS) || 900000, 60000);
    this.lastCleanupAt = 0;
    this.timer = setInterval(() => this.tick(), this.pollMs);
    this.tick();
  }

  static stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.workerId = null;
    this.lastCleanupAt = 0;
  }

  static async tick() {
    if (this.running) return;
    this.running = true;

    try {
      const deleted = await MarketplacePreviewRepository.deleteExpired();
      if (deleted) logger.info(`[MarketplacePreviewWorker] Operaciones expiradas eliminadas: ${deleted}`);

      if (Date.now() - this.lastCleanupAt >= this.cleanupMs) {
        this.lastCleanupAt = Date.now();
        const removedImages = await MarketplaceImageService.cleanupPreviewImages();
        if (removedImages) logger.info(`[MarketplacePreviewWorker] Imágenes temporales eliminadas: ${removedImages}`);
      }

      const operation = await MarketplacePreviewRepository.claimNext(this.workerId, this.leaseMs);
      if (operation) {
        logger.info(`[MarketplacePreviewWorker] Iniciando operación ${operation.id}`);
        await MarketplacePreviewService.run(operation.id, this.workerId);
        logger.info(`[MarketplacePreviewWorker] Finalizó operación ${operation.id}`);
      }
    } catch (error) {
      logger.error(`[MarketplacePreviewWorker] Error: ${error.message}`, error);
    } finally {
      this.running = false;
    }
  }
}

MarketplacePreviewWorker.timer = null;
MarketplacePreviewWorker.running = false;
MarketplacePreviewWorker.workerId = null;

module.exports = MarketplacePreviewWorker;
