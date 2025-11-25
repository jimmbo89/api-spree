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
  LogRepository,
  WarehouseProductRepository
} = require('../repositories');
const MarketplaceTransformer = require('../services/MarketplaceTransformer');
const { getRequestMetadata } = require('../util/requestUtil');

const ProductPublishingTaskController = {
  // 1. Registrar publicación (simula envío a API)
  /*async store(req, res) {
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
  },*/

  async store(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Registra publicación de productos`);
    logger.info('Datos recibidos:');
    logger.info(JSON.stringify(req.body));

    const { products, marketplace_id, warehouse_id } = req.body;
    const user_id = req.user.id;
    const metadata = getRequestMetadata(req);

    // Validaciones previas (sin transacción)
    const marketplace = await MarketplaceRepository.findById(marketplace_id);
    if (!marketplace) return res.status(400).json({ msg: "marketplaceNotFound" });

    const warehouse = await WarehouseRepository.findById(warehouse_id);
    if (!warehouse) return res.status(400).json({ msg: "warehouseNotFound" });


    // Preparar resultados
    const successResults = [];
    const errorResults = [];

    // Procesar cada producto
    for (const product of products) {
        try {
        // Validar producto
        const prod = await ProductRepository.findById(product.product_id);
        if (!prod) {
            errorResults.push({
            product_id: product.product_id,
            error: 'productNotFound'
            });
            continue;
        }

        // Transformar
        const [transformed] = await MarketplaceTransformer.transformProducts([product], marketplace_id);
        if (!transformed) {
            errorResults.push({
            product_id: product.product_id,
            error: 'productTransformFailed'
            });
            continue;
        }

        // ✅ SIMULACIÓN DE ENVÍO A API EXTERNA
        const mockApiResponse = {
            success: Math.random() > 0.3, // 70% éxito
            external_id: `EXT-${product.product_id}-${Date.now()}`,
            external_url: `https://marketplace.com/item/${product.product_id}`,
            error: Math.random() > 0.7 ? "El título debe tener al menos 10 caracteres" : null
        };

        if (mockApiResponse.success) {
            // Crear tarea en BD (con transacción individual o sin transacción)
            const task = await ProductPublishingTaskRepository.create({
            product_id: product.product_id,
            marketplace_id,
            warehouse_id,
            user_id,
            date: new Date(), // DATEONLY
            status: 'published',
            payload: transformed,
            external_id: mockApiResponse.external_id,
            external_url: mockApiResponse.external_url
            });

            successResults.push({
            product_id: product.product_id,
            task_id: task.id,
            external_id: task.external_id
            });
        } else {
            // Registrar tarea con error
            const task = await ProductPublishingTaskRepository.create({
            product_id: product.product_id,
            marketplace_id,
            warehouse_id,
            company_id,
            user_id,
            date: new Date(),
            status: 'error',
            error_message: mockApiResponse.error || 'Error desconocido al publicar',
            payload: transformed
            });

            errorResults.push({
            product_id: product.product_id,
            task_id: task.id,
            payload: transformed, // 👈 se devuelve para corrección
            error: mockApiResponse.error || 'Error desconocido al publicar'
            });
        }

        } catch (err) {
        logger.error(`Error procesando producto ${product.product_id}:`, err.message);
        errorResults.push({
            product_id: product.product_id,
            error: err.message || 'Error interno'
        });
        }
    }

    // Log general
    await LogRepository.create({
        user_id: metadata.user_id,
        action: 'publishing_task.create',
        description: `Publicación: ${successResults.length} éxitos, ${errorResults.length} errores`,
        ip_address: metadata.ip_address,
        user_agent: metadata.user_agent,
        status: errorResults.length === 0 ? 'success' : 'partial_success',
        meta: { 
        marketplace_id, 
        warehouse_id, 
        success_count: successResults.length,
        error_count: errorResults.length
        }
    });

    // Responder
    const hasErrors = errorResults.length > 0;
    res.status(200).json({
        success: successResults.length > 0,
        has_errors: hasErrors,
        message: hasErrors 
        ? "Algunos productos no se pudieron publicar" 
        : "Todos los productos publicados correctamente",
        success: successResults,
        errors: errorResults // 👈 aquí están los errores por producto
    });
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
  },

  async retry(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Reintenta publicación con datos actualizados`);
    logger.info('Datos recibidos:');
    logger.info(JSON.stringify(req.body));

    const { task_id, payload } = req.body;
    const user_id = req.user.id;
    const metadata = getRequestMetadata(req);

    if (!task_id) {
        return res.status(400).json({ msg: "task_id es obligatorio" });
    }

    let transaction;
    try {
        const task = await ProductPublishingTaskRepository.findById(task_id);
        if (!task) return res.status(404).json({ msg: "PublishingTaskNotFound" });
        if (task.status !== 'error') return res.status(400).json({ msg: "Tarea no es reintentable" });

        // Validar entidades
        const marketplace = await MarketplaceRepository.findById(task.marketplace_id);
        const warehouse = await WarehouseRepository.findById(task.warehouse_id);
        const user = await UserRepository.findById(user_id);
        if (!marketplace || !warehouse || !user) {
        return res.status(400).json({ msg: "Entidad relacionada no encontrada" });
        }

        // Usar payload corregido o el original
        const payloadToSend = payload || task.payload;

        transaction = await sequelize.transaction();

        // 8. ✅ SIMULACIÓN DE ENVÍO CON NUEVO PAYLOAD
        const mockApiResponse = {
        success: Math.random() > 0.1, // 90% éxito
        external_id: `EXT-${product.id}-${Date.now()}`,
        external_url: `https://marketplace.com/item/${product.id}`,
        error: Math.random() > 0.95 ? "Precio no válido" : null
        };

         if (mockApiResponse.success) {
        // ✅ SINCRONIZAR DATOS INTERNOS
        await this.syncInternalData(task, payloadToSend, { transaction });

        // Actualizar tarea
        await ProductPublishingTaskRepository.updateTask(task, {
            status: 'published',
            payload: payloadToSend,
            external_id: mockApiResponse.external_id,
            external_url: mockApiResponse.external_url,
            error_message: null
        }, { transaction });
        } else {
        await ProductPublishingTaskRepository.updateTask(task, {
            status: 'error',
            payload: payloadToSend,
            error_message: mockApiResponse.error || 'Error al publicar'
        }, { transaction });
        }

        await transaction.commit();

        // Log y respuesta
        const updatedTask = await ProductPublishingTaskRepository.findById(task_id);
        res.status(200).json({
        message: mockApiResponse.success ? "Publicación exitosa" : "El reintento falló",
        task: {
            id: updatedTask.id,
            status: updatedTask.status,
            error_message: updatedTask.error_message,
            external_id: updatedTask.external_id
        }
        });

        // 10. Log y respuesta
        await LogRepository.create({
        user_id: metadata.user_id,
        action: 'publishing_task.retry',
        description: `Reintento con datos actualizados ${mockApiResponse.success ? 'exitoso' : 'fallido'}`,
        ip_address: metadata.ip_address,
        user_agent: metadata.user_agent,
        status: mockApiResponse.success ? 'success' : 'error',
        meta: { task_id, product_id: product.id }
        });

    } catch (error) {
        if (transaction) await transaction.rollback();
        await LogRepository.create({
        user_id: metadata?.user_id,
        action: 'publishing_task.retry',
        description: `Error: ${error.message}`,
        ip_address: metadata?.ip_address,
        user_agent: metadata?.user_agent,
        status: 'error',
        meta: { task_id }
        });
        logger.error('ProductPublishingTaskController->retry: ' + error.message);
        res.status(500).json({ error: 'ServerError' });
    }
  },

  async syncInternalData(task, externalPayload, options) {
  logger.info(`[SYNC] Sincronizando datos internos para producto ${task.product_id}`);

  const product = await ProductRepository.findById(task.product_id);
  const warehouseProduct = await WarehouseProductRepository.findByProductAndWarehouse(
    task.product_id,
    task.warehouse_id
  );

  if (!product || !warehouseProduct) {
    logger.warn(`[SYNC] Producto o warehouse_product no encontrado para tarea ${task.id}`);
    return;
  }

  // ✅ USAR EL NUEVO MÉTODO DEL SERVICIO
  const internalData = await MarketplaceTransformer.reverseTransform(
    externalPayload,
    task.marketplace_id
  );

  if (Object.keys(internalData).length === 0) {
    logger.info(`[SYNC] No hay datos para sincronizar desde el payload`);
    return;
  }

  // Separar actualizaciones
  const productFields = ['name', 'description', 'base_price', 'sku'];
  const warehouseFields = ['stock', 'price'];

  const productUpdates = {};
  const warehouseUpdates = {};

  for (const [field, value] of Object.entries(internalData)) {
    if (productFields.includes(field)) {
      productUpdates[field] = value;
    }
    if (warehouseFields.includes(field)) {
      warehouseUpdates[field] = value;
    }
    // Caso especial: base_price también actualiza price en warehouse
    if (field === 'base_price') {
      warehouseUpdates['price'] = value;
    }
  }

  // Aplicar actualizaciones
  if (Object.keys(productUpdates).length > 0) {
    await product.update(productUpdates, options);
    logger.info(`[SYNC] Producto ${task.product_id} actualizado:`, productUpdates);
  }

  if (Object.keys(warehouseUpdates).length > 0) {
    await warehouseProduct.update(warehouseUpdates, options);
    logger.info(`[SYNC] WarehouseProduct actualizado:`, warehouseUpdates);
  }
}
};

module.exports = ProductPublishingTaskController;