// src/repositories/JobRepository.js
const { Job, JobProduct, User, Company } = require('../models');
const { Op } = require('sequelize');
const logger = require('../../config/logger');
const JobProductRepository = require('./JobProductRepository');

const JobRepository = {
// Agregar este método en JobRepository.js

/**
 * Obtiene un job por batch_id con estadísticas completas
 * @param {String} batch_id - ID del batch a consultar
 * @param {Number} company_id - ID de la empresa para validación
 * @returns {Object|null} Job con datos completos o null
 */
async findByBatchIdWithStats(batch_id, company_id) {
  try {
    if (!batch_id || !company_id) {
      throw new Error('batch_id y company_id son requeridos');
    }

    const job = await Job.findOne({
      where: { batch_id, company_id },
      attributes: [
        'id', 'batch_id', 'job_type', 'mode', 'draft_name',
        'publication_step', 'status', 'total_products', 'processed', 'successful',
        'errors_count', 'percentage',
        'config', 'error_summary',
        'started_at', 'completed_at',
        'createdAt', 'updatedAt'
      ],
      order: [['createdAt', 'DESC']] // Por si hay múltiples, tomar el más reciente
    });

    if (!job) {
      return null;
    }

    return job.get({ plain: true });

  } catch (error) {
    logger.error(`Error en JobRepository->findByBatchIdWithStats (Batch: ${batch_id}):`, error);
    throw new Error(`Error al obtener job por batch_id: ${error.message}`);
  }
},
  /**
   * Obtiene todos los jobs con filtros opcionales
   */
  async findAll(filters = {}) {
    try {
      const { 
        user_id, 
        company_id, 
        status, 
        job_type, 
        batch_id,
        limit = 50,
        offset = 0,
        includeDetails = false 
      } = filters;

      const where = {};
      if (user_id) where.user_id = user_id;
      if (company_id) where.company_id = company_id;
      if (status) where.status = status;
      if (job_type) where.job_type = job_type;
      if (batch_id) where.batch_id = batch_id;

      const includeOptions = includeDetails ? [
        {
          model: User,
          as: 'user',
          attributes: ['id', 'name', 'email']
        },
        {
          model: Company,
          as: 'company',
          attributes: ['id', 'name']
        }
      ] : [];

      const jobs = await Job.findAll({
        where,
        attributes: [
          'id', 'batch_id', 'job_type', 'mode', 'draft_name',
          'publication_step', 'status', 'total_products', 'processed', 'successful',
          'errors_count', 'percentage', 'config',  // ← Agregar config
          'started_at', 'completed_at',
          'createdAt', 'updatedAt'
        ],
        include: includeOptions,
        order: [['createdAt', 'DESC']],
        limit: parseInt(limit),
        offset: parseInt(offset)
      });

      // Serializar a objetos planos
      return jobs.map(job => job.get({ plain: true }));

    } catch (error) {
      logger.error('Error en JobRepository->findAll:', error);
      throw new Error(`Error al obtener jobs: ${error.message}`);
    }
  },

  /**
   * Obtiene un único job con filtros
   * @param {Object} filters - { where: { ... }, attributes: [...] }
   * @returns {Object|null} Job encontrado o null
   */
  async findOne(filters = {}) {
    try {
      const { where = {}, attributes = null } = filters;

      if (!where || Object.keys(where).length === 0) {
        throw new Error('Debe especificar al menos un filtro en where');
      }

      const job = await Job.findOne({
        where,
        attributes: attributes || [
          'id', 'batch_id', 'job_type', 'mode', 'draft_name',
          'publication_step', 'status', 'total_products', 'processed',
          'successful', 'errors_count', 'percentage',
          'config', 'error_summary',
          'started_at', 'completed_at',
          'createdAt', 'updatedAt'
        ]
      });

      if (!job) {
        return null;
      }

      return job.get({ plain: true });

    } catch (error) {
      logger.error('Error en JobRepository->findOne:', error);
      throw new Error(`Error al obtener job: ${error.message}`);
    }
  },

  /**
   * Obtiene un job por batch_id
   * @param {String} batch_id - UUID del batch
   * @param {Number} company_id - ID de la empresa para validación
   * @returns {Object|null} Job encontrado o null
   */
  async findByBatchId(batch_id, company_id) {
    try {
      if (!batch_id) {
        throw new Error('batch_id es requerido');
      }

      const where = { batch_id };
      if (company_id) {
        where.company_id = company_id;
      }

      return await this.findOne({ where });

    } catch (error) {
      logger.error(`Error en JobRepository->findByBatchId (Batch: ${batch_id}):`, error);
      throw new Error(`Error al obtener job por batch: ${error.message}`);
    }
  },

  /**
   * Obtiene un job por ID con datos completos
   */
// src/repositories/JobRepository.js

/**
 * Obtiene un job por ID con datos completos
 * @param {Number} id - ID del job
 * @param {Object} options - { includeUser: boolean, includeProducts: boolean }
 */
async findById(id, options = {}) {
  try {
    if (!id) {
      throw new Error('El ID del job es requerido');
    }

    const { includeUser = false, includeProducts = false } = options;

    const includeOptions = [];

    // ✅ Incluir User si se solicita
    if (includeUser) {
      includeOptions.push({
        model: User,
        as: 'user',
        attributes: ['id', 'name', 'email']
      });
    }

    // ✅ Incluir JobProducts si se solicita
    if (includeProducts) {
      includeOptions.push({
        model: JobProduct,
        as: 'jobProducts',
        attributes: [
          'id', 'product_id', 'marketplace_id', 'credential_id',
          'status', 'external_id', 'error_message', 'attempt_count',
          'createdAt'
        ],
        order: [['createdAt', 'ASC']]
      });
    }

    const job = await Job.findByPk(id, {
      attributes: [
        'id', 'user_id', 'company_id', 'batch_id',
        'job_type', 'mode', 'draft_name',
        'status', 'total_products', 'processed', 'successful',
        'errors_count', 'percentage',
        'config', 'error_summary',
        'started_at', 'completed_at',
        'createdAt', 'updatedAt'
      ],
      include: includeOptions
    });

    if (!job) {
      return null;
    }

    return job.get({ plain: true });

  } catch (error) {
    logger.error(`Error en JobRepository->findById (ID: ${id}):`, error);
    throw new Error(`Error al obtener el job: ${error.message}`);
  }
},

  /**
   * Crea un nuevo job padre
   */
  async create(data) {
    try {
      const {
        user_id,
        company_id,
        batch_id,
        job_type,
        mode,
        draft_name,
        publication_step,
        config = {},
        total_products = 0
      } = data;

      // Validaciones básicas
      if (!company_id) {
        throw new Error('company_id es requerido');
      }
      if (!batch_id) {
        throw new Error('batch_id es requerido');
      }
      if (!['publish', 'draft', 'sync'].includes(job_type)) {
        throw new Error('job_type debe ser publish, draft o sync');
      }

      const job = await Job.create({
        user_id: user_id || null,
        company_id,
        batch_id,
        job_type,
        mode: mode || null,
        draft_name: draft_name || null,
        publication_step: publication_step !== undefined ? parseInt(publication_step) : 0,
        status: 'pending',
        total_products: parseInt(total_products) || 0,
        processed: 0,
        successful: 0,
        errors_count: 0,
        percentage: 0,
        config: config || {},
        started_at: null,
        completed_at: null,
        error_summary: null
      });

      logger.info(`Job creado: ID ${job.id}, Batch ${job.batch_id}, Tipo ${job.job_type}`);
      return job.get({ plain: true });

    } catch (error) {
      logger.error('Error en JobRepository->create:', error);
      throw new Error(`Error al crear job: ${error.message}`);
    }
  },

  /**
   * Actualiza un job existente (solo campos permitidos)
   */
  async update(job, data) {
    try {
      if (!job || !job.id) {
        throw new Error('Job inválido para actualizar');
      }

      // Campos permitidos para actualización
      const allowedFields = [
        'job_type', 'mode', 'draft_name', 'publication_step',
        'total_products',
        'status', 'processed', 'successful', 'errors_count', 
        'percentage', 'started_at', 'completed_at', 
        'error_summary', 'config'
      ];

      const updateData = {};
      for (const field of allowedFields) {
        if (data[field] !== undefined) {
          updateData[field] = data[field];
        }
      }

      // Si no hay nada para actualizar, retornar tal cual
      if (Object.keys(updateData).length === 0) {
        return job.get({ plain: true });
      }

      await job.update(updateData);
      logger.info(`Job actualizado (ID: ${job.id}): ${JSON.stringify(updateData)}`);
      return job.get({ plain: true });

    } catch (error) {
      logger.error(`Error en JobRepository->update (ID: ${job?.id}):`, error);
      throw new Error(`Error al actualizar job: ${error.message}`);
    }
  },

  /**
   * Actualiza el progreso del job con cálculo automático de porcentaje
   */
  async updateProgress(jobId, { processed, successful, errors_count }) {
    try {
      const job = await Job.findByPk(jobId);
      if (!job) {
        throw new Error(`Job no encontrado (ID: ${jobId})`);
      }

      const total = job.total_products || 0;
      const percentage = total > 0 
        ? Math.min(100, Math.round((processed / total) * 100)) 
        : 0;

      const updateData = {
        processed: processed !== undefined ? processed : job.processed,
        successful: successful !== undefined ? successful : job.successful,
        errors_count: errors_count !== undefined ? errors_count : job.errors_count,
        percentage
      };

      return await this.update(job, updateData);

    } catch (error) {
      logger.error(`Error en JobRepository->updateProgress (ID: ${jobId}):`, error);
      throw new Error(`Error al actualizar progreso: ${error.message}`);
    }
  },

  /**
   * Marca el job como iniciado (processing)
   */
  async startProcessing(jobId) {
    try {
      const job = await Job.findByPk(jobId);
      if (!job) {
        throw new Error(`Job no encontrado (ID: ${jobId})`);
      }

      if (['completed', 'failed', 'cancelled'].includes(job.status)) {
        throw new Error(`No se puede iniciar job en estado: ${job.status}`);
      }

      return await this.update(job, {
        status: 'processing',
        started_at: new Date()
      });

    } catch (error) {
      logger.error(`Error en JobRepository->startProcessing (ID: ${jobId}):`, error);
      throw new Error(`Error al iniciar job: ${error.message}`);
    }
  },

  /**
   * ✅ Recalcula el progreso de un job basándose en los JobProduct
   * Actualiza: processed, successful, errors_count, percentage
   * @param {Number} jobId - ID del job
   * @returns {Object} Job actualizado
   */
  async recalculateProgress(jobId) {
    try {
      const job = await Job.findByPk(jobId);
      if (!job) {
        throw new Error(`Job no encontrado (ID: ${jobId})`);
      }
      const stats = await JobProductRepository.getStatsByJob(jobId);
      const processed = stats.processed || 0;
      const successful = stats.successful || 0;
      const errors_count = stats.errors || 0;

      const total = job.total_products || 0;
      const percentage = total > 0
        ? Math.min(100, Math.round((processed / total) * 100))
        : 0;

      // Determinar estado del job según progreso
      let status = job.status;
      const hasActiveItems = (stats.pending || 0) > 0 || (stats.processing || 0) > 0 || (stats.retrying || 0) > 0;

      if (processed >= total && total > 0) {
        status = errors_count > 0 ? 'completed_with_errors' : 'completed';
      } else if (hasActiveItems || processed > 0) {
        status = 'processing';
      } else if (job.status === 'pending') {
        status = 'processing'; // Si hay al menos un producto procesado, el job está en proceso
      }

      // Actualizar job
      await this.update(job, {
        status,
        processed,
        successful,
        errors_count,
        percentage
      });

      logger.info(`[JobRepository] Job ${jobId} recalculado: ${processed}/${total} procesados, ${successful} éxitos, ${errors_count} errores (${percentage}%)`);

      return job.get({ plain: true });

    } catch (error) {
      logger.error(`Error en JobRepository->recalculateProgress (ID: ${jobId}):`, error);
      throw new Error(`Error al recalcular progreso: ${error.message}`);
    }
  },

  /**
   * Marca el job como completado
   */
  // Cuando se complete un job, verificar si hay errores
async complete(jobId, { successful, errors_count, error_summary = null }) {
  const job = await Job.findByPk(jobId);

  // ✅ Determinar estado correcto según errores
  // ✅ Usamos 'completed_with_errors' si hubo errores, 'completed' si fue exitoso
  const finalStatus = errors_count > 0 ? 'completed_with_errors' : 'completed';

  await job.update({
    status: finalStatus,
    successful,
    errors_count,
    error_summary,
    completed_at: new Date()
  });

  logger.info(`[JobRepository] Job ${jobId} completado: ${successful} éxitos, ${errors_count} errores`);

  return job.get({ plain: true });
},

  /**
   * Marca el job como fallido
   */
  async fail(jobId, error_message, error_details = null) {
    try {
      const job = await Job.findByPk(jobId);
      if (!job) {
        throw new Error(`Job no encontrado (ID: ${jobId})`);
      }

      const error_summary = {
        message: error_message,
        details: error_details,
        timestamp: new Date().toISOString()
      };

      return await this.update(job, {
        status: 'failed',
        error_summary,
        completed_at: new Date()
      });

    } catch (error) {
      logger.error(`Error en JobRepository->fail (ID: ${jobId}):`, error);
      throw new Error(`Error al marcar job como fallido: ${error.message}`);
    }
  },

  /**
   * Cancela un job (solo si está pending o processing)
   */
  async cancel(jobId) {
    try {
      const job = await Job.findByPk(jobId);
      if (!job) {
        throw new Error(`Job no encontrado (ID: ${jobId})`);
      }

      if (!['pending', 'processing'].includes(job.status)) {
        throw new Error(`No se puede cancelar job en estado: ${job.status}`);
      }

      return await this.update(job, {
        status: 'cancelled',
        completed_at: new Date()
      });

    } catch (error) {
      logger.error(`Error en JobRepository->cancel (ID: ${jobId}):`, error);
      throw new Error(`Error al cancelar job: ${error.message}`);
    }
  },

  /**
   * Obtiene jobs activos de un usuario/empresa para polling
   */
  async getActiveJobs({ user_id, company_id, limit = 5 }) {
    try {
      const where = {
        company_id,
        status: { [Op.in]: ['pending', 'processing'] }
      };
      if (user_id) {
        where.user_id = user_id;
      }

      const jobs = await Job.findAll({
        where,
        attributes: [
          'id', 'batch_id', 'job_type', 'mode', 'draft_name',
          'status', 'percentage', 'processed', 'total_products',
          'createdAt', 'started_at'
        ],
        order: [['createdAt', 'DESC']],
        limit: parseInt(limit) || 5
      });

      return jobs.map(job => job.get({ plain: true }));

    } catch (error) {
      logger.error('Error en JobRepository->getActiveJobs:', error);
      throw new Error(`Error al obtener jobs activos: ${error.message}`);
    }
  },

  /**
   * Elimina un job (soft delete vía status, o hard delete si se requiere)
   */
  async delete(jobId) {
    try {
      if (!jobId) {
        throw new Error('Job ID es requerido para eliminar');
      }

      const deleted = await Job.destroy({
        where: { id: jobId }
      });

      if (deleted === 0) {
        throw new Error('Job no encontrado');
      }

      logger.info(`Job eliminado físicamente (ID: ${jobId})`);
      return { success: true, message: 'Job eliminado correctamente', job_id: jobId };

    } catch (error) {
      logger.error(`Error en JobRepository->delete (ID: ${jobId}):`, error);
      throw new Error(`Error al eliminar job: ${error.message}`);
    }
  },

  /**
   * Limpia jobs antiguos completados (tarea de mantenimiento)
   */
  async cleanupOldJobs({ days = 30, status = 'completed' }) {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - days);

      const { count } = await Job.destroy({
        where: {
          status,
          completed_at: { [Op.lte]: cutoffDate }
        }
      });

      logger.info(`Limpieza de jobs: ${count} registros eliminados (status: ${status}, > ${days} días)`);
      return { success: true, deleted_count: count };

    } catch (error) {
      logger.error('Error en JobRepository->cleanupOldJobs:', error);
      throw new Error(`Error al limpiar jobs antiguos: ${error.message}`);
    }
  },

  /**
 * Verifica si un job ya fue notificado a un usuario
 * @param {Number} jobId - ID del job
 * @param {Number} userId - ID del usuario
 * @returns {Boolean} true si ya fue notificado, false si no
 */
async checkIfJobNotified(jobId, userId) {
  try {
    if (!jobId || !userId) {
      throw new Error('jobId y userId son requeridos');
    }

    const job = await Job.findByPk(jobId, { 
      attributes: ['notified_users'] 
    });
    
    if (!job) {
      logger.warn(`[JobRepository.checkIfJobNotified] Job no encontrado (ID: ${jobId})`);
      return true; // Si no existe, asumir notificado para evitar spam
    }

    const notifiedUsers = job.notified_users || [];
    const isNotified = notifiedUsers.includes(userId);
    
    logger.debug(`[JobRepository.checkIfJobNotified] Job ${jobId} para user ${userId}: ${isNotified ? 'notificado' : 'no notificado'}`);
    
    return isNotified;

  } catch (error) {
    logger.error(`Error en JobRepository->checkIfJobNotified (Job: ${jobId}, User: ${userId}):`, error);
    throw new Error(`Error al verificar notificación de job: ${error.message}`);
  }
},

/**
 * Marca un job como notificado para un usuario
 * @param {Number} jobId - ID del job
 * @param {Number} userId - ID del usuario
 * @returns {Object} Resultado de la operación
 */
async markJobNotified(jobId, userId) {
  try {
    if (!jobId || !userId) {
      throw new Error('jobId y userId son requeridos');
    }

    const job = await Job.findByPk(jobId);
    
    if (!job) {
      logger.warn(`[JobRepository.markJobNotified] Job no encontrado (ID: ${jobId})`);
      return { success: false, message: 'Job no encontrado' };
    }

    // Obtener array de usuarios notificados (o crear uno vacío)
    const notifiedUsers = job.notified_users || [];
    
    // Solo agregar si no está ya en la lista
    if (!notifiedUsers.includes(userId)) {
      notifiedUsers.push(userId);
      
      await job.update({ 
        notified_users: notifiedUsers 
      });
      
      logger.info(`[JobRepository.markJobNotified] Job ${jobId} marcado como notificado para user ${userId}`);
      
      return { 
        success: true, 
        message: 'Job marcado como notificado',
        notified_users: notifiedUsers
      };
    }
    
    logger.debug(`[JobRepository.markJobNotified] Job ${jobId} ya estaba notificado para user ${userId}`);
    
    return { 
      success: true, 
      message: 'Job ya estaba notificado',
      notified_users: notifiedUsers
    };

  } catch (error) {
    logger.error(`Error en JobRepository->markJobNotified (Job: ${jobId}, User: ${userId}):`, error);
    throw new Error(`Error al marcar job como notificado: ${error.message}`);
  }
},

/**
 * Obtiene jobs completados no notificados para un usuario
 * @param {Number} userId - ID del usuario
 * @param {Number} company_id - ID de la empresa
 * @param {Object} options - Opciones adicionales
 * @returns {Array} Lista de jobs no notificados
 */
async getCompletedJobsNotNotified(userId, company_id, options = {}) {
  try {
    if (!userId || !company_id) {
      throw new Error('userId y company_id son requeridos');
    }

    const { limit = 20 } = options;

    // Obtener jobs completados recientemente
    const jobs = await Job.findAll({
      where: {
        company_id,
        user_id: userId,
        job_type: 'publish',
        status: { [Op.in]: ['completed', 'completed_with_errors', 'failed'] }
      },
      attributes: [
        'id', 'batch_id', 'status', 'job_type', 'mode',
        'total_products', 'processed', 'successful', 
        'errors_count', 'percentage',
        'completed_at', 'createdAt'
      ],
      order: [['completed_at', 'DESC']],
      limit: parseInt(limit) || 20
    });

    // Filtrar jobs que no han sido notificados
    const notNotifiedJobs = [];
    
    for (const job of jobs) {
      const notifiedUsers = job.notified_users || [];
      
      if (!notifiedUsers.includes(userId)) {
        notNotifiedJobs.push(job.get({ plain: true }));
      }
    }

    logger.debug(`[JobRepository.getCompletedJobsNotNotified] User ${userId}: ${notNotifiedJobs.length} jobs no notificados`);
    
    return notNotifiedJobs;

  } catch (error) {
    logger.error(`Error en JobRepository->getCompletedJobsNotNotified (User: ${userId}):`, error);
    throw new Error(`Error al obtener jobs no notificados: ${error.message}`);
  }
},

/**
 * Obtiene todos los jobs activos (pending/processing) + completados recientes
 * @param {Number} userId - ID del usuario
 * @param {Number} company_id - ID de la empresa
 * @param {Object} options - Opciones adicionales
 * @returns {Object} Jobs activos y completados con metadata
 */
async getActiveAndCompletedJobs(userId, company_id, options = {}) {
  try {
    if (!userId || !company_id) {
      throw new Error('userId y company_id son requeridos');
    }

    const { limit = 20, includeNotNotified = true } = options;

    // Obtener jobs activos y completados
    const allJobs = await Job.findAll({
      where: {
        company_id,
        user_id: userId,
        job_type: 'publish',
        status: { 
          [Op.in]: ['pending', 'processing', 'completed', 'completed_with_errors', 'failed'] 
        }
      },
      attributes: [
        'id', 'batch_id', 'status', 'job_type', 'mode',
        'total_products', 'processed', 'successful', 
        'errors_count', 'percentage',
        'completed_at', 'createdAt', 'updatedAt'
      ],
      order: [['createdAt', 'DESC']],
      limit: parseInt(limit) || 20
    });

    const jobsPlain = allJobs.map(job => job.get({ plain: true }));
    
    // Separar activos y completados
    const activeJobs = jobsPlain.filter(j => ['pending', 'processing'].includes(j.status));
    const completedJobs = jobsPlain.filter(j => ['completed', 'completed_with_errors', 'failed'].includes(j.status));
    
    // Si se solicita, filtrar solo los no notificados
    let jobsToReturn = jobsPlain;
    let notNotifiedCount = 0;
    
    if (includeNotNotified) {
      const notNotifiedJobs = [];
      
      for (const job of completedJobs) {
        const notifiedUsers = job.notified_users || [];
        
        if (!notifiedUsers.includes(userId)) {
          notNotifiedJobs.push(job);
          notNotifiedCount++;
        }
      }
      
      jobsToReturn = [...activeJobs, ...notNotifiedJobs];
    }

    logger.debug(`[JobRepository.getActiveAndCompletedJobs] User ${userId}: ${activeJobs.length} activos, ${completedJobs.length} completados, ${notNotifiedCount} no notificados`);
    
    return {
      active_count: activeJobs.length,
      jobs: jobsToReturn,
      metadata: {
        total_active: activeJobs.length,
        total_completed: completedJobs.length,
        not_notified: notNotifiedCount
      }
    };

  } catch (error) {
    logger.error(`Error en JobRepository->getActiveAndCompletedJobs (User: ${userId}):`, error);
    throw new Error(`Error al obtener jobs activos y completados: ${error.message}`);
  }
},

/**
 * GET /api/jobs/finished
 * Lista jobs finalizados con filtros y paginación
 * body: { company_id, user_id, status_filter, channel_id, date_range, search, page, limit }
 */
async listFinishedJobs(req, res) {
  try {
    const {
      company_id,
      user_id,
      status_filter = 'all',
      channel_id,
      date_range = '30d',
      search,
      page = 1,
      limit = 20
    } = req.body;

    // Validaciones
    if (!company_id) {
      return res.status(400).json({ success: false, msg: 'company_id_required' });
    }

    // Mapeo de filtros de status
    const statusMap = {
      'all': ['completed', 'completed_with_errors', 'failed'],
      'completed': ['completed'],
      'completed_with_errors': ['completed_with_errors'],
      'failed': ['failed'],
      'requires_attention': ['completed_with_errors']
    };
    const statuses = statusMap[status_filter] || statusMap.all;

    // Filtro de fecha
    let date_from = null;
    if (date_range !== 'all') {
      const days = parseInt(date_range);
      date_from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    }

    // ✅ 1. Obtener jobs desde Repository con paginación
    const { count, rows: jobs } = await JobRepository.findAndCountFinished({
      company_id,
      user_id,
      statuses,
      date_from,
      search_term: search,
      limit: parseInt(limit),
      offset: (parseInt(page) - 1) * parseInt(limit)
    });

    // ✅ 2. Enriquecer cada job con conteo de canales (usando JobProductRepository)
    const enrichedJobs = await Promise.all(jobs.map(async (job) => {
      const channelCount = await JobProductRepository.countDistinctChannelsByJob(job.id);
      
      return {
        id: job.id,
        batch_id: job.batch_id,
        display_id: `J-${String(job.id).padStart(5, '0')}`,
        status: job.status,
        createdAt: job.completed_at || job.createdAt,
        user_name: job.user?.name || 'N/A',
        channelsCount: channelCount,
        productsTotal: job.total_products,
        publishedCount: job.successful,
        errorCount: job.errors_count,
        percentage: job.percentage,
        draft_name: job.draft_name
      };
    }));

    return res.json({
      success: true,
      data: {
        jobs: enrichedJobs,
        pagination: {
          total: count,
          page: parseInt(page),
          limit: parseInt(limit),
          pages: Math.ceil(count / limit)
        }
      }
    });

  } catch (error) {
    logger.error(`[JobController.listFinishedJobs] Error: ${error.message}`, { stack: error.stack });
    return res.status(500).json({
      success: false,
      msg: 'fetch_finished_jobs_failed',
      error: error.message
    });
  }
},

/**
 * Obtiene jobs finalizados con filtros y paginación
 */
async findAndCountFinished(filters) {
  try {
    const {
      company_id,
      user_id,
      statuses = ['completed', 'completed_with_errors', 'failed'],
      date_from,
      search_term,
      limit = 20,
      offset = 0
    } = filters;

    const { Op } = require('sequelize');
    
    const where = {
      company_id,
      job_type: 'publish',
      status: { [Op.in]: statuses },
      completed_at: { [Op.ne]: null }
    };

    if (user_id) where.user_id = user_id;
    if (date_from) where.completed_at = { ...where.completed_at, [Op.gte]: date_from };

    if (search_term) {
      where[Op.or] = [
        { batch_id: { [Op.like]: `%${search_term}%` } },
        { draft_name: { [Op.like]: `%${search_term}%` } }
      ];
    }

    return await Job.findAndCountAll({
      where,
      attributes: [
        'id', 'batch_id', 'job_type', 'mode', 'draft_name',
        'status', 'total_products', 'processed', 'successful',
        'errors_count', 'percentage',
        'started_at', 'completed_at', 'createdAt'
      ],
      include: [{
        model: User,
        as: 'user',
        attributes: ['id', 'name']
      }],
      order: [['completed_at', 'DESC']],
      limit: parseInt(limit),
      offset: parseInt(offset),
      raw: false
    });
  } catch (error) {
    logger.error('Error en JobRepository->findAndCountFinished:', error);
    throw new Error(`Error al obtener jobs finalizados: ${error.message}`);
  }
},
};

module.exports = JobRepository;
