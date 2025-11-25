// src/controllers/ProductPublishingTaskController.js
const logger = require('../../config/logger');
const { sequelize } = require('../models');
const {
  ProductPublishingTaskRepository,
  ProductRepository,
  MarketplaceRepository,
  WarehouseRepository,
  CompanyRepository,
  UserRepository,
  LogRepository
} = require('../repositories');
const MarketplaceTransformer = require('../services/MarketplaceTransformer');
const { getRequestMetadata } = require('../util/requestUtil');

const ProductPublishingTaskController = {
  // 1. Registrar publicación (simula envío a API)
  async store(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Registra publicación de productos`);
    logger.info('Datos recibidos:');
    logger.info(JSON.stringify(req.body));

    const { products, marketplace_id, warehouse_id } = req.body;
    const user_id = req.user.id;
    const metadata = getRequestMetadata(req);

    let transaction;
    try {
      // Validar marketplace
      const marketplace = await MarketplaceRepository.findById(marketplace_id);
      if (!marketplace) return res.status(400).json({ msg: "marketplaceNotFound" });

      // Validar warehouse (para obtener company_id)
      const warehouse = await WarehouseRepository.findById(warehouse_id);
      if (!warehouse) return res.status(400).json({ msg: "warehouseNotFound" });

      const user = await UserRepository.findById(user_id);
      if (!user) return res.status(400).json({ msg: "userNotFound" });

      transaction = await sequelize.transaction();

      const tasks = [];
      for (const product of products) {
        // Validar producto
        const prod = await ProductRepository.findById(product.product_id);
        if (!prod) {
          logger.warn(`Producto no encontrado: ${product.product_id}`);
          continue;
        }

        // Transformar producto
        const [transformed] = await MarketplaceTransformer.transformProducts([product], marketplace_id);
        if (!transformed) {
          logger.warn(`No se pudo transformar producto ${product.product_id}`);
          continue;
        }

        // ✅ SIMULACIÓN DE ENVÍO A API EXTERNA
        // En producción, aquí llamarías al ChannelAdapter
        const mockApiResponse = {
          success: Math.random() > 0.2, // 80% éxito
          external_id: `EXT-${product.product_id}-${Date.now()}`,
          external_url: `https://marketplace.com/item/${product.product_id}`,
          error: Math.random() > 0.8 ? "API timeout" : null
        };

        // Determinar estado inicial
        let status = 'pending';
        let error_message = null;
        let external_id = null;
        let external_url = null;

        if (mockApiResponse.success) {
          status = 'published';
          external_id = mockApiResponse.external_id;
          external_url = mockApiResponse.external_url;
        } else {
          status = 'error';
          error_message = mockApiResponse.error || 'Error desconocido al publicar';
        }

        // Crear tarea
        const task = await ProductPublishingTaskRepository.create({
          product_id: product.product_id,
          marketplace_id,
          warehouse_id,
          user_id,
          status,
          error_message,
          payload: transformed,
          external_id,
          external_url
        }, { transaction });

        tasks.push(task);
      }

      await transaction.commit();

      // Log de éxito
      await LogRepository.create({
        user_id: metadata.user_id,
        action: 'publishing_task.create',
        description: `Registradas ${tasks.length} tareas de publicación`,
        ip_address: metadata.ip_address,
        user_agent: metadata.user_agent,
        status: 'success',
        meta: { marketplace_id, warehouse_id, tasks_created: tasks.length }
      });

      res.status(201).json({
        message: "Tareas de publicación registradas",
        tasks: tasks.map(t => ({
          id: t.id,
          product_id: t.product_id,
          status: t.status,
          external_id: t.external_id,
          error_message: t.error_message
        }))
      });

    } catch (error) {
      if (transaction) await transaction.rollback();
      await LogRepository.create({
        user_id: metadata?.user_id,
        action: 'publishing_task.create',
        description: `Error: ${error.message}`,
        ip_address: metadata?.ip_address,
        user_agent: metadata?.user_agent,
        status: 'error',
        meta: null
      });
      logger.error('ProductPublishingTaskController->store: ' + error.message);
      res.status(500).json({ error: 'ServerError' });
    }
  },

  // 2. Actualizar estado (para reintentos, sincronización, etc.)
  async updateStatus(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Actualiza estado de tarea de publicación`);
    const { id, status, error_message, external_id, external_url } = req.body;
    const metadata = getRequestMetadata(req);

    try {
      const task = await ProductPublishingTaskRepository.findById(id);
      if (!task) return res.status(404).json({ msg: "PublishingTaskNotFound" });

      const updateData = {};
      if (error_message !== undefined) updateData.error_message = error_message;
      if (external_id !== undefined) updateData.external_id = external_id;
      if (external_url !== undefined) updateData.external_url = external_url;

      const updated = await ProductPublishingTaskRepository.updateStatus(
        task,
        status,
        updateData
      );

      await LogRepository.create({
        user_id: metadata.user_id,
        action: 'publishing_task.update_status',
        description: `Tarea ${id} actualizada a: ${status}`,
        ip_address: metadata.ip_address,
        user_agent: metadata.user_agent,
        status: 'success',
        meta: { id, status }
      });

      res.status(200).json({ message: "Estado actualizado", task: { id: updated.id, status: updated.status } });
    } catch (error) {
      await LogRepository.create({
        user_id: metadata?.user_id,
        action: 'publishing_task.update_status',
        description: `Error: ${error.message}`,
        ip_address: metadata?.ip_address,
        user_agent: metadata?.user_agent,
        status: 'error',
        meta: null
      });
      logger.error('ProductPublishingTaskController->updateStatus: ' + error.message);
      res.status(500).json({ error: 'ServerError' });
    }
  },

  // 3. Listar tareas
  async list(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Lista tareas de publicación`);
    const { company_id, status } = req.body;

    try {
      let tasks;
      if (status) {
        tasks = await ProductPublishingTaskRepository.findByCompanyAndStatus(company_id, status);
      } else {
        tasks = await ProductPublishingTaskRepository.findAllByCompany(company_id);
      }

      const mapped = tasks.map(t => ({
        id: t.id,
        product_id: t.product_id,
        marketplace_id: t.marketplace_id,
        warehouse_id: t.warehouse_id,
        company_id: t.company_id,
        user_id: t.user_id,
        status: t.status,
        error_message: t.error_message,
        external_id: t.external_id,
        external_url: t.external_url,
        created_at: t.createdAt,
        updated_at: t.updatedAt
      }));

      res.status(200).json({ publishing_tasks: mapped });
    } catch (error) {
      logger.error('ProductPublishingTaskController->list: ' + error.message);
      res.status(500).json({ error: 'ServerError' });
    }
  }
};

module.exports = ProductPublishingTaskController;