// src/controllers/ProductPublishingTaskController.js
const { getUserId } = require('../../config/context');
const logger = require('../../config/logger');
const { v4: uuidv4 } = require('uuid');
const { sequelize } = require('../models');
const {
  ProductPublishingTaskRepository,
  ProductRepository,
  MarketplaceRepository,
  WarehouseRepository,
  CompanyRepository,
  UserRepository,
  LogRepository,
  WarehouseProductRepository,
  MarketplaceCredentialRepository,
  ProductMarketplaceLinkRepository,
  PoolRepository,
  ProductCategoryRepository
} = require('../repositories');
const MercadoLibreAdapter = require('../services/adapters/MercadoLibreAdapter');
const MarketplaceTransformer = require('../services/MarketplaceTransformer');
const PublishingService = require('../services/PublishingService');
const { getRequestMetadata } = require('../util/requestUtil');

const ProductPublishingTaskController = {
  // 1. Registrar publicación (simula envío a API)
  async warehouseMarketplaces(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Lista ruta combinada de almacenes y marketplaces`);

    const { company_id, user_id: bodyUserId, status } = req.body;
    let user_id = bodyUserId || getUserId;

    // Parsear IDs
    const companyId = company_id ? Number(company_id) : undefined;
    const userId = user_id ? Number(user_id) : undefined;

    if (company_id) {
      const company = await CompanyRepository.findById(company_id);
      if (!company) {
        logger.info(`WarehouseController->list: Compañía no encontrada con ID ${company_id}`);
        return res.status(400).json({ success: false, message: "companyNotFound" });
      }
    }

    try {
      /*const mappedWarehouses = await WarehouseRepository.findFiltered({
        companyId,
        branchId: null,
        userId: null,
        status: null,
        type: null,
        include_products: false
      });*/

      const pools = await PoolRepository.findFiltered({
        companyId: company_id,
        userId: user_id,
        isActive: true
      });

      const credentials = await MarketplaceCredentialRepository.findByUser(user_id);
     
      // Transformar resultados
      const marketplaces = credentials.map(credential => {
        const mp = credential.marketplace;

        // Opcional: limpiar espacios en domain
        if (typeof mp.domain === 'string') {
          mp.domain = mp.domain.trim();
        }

        return {
        ...mp,
        credential_id: credential.id,
        access_token: credential ? 'Token existente' : null,
        seller_id: credential.seller_id,
        seller_email: credential.seller_email,
        api_key: credential.api_key,
        expires_at: credential.expires_at,
        is_expired: credential.expires_at ? new Date(credential.expires_at) < new Date() : false,
      };
      });

      const categories = await ProductCategoryRepository.findActive();

      res.status(200).json({ success: true, pools: pools, marketplaces: marketplaces, categories: categories });
    } catch (error) {
      logger.error('ProductCategoryController->warehouseMarketplaces: ' + error.message);
      res.status(500).json({ success: false,  message: 'Error interno del servidor', details: error.message });
    }
  },
  async store(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Publicación/Draft iniciado`);
    logger.info('Datos recibidos:');
    logger.info(JSON.stringify(req.body, null, 2));

    const { products, marketplaces, pool, mode, draft_name } = req.body;
    const user_id = req.user.id;
    const company_id = req.user.company_id;
    const metadata = getRequestMetadata(req);

    // ✅ Validar modo
    if (!['draft', 'publish', 'quick', 'advanced'].includes(mode)) {
      return res.status(400).json({ 
        success: false, 
        msg: "mode_invalid",
        details: "Modo debe ser 'draft', 'publish', 'quick' o 'advanced'"
      });
    }

    // ✅ Determinar si es draft
    const isDraft = mode === 'draft';
    const actualMode = isDraft ? 'quick' : mode; // Para publicación usar quick/advanced

    // Extraer warehouse_ids y primary
    const warehouse_ids = pool.warehouses.map(w => w.warehouse_id);
    const primary_warehouse_id = pool.primary_warehouse.warehouse_id;
    const primary_warehouse = pool.primary_warehouse;

    // Validar marketplaces reales
    const marketplaceIds = marketplaces.map(mp => Number(mp.id));
    const validation = await MarketplaceRepository.findByIds(marketplaceIds);
    if (!validation.valid) {
      return res.status(400).json({ success: false, msg: "someMarketplacesNotFound" });
    }
    const validMarketplaces = validation.marketplaces;

    // ✅ Generar batch_id para agrupar todas las publicaciones
    const batch_id = uuidv4();

    const successResults = [];
    const errorResults = [];
    const draftTasks = [];

    // ✅ Si es DRAFT, guardar sin publicar
    if (isDraft) {
      try {
        for (const mp of validMarketplaces) {
          for (const product of products) {
            // Transformar producto
            const [transformed] = await MarketplaceTransformer.transformProducts(
              [{ ...product, marketplace_id: mp.id }],
              mp.id
            );

            if (!transformed) {
              logger.warn(`No se pudo transformar producto ${product.id} para marketplace ${mp.id}`);
              errorResults.push({
                product_id: product.id,
                marketplace_id: mp.id,
                error: 'transform_failed'
              });
              continue;
            }

            // Guardar como draft
            const task = await ProductPublishingTaskRepository.create({
              product_id: product.id,
              marketplace_id: mp.id,
              warehouse_id: primary_warehouse_id,
              branch_id: primary_warehouse.branch_id || null,
              user_id: user_id,
              company_id: company_id,
              batch_id: batch_id,
              status: 'draft',
              draft_name: draft_name || `Draft ${new Date().toISOString()}`,
              publishing_mode: actualMode,
              date: new Date(),
              payload: transformed,
              attempt_count: 1
            });

            draftTasks.push({
              id: task.id,
              product_id: task.product_id,
              marketplace_id: task.marketplace_id,
              status: task.status,
              draft_name: task.draft_name
            });
          }
        }

        await LogRepository.create({
          user_id: metadata.user_id,
          action: 'publishing_task.draft_save',
          description: `Borrador guardado: ${draftTasks.length} tareas`,
          ip_address: metadata.ip_address,
          user_agent: metadata.user_agent,
          status: 'success',
          meta: { 
            batch_id,
            marketplace_ids: marketplaceIds,
            product_count: products.length,
            draft_name
          }
        });

        return res.status(201).json({
          success: true,
          message: "Borrador guardado exitosamente",
          batch_id: batch_id,
          tasks: draftTasks
        });

      } catch (error) {
        logger.error('Error guardando draft:', error.message);
        return res.status(500).json({ 
          success: false, 
          msg: "draft_save_failed",
          error: error.message 
        });
      }
    }

    // ✅ Si NO es draft, publicar inmediatamente
    for (const mp of validMarketplaces) {
      const config = marketplaces.find(m => Number(m.id) === mp.id)?.publishing_config || {};
      
      try {
        const result = await PublishingService.publishProducts(
          products,
          mp,
          { id: primary_warehouse_id, company_id, branch_id: null },
          user_id,
          company_id,
          actualMode,
          config
        );

        if (result.auth_required) {
          return res.status(401).json({ 
            success: false,
            msg: "auth_required", 
            auth_url: result.auth_url 
          });
        }

        // ✅ Procesar resultados exitosos
        if (result.success && Array.isArray(result.success)) {
          for (const successItem of result.success) {
            successResults.push({
              ...successItem,
              marketplace_id: mp.id,
              batch_id: batch_id
            });
          }
        }

        // ✅ Procesar errores
        if (result.errors && Array.isArray(result.errors)) {
          for (const errorItem of result.errors) {
            errorResults.push({
              ...errorItem,
              marketplace_id: mp.id,
              batch_id: batch_id
            });
          }
        }

      } catch (err) {
        logger.error(`Error en marketplace ${mp.id}:`, err.message);
        errorResults.push(...products.map(p => ({
          product_id: p.id,
          marketplace_id: mp.id,
          batch_id: batch_id,
          error: err.message || 'Error interno'
        })));
      }
    }

    // ✅ Registrar log
    await LogRepository.create({
      user_id: metadata.user_id,
      action: 'publishing_task.publish',
      description: `Publicación: ${successResults.length} éxitos, ${errorResults.length} errores`,
      ip_address: metadata.ip_address,
      user_agent: metadata.user_agent,
      status: errorResults.length === 0 ? 'success' : 'partial_success',
      meta: { 
        batch_id,
        warehouse_id: primary_warehouse_id,
        marketplace_ids: marketplaceIds,
        success_count: successResults.length,
        error_count: errorResults.length,
        mode: actualMode,
        product_count: products.length
      }
    });

    // ✅ Responder con resultados detallados
    return res.status(200).json({
      success: successResults.length > 0,
      has_errors: errorResults.length > 0,
      message: errorResults.length > 0 
        ? "Algunos productos no se pudieron publicar"
        : "Publicación completada exitosamente",
      data: {
        batch_id: batch_id,
        success: successResults,
        errors: errorResults,
        summary: {
          total: products.length * validMarketplaces.length,
          published: successResults.length,
          failed: errorResults.length,
          marketplaces: validMarketplaces.map(mp => ({
            id: mp.id,
            name: mp.name,
            published: successResults.filter(s => s.marketplace_id === mp.id).length,
            failed: errorResults.filter(e => e.marketplace_id === mp.id).length
          }))
        }
      }
    });
  },

    async publishDraft(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Publicando draft`);
    logger.info(`Datos recibidos:\n ${JSON.stringify(req.body)}`);

    const { task_id, mode } = req.body;
    const user_id = req.user.id;
    const metadata = getRequestMetadata(req);

    try {
      // Obtener tarea draft
      const task = await ProductPublishingTaskRepository.findById(task_id);
      if (!task) {
        return res.status(404).json({ success: false, msg: "task_not_found" });
      }

      if (task.status !== 'draft') {
        return res.status(400).json({ 
          success: false, 
          msg: "task_not_draft",
          current_status: task.status
        });
      }

      // Validar entidades
      const marketplace = await MarketplaceRepository.findById(task.marketplace_id);
      const warehouse = await WarehouseRepository.findById(task.warehouse_id);
      const product = await ProductRepository.findById(task.product_id);

      if (!marketplace || !warehouse || !product) {
        return res.status(400).json({ 
          success: false, 
          msg: "related_entity_not_found" 
        });
      }

      // ✅ Actualizar tarea a pending
      await ProductPublishingTaskRepository.updateStatus(task, 'pending', {
        publishing_mode: mode || task.publishing_mode,
        attempt_count: task.attempt_count + 1
      });

      // ✅ Publicar
      const result = await PublishingService.publishProduct(
        { ...product.toJSON(), ...task.payload },
        marketplace,
        warehouse,
        user_id
      );

      if (result.auth_required) {
        // ✅ Revertir a draft si requiere auth
        await ProductPublishingTaskRepository.updateStatus(task, 'draft');
        return res.status(401).json({
          success: false,
          msg: "auth_required",
          auth_url: result.auth_url
        });
      }

      // ✅ Procesar resultado
      let updatedTask;
      if (result.success) {
        updatedTask = await ProductPublishingTaskRepository.updateStatus(task, 'published', {
          external_id: result.external_id,
          external_url: result.external_url,
          published_at: new Date(),
          api_response: result.data || null,
          error_message: null,
          error_details: null
        });

        await LogRepository.create({
          user_id: metadata.user_id,
          action: 'publishing_task.draft_published',
          description: `Draft ${task_id} publicado exitosamente`,
          ip_address: metadata.ip_address,
          user_agent: metadata.user_agent,
          status: 'success',
          meta: { task_id, product_id: task.product_id, external_id: result.external_id }
        });

        return res.status(200).json({
          success: true,
          message: "Publicación exitosa",
          data: {
            task_id: updatedTask.id,
            product_id: updatedTask.product_id,
            external_id: updatedTask.external_id,
            external_url: updatedTask.external_url
          }
        });
      } else {
        // ✅ Guardar errores detallados
        updatedTask = await ProductPublishingTaskRepository.updateStatus(task, 'failed', {
          error_message: result.error || 'Error desconocido',
          error_details: result.details || null,
          api_response: result.api_response || null,
          attempt_count: task.attempt_count + 1
        });

        await LogRepository.create({
          user_id: metadata.user_id,
          action: 'publishing_task.draft_publish_failed',
          description: `Draft ${task_id} falló: ${result.error}`,
          ip_address: metadata.ip_address,
          user_agent: metadata.user_agent,
          status: 'error',
          meta: { 
            task_id, 
            product_id: task.product_id,
            error: result.error,
            details: result.details
          }
        });

        return res.status(200).json({
          success: false,
          message: "Publicación fallida",
          data: {
            task_id: updatedTask.id,
            product_id: updatedTask.product_id,
            error: updatedTask.error_message,
            error_details: updatedTask.error_details,
            attempt_count: updatedTask.attempt_count
          }
        });
      }

    } catch (error) {
      logger.error('Error publicando draft:', error.message);
      await LogRepository.create({
        user_id: metadata?.user_id,
        action: 'publishing_task.draft_publish_error',
        description: `Error: ${error.message}`,
        ip_address: metadata?.ip_address,
        user_agent: metadata?.user_agent,
        status: 'error',
        meta: { task_id }
      });
      return res.status(500).json({ 
        success: false, 
        msg: "internal_error",
        error: error.message 
      });
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

    async listDrafts(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Listando drafts`);
    
    const { company_id, user_id } = req.body;
    const userId = user_id || req.user.id;

    try {
      const drafts = await ProductPublishingTaskRepository.findDraftsByUser(userId, company_id);

      const grouped = {};
      drafts.forEach(draft => {
        if (!grouped[draft.batch_id]) {
          grouped[draft.batch_id] = {
            batch_id: draft.batch_id,
            draft_name: draft.draft_name,
            created_at: draft.createdAt,
            products: []
          };
        }
        grouped[draft.batch_id].products.push({
          id: draft.id,
          product_id: draft.product_id,
          marketplace_id: draft.marketplace_id,
          marketplace_name: draft.marketplace?.name,
          product_name: draft.product?.name,
          status: draft.status
        });
      });

      return res.status(200).json({
        success: true,
        drafts: Object.values(grouped)
      });

    } catch (error) {
      logger.error('Error listando drafts:', error.message);
      return res.status(500).json({ 
        success: false, 
        msg: "internal_error",
        error: error.message 
      });
    }
  },
async updateStatus(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Actualiza estado de tarea`);
    const { id, status, error_message, error_details, api_response, external_id, external_url, published_at } = req.body;
    const metadata = getRequestMetadata(req);

    try {
      const task = await ProductPublishingTaskRepository.findById(id);
      if (!task) return res.status(404).json({ success: false, msg: "task_not_found" });

      const updateData = {};
      if (error_message !== undefined) updateData.error_message = error_message;
      if (error_details !== undefined) updateData.error_details = error_details;
      if (api_response !== undefined) updateData.api_response = api_response;
      if (external_id !== undefined) updateData.external_id = external_id;
      if (external_url !== undefined) updateData.external_url = external_url;
      if (published_at !== undefined) updateData.published_at = published_at;

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

      return res.status(200).json({ 
        success: true,
        message: "Estado actualizado", 
        task: { 
          id: updated.id, 
          status: updated.status,
          external_id: updated.external_id,
          error_message: updated.error_message
        } 
      });
    } catch (error) {
      logger.error('Error actualizando estado:', error.message);
      return res.status(500).json({ 
        success: false,
        msg: "internal_error",
        error: error.message 
      });
    }
  },

  async list(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Lista tareas`);
    const { company_id, user_id, status, batch_id } = req.body;

    try {
      let tasks;
      if (batch_id) {
        tasks = await ProductPublishingTaskRepository.findByBatchId(batch_id);
      } else if (status) {
        tasks = await ProductPublishingTaskRepository.findByCompanyAndStatus(company_id, status);
      } else {
        tasks = await ProductPublishingTaskRepository.findAllByCompany(company_id);
      }

      // ✅ Filtrar por usuario si se especifica
      if (user_id) {
        tasks = tasks.filter(t => t.user_id === Number(user_id));
      }

      const mapped = tasks.map(t => ({
        id: t.id,
        product_id: t.product_id,
        product_name: t.product?.name || 'N/A',
        product_image: t.product?.images[0] || 'products/default.jpg',
        marketplace_id: t.marketplace_id,
        marketplace_name: t.marketplace?.name || 'N/A',
        warehouse_id: t.warehouse_id,
        company_id: t.company_id,
        user_id: t.user_id,
        user_name: t.user?.name || 'N/A',
        batch_id: t.batch_id,
        status: t.status,
        draft_name: t.draft_name,
        payload: t.payload,
        publishing_mode: t.publishing_mode,
        error_message: t.error_message,
        error_details: t.error_details,
        api_response: t.api_response,
        external_id: t.external_id,
        external_url: t.external_url,
        published_at: t.published_at,
        attempt_count: t.attempt_count,
        created_at: t.createdAt,
        updated_at: t.updatedAt
      }));

      // ✅ Agrupar por batch_id si existe
      const grouped = {};
      mapped.forEach(task => {
        if (!grouped[task.batch_id]) {
          grouped[task.batch_id] = {
            batch_id: task.batch_id,
            tasks: [],
            summary: {
              total: 0,
              published: 0,
              failed: 0,
              draft: 0,
              pending: 0
            }
          };
        }
        grouped[task.batch_id].tasks.push(task);
        grouped[task.batch_id].summary.total++;
        
        switch(task.status) {
          case 'published': grouped[task.batch_id].summary.published++; break;
          case 'failed': grouped[task.batch_id].summary.failed++; break;
          case 'draft': grouped[task.batch_id].summary.draft++; break;
          case 'pending': grouped[task.batch_id].summary.pending++; break;
        }
      });

      return res.status(200).json({ 
        success: true,
        publishing_tasks: batch_id ? mapped : Object.values(grouped) 
      });
    } catch (error) {
      logger.error(`Error listando tareas: ${error.message}`);
      return res.status(500).json({ 
        success: false,
        msg: "internal_error",
        error: error.message 
      });
    }
  },

  // ✅ CORREGIDO: Reintentar publicación
  async retry(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Reintenta publicación`);
    logger.info('Datos recibidos:', JSON.stringify(req.body));

    const { task_id, payload } = req.body;
    const user_id = req.user.id;
    const metadata = getRequestMetadata(req);

    if (!task_id) {
      return res.status(400).json({ success: false, msg: "task_id_required" });
    }

    let transaction;
    try {
      const task = await ProductPublishingTaskRepository.findById(task_id);
      if (!task) return res.status(404).json({ success: false, msg: "task_not_found" });
      
      if (!['failed', 'draft'].includes(task.status)) {
        return res.status(400).json({ 
          success: false, 
          msg: "task_not_retryable",
          current_status: task.status
        });
      }

      // Validar entidades
      const marketplace = await MarketplaceRepository.findById(task.marketplace_id);
      const warehouse = await WarehouseRepository.findById(task.warehouse_id);
      const user = await UserRepository.findById(user_id);
      
      if (!marketplace || !warehouse || !user) {
        return res.status(400).json({ success: false, msg: "related_entity_not_found" });
      }

      transaction = await sequelize.transaction();

      // ✅ Incrementar attempt_count
      const newAttemptCount = task.attempt_count + 1;
      await ProductPublishingTaskRepository.updateStatus(task, 'processing', {
        attempt_count: newAttemptCount
      }, { transaction });

      // ✅ Publicar con payload corregido o original
      const payloadToSend = payload || task.payload;
      const result = await PublishingService.publishProduct(
        { ...payloadToSend, id: task.product_id },
        marketplace,
        warehouse,
        user_id
      );

      let updatedTask;
      if (result.success) {
        updatedTask = await ProductPublishingTaskRepository.updateStatus(task, 'published', {
          payload: payloadToSend,
          external_id: result.external_id,
          external_url: result.external_url,
          published_at: new Date(),
          api_response: result.data || null,
          error_message: null,
          error_details: null
        }, { transaction });

        // ✅ Crear/Actualizar ProductMarketplaceLink
        await ProductMarketplaceLinkRepository.upsert({
          product_id: task.product_id,
          marketplace_id: task.marketplace_id,
          company_id: warehouse.company_id,
          branch_id: warehouse.branch_id,
          status: 'published',
          external_id: result.external_id,
          external_url: result.external_url,
          last_synced_at: new Date()
        }, { transaction });

        await transaction.commit();

        await LogRepository.create({
          user_id: metadata.user_id,
          action: 'publishing_task.retry_success',
          description: `Reintento exitoso para tarea ${task_id}`,
          ip_address: metadata.ip_address,
          user_agent: metadata.user_agent,
          status: 'success',
          meta: { task_id, product_id: task.product_id, attempt: newAttemptCount }
        });

        return res.status(200).json({
          success: true,
          message: "Reintento exitoso",
          data: {
            task_id: updatedTask.id,
            status: updatedTask.status,
            external_id: updatedTask.external_id,
            attempt_count: updatedTask.attempt_count
          }
        });

      } else {
        // ✅ Guardar errores detallados
        updatedTask = await ProductPublishingTaskRepository.updateStatus(task, 'failed', {
          payload: payloadToSend,
          error_message: result.error || 'Error desconocido',
          error_details: result.details || null,
          api_response: result.api_response || null,
          attempt_count: newAttemptCount
        }, { transaction });

        await transaction.commit();

        await LogRepository.create({
          user_id: metadata.user_id,
          action: 'publishing_task.retry_failed',
          description: `Reintento fallido para tarea ${task_id}: ${result.error}`,
          ip_address: metadata.ip_address,
          user_agent: metadata.user_agent,
          status: 'error',
          meta: { 
            task_id, 
            product_id: task.product_id,
            attempt: newAttemptCount,
            error: result.error
          }
        });

        return res.status(200).json({
          success: false,
          message: "Reintento fallido",
          data: {
            task_id: updatedTask.id,
            status: updatedTask.status,
            error: updatedTask.error_message,
            error_details: updatedTask.error_details,
            attempt_count: updatedTask.attempt_count
          }
        });
      }

    } catch (error) {
      if (transaction) await transaction.rollback();
      logger.error('Error en retry:', error.message);
      await LogRepository.create({
        user_id: metadata?.user_id,
        action: 'publishing_task.retry_error',
        description: `Error: ${error.message}`,
        ip_address: metadata?.ip_address,
        user_agent: metadata?.user_agent,
        status: 'error',
        meta: { task_id }
      });
      return res.status(500).json({ 
        success: false,
        msg: "internal_error",
        error: error.message 
      });
    }
  },

  // Agregar método destroy al controlador
async destroy(req, res) {
  const userName = req.user?.name || 'Anonymous';
  const task_id = req.body.id;
  logger.info(`${userName} - Elimina tarea de publicación ID ${task_id}`);
  logger.info("Datos recibidos:");
  logger.info(JSON.stringify({ body: req.body }));

  try {
    const task = await ProductPublishingTaskRepository.findById(task_id);
    if (!task) return res.status(404).json({ msg: "PublishingTaskNotFound" });

    // Verificar que el usuario tenga permiso para eliminar
    if (task.user_id !== req.user.id && task.company_id !== req.user.company_id) {
      return res.status(403).json({ msg: "Forbidden" });
    }

    await ProductPublishingTaskRepository.delete(task);
    
    
    return res.status(200).json({ 
      success: true,
      message: "Publicación eliminada correctamente", 
    });
  } catch (err) {
    logger.error("ProductPublishingTaskController->destroy: " + err.message);
    return res.status(500).json({ error: "ServerError", details: err.message });
  }
}
};

module.exports = ProductPublishingTaskController;