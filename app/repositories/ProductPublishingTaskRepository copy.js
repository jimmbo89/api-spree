// src/repositories/ProductPublishingTaskRepository.js
const { ProductPublishingTask } = require('../models');
const logger = require('../../config/logger');

const ProductPublishingTaskRepository = {
  async create(taskData, options = {}) {
    logger.info(`[REPO] Creando tarea de publicación para producto ${taskData.product_id}`);
    try {
      return await ProductPublishingTask.create(taskData, options);
    } catch (error) {
      logger.error(`[REPO] ERROR al crear tarea de publicación:`, error.message);
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
      logger.error(`[REPO] ERROR al actualizar estado de tarea:`, error.message);
      throw error;
    }
  },

  async findById(id) {
    return await ProductPublishingTask.findByPk(id);
  },

  async findByWarehouseAndStatus(warehouseId, status) {
    return await ProductPublishingTask.findAll({
      where: { warehouse_id: warehouseId, status },
      order: [['createdAt', 'DESC']]
    });
  },
  async updateTask(task, updateData, options = {}) {
  logger.info(`[REPO] Actualizando tarea de publicación ID ${task.id}`);
  try {
    await task.update(updateData, options);
    return task;
  } catch (error) {
    logger.error(`[REPO] ERROR al actualizar tarea:`, error.message);
    throw error;
  }
}
};

module.exports = ProductPublishingTaskRepository;