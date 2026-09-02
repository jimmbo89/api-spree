// src/services/JobBackgroundProcessor.js
const { JobRepository, JobProductRepository, MarketplaceRepository, MarketplaceCredentialRepository, NotificationRepository } = require('../repositories');
const MarketplaceStockSyncService = require('./MarketplaceStockSyncService');
const PublishingService = require('./PublishingService');
const logger = require('../../config/logger');
const PublicationAuditService = require('./PublicationAuditService');

// ⚙️ Configuración ajustada para cPanel (recursos limitados)
const CONFIG = {
  POLL_INTERVAL_MS: 5000,        // Revisar jobs cada 15 segundos
  BATCH_SIZE: 3,                  // Procesar máximo 3 productos por ciclo
  CONCURRENCY: 2,                  // Reintentos por producto
  JOB_TIMEOUT_MINUTES: 60         // Timeout para jobs colgados
};

function normalizeWarningEntry(warning) {
  if (typeof warning === 'string') {
    const message = warning.trim();
    return {
      field: 'warning',
      message: message || 'Sin detalle',
      value: null
    };
  }

  if (!warning || typeof warning !== 'object') return null;

  return {
    field: warning.field || warning.code || 'unknown',
    message: warning.message || warning.error || warning.detail || 'Sin detalle',
    value: warning.value ?? null
  };
}

function buildWarningMessage(warnings, fallbackMessage = null) {
  const normalized = Array.isArray(warnings)
    ? warnings.map(normalizeWarningEntry).filter(Boolean)
    : [];

  if (normalized.length > 0) {
    return `Advertencias: ${normalized.map(w => w.message).join(', ')}`;
  }

  return fallbackMessage || null;
}

let processorInterval = null;
let isRunning = false;
const activeJobIds = new Set();

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

    //logger.debug(`[JobProcessor] ${jobs.length} jobs encontrados para procesar`);

    for (const job of jobs) {
      if (activeJobIds.has(job.id)) {
        logger.debug(`[JobProcessor] Job ${job.id} ya está en ejecución, saltando ciclo duplicado`);
        continue;
      }
      // Verificar timeout para jobs colgados
      if (job.started_at) {
        const elapsedMin = (Date.now() - new Date(job.started_at)) / 60000;
        if (elapsedMin > CONFIG.JOB_TIMEOUT_MINUTES) {
          logger.warn(`[JobProcessor] Job ${job.id} excedió timeout (${elapsedMin}min)`);
          const failedJob = await JobRepository.fail(job.id, 'timeout', { elapsed_minutes: elapsedMin });
          await PublicationAuditService.recordProcessSystemEvent(failedJob, 'process.stopped', {
            result: 'error',
            previous_value: { status: job.status },
            new_value: { status: failedJob.status },
            description: `Proceso #${job.id} detenido por timeout`,
            metadata: {
              reason: 'timeout',
              elapsed_minutes: elapsedMin
            }
          });
          continue;
        }
      }

      activeJobIds.add(job.id);

      // Procesar sin await para no bloquear el ciclo
      this._processJob(job).catch(err => {
        logger.error(`[JobProcessor] Error en job ${job.id}:`, err.message);
      }).finally(() => {
        activeJobIds.delete(job.id);
      });
    }
  },

  /**
   * Procesa un job padre: ejecuta sus productos pendientes
   */
  async _processJob(job) {
    const jobId = job.id;

    // === NUEVO: Ignorar jobs tipo 'draft' ===
    if (job.job_type === 'draft') {
      logger.debug(`[JobProcessor] Ignorando job ${jobId} porque es draft (job_type='draft')`);
      return;
    }

    try {
      // Si está pending, marcar como processing
      if (job.status === 'pending') {
        const startedJob = await JobRepository.startProcessing(jobId);
        await PublicationAuditService.recordProcessSystemEvent(startedJob, 'process.started', {
          previous_value: { status: job.status },
          new_value: { status: startedJob.status, started_at: startedJob.started_at },
          description: `Proceso #${jobId} iniciado`
        });
        //logger.info(`[JobProcessor] Job ${jobId} iniciado`);
      }

      // 🔑 CRÍTICO: Agregar includePayloads: true para recuperar product_payload y marketplace_payload
      const pendingProducts = await JobProductRepository.findAllByJob(jobId, {
        status: 'pending',
        limit: CONFIG.BATCH_SIZE,
        includePayloads: true  // ← ✅ ESTO ES LO QUE FALTABA
      });

      if (pendingProducts.length === 0) {
        // Verificar si el job ya completó todos sus productos
        logger.info(`[JobProcessor] Job ${jobId}: no hay productos pendientes, verificando completado`);
        await this._checkJobCompletion(jobId);
        return;
      }

      //logger.debug(`[JobProcessor] Job ${jobId}: procesando ${pendingProducts.length} productos`);

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
      const failedJob = await JobRepository.fail(jobId, error.message, { stage: 'job_process' });
      await PublicationAuditService.recordProcessSystemEvent(failedJob, 'process.failed', {
        result: 'error',
        previous_value: { status: job.status },
        new_value: { status: failedJob.status },
        description: `Proceso #${jobId} fallido`,
        metadata: {
          error: error.message,
          stage: 'job_process'
        }
      });
      await this._notifyPublicationFinished(failedJob, {
        total: failedJob.total_products || 0,
        successful: failedJob.successful || 0,
        errors: Math.max(1, failedJob.errors_count || 0)
      });
    }
  },

/**
 * Procesa un solo producto: UN INTENTO, sin reintentos automáticos
 */
/*async _processProduct(jobProduct, parentJobId) {
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
    const job = await JobRepository.findById(parentJobId);
    if (!job) {
      throw new Error(`Job ${parentJobId} no encontrado`);
    }

    if (job.job_type === 'sync') {
      await JobProductRepository.update(jobProduct, {
        status: 'processing',
        last_attempt_at: new Date(),
        error_message: null
      });

      const result = await MarketplaceStockSyncService.processJobProduct(jobProduct, job);

      if (result?.success) {
        await JobProductRepository.update(jobProduct, {
          status: 'success',
          error_message: null,
          error_details: null
        });
        return { success: true };
      }

      const errorMessage = result?.error || 'sync_failed';
      await JobProductRepository.update(jobProduct, {
        status: 'error',
        error_message: errorMessage,
        error_details: result?.details || null
      });
      return { success: false };
    }

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
      credential_id,
      {
    batch_id: job.batch_id,  // ← ✅ Pasar batch_id del job padre
    job_id: parentJobId       // ← ✅ Pasar job_id del job padre
  }
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
      const warningMessage = buildWarningMessage(
        result.warning_details?.warnings || result.warnings,
        result.warning_message || result.error || null
      );
      const warningDetails = Array.isArray(result.warning_details?.warnings)
        ? result.warning_details
        : (Array.isArray(result.warnings) && result.warnings.length > 0
          ? { warnings: result.warnings }
          : null);

      await JobProductRepository.update(jobProduct, {
        status: 'success',
        external_id: result.external_id || null,
        external_url: result.external_url || null,
        error_message: result.has_warnings ? warningMessage : null,
        error_details: result.has_warnings ? warningDetails : null
      });
      return { success: true };
    }

    // Error → marcar y terminar
    const errorMessage = result?.message || result?.error || 'unknown_error';
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
},*/
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
    const job = await JobRepository.findById(parentJobId);
    if (!job) {
      throw new Error(`Job ${parentJobId} no encontrado`);
    }

    // 🔧 PARSEAR CONFIG SI VIENE COMO STRING + RECONSTRUIR primary_warehouse
    let config = job?.config;
    
    // Caso 1: config viene como string JSON (Sequelize JSON field puede serializar como string)
    if (typeof config === 'string') {
      try {
        config = JSON.parse(config);
      } catch (e) {
        logger.error(`[JobProcessor] Error parseando config del job ${parentJobId}`);
        throw new Error(`Config del job ${parentJobId} no es un JSON válido`);
      }
    }
    
    // Caso 2: primary_warehouse falta pero existen warehouses → reconstruir desde el primero
    if (!config?.pool?.primary_warehouse && config?.pool?.warehouses?.length > 0) {
      config.pool.primary_warehouse = config.pool.warehouses[0];
      logger.debug(`[JobProcessor] Job ${parentJobId}: primary_warehouse reconstruido desde warehouses[0]`);
    }

    // Validación final reforzada
    if (!config?.pool?.primary_warehouse) {
      throw new Error(`Job ${parentJobId} sin pool.primary_warehouse en config`);
    }

    if (job.job_type === 'sync') {
      await JobProductRepository.update(jobProduct, {
        status: 'processing',
        last_attempt_at: new Date(),
        error_message: null
      });

      const result = await MarketplaceStockSyncService.processJobProduct(jobProduct, job);

      if (result?.success) {
        await JobProductRepository.update(jobProduct, {
          status: 'success',
          error_message: null,
          error_details: null
        });
        return { success: true };
      }

      const errorMessage = result?.error || 'sync_failed';
      await JobProductRepository.update(jobProduct, {
        status: 'error',
        error_message: errorMessage,
        error_details: result?.details || null
      });
      return { success: false };
    }

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
    });

    // === Obtener config del job padre (ya parseada y validada arriba) ===
    if (!config?.pool?.primary_warehouse) {
      throw new Error(`Job ${parentJobId} sin pool.primary_warehouse en config`);
    }

    // === Construir warehouse ===
    const primaryWarehouse = config.pool.primary_warehouse;
    const warehouse = {
      id: primaryWarehouse.warehouse_id,
      company_id: config.pool.company_id || job.company_id,
      branch_id: primaryWarehouse.branch_id || null
    };

    const userId = config.pool.user_id || job.user_id;
    if (!userId) throw new Error(`user_id no encontrado en job config`);

    // === ✅ LLAMAR A publishProduct (único intento) ===
    const result = await PublishingService.publishProduct(
      product_payload,
      marketplace_payload,
      warehouse,
      userId,
      credential_id,
      {
        batch_id: job.batch_id,
        job_id: parentJobId
      }
    );

    // === Manejar resultado: éxito o error, sin reintentos ===

    // Auth required
    if (result?.auth_required) {
      await JobProductRepository.update(jobProduct, {
        status: 'error',
        error_message: 'auth_required',
        task_id: result.task_id || null,
        error_details: { 
          auth_url: result.auth_url,
          task_id: result.task_id || null  // ✅ Guardar referencia al task creado
        }
      });
      return { success: false, auth_required: true };
    }

    // Éxito
    if (result?.success) {
      const warningMessage = buildWarningMessage(
        result.warning_details?.warnings || result.warnings,
        result.warning_message || result.error || null
      );
      const warningDetails = Array.isArray(result.warning_details?.warnings)
        ? result.warning_details
        : (Array.isArray(result.warnings) && result.warnings.length > 0
          ? { warnings: result.warnings }
          : null);

      await JobProductRepository.update(jobProduct, {
        status: 'success',
        external_id: result.external_id || null,
        external_url: result.external_url || null,
        task_id: result.task_id || null,
        error_message: result.has_warnings ? warningMessage : null,
        error_details: result.has_warnings
          ? {
              ...(warningDetails || {}),
              task_id: result.task_id || null
            }
          : null
      });
      return { success: true };
    }

    // Error → marcar y terminar
    const errorMessage = result?.error || result?.message || 'unknown_error';
    logger.warn(`[JobProcessor] ❌ Producto ${product_id} falló: ${errorMessage}`);

      await JobProductRepository.update(jobProduct, {
        status: 'error',
        error_message: errorMessage,
        task_id: result?.task_id || null,
        error_details: {
          ...(result?.details || null),
          task_id: result?.task_id || null  // ✅ Guardar referencia al task creado
        }
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

    logger.info(`[JobProcessor] Verificando completado job ${jobId}: ${stats.processed}/${stats.total} procesados, ${stats.successful} éxitos, ${stats.errors} errores`);

    if (stats.processed >= stats.total && stats.total > 0) {
      const completedJob = await JobRepository.complete(jobId, {
        successful: stats.successful,
        errors_count: stats.errors
      });
      await PublicationAuditService.recordProcessSystemEvent(completedJob, 'process.finished', {
        result: stats.errors > 0 ? 'warning' : 'success',
        new_value: {
          status: completedJob.status,
          successful: stats.successful,
          errors_count: stats.errors,
          total: stats.total
        },
        description: stats.errors > 0
          ? `Proceso #${jobId} finalizado con errores`
          : `Proceso #${jobId} finalizado correctamente`
      });
      await this._notifyPublicationFinished(completedJob, stats);
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
   * Crea una sola notificación para el dueño cuando un job de publicación termina.
   * Un fallo de notificación nunca debe alterar el resultado de la publicación.
   */
  async _notifyPublicationFinished(job, stats = {}) {
    if (job?.job_type !== 'publish' || !job.user_id || !job.company_id || !job.id) {
      return;
    }

    try {
      if (await JobRepository.checkIfJobNotified(job.id, job.user_id)) {
        return;
      }

      const total = Number(stats.total ?? job.total_products ?? 0);
      const successful = Number(stats.successful ?? job.successful ?? 0);
      const errors = Number(stats.errors ?? stats.errors_count ?? job.errors_count ?? 0);
      const failed = job.status === 'failed';
      const completedWithErrors = failed || errors > 0 || job.status === 'completed_with_errors';
      const title = failed
        ? 'Publicación fallida'
        : (completedWithErrors ? 'Publicación finalizada con errores' : 'Publicación exitosa');
      const description = failed
        ? `La publicación no pudo completarse${job.error_summary?.message ? `: ${job.error_summary.message}` : '.'}`
        : `${successful}/${total} producto${total === 1 ? '' : 's'} publicado${successful === 1 ? '' : 's'}${errors > 0 ? `; ${errors} con error` : ''}.`;

      await NotificationRepository.create({
        user_id: job.user_id,
        company_id: job.company_id,
        title,
        description,
        type: 'publication_completed',
        data: {
          job_id: job.id,
          batch_id: job.batch_id,
          total,
          successful,
          errors,
          job_status: job.status,
          completed_at: job.completed_at || new Date().toISOString()
        },
        status: 0
      });

      await JobRepository.markJobNotified(job.id, job.user_id);
      logger.info(`[JobProcessor] Notificación creada para job ${job.id}, usuario ${job.user_id}`);
    } catch (error) {
      logger.error(`[JobProcessor] No se pudo notificar job ${job?.id}: ${error.message}`);
    }
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
