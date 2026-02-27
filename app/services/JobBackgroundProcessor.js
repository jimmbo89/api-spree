// src/services/JobBackgroundProcessor.js
const { JobRepository, JobProductRepository, MarketplaceRepository, MarketplaceCredentialRepository } = require('../repositories');
const PublishingService = require('./PublishingService');
const logger = require('../../config/logger');

// ⚙️ Configuración ajustada para cPanel (recursos limitados)
const CONFIG = {
  POLL_INTERVAL_MS: 5000,        // Revisar jobs cada 15 segundos
  BATCH_SIZE: 3,                  // Procesar máximo 3 productos por ciclo
  CONCURRENCY: 2,                  // Reintentos por producto
  JOB_TIMEOUT_MINUTES: 60         // Timeout para jobs colgados
};

let processorInterval = null;
let isRunning = false;

const JobBackgroundProcessor = {

  /**
   * Inicia el processor en background
   * Llamar UNA VEZ en app.js después de configurar express
   */
  start() {
    if (processorInterval) {
      logger.warn('[JobProcessor] Ya está iniciado');
      return;
    }

    logger.info(`[JobProcessor] Iniciado - Poll: ${CONFIG.POLL_INTERVAL_MS}ms, Batch: ${CONFIG.BATCH_SIZE}`);
    
    // Ejecutar inmediatamente al iniciar
    this._runCycle();
    
    // Programar ciclos periódicos
    processorInterval = setInterval(() => {
      this._runCycle();
    }, CONFIG.POLL_INTERVAL_MS);
  },

  /**
   * Detiene el processor (para shutdown graceful)
   */
  stop() {
    if (processorInterval) {
      clearInterval(processorInterval);
      processorInterval = null;
      logger.info('[JobProcessor] Detenido');
    }
  },

  /**
   * Ciclo principal: busca y procesa jobs pendientes
   */
  async _runCycle() {
    // Evitar solapamiento de ciclos
    if (isRunning) {
      logger.debug('[JobProcessor] Ciclo anterior en ejecución, saltando');
      return;
    }

    isRunning = true;
    
    try {
      await this._processPendingJobs();
    } catch (error) {
      logger.error('[JobProcessor] Error en ciclo:', error.message);
    } finally {
      isRunning = false;
    }
  },

  /**
   * Busca jobs en estado pending/processing y los procesa
   */
  async _processPendingJobs() {
    // Buscar jobs que necesiten procesamiento
    const jobs = await JobRepository.findAll({
      status: ['pending', 'processing'],
      limit: 2  // Máximo 2 jobs activos simultáneos en cPanel
    });

    if (jobs.length === 0) return;

    logger.debug(`[JobProcessor] ${jobs.length} jobs encontrados para procesar`);

    for (const job of jobs) {
      // Verificar timeout para jobs colgados
      if (job.started_at) {
        const elapsedMin = (Date.now() - new Date(job.started_at)) / 60000;
        if (elapsedMin > CONFIG.JOB_TIMEOUT_MINUTES) {
          logger.warn(`[JobProcessor] Job ${job.id} excedió timeout (${elapsedMin}min)`);
          await JobRepository.fail(job.id, 'timeout', { elapsed_minutes: elapsedMin });
          continue;
        }
      }

      // Procesar sin await para no bloquear el ciclo
      this._processJob(job).catch(err => {
        logger.error(`[JobProcessor] Error en job ${job.id}:`, err.message);
      });
    }
  },

  /**
   * Procesa un job padre: ejecuta sus productos pendientes
   */
  async _processJob(job) {
    const jobId = job.id;

    try {
      // Si está pending, marcar como processing
      if (job.status === 'pending') {
        await JobRepository.startProcessing(jobId);
        logger.info(`[JobProcessor] Job ${jobId} iniciado`);
      }

      // 🔑 CRÍTICO: Agregar includePayloads: true para recuperar product_payload y marketplace_payload
      const pendingProducts = await JobProductRepository.findAllByJob(jobId, {
        status: 'pending',
        limit: CONFIG.BATCH_SIZE,
        includePayloads: true  // ← ✅ ESTO ES LO QUE FALTABA
      });

      if (pendingProducts.length === 0) {
        // Verificar si el job ya completó todos sus productos
        await this._checkJobCompletion(jobId);
        return;
      }

      logger.debug(`[JobProcessor] Job ${jobId}: procesando ${pendingProducts.length} productos`);

      // Procesar productos en paralelo limitado
      const results = await Promise.allSettled(
        pendingProducts.slice(0, CONFIG.CONCURRENCY).map(p => 
          this._processProduct(p, jobId)
        )
      );

      // Actualizar progreso después del lote
      await this._updateJobProgress(jobId);

    } catch (error) {
      logger.error(`[JobProcessor] Error crítico en job ${job.id}:`, error.message);
      await JobRepository.fail(jobId, error.message, { stage: 'job_process' });
    }
  },

/**
 * Procesa un solo producto: UN INTENTO, sin reintentos automáticos
 */
async _processProduct(jobProduct, parentJobId) {
  const { 
    id: jpId, 
    product_id, 
    marketplace_id,
    credential_id,
    product_payload,
    marketplace_payload,
    attempt_count = 0 
  } = jobProduct || {};

  try {
    // === Validaciones básicas ===
    if (!jpId || !product_id || !credential_id) {
      throw new Error(`Datos inválidos: jpId=${jpId}, product_id=${product_id}, credential_id=${credential_id}`);
    }

    if (!product_payload || typeof product_payload !== 'object') {
      throw new Error(`product_payload inválido o undefined`);
    }

    if (!marketplace_payload || typeof marketplace_payload !== 'object') {
      throw new Error(`marketplace_payload inválido o undefined`);
    }

    // === Marcar como processing ===
    await JobProductRepository.update(jobProduct, {
      status: 'processing',
      last_attempt_at: new Date(),
      error_message: null
      // ← attempt_count se mantiene, pero ya no se usa para reintentos
    });

    // === Obtener config del job padre ===
    const job = await JobRepository.findById(parentJobId);
    if (!job?.config?.pool?.primary_warehouse) {
      throw new Error(`Job ${parentJobId} sin pool.primary_warehouse en config`);
    }

    // === Construir warehouse ===
    const primaryWarehouse = job.config.pool.primary_warehouse;
    const warehouse = {
      id: primaryWarehouse.warehouse_id,
      company_id: job.config.pool.company_id,
      branch_id: primaryWarehouse.branch_id || null
    };

    const userId = job.config.pool.user_id || job.user_id;
    if (!userId) throw new Error(`user_id no encontrado en job config`);

    // === ✅ LLAMAR A publishProduct (único intento) ===
    const result = await PublishingService.publishProduct(
      product_payload,
      marketplace_payload,
      warehouse,
      userId,
      credential_id
    );

    // === Manejar resultado: éxito o error, sin reintentos ===
    
    // Auth required
    if (result?.auth_required) {
      await JobProductRepository.update(jobProduct, {
        status: 'error',
        error_message: 'auth_required',
        error_details: { auth_url: result.auth_url }
      });
      return { success: false, auth_required: true };
    }

    // Éxito
    if (result?.success) {
      await JobProductRepository.update(jobProduct, {
        status: 'success',
        external_id: result.external_id || null,
        external_url: result.external_url || null
      });
      return { success: true };
    }

    // Error → marcar y terminar
    const errorMessage = result?.error || result?.message || 'unknown_error';
    logger.warn(`[JobProcessor] ❌ Producto ${product_id} falló: ${errorMessage}`);
    
    await JobProductRepository.update(jobProduct, {
      status: 'error',
      error_message: errorMessage,
      error_details: result?.details || null
    });
    
    return { success: false };

  } catch (error) {
    // Cualquier excepción → error definitivo
    logger.error(`[JobProcessor] ❌ Excepción en producto ${product_id}: ${error.message}`);
    
    await JobProductRepository.update(jobProduct, {
      status: 'error',
      error_message: error.message || 'internal_error',
      error_details: { stack: error.stack }
    });
    
    return { success: false };
  }
},

  /**
   * Verifica si un job completó todos sus productos
   */
  async _checkJobCompletion(jobId) {
    const stats = await JobProductRepository.getStatsByJob(jobId);
    
    if (stats.processed >= stats.total && stats.total > 0) {
      await JobRepository.complete(jobId, {
        successful: stats.successful,
        errors_count: stats.errors
      });
      logger.info(`[JobProcessor] 🏁 Job ${jobId} completado: ${stats.successful}/${stats.total}`);
      return true;
    }
    return false;
  },

  /**
   * Actualiza el progreso del job padre basado en sus productos
   */
  async _updateJobProgress(jobId) {
    const stats = await JobProductRepository.getStatsByJob(jobId);
    
    await JobRepository.updateProgress(jobId, {
      processed: stats.processed,
      successful: stats.successful,
      errors_count: stats.errors
    });

    // Verificar si completó
    await this._checkJobCompletion(jobId);
  },

  /**
   * Obtiene estado para diagnóstico (endpoint admin opcional)
   */
  getStatus() {
    return {
      running: processorInterval !== null,
      isProcessing: isRunning,
      config: CONFIG
    };
  }
};

module.exports = JobBackgroundProcessor;