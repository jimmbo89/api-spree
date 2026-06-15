const { Op, Sequelize } = require('sequelize');
const { ProductPublishingTask, Product, Marketplace, Warehouse, Branch, Company, User, MarketplaceCredential, Job, sequelize } = require('../models');
const logger = require('../../config/logger');

const ProductPublishingTaskRepository = {
  buildFeedIdSearchClauses(feedId) {
    return [
      { external_id: feedId },
      Sequelize.where(Sequelize.fn('JSON_EXTRACT', Sequelize.col('error_details'), '$.feed_id'), feedId),
      Sequelize.where(Sequelize.fn('JSON_EXTRACT', Sequelize.col('error_details'), '$.image_sync.request_id'), feedId),
      Sequelize.where(Sequelize.fn('JSON_EXTRACT', Sequelize.col('error_details'), '$.image_upload.request_id'), feedId),
      Sequelize.where(Sequelize.fn('JSON_EXTRACT', Sequelize.col('api_response'), '$.feed_id'), feedId),
      Sequelize.where(Sequelize.fn('JSON_EXTRACT', Sequelize.col('api_response'), '$.feed.FeedID'), feedId),
      Sequelize.where(Sequelize.fn('JSON_EXTRACT', Sequelize.col('api_response'), '$.data.feed_id'), feedId),
      Sequelize.where(Sequelize.fn('JSON_EXTRACT', Sequelize.col('api_response'), '$.image_sync.request_id'), feedId),
      Sequelize.where(Sequelize.fn('JSON_EXTRACT', Sequelize.col('api_response'), '$.image_upload.request_id'), feedId)
    ];
  },

  async create(taskData, options = {}) {
    logger.info(`[REPO] Creando tarea de publicación para producto ${taskData.product_id}`);
    try {
      return await ProductPublishingTask.create(taskData, options);
    } catch (error) {
      logger.error(`[REPO] ERROR al crear tarea:`, error.message);
      throw error;
    }
  },

  async updateStatus(task, status, updateData = {}, options = {}) {
    const update = { status, ...updateData };
    logger.info(`[REPO] Actualizando estado de tarea ID ${task.id} a: ${status}`);
    try {
      await task.update(update, options);
      return task;
    } catch (error) {
      logger.error(`[REPO] ERROR al actualizar estado:`, error.message);
      throw error;
    }
  },

  async updateTask(task, updateData, options = {}) {
    logger.info(`[REPO] Actualizando tarea ID ${task.id}`);
    try {
      await task.update(updateData, options);
      return task;
    } catch (error) {
      logger.error(`[REPO] ERROR al actualizar tarea:`, error.message);
      throw error;
    }
  },

  async findById(id) {
    return await ProductPublishingTask.findByPk(id, {
      include: [
        { model: Product, as: 'product' },
        { model: Marketplace, as: 'marketplace' },
        { model: User, as: 'user' },
        { model: MarketplaceCredential, as: 'credential' }
      ]
    });
  },

  async findByBatchId(batch_id) {
    return await ProductPublishingTask.findAll({
      where: { batch_id },
      include: [
        { model: Product, as: 'product' },
        { model: Marketplace, as: 'marketplace' },
        { model: User, as: 'user' },
        { model: MarketplaceCredential, as: 'credential' }
      ],
      order: [['createdAt', 'DESC']]
    });
  },

  async findByCompanyAndStatus(company_id, status) {
    return await ProductPublishingTask.findAll({
      where: { company_id, status },
      include: [
        { model: Product, as: 'product' },
        { model: Marketplace, as: 'marketplace' },
        { model: User, as: 'user' },
        { model: MarketplaceCredential, as: 'credential' }
      ],
      order: [['createdAt', 'DESC']]
    });
  },

  async findAllByCompany(company_id, user_id) {
    const where = { company_id };
  if (user_id) where.user_id = user_id;  // ← Filtro en BD
    return await ProductPublishingTask.findAll({
      include: [
        { model: Product, as: 'product' },
        { model: Marketplace, as: 'marketplace' },
        { model: User, as: 'user' },
        { model: MarketplaceCredential, as: 'credential' }
      ],
      order: [['createdAt', 'DESC']]
    });
  },

  async findDraftsByUser(user_id, company_id = null) {
    const where = { user_id, status: 'draft' };
    if (company_id) {
      where.company_id = company_id;
    }
    return await ProductPublishingTask.findAll({
      where,
      include: [
        { model: Product, as: 'product' },
        { model: Marketplace, as: 'marketplace' },
        { model: MarketplaceCredential, as: 'credential' }
      ],
      order: [['createdAt', 'DESC']]
    });
  },

  async findByWarehouseAndStatus(warehouseId, status) {
    return await ProductPublishingTask.findAll({
      where: { warehouse_id: warehouseId, status },
      include: [
        { model: Product, as: 'product' },
        { model: Marketplace, as: 'marketplace' },
        { model: MarketplaceCredential, as: 'credential' }
      ],
      order: [['createdAt', 'DESC']]
    });
  },

  async findLatestByExternalId(marketplaceId, externalId) {
    return await ProductPublishingTask.findOne({
      where: {
        marketplace_id: marketplaceId,
        external_id: externalId
      },
      include: [
        {
          model: Product,
          as: 'product'
        },
        {
          model: MarketplaceCredential,
          as: 'credential',
          attributes: ['id', 'name', 'seller_email', 'active']
        },
        {
          model: Job,
          as: 'job',
          attributes: ['id', 'batch_id', 'config', 'company_id', 'user_id']
        }
      ],
      order: [['createdAt', 'DESC']]
    });
  },

  async findLatestByExternalIdAndContext({
    marketplaceId,
    externalId,
    companyId = null,
    branchId = null,
    credentialId = null,
    userId = null
  } = {}) {
    if (!marketplaceId || !externalId) {
      return null;
    }

    const where = {
      marketplace_id: marketplaceId,
      external_id: externalId,
      status: {
        [Op.in]: ['published', 'published_with_warnings']
      }
    };

    if (companyId) where.company_id = companyId;
    if (branchId) where.branch_id = branchId;
    if (credentialId) where.credential_id = credentialId;
    if (userId) where.user_id = userId;

    return await ProductPublishingTask.findOne({
      where,
      include: [
        { model: Product, as: 'product' },
        { model: Marketplace, as: 'marketplace' },
        { model: User, as: 'user' },
        { model: MarketplaceCredential, as: 'credential' }
      ],
      order: [['createdAt', 'DESC']]
    });
  },

  async findLatestByProductAndMarketplace(productId, marketplaceId) {
    return await ProductPublishingTask.findOne({
      where: {
        product_id: productId,
        marketplace_id: marketplaceId
      },
      order: [['createdAt', 'DESC']]
    });
  },

  async findLatestPublishedByProductMarketplaceAndCredential(productId, marketplaceId, credentialId, userId = null) {
    const where = {
      product_id: productId,
      marketplace_id: marketplaceId,
      status: {
        [Op.in]: ['published', 'published_with_warnings']
      }
    };

    if (credentialId) {
      where.credential_id = credentialId;
    }

    if (userId) {
      where.user_id = userId;
    }

    return await ProductPublishingTask.findOne({
      where,
      order: [['createdAt', 'DESC']]
    });
  },

    async findPublishedProducts({
    companyId = null,
    userId = null,
    marketplaceId = null,
    productId = null,
    startDate = null,
    endDate = null,
    includeProcessing = false
  } = {}) {
    const where = {
      status: {
        [Op.in]: includeProcessing
          ? ['published', 'published_with_warnings', 'processing', 'failed']
          : ['published', 'published_with_warnings']
      }
    };

    if (companyId) where.company_id = companyId;
    if (userId) where.user_id = userId;
    if (marketplaceId) where.marketplace_id = marketplaceId;
    if (productId) where.product_id = productId;

    if (startDate && endDate) {
      where[Op.and] = sequelize.where(
        sequelize.literal('DATE(COALESCE(`ProductPublishingTask`.`published_at`, `ProductPublishingTask`.`createdAt`))'),
        {
          [Op.between]: [startDate, endDate]
        }
      );
    }

    return await ProductPublishingTask.findAll({
      where,
      include: [
        { model: Product, as: 'product' },
        { model: Marketplace, as: 'marketplace' },
        { model: MarketplaceCredential, as: 'credential' }
      ],
      order: [
        [sequelize.literal('DATE(COALESCE(`ProductPublishingTask`.`published_at`, `ProductPublishingTask`.`createdAt`))'), 'DESC'],
        ['id', 'DESC']
      ]
    });
  },

  async delete(task) {
  try {
    await task.destroy();
    logger.info(`Tarea de publicación eliminada (ID: ${task.id})`);
    return { success: true, message: "Publicación eliminada correctamente" };
  } catch (error) {
    logger.error(`Error en ProductPublishingTaskRepository->delete (ID: ${task.id}):`, error);
    throw new Error(`Error al eliminar publicación: ${error.message}`);
  }
},

// === AGREGAR DESPUÉS DE updateTask ===

  /**
   * Actualiza únicamente el campo payload de una tarea de publicación
   * @param {Object} task - Instancia de ProductPublishingTask
   * @param {Object} payloadData - Nuevo payload a guardar (objeto completo o parcial)
   * @param {Object} options - Opciones de Sequelize (transaction, etc.)
   * @returns {Promise<ProductPublishingTask>} Tarea actualizada
   */
  async updatePayload(task, payloadData, options = {}) {
    logger.info(`[REPO] Actualizando payload de tarea ID ${task.id}`);
    try {
      // Validar que payloadData sea un objeto válido
      if (!payloadData || typeof payloadData !== 'object') {
        throw new Error('payloadData debe ser un objeto válido');
      }
      
      // Actualizar solo el campo payload (merge profundo si es necesario)
      await task.update({ payload: payloadData }, options);
      
      logger.info(`[REPO] Payload actualizado exitosamente para tarea ID ${task.id}`);
      return task;
    } catch (error) {
      logger.error(`[REPO] ERROR al actualizar payload:`, error.message);
      throw error;
    }
  },

  // ✅ NUEVO MÉTODO: Buscar tarea por FeedID (para webhooks de Falabella)
   async findLatestByFeedId(marketplaceId, feedId) {
    try {
      if (!feedId) {
        return null;
      }

      logger.info(`[REPO] Buscando tarea por feedId=${feedId} marketplace=${marketplaceId || 'any'}`);

      const { Op, Sequelize } = require('sequelize');

      // ✅ ESTRATEGIA 1: Búsqueda por JSON_EXTRACT (funciona si el campo es JSON nativo)
      const whereJsonExtract = {
        [Op.or]: this.buildFeedIdSearchClauses(feedId)
      };

      if (marketplaceId) {
        whereJsonExtract.marketplace_id = marketplaceId;
      }

      let task = await ProductPublishingTask.findOne({
        where: whereJsonExtract,
        include: [
          { model: Product, as: 'product' },
          { model: Marketplace, as: 'marketplace' },
          { model: MarketplaceCredential, as: 'credential' },
          {
            model: Job,
            as: 'job',
            attributes: ['id', 'batch_id', 'config', 'company_id', 'user_id']
          }
        ],
        order: [['createdAt', 'DESC']]
      });

      if (task) {
        logger.info(`[REPO] ✅ Tarea encontrada por JSON_EXTRACT: ID=${task.id}, status=${task.status}`);
        return task;
      }

      // ✅ ESTRATEGIA 2: Búsqueda por LIKE (fallback si el campo es TEXT/VARCHAR)
      logger.info(`[REPO] JSON_EXTRACT no encontró resultado, intentando LIKE...`);
      
      const whereLike = {
        [Op.or]: [
          Sequelize.where(Sequelize.col('error_details'), { [Op.like]: `%"feed_id":"${feedId}"%` }),
          Sequelize.where(Sequelize.col('error_details'), { [Op.like]: `%"feed_id": "${feedId}"%` }),
          Sequelize.where(Sequelize.col('error_details'), { [Op.like]: `%"request_id":"${feedId}"%` }),
          Sequelize.where(Sequelize.col('error_details'), { [Op.like]: `%"request_id": "${feedId}"%` }),
          Sequelize.where(Sequelize.col('api_response'), { [Op.like]: `%"feed_id":"${feedId}"%` }),
          Sequelize.where(Sequelize.col('api_response'), { [Op.like]: `%"feed_id": "${feedId}"%` }),
          Sequelize.where(Sequelize.col('api_response'), { [Op.like]: `%"request_id":"${feedId}"%` }),
          Sequelize.where(Sequelize.col('api_response'), { [Op.like]: `%"request_id": "${feedId}"%` })
        ]
      };

      if (marketplaceId) {
        whereLike.marketplace_id = marketplaceId;
      }

      task = await ProductPublishingTask.findOne({
        where: whereLike,
        include: [
          { model: Product, as: 'product' },
          { model: Marketplace, as: 'marketplace' },
          { model: MarketplaceCredential, as: 'credential' },
          {
            model: Job,
            as: 'job',
            attributes: ['id', 'batch_id', 'config', 'company_id', 'user_id']
          }
        ],
        order: [['createdAt', 'DESC']]
      });

      if (task) {
        logger.info(`[REPO] ✅ Tarea encontrada por LIKE: ID=${task.id}, status=${task.status}`);
        return task;
      }

      // ✅ ESTRATEGIA 3: Búsqueda sin filtro de marketplace (búsqueda global)
      if (marketplaceId) {
        logger.info(`[REPO] LIKE con marketplace no encontró, intentando sin filtro de marketplace...`);
        
        const whereGlobal = {
          [Op.or]: [
            Sequelize.where(Sequelize.col('error_details'), { [Op.like]: `%"feed_id":"${feedId}"%` }),
            Sequelize.where(Sequelize.col('error_details'), { [Op.like]: `%"feed_id": "${feedId}"%` }),
            Sequelize.where(Sequelize.col('error_details'), { [Op.like]: `%"request_id":"${feedId}"%` }),
            Sequelize.where(Sequelize.col('error_details'), { [Op.like]: `%"request_id": "${feedId}"%` }),
            Sequelize.where(Sequelize.col('api_response'), { [Op.like]: `%"feed_id":"${feedId}"%` }),
            Sequelize.where(Sequelize.col('api_response'), { [Op.like]: `%"feed_id": "${feedId}"%` }),
            Sequelize.where(Sequelize.col('api_response'), { [Op.like]: `%"request_id":"${feedId}"%` }),
            Sequelize.where(Sequelize.col('api_response'), { [Op.like]: `%"request_id": "${feedId}"%` })
          ]
        };

        task = await ProductPublishingTask.findOne({
          where: whereGlobal,
          include: [
            { model: Product, as: 'product' },
            { model: Marketplace, as: 'marketplace' },
            { model: MarketplaceCredential, as: 'credential' },
            {
              model: Job,
              as: 'job',
              attributes: ['id', 'batch_id', 'config', 'company_id', 'user_id']
            }
          ],
          order: [['createdAt', 'DESC']]
        });

        if (task) {
          logger.info(`[REPO] ✅ Tarea encontrada por LIKE global: ID=${task.id}, status=${task.status}`);
          return task;
        }
      }

      logger.warn(`[REPO] ⚠️ No se encontró tarea para feedId=${feedId} (se intentaron 3 estrategias)`);
      return null;
    } catch (error) {
      logger.error(`[REPO] ERROR buscando por feedId ${feedId}: ${error.message}`);
      return null;
    }
  },

  // ✅ NUEVO MÉTODO: Buscar tarea por producto y marketplace (más flexible)
  async findLatestByProductAndMarketplaceWithStatus(productId, marketplaceId, statuses = null) {
    const where = {
      product_id: productId,
      marketplace_id: marketplaceId
    };

    if (statuses && Array.isArray(statuses) && statuses.length > 0) {
      where.status = { [Op.in]: statuses };
    }

    return await ProductPublishingTask.findOne({
      where,
      include: [
        { model: Product, as: 'product' },
        { model: Marketplace, as: 'marketplace' },
        { model: MarketplaceCredential, as: 'credential' }
      ],
      order: [['createdAt', 'DESC']]
    });
  }
};

module.exports = ProductPublishingTaskRepository;
