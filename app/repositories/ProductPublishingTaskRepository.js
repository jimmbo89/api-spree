const { ProductPublishingTask, Product, Marketplace, Warehouse, Branch, Company, User, MarketplaceCredential } = require('../models');
const logger = require('../../config/logger');

const ProductPublishingTaskRepository = {
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
          model: MarketplaceCredential,
          as: 'credential',
          attributes: ['id', 'name', 'seller_email', 'active']
        }
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
};

module.exports = ProductPublishingTaskRepository;
