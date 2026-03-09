const { getUserId } = require("../../config/context");
const logger = require("../../config/logger");
const { JobRepository, JobProductRepository, NotificationRepository } = require("../repositories");

const JobController = {  
/**
 * GET /api/jobs/:jobId/progress
 * Obtiene el progreso actual de un job de publicación
 */
async getJobProgress(req, res) {
  try {
    const { include_products = false, jobId } = req.body;

    // 1. Obtener job principal
    const job = await JobRepository.findById(jobId);
    if (!job) {
      return res.status(404).json({ success: false, msg: "job_not_found" });
    }

    // 2. Verificar permisos (solo owner o admin de la company)
    if (job.company_id !== req.user.company_id && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, msg: "unauthorized" });
    }

    // 3. Obtener estadísticas generales
    const stats = await JobProductRepository.getStatsByJob(jobId);
    
    // 4. Calcular progreso general
    const overallProgress = stats.total > 0 
      ? Math.round((stats.processed / stats.total) * 100) 
      : 0;

    // 5. Determinar estado del job
    let jobStatus = job.status;
    if (job.status === 'processing') {
      if (stats.errors > 0 && stats.processed >= stats.total) {
        jobStatus = 'completed_with_errors';
      } else if (stats.processed >= stats.total) {
        jobStatus = stats.errors === 0 ? 'completed' : 'completed_with_errors';
      }
    }

    // 6. Obtener progreso por canal/marketplace (para las tarjetas)
    const channels = await JobProductRepository.getStatsByJobAndMarketplace(jobId);

    // ✅ 7. Obtener errores detallados SOLO si el job terminó y se solicitan productos
let errorsByChannel = {};
if (['completed', 'completed_with_errors', 'failed'].includes(jobStatus) && include_products === 'true') {
  const allErrors = await JobProductRepository.findAllErrorsByJob(job, {
    includePayloads: true,
    includeDetails: true,
    limit: 200 // Límite para no sobrecargar la respuesta
  });
  
  // Agrupar errores por credential_id para facilitar el mapeo en frontend
  errorsByChannel = allErrors.reduce((acc, error) => {
    const key = error.credential_id;
    if (!acc[key]) acc[key] = [];
    acc[key].push(error);
    return acc;
  }, {});
};

    // 8. Respuesta
const response = {
  success: true,
  data: {
    job_id: job.id,
    batch_id: job.batch_id,
    status: jobStatus,
    overall_progress: overallProgress,
    stats: {
      total: stats.total,
      processed: stats.processed,
      successful: stats.successful,
      errors: stats.errors,
      pending: stats.pending
    },
    channels: channels.map(ch => ({
      credential_id: ch.credential_id,
      marketplace_id: ch.marketplace_id,
      marketplace_name: ch.marketplace_name,
      marketplace_domain: ch.marketplace_domain,
      credential_name: ch.credential_name,
      total: ch.total,
      processed: ch.processed,
      published: ch.published,
      failed: ch.failed,
      pending: ch.pending,
      percentage: ch.percentage,
      status: ch.status,
      // ✅ INCLUIR ERRORES DETALLADOS
      errors: errorsByChannel[ch.credential_id] || []
    })),
    products: include_products === 'true' 
      ? await JobProductRepository.findAllByJob(jobId, { 
          limit: 50, 
          includePayloads: false,
          includeDetails: true 
        }) 
      : undefined
  }
};

const sampleChannel = response.data.channels.find(ch => ch.errors?.length > 0);
  if (sampleChannel?.errors?.[0]) {
    //logger.info(`[getJobProgress] 🧪 Payload verification: ${ sampleChannel.errors[0].payload ? 
       // Object.keys(sampleChannel.errors[0].payload) : []
   // }`);
  }

    return res.json(response);

  } catch (error) {
    logger.error(`[JobController.getJobProgress] Error:`, error.message);
    return res.status(500).json({ 
      success: false, 
      msg: "progress_fetch_failed",
      error: error.message 
    });
  }
},

async getActiveJobs(req, res) {
    try {
      const { company_id, user_id: bodyUserId } = req.body;
    const user_id = bodyUserId || getUserId();
      
      // 1. 🔹 Obtener jobs activos y completados usando el nuevo método del repository
    const result = await JobRepository.getActiveAndCompletedJobs(
      user_id, 
      company_id, 
      { includeNotNotified: true }
    );
    
    // 2. 🔹 Para cada job completado no notificado, crear notificación
    for (const job of result.jobs) {
      // Solo procesar jobs completados
      if (!['completed', 'completed_with_errors', 'failed'].includes(job.status)) {
        continue;
      }
      
      // 🔹 Verificar si ya fue notificado (usando método del repository)
      const alreadyNotified = await JobRepository.checkIfJobNotified(job.id, user_id);
      
      if (!alreadyNotified) {
        try {
          // Obtener stats del job
          const stats = await JobProductRepository.getStatsByJob(job.id);
          const channels = await JobProductRepository.getStatsByJobAndMarketplace(job.id);
          
          // 🔹 Crear notificación (ahora con mejor logging de errores)
          await JobController.createPublicationNotification(job, stats, channels, user_id, company_id);
          
          // 🔹 Marcar como notificado (usando método del repository)
          await JobRepository.markJobNotified(job.id, user_id);
          
          logger.info(`[PublishingJobsController] Notificación creada para job ${job.id}, user ${user_id}`);
          
        } catch (notifError) {
          // 🔍 Log completo del error de notificación SIN romper el flujo principal
          logger.error(`[PublishingJobsController] Error creando notificación para job ${job.id}:`, {
            error_message: notifError?.message,
            error_name: notifError?.name,
            error_stack: notifError?.stack?.split('\n')[0],
            job_id: job.id,
            user_id: user_id
          });
          
          // Continuar con el siguiente job (no romper el flujo)
          continue;
        }
      }
    }
    
    // 3. 🔹 Respuesta con jobs
    return res.json({
      success: true,
      data: {
        active_count: result.metadata?.total_active || result.active_count || 0,
        jobs: result.jobs.map(job => ({
          id: job.id,
          batch_id: job.batch_id,
          status: job.status,
          mode: job.mode,
          total_products: job.total_products,
          processed: job.processed,
          successful: job.successful,
          errors_count: job.errors_count,
          percentage: job.percentage,
          createdAt: job.createdAt,
          completed_at: job.completed_at
        }))
      }
    });
    
  } catch (error) {
    logger.error(`[PublishingJobsController.getActiveJobs] Error:\n ${error.message}`);
    return res.status(500).json({
      success: false,
      msg: 'fetch_active_jobs_failed',
      error: error.message
    });
  }
},
  
  /**
   * 🔹 Helper: Crea notificación de publicación completada
   * (Este método se mantiene porque la lógica de notificación es específica del controller)
   */
  async createPublicationNotification(job, stats, channels, userId, companyId) {
   try {
    if (!userId || !companyId || !job?.id) {
      throw new Error(`Datos requeridos faltantes: userId=${userId}, companyId=${companyId}, jobId=${job?.id}`);
    }
    
    // 🔹 Calcular métricas para el mensaje
    const totalChannels = channels?.length || 0;
    const completedChannels = channels?.filter(c => c.status === 'completed')?.length || 0;
    const errorChannels = channels?.filter(c => c.failed > 0 || c.status === 'completed_with_errors')?.length || 0;
    const productsRequiringAttention = stats?.errors || 0;
    
    // 🔹 Construir título según estado general
    let title, emoji;
    if (job.status === 'completed' && errorChannels === 0) {
      emoji = '✅';
      title = 'Publicación exitosa';
    } else if (job.status === 'completed_with_errors' || errorChannels > 0) {
      emoji = '⚠️';
      title = 'Publicación finalizada con errores';
    } else {
      emoji = '❌';
      title = 'Publicación fallida';
    }
    
    // 🔹 Construir descripción con formato solicitado
    const descriptionLines = [];
    
    if (completedChannels > 0) {
      descriptionLines.push(`${completedChannels} marketplace${completedChannels > 1 ? 's' : ''} completado${completedChannels > 1 ? 's' : ''}`);
    }
    if (errorChannels > 0) {
      descriptionLines.push(`${errorChannels} marketplace${errorChannels > 1 ? 's' : ''} con errores`);
    }
    if (productsRequiringAttention > 0) {
      descriptionLines.push(`${productsRequiringAttention} producto${productsRequiringAttention > 1 ? 's' : ''} requiere${productsRequiringAttention > 1 ? 'n' : ''} atención`);
    }
    
    // Si no hay líneas, agregar mensaje por defecto
    if (descriptionLines.length === 0) {
      descriptionLines.push('Sin productos para publicar');
    }
    
    const description = descriptionLines.join('\n');
    
    // 🔹 Datos para acciones en la notificación
    const notificationData = {
      job_id: job.id,
      batch_id: job.batch_id,
      total: stats?.total || 0,
      successful: stats?.successful || 0,
      errors: stats?.errors || 0,
      channels_summary: {
        total: totalChannels,
        completed: completedChannels,
        with_errors: errorChannels
      },
      // Lista detallada de canales para el dialog
      channels: (channels || []).map(c => ({
        credential_id: c.credential_id,
        marketplace_id: c.marketplace_id,
        marketplace_name: c.marketplace_name,
        total: c.total,
        published: c.published,
        failed: c.failed,
        status: c.status,
        percentage: c.percentage
      })),
      timestamp: new Date().toISOString()
    };
    
    // 🔹 Crear notificación para UN SOLO usuario
    const notification = await NotificationRepository.create({
      user_id: userId,
      company_id: companyId,
      title: `${emoji} ${title}`,                    // ✅ Formato: "✅ Publicación exitosa"
      description: description,                      // ✅ Formato multilínea con \n
      type: 'publication_completed',
       notificationData,
      status: 0 // No leída
    });
    
    logger.info(`[PublishingJobsController] Notificación creada: ID ${notification?.id} para job ${job.id}, user ${userId}`);
    return notification;
    
  } catch (error) {
    logger.error(`[PublishingJobsController] Error creando notificación:`, {
      error_name: error?.name,
      error_message: error?.message,
      error_stack: error?.stack?.split('\n')[0],
      context: {
        job_id: job?.id,
        user_id: userId,
        company_id: companyId
      }
    });
    throw error;
  }
    /*try {
    // Validar datos requeridos
    if (!userId || !companyId || !job?.id) {
      throw new Error(`Datos requeridos faltantes: userId=${userId}, companyId=${companyId}, jobId=${job?.id}`);
    }
    
    // Construir mensaje según el estado
    const completedChannels = channels?.filter(c => c.status === 'completed')?.length || 0;
    const errorChannels = channels?.filter(c => c.failed > 0)?.length || 0;
    
    let title, description;
    
    if (job.status === 'completed') {
      title = '✅ Publicación exitosa';
      description = `Publicación completada en ${channels?.length || 1} marketplace${(channels?.length || 1) > 1 ? 's' : ''}`;
    } else if (job.status === 'completed_with_errors') {
      title = '⚠️ Publicación con errores';
      description = `${completedChannels} marketplace${completedChannels > 1 ? 's' : ''} completado${completedChannels > 1 ? 's' : ''}, ${errorChannels} con errores`;
    } else {
      title = '❌ Publicación fallida';
      description = `${stats?.errors || 0} producto${(stats?.errors || 0) !== 1 ? 's' : ''} requiere${(stats?.errors || 0) !== 1 ? 'n' : ''} atención`;
    }
    
    // 🔹 Crear notificación para UN SOLO usuario usando create()
    const notification = await NotificationRepository.create({
      user_id: userId,              // ← Campo individual (no user_ids array)
      company_id: companyId,
      title: title,
      description: description,
      type: 'publication_completed',
       data: {
        job_id: job.id,
        batch_id: job.batch_id,
        total: stats?.total || 0,
        successful: stats?.successful || 0,
        errors: stats?.errors || 0,
        channels: (channels || []).map(c => ({
          credential_id: c.credential_id,
          marketplace_id: c.marketplace_id,
          marketplace_name: c.marketplace_name,
          total: c.total,
          published: c.published,
          failed: c.failed,
          status: c.status
        })),
        timestamp: new Date().toISOString()
      },
      status: 0 // No leída
    });
    
    logger.info(`[PublishingJobsController] Notificación creada: ID ${notification?.id} para job ${job.id}, user ${userId}`);
    return notification;
    
  } catch (error) {
    // 🔍 Log completo del error para debugging
    logger.error(`[PublishingJobsController] Error creando notificación:`, {
      error_name: error?.name,
      error_message: error?.message,
      error_stack: error?.stack?.split('\n')[0],
      error_parent: error?.parent?.message,
      error_original: error?.original?.message,
      context: {
        job_id: job?.id,
        user_id: userId,
        company_id: companyId,
        job_status: job?.status,
        stats: { total: stats?.total, errors: stats?.errors }
      }
    });
    
    // Re-lanzar para que el caller lo maneje
    throw error;
  }*/
},
  
  /**
   * POST /api/publishing-jobs/:jobId/notify
   * Endpoint manual para marcar job como notificado (fallback)
   */
  async markJobNotified(req, res) {
    try {
      const { jobId } = req.params;
      const user_id = req.user?.id;
      
      if (!jobId || !user_id) {
        return res.status(400).json({
          success: false,
          msg: 'jobId and user_id required'
        });
      }
      
      // 🔹 Usar método del repository
      const result = await JobRepository.markJobNotified(jobId, user_id);
      
      return res.json({
        success: true,
        message: result.message,
        data: result
      });
      
    } catch (error) {
      logger.error('[PublishingJobsController.markJobNotified] Error:', error.message);
      return res.status(500).json({
        success: false,
        msg: 'mark_notified_failed',
        error: error.message
      });
    }
  }
};

module.exports = JobController