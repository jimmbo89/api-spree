// src/repositories/JobProductRepository.js
const { JobProduct, Job, Product, Marketplace, MarketplaceCredential, ProductPublishingTask } = require('../models');
const { Op } = require('sequelize');
const logger = require('../../config/logger');

const JobProductRepository = {

  // ========================================================================
  // 📊 MÉTODOS DE ESTADÍSTICAS (Sin cambios)
  // ========================================================================

  /**
   * Obtiene estadísticas agrupadas por marketplace para un job
   */
  async getStatsByJobAndMarketplace(jobId) {
  try {
    if (!jobId) throw new Error('job_id es requerido');

    const { JobProduct, Marketplace, MarketplaceCredential } = require('../models');
    const { fn, col } = require('sequelize');

    const stats = await JobProduct.findAll({
      attributes: [
        'marketplace_id',
        'credential_id', 
        'status',
        // 🔑 CORREGIDO: Especificar tabla JobProduct para el COUNT
        [fn('COUNT', col('JobProduct.id')), 'count']
      ],
      include: [
        { 
          model: Marketplace, 
          as: 'marketplace', 
          attributes: ['id', 'name', 'domain'], 
          required: false 
        },
        { 
          model: MarketplaceCredential, 
          as: 'credential', 
          attributes: ['id', 'name', 'seller_email'], 
          required: false 
        }
      ],
      where: { job_id: jobId },
      // 🔑 CORREGIDO: Prefixear columnas del GROUP BY con la tabla principal
      group: ['JobProduct.marketplace_id', 'JobProduct.credential_id', 'JobProduct.status'],
      raw: true,
      nest: true
    });

    const grouped = {};
    stats.forEach(row => {
      const key = `${row.marketplace_id}-${row.credential_id}`;
      
      if (!grouped[key]) {
        grouped[key] = {
          marketplace_id: row.marketplace_id,
          marketplace_name: row.marketplace?.name || 'Marketplace',
          marketplace_domain: row.marketplace?.domain || '',
          credential_id: row.credential_id,
          credential_name: row.credential?.name || `Credencial ${row.credential_id}`,
          seller_email: row.credential?.seller_email || null,
          total: 0, processed: 0, published: 0, failed: 0, pending: 0
        };
      }
      
      const count = parseInt(row.count) || 0;
      grouped[key].total += count;
      
      if (['success', 'error'].includes(row.status)) grouped[key].processed += count;
      if (row.status === 'success') grouped[key].published += count;
      if (row.status === 'error') grouped[key].failed += count;
      if (['pending', 'processing'].includes(row.status)) grouped[key].pending += count;
    });

    return Object.values(grouped).map(channel => ({
      ...channel,
      percentage: channel.total > 0 
        ? Math.round((channel.processed / channel.total) * 100) 
        : 0,
      status: this._getChannelStatus(channel)
    }));

  } catch (error) {
    logger.error(`Error en JobProductRepository->getStatsByJobAndMarketplace:`, error);
    throw new Error(`Error al obtener estadísticas por marketplace: ${error.message}`);
  }
},

  _getChannelStatus(channel) {
    if (channel.failed > 0 && channel.processed >= channel.total) return 'completed_with_errors';
    if (channel.processed >= channel.total && channel.total > 0) {
      return channel.failed === 0 ? 'completed' : 'completed_with_errors';
    }
    if (channel.processed > 0) return 'processing';
    return 'queued';
  },

  // ========================================================================
  // 🔍 MÉTODOS DE LECTURA (Actualizados para incluir marketplace_payload)
  // ========================================================================

  /**
   * Obtiene productos de un job con filtros
   * ✅ Ahora incluye product_payload y marketplace_payload
   */
  async findAllByJob(jobId, filters = {}) {
    try {
      if (!jobId) throw new Error('job_id es requerido');

      const { 
        status, marketplace_id, credential_id,
        limit = 100, offset = 0,
        includeDetails = false,
        includePayloads = false  // ← NUEVO: flag para incluir payloads (evita cargar JSON grandes innecesariamente)
      } = filters;

      const where = { job_id: jobId };
      if (status) where.status = status;
      if (marketplace_id) where.marketplace_id = marketplace_id;
      if (credential_id) where.credential_id = credential_id;

      // Atributos base
      const baseAttributes = [
        'id', 'product_id', 'marketplace_id', 'credential_id',
        'status', 'external_id', 'external_url',
        'error_message', 'attempt_count', 'last_attempt_at',
        'createdAt', 'updatedAt'
      ];

      // Agregar payloads solo si se solicitan explícitamente
      if (includePayloads) {
        baseAttributes.push('product_payload', 'marketplace_payload');
      }

      const includeOptions = includeDetails ? [
        { model: Product, as: 'product' },
        { model: Marketplace, as: 'marketplace' },
        { model: MarketplaceCredential, as: 'credential'}
      ] : [];

      const jobProducts = await JobProduct.findAll({
        where,
        attributes: baseAttributes,
        include: includeOptions,
        order: [['createdAt', 'ASC']],
        limit: parseInt(limit),
        offset: parseInt(offset),
        raw: false  // ← Importante: false para que Sequelize aplique getters de JSON
      });

      // Convertir a POJOs y asegurar que los JSON se parseen correctamente
      return jobProducts.map(item => {
        const data = item.get({ plain: true });
        // Parsear manualmente si Sequelize no lo hizo (fallback para MySQL < 5.7)
        if (includePayloads) {
          if (typeof data.product_payload === 'string') {
            try { data.product_payload = JSON.parse(data.product_payload); } catch (e) { data.product_payload = null; }
          }
          if (typeof data.marketplace_payload === 'string') {
            try { data.marketplace_payload = JSON.parse(data.marketplace_payload); } catch (e) { data.marketplace_payload = null; }
          }
        }
        return data;
      });

    } catch (error) {
      logger.error(`Error en JobProductRepository->findAllByJob (Job: ${jobId}):`, error);
      throw new Error(`Error al obtener productos del job: ${error.message}`);
    }
  },

  /**
   * Obtiene todos los job_products con filtros opcionales
   * @param {Object} filters - { where: {...}, attributes: [...], limit, offset }
   * @returns {Array} Lista de job_products encontrados
   */
  async findAll(filters = {}) {
    try {
      const {
        where = {},
        attributes = [
          'id', 'job_id', 'product_id', 'marketplace_id', 'credential_id',
          'status', 'external_id', 'external_url',
          'error_message', 'error_details', 'attempt_count', 'last_attempt_at',
          'product_payload', 'marketplace_payload',
          'createdAt', 'updatedAt'
        ],
        include = [],
        order = [['createdAt', 'ASC']],
        limit,
        offset
      } = filters;

      const queryOptions = {
        where,
        attributes,
        include,
        order
      };

      if (limit) queryOptions.limit = parseInt(limit);
      if (offset) queryOptions.offset = parseInt(offset);

      const jobProducts = await JobProduct.findAll(queryOptions);

      return jobProducts.map(item => item.get({ plain: true }));

    } catch (error) {
      logger.error('Error en JobProductRepository->findAll:', error);
      throw new Error(`Error al obtener job_products: ${error.message}`);
    }
  },

  /**
   * Obtiene un producto de job por ID
   * ✅ Ahora incluye marketplace_payload
   */
async findById(id, options = {}) {
  try {
    if (!id) throw new Error('El ID del job es requerido');
    
    const { includeUser = false, includeProducts = false } = options;
    
    const includeOptions = [];
    
    if (includeUser) {
      includeOptions.push({
        model: User,
        as: 'user',
        attributes: ['id', 'name', 'email']
      });
    }
    
    if (includeProducts) {
      includeOptions.push({
        model: JobProduct,
        as: 'jobProducts',
        attributes: ['id', 'product_id', 'marketplace_id', 'credential_id', 'status'],
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

    if (!job) return null;
    return job.get({ plain: true });
    
  } catch (error) {
    logger.error(`Error en JobRepository->findById (ID: ${id}):`, error);
    throw new Error(`Error al obtener el job: ${error.message}`);
  }
},

  /**
   * Busca un producto específico dentro de un job
   * ✅ Ahora puede incluir payloads si se solicita
   */
  async findByProductAndMarketplace(jobId, product_id, marketplace_id, credential_id = null, options = {}) {
    try {
      if (!jobId || !product_id || !marketplace_id) {
        throw new Error('job_id, product_id y marketplace_id son requeridos');
      }

      const where = { job_id: jobId, product_id, marketplace_id };
      if (credential_id) where.credential_id = credential_id;

      const attributes = [
        'id', 'status', 'external_id', 'external_url',
        'error_message', 'attempt_count', 'product_payload'
      ];
      
      // Incluir marketplace_payload si se solicita
      if (options.includePayloads) {
        attributes.push('marketplace_payload');
      }

      const jobProduct = await JobProduct.findOne({ where, attributes, raw: false });
      if (!jobProduct) return null;

      const data = jobProduct.get({ plain: true });
      // Fallback de parseo
      if (options.includePayloads) {
        if (typeof data.product_payload === 'string') {
          try { data.product_payload = JSON.parse(data.product_payload); } catch (e) { data.product_payload = null; }
        }
        if (typeof data.marketplace_payload === 'string') {
          try { data.marketplace_payload = JSON.parse(data.marketplace_payload); } catch (e) { data.marketplace_payload = null; }
        }
      }
      return data;

    } catch (error) {
      logger.error(`Error en JobProductRepository->findByProductAndMarketplace:`, error);
      throw new Error(`Error al buscar producto: ${error.message}`);
    }
  },

  // ========================================================================
  // ✏️ MÉTODOS DE ESCRITURA (Corregidos para manejar payloads JSON)
  // ========================================================================

  /**
   * Crea un nuevo registro de producto en job
   * ✅ CORREGIDO: Ahora guarda product_payload y marketplace_payload correctamente
   */
  async create(data) {
    try {
      const {
        job_id, product_id, marketplace_id, credential_id,
        product_payload, marketplace_payload,  // ← NUEVO: marketplace_payload
        status = 'pending'
      } = data;

      // Validaciones
      if (!job_id || !product_id || !marketplace_id) {
        throw new Error('job_id, product_id y marketplace_id son requeridos');
      }
      if (!['pending', 'processing', 'success', 'error', 'retrying'].includes(status)) {
        throw new Error('status inválido');
      }

      // 🔑 Preparar payload para Sequelize:
      // - Si ya es objeto, Sequelize lo serializa automáticamente (DataTypes.JSON)
      // - Si es string, lo dejamos así (compatibilidad)
      // - Si es undefined/null, guardamos null
      const preparePayload = (payload) => {
        if (!payload) return null;
        if (typeof payload === 'string') return payload;
        if (typeof payload === 'object') {
          // Deep clone seguro para eliminar funciones, undefined, símbolos
          try {
            return JSON.parse(JSON.stringify(payload));
          } catch (e) {
            logger.warn('[JobProductRepository] Payload no serializable, guardando como null', { error: e.message });
            return null;
          }
        }
        return null;
      };

      const jobProduct = await JobProduct.create({
        job_id: Number(job_id),  // ← Asegurar que sea número, no objeto
        product_id: Number(product_id),
        marketplace_id: Number(marketplace_id),
        credential_id: credential_id ? Number(credential_id) : null,
        status,
        external_id: null,
        external_url: null,
        error_message: null,
        error_details: null,
        attempt_count: 0,
        last_attempt_at: null,
        product_payload: preparePayload(product_payload),
        marketplace_payload: preparePayload(marketplace_payload)  // ← NUEVO
      });

      logger.debug(`JobProduct creado: ID ${jobProduct.id}, Producto ${product_id}, Marketplace ${marketplace_id}, Credential ${credential_id}`);
      return jobProduct.get({ plain: true });

    } catch (error) {
      logger.error('Error en JobProductRepository->create:', error);
      throw new Error(`Error al crear producto de job: ${error.message}`);
    }
  },

  /**
   * Crea múltiples registros en bulk (para inicializar jobs)
   * ✅ CORREGIDO: Ahora maneja ambos payloads
   */
  async bulkCreate(items) {
    try {
      if (!Array.isArray(items) || items.length === 0) return [];

      const preparePayload = (payload) => {
        if (!payload) return null;
        if (typeof payload === 'string') return payload;
        if (typeof payload === 'object') {
          try { return JSON.parse(JSON.stringify(payload)); } catch (e) { return null; }
        }
        return null;
      };

      const validItems = items.map(item => {
        // 🔑 Validar que job_id sea número, no objeto
        const jobId = typeof item.job_id === 'object' && item.job_id?.id 
          ? item.job_id.id 
          : Number(item.job_id);
        
        if (!jobId || isNaN(jobId)) {
          throw new Error(`job_id inválido en item: ${JSON.stringify(item.job_id)}`);
        }

        return {
          job_id: jobId,
          product_id: Number(item.product_id),
          marketplace_id: Number(item.marketplace_id),
          credential_id: item.credential_id ? Number(item.credential_id) : null,
          status: item.status || 'pending',
          product_payload: preparePayload(item.product_payload),
          marketplace_payload: preparePayload(item.marketplace_payload),  // ← NUEVO
          attempt_count: 0,
          external_id: null,
          external_url: null,
          error_message: null,
          error_details: null,
          last_attempt_at: null
        };
      });

      const created = await JobProduct.bulkCreate(validItems, {
        validate: true,
        individualHooks: false
      });

      logger.info(`JobProducts creados en bulk: ${created.length} registros`);
      return created.map(item => item.get({ plain: true }));

    } catch (error) {
      logger.error(`Error en JobProductRepository->bulkCreate: ${error}`);
      throw new Error(`Error al crear productos en masa: ${error.message}`);
    }
  },

  /**
   * Actualiza un producto de job
   * ✅ CORREGIDO: marketplace_payload ahora está en allowedFields
   */
  async update(jobProduct, data) {
    try {
      const id = typeof jobProduct === 'object' && jobProduct?.id 
        ? jobProduct.id 
        : jobProduct;
      
      if (!id) throw new Error('JobProduct ID es requerido');

      // 🔑 Allowed fields actualizado con marketplace_payload y task_id
      const allowedFields = [
        'status', 'external_id', 'external_url',
        'error_message', 'error_details',
        'attempt_count', 'last_attempt_at',
        'product_payload', 'marketplace_payload',  // ← NUEVO
        'task_id'  // ✅ Referencia al product_publishing_task
      ];
      
      const updateData = {};
      for (const field of allowedFields) {
        if (data[field] !== undefined) {
          // Serializar si es objeto y el campo es payload JSON
          if (['product_payload', 'marketplace_payload'].includes(field) && typeof data[field] === 'object') {
            updateData[field] = JSON.parse(JSON.stringify(data[field]));
          } else {
            updateData[field] = data[field];
          }
        }
      }

      if (Object.keys(updateData).length === 0) {
        return typeof jobProduct === 'object' && jobProduct.get 
          ? jobProduct.get({ plain: true }) 
          : { id, ...data };
      }
      
      if (updateData.status && ['success', 'error'].includes(updateData.status)) {
        updateData.last_attempt_at = new Date();
      }

      // Intentar con instancia primero, fallback a update por ID
      if (typeof jobProduct === 'object' && jobProduct?.update && typeof jobProduct.update === 'function') {
        await jobProduct.update(updateData);
        return jobProduct.get({ plain: true });
      } else {
        const [count] = await JobProduct.update(updateData, { where: { id } });
        if (count === 0) throw new Error(`JobProduct no encontrado (ID: ${id})`);
        const updated = await JobProduct.findByPk(id, { raw: false });
        return updated ? updated.get({ plain: true }) : { id, ...updateData };
      }
    } catch (error) {
      logger.error(`Error en JobProductRepository->update:`, error);
      throw new Error(`Error al actualizar: ${error.message}`);
    }
  },

  // ========================================================================
  // 📦 MÉTODOS DE ACTUALIZACIÓN MASIVA
  // ========================================================================

  /**
   * Obtiene el conteo de job_products por status para un job
   * @param {Number} jobId - ID del job
   * @returns {Object} { total, statusCounts }
   */
  async getStatusCounts(jobId) {
    try {
      const { JobProduct } = require('../models');
      
      const jobProducts = await JobProduct.findAll({
        where: { job_id: jobId },
        attributes: ['status'],
        raw: true
      });

      const total = jobProducts.length;
      const statusCounts = jobProducts.reduce((acc, jp) => {
        acc[jp.status] = (acc[jp.status] || 0) + 1;
        return acc;
      }, {});

      return { total, statusCounts };

    } catch (error) {
      logger.error(`Error en JobProductRepository->getStatusCounts:`, error);
      throw new Error(`Error al obtener conteo de job_products: ${error.message}`);
    }
  },

  /**
   * Actualiza múltiples job_products que coincidan con los filtros
   * @param {Object} where - Filtros de búsqueda
   * @param {Object} data - Datos a actualizar
   * @returns {Object} { count: número de registros actualizados }
   */
  async updateMany(where, data) {
    try {
      if (!where || Object.keys(where).length === 0) {
        throw new Error('Debe especificar filtros where');
      }

      const allowedFields = [
        'status', 'external_id', 'external_url',
        'error_message', 'error_details',
        'attempt_count', 'last_attempt_at',
        'product_payload', 'marketplace_payload'
      ];

      const updateData = {};
      for (const field of allowedFields) {
        if (data[field] !== undefined) {
          if (['product_payload', 'marketplace_payload'].includes(field) && typeof data[field] === 'object') {
            updateData[field] = JSON.parse(JSON.stringify(data[field]));
          } else {
            updateData[field] = data[field];
          }
        }
      }

      if (Object.keys(updateData).length === 0) {
        return { count: 0 };
      }

      const [count] = await JobProduct.update(updateData, { where });

      logger.info(`JobProducts actualizados en masa: ${count} registros`);
      return { count };

    } catch (error) {
      logger.error('Error en JobProductRepository->updateMany:', error);
      throw new Error(`Error al actualizar job_products en masa: ${error.message}`);
    }
  },

  /**
   * Elimina múltiples job_products que coincidan con los filtros
   * @param {Object} where - Filtros de búsqueda
   * @returns {Object} { count: número de registros eliminados }
   */
  async deleteMany(where) {
    try {
      if (!where || Object.keys(where).length === 0) {
        throw new Error('Debe especificar filtros where');
      }

      const { count } = await JobProduct.destroy({ where });

      logger.info(`JobProducts eliminados en masa: ${count} registros`);
      return { count };

    } catch (error) {
      logger.error('Error en JobProductRepository->deleteMany:', error);
      throw new Error(`Error al eliminar job_products en masa: ${error.message}`);
    }
  },

  // ========================================================================
  // 🔄 MÉTODOS DE ESTADO (Sin cambios estructurales)
  // ========================================================================

  async markAsProcessing(id) {
    try {
      const jobProduct = await JobProduct.findByPk(id);
      if (!jobProduct) throw new Error(`JobProduct no encontrado (ID: ${id})`);
      return await this.update(jobProduct, {
        status: 'processing',
        attempt_count: (jobProduct.attempt_count || 0) + 1,
        last_attempt_at: new Date(),
        error_message: null,
        error_details: null
      });
    } catch (error) {
      logger.error(`Error en JobProductRepository->markAsProcessing (ID: ${id}):`, error);
      throw new Error(`Error al marcar como processing: ${error.message}`);
    }
  },

  async markAsSuccess(id, { external_id, external_url }) {
    try {
      const jobProduct = await JobProduct.findByPk(id);
      if (!jobProduct) throw new Error(`JobProduct no encontrado (ID: ${id})`);
      return await this.update(jobProduct, {
        status: 'success',
        external_id: external_id || null,
        external_url: external_url || null,
        last_attempt_at: new Date()
      });
    } catch (error) {
      logger.error(`Error en JobProductRepository->markAsSuccess (ID: ${id}):`, error);
      throw new Error(`Error al marcar como éxito: ${error.message}`);
    }
  },

  async markAsError(id, { error_message, error_details }) {
    try {
      const jobProduct = await JobProduct.findByPk(id);
      if (!jobProduct) throw new Error(`JobProduct no encontrado (ID: ${id})`);
      return await this.update(jobProduct, {
        status: 'error',
        error_message: error_message || 'Error desconocido',
        error_details: error_details || null,
        last_attempt_at: new Date()
      });
    } catch (error) {
      logger.error(`Error en JobProductRepository->markAsError (ID: ${id}):`, error);
      throw new Error(`Error al marcar como error: ${error.message}`);
    }
  },

  async retryProduct(id) {
    try {
      const jobProduct = await JobProduct.findByPk(id);
      if (!jobProduct) throw new Error(`JobProduct no encontrado (ID: ${id})`);
      if (jobProduct.status !== 'error') {
        throw new Error(`Solo se pueden reintentar productos en estado error, actual: ${jobProduct.status}`);
      }
      const reset = await jobProduct.update({
        status: 'pending',
        error_message: null,
        error_details: null,
        external_id: null,
        external_url: null
      });
      logger.info(`JobProduct listo para reintento (ID: ${id})`);
      return reset.get({ plain: true });
    } catch (error) {
      logger.error(`Error en JobProductRepository->retryProduct (ID: ${id}):`, error);
      throw new Error(`Error al preparar reintento: ${error.message}`);
    }
  },

  // ========================================================================
  // 📈 MÉTODOS DE ESTADÍSTICAS Y UTILIDAD
  // ========================================================================

  async getStatsByJob(jobId) {
  try {
    if (!jobId) throw new Error('job_id es requerido');

    const { JobProduct } = require('../models');
    const { fn, col } = require('sequelize');

    const stats = await JobProduct.findAll({
      attributes: [
        'status',
        // 🔑 CORREGIDO: Especificar tabla para COUNT
        [fn('COUNT', col('JobProduct.id')), 'count']
      ],
      where: { job_id: jobId },
      // 🔑 CORREGIDO: Prefixear GROUP BY
      group: ['JobProduct.status'],
      raw: true
    });

    const result = { 
      total: 0, processed: 0, successful: 0, errors: 0, 
      pending: 0, processing: 0, retrying: 0 
    };
    
    stats.forEach(row => {
      const count = parseInt(row.count) || 0;
      result.total += count;
      switch (row.status) {
        case 'success': result.successful += count; result.processed += count; break;
        case 'error': result.errors += count; result.processed += count; break;
        case 'pending': result.pending += count; break;
        case 'processing': result.processing += count; break;
        case 'retrying': result.retrying += count; break;
      }
    });
    
    return result;

  } catch (error) {
    logger.error(`Error en JobProductRepository->getStatsByJob (Job: ${jobId}):`, error);
    throw new Error(`Error al obtener estadísticas: ${error.message}`);
  }
},

  async getFailedProducts(jobId, { limit = 50, withRetryableOnly = false } = {}) {
    try {
      if (!jobId) throw new Error('job_id es requerido');
      const where = { job_id: jobId, status: 'error' };
      if (withRetryableOnly) where.attempt_count = { [Op.lt]: 3 };

      const failed = await JobProduct.findAll({
        where,
        attributes: [
          'id', 'product_id', 'marketplace_id', 'credential_id',
          'status', 'error_message', 'error_details', 
          'attempt_count', 'last_attempt_at'
        ],
        limit: parseInt(limit) || 50,
        order: [['last_attempt_at', 'DESC']]
      });
      return failed.map(item => item.get({ plain: true }));

    } catch (error) {
      logger.error(`Error en JobProductRepository->getFailedProducts (Job: ${jobId}):`, error);
      throw new Error(`Error al obtener productos fallidos: ${error.message}`);
    }
  },

  async deleteByJob(jobId, filters = {}) {
    try {
      if (!jobId) throw new Error('job_id es requerido');
      const where = { job_id: jobId };
      if (filters.status) where.status = filters.status;
      if (filters.product_id) where.product_id = filters.product_id;

      const { count } = await JobProduct.destroy({ where });
      logger.info(`JobProducts eliminados: ${count} registros (Job: ${jobId})`);
      return { success: true, deleted_count: count };

    } catch (error) {
      logger.error(`Error en JobProductRepository->deleteByJob (Job: ${jobId}):`, error);
      throw new Error(`Error al eliminar productos: ${error.message}`);
    }
  },

async findAllErrorsByJob(job, options = {}) {
  try {
    // ✅ 1. Validar que job tenga los datos necesarios
    if (!job || !job.id || !job.batch_id) {
      logger.warn('[findAllErrorsByJob] Job inválido:', { job });
      return []; // Retornar array vacío en lugar de lanzar error
    }

    const parseJsonMaybe = (value) => {
      if (!value) return null;
      if (typeof value === 'object') return value;
      if (typeof value !== 'string') return null;

      try {
        return JSON.parse(value);
      } catch (e) {
        return null;
      }
    };

    const hasWarningDetails = (value) => {
      const parsed = parseJsonMaybe(value);
      return Boolean(
        parsed &&
        (
          parsed.has_warnings === true ||
          (Array.isArray(parsed.warnings) && parsed.warnings.length > 0) ||
          (
            parsed.marketplace_item_state &&
            typeof parsed.marketplace_item_state === 'object' &&
            String(parsed.marketplace_item_state.status || '').toLowerCase() &&
            String(parsed.marketplace_item_state.status || '').toLowerCase() !== 'active'
          )
        )
      );
    };

    const jobProducts = await JobProduct.findAll({
      where: {
        job_id: job.id,
        [Op.or]: [
          { status: { [Op.in]: ['error', 'failed'] } },
          { 
            status: 'success',
            [Op.or]: [
              { error_message: { [Op.ne]: null } },
              { error_details: { [Op.ne]: null } }
            ]
          }
        ]
      },
      include: [
        { model: Product, as: 'product', required: false },
        { model: Marketplace, as: 'marketplace', required: false },
        { model: MarketplaceCredential, as: 'credential', required: false }
      ],
      attributes: {
        include: options.includePayloads !== false 
          ? ['product_payload', 'marketplace_payload', 'error_message', 'error_details'] 
          : ['error_message']
      },
      order: [['createdAt', 'DESC']],
      limit: options.limit || 100
    });

    const errors = [];
    for (const jp of jobProducts) {
      // ✅ 2. Buscar task con validación de null
      const task = await ProductPublishingTask.findOne({
        where: {
          product_id: jp.product_id,
          marketplace_id: jp.marketplace_id,
          credential_id: jp.credential_id,
          batch_id: job.batch_id  // ✅ job.batch_id ya validado arriba
        },
        attributes: ['payload', 'id'],
        order: [['createdAt', 'DESC']],
        raw: true
      });

      const data = jp.get({ plain: true });
      
      // ✅ 3. Procesar payload solo si task existe
      let processedPayload = null;
      if (options.includePayloads !== false && task?.payload) {
        if (typeof task.payload === 'string') {
          try {
            processedPayload = JSON.parse(task.payload);
          } catch (e) {
            logger.warn(`[findAllErrorsByJob] ⚠️ Payload no es JSON válido: ${e.message}`);
            processedPayload = null;
          }
        } else if (typeof task.payload === 'object' && task.payload !== null) {
          processedPayload = task.payload;
        }
      }
      
      // ✅ 4. Push con task_id opcional (null si no se encontró task)
      if (
        data.status === 'success' &&
        !hasWarningDetails(data.error_details) &&
        !(typeof data.error_message === 'string' && data.error_message.trim().toLowerCase().startsWith('advertencias'))
      ) {
        continue;
      }

      errors.push({
        id: jp.id,
        task_id: task?.id || null,  // ✅ CLAVE: usar optional chaining
        product_id: jp.product_id,
        product_name: jp.product?.name || 'Producto sin nombre',
        sku: jp.product?.sku || null,
        product_image: jp.product?.image_url || null,
        marketplace_id: jp.marketplace_id,
        marketplace_name: jp.marketplace?.name || 'Marketplace',
        marketplace_domain: jp.marketplace?.domain || null,
        credential_id: jp.credential_id,
        credential_name: jp.credential?.name || null,
        status: jp.status,
        error_message: jp.error_message,
        error_details: options.includeDetails !== false ? jp.error_details : null,
        payload: processedPayload,
        created_at: jp.createdAt,
        updated_at: jp.updatedAt
      });
    }
    
    return errors;

  } catch (error) {
    logger.error(`[JobProductRepository->findAllErrorsByJob] Error: ${error.message}`);
    throw new Error(`Error al obtener errores del job: ${error.message}`);
  }
},

/**
 * Cuenta canales únicos (credential_id) para un job
 */
async countDistinctChannelsByJob(jobId) {
  try {
    if (!jobId) throw new Error('job_id es requerido');
    
    const { fn, col } = require('sequelize');
    
    const result = await JobProduct.findOne({
      attributes: [[fn('COUNT', fn('DISTINCT', col('credential_id'))), 'channel_count']],
      where: { job_id: jobId },
      raw: true
    });
    
    return parseInt(result?.channel_count) || 0;
  } catch (error) {
    logger.error(`Error en JobProductRepository->countDistinctChannelsByJob:`, error);
    throw new Error(`Error al contar canales: ${error.message}`);
  }
},
};

module.exports = JobProductRepository;
