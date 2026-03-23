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
  ProductCategoryRepository,
  JobRepository,
  JobProductRepository
} = require('../repositories');
const MercadoLibreAdapter = require('../services/adapters/MercadoLibreAdapter');
const MarketplaceTransformer = require('../services/MarketplaceTransformer');
const PublishingService = require('../services/PublishingService');
const { getRequestMetadata } = require('../util/requestUtil');
const PublishingAdapterFactory = require('../services/adapters/PublishingAdapterFactory');

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
    const pools = await PoolRepository.findFiltered({
      companyId: company_id,
      userId: user_id,
      isActive: true
    });

    const credentials = await MarketplaceCredentialRepository.findByUserDecifrado(user_id);
    
    // 3. ✅ RENOVAR TOKENS EXPIRADOS ANTES DE TRANSFORMAR
    const refreshedCredentials = await ProductPublishingTaskController.refreshExpiredTokens(credentials, userId);

    // 4. Transformar resultados (igual que antes, pero con credenciales actualizadas)
    const marketplaces = refreshedCredentials.map(credential => {
      const mp = credential.marketplace;

      // Opcional: limpiar espacios en domain
      if (typeof mp.domain === 'string') {
        mp.domain = mp.domain.trim();
      }

      return {
        id: credential.id,
        name: credential.name || `${mp.name} (${credential.seller_email || 'Sin nombre'})`,
        description: mp.description || 'Integración con marketplace',
        marketplace_id: mp.id,
        marketplace_name: mp.name,
        type: mp.type,
        domain: mp.domain,
        config: mp.config,
        active: mp.active,
        client_id: mp.client_id,
        client_secret: mp.client_secret,
        redirect_uri: mp.redirect_uri,
        scopes: mp.scopes,
        createdAt: mp.createdAt,
        updatedAt: mp.updatedAt,
        credential_id: credential.id,
        access_token: credential.access_token ? 'Token existente' : null,
        seller_id: credential.seller_id,
        seller_email: credential.seller_email,
        api_key: credential.api_key,
        expires_at: credential.expires_at,
        is_expired: credential.expires_at ? new Date(credential.expires_at) < new Date() : false,
        country: credential.country,
        fieldMappings: credential.fieldMappings
      };
    });

    const categories = await ProductCategoryRepository.findActive();

    res.status(200).json({ 
      success: true, 
      pools: pools, 
      marketplaces: marketplaces, 
      categories: categories 
    });
  } catch (error) {
    logger.error('ProductCategoryController->warehouseMarketplaces: ' + error.message);
    res.status(500).json({ 
      success: false,  
      message: 'Error interno del servidor', 
      details: error.message 
    });
  }
},

/**
 * Verifica y renueva automáticamente tokens expirados para marketplaces que lo requieran
 * @param {Array} credentials - Lista de credenciales con marketplace incluido
 * @param {number} userId - ID del usuario propietario
 * @returns {Promise<Array>} - Lista de credenciales (algunas con tokens renovados)
 */
async refreshExpiredTokens(credentials, userId) {
  // Marketplaces que requieren validación de token (no API key como Falabella)
  
  const refreshPromises = credentials.map(async (credential) => {
    try {
      const mp = credential.marketplace;
      const mpName = mp?.domain || '';
      
      // ✅ Solo procesar marketplaces basados en token
      const isTokenBased = mpName.includes("mercadolibre");
      if (!isTokenBased) {
        return credential; // Falabella y otros con API key no necesitan refresh
      }
      
      // ✅ Verificar si el token está expirado o ausente
      const isExpired = credential.expires_at 
        ? new Date(credential.expires_at) < new Date() 
        : true;
      
      const hasNoToken = !credential.access_token;
      
      if (isExpired || hasNoToken) {
        logger.info(`[warehouseMarketplaces] Token expirado/ausente para credential ${credential.id}. Intentando refresh...`);
        
        // ✅ Crear adapter y validar/renovar credenciales
        const adapter = PublishingAdapterFactory.getAdapter(
          mp, 
          null, // companyId
          null, // branchId
          userId,
          credential // ← Pasar credencial específica
        );
        
        if (adapter && typeof adapter.ensureValidCredentials === 'function') {
          const status = await adapter.ensureValidCredentials();
          
          if (status.valid) {
            logger.info(`[warehouseMarketplaces] ✅ Token renovado para credential ${credential.id}`);
            // ✅ Recargar la credencial actualizada desde la BD
            const updated = await MarketplaceCredentialRepository.findById(credential.id);
            if (updated) {
              updated.marketplace = mp; // Mantener el include del marketplace
              return updated;
            }
          } else if (status.auth_required) {
            logger.warn(`[warehouseMarketplaces] ⚠️ Credential ${credential.id} requiere re-autorización: ${status.auth_url}`);
          } else {
            logger.warn(`[warehouseMarketplaces] ⚠️ No se pudo validar credential ${credential.id}: ${status.error || 'unknown'}`);
          }
        }
      }
      
      return credential; // Retornar original si no hubo cambios o falló el refresh
    } catch (error) {
      // ✅ NO bloquear el flujo: loggear y continuar con la credencial original
      logger.error(`[warehouseMarketplaces] Error al refresh credential ${credential?.id}: ${error.message}`);
      return credential;
    }
  });
  
  // ✅ Ejecutar en paralelo con aislamiento de errores
  const results = await Promise.all(refreshPromises);
  return results;
},

/**
 * ✅ Verifica y renueva token expirado para UNA credencial específica
 * @param {Object} credential - Credencial a validar/renovar
 * @param {Object} marketplace - Marketplace asociado
 * @param {number} userId - ID del usuario
 * @returns {Promise<Object>} - Credencial actualizada o original
 */
async refreshSingleCredential(credential, marketplace, userId) {
  try {
    const mpName = marketplace?.domain || '';
    
    // ✅ Solo marketplaces basados en token (no API key)
    if (!mpName.includes('mercadolibre')) {
      logger.debug(`[refreshSingleCredential] Marketplace ${mpName} no requiere token refresh`);
      return credential;
    }
    
    // ✅ Verificar expiración
    const isExpired = credential.expires_at 
      ? new Date(credential.expires_at) < new Date() 
      : true;
    
    const hasNoToken = !credential.access_token;
    
    if (!isExpired && !hasNoToken) {
      return credential; // Token válido
    }
    
    logger.info(`[refreshSingleCredential] 🔑 Token expirado/ausente para credential ${credential.id}. Renovando...`);
    
    // ✅ Crear adapter y renovar
    const adapter = PublishingAdapterFactory.getAdapter(
      marketplace,
      null, // companyId
      null, // branchId
      userId,
      credential
    );
    
    if (!adapter || typeof adapter.ensureValidCredentials !== 'function') {
      logger.warn(`[refreshSingleCredential] Adapter no soporta refresh para ${mpName}`);
      return credential;
    }
    
    const status = await adapter.ensureValidCredentials();
    
    if (status.valid) {
      logger.info(`[refreshSingleCredential] ✅ Token renovado exitosamente para credential ${credential.id}`);
      
      // ✅ Recargar credencial actualizada desde BD
      const updated = await MarketplaceCredentialRepository.findById(credential.id);
      if (updated) {
        updated.marketplace = marketplace;
        return updated;
      }
    } else if (status.auth_required) {
      logger.warn(`[refreshSingleCredential] ⚠️ Credential ${credential.id} requiere re-autorización: ${status.auth_url}`);
      throw new Error(`auth_required:${status.auth_url}`);
    } else {
      logger.warn(`[refreshSingleCredential] ⚠️ No se pudo renovar credential ${credential.id}: ${status.error || 'unknown'}`);
    }
    
    return credential;
    
  } catch (error) {
    logger.error(`[refreshSingleCredential] Error al renovar credential ${credential?.id}: ${error.message}`);
    throw error; // Propagar error para que el endpoint lo maneje
  }
},
async store(req, res) {
  logger.info(`${req.user?.name || 'Unknown'} - Solicitud de publicación en ${req.body.mode} iniciada`);
  logger.info(`Datos recibidos:\n ${JSON.stringify(req.body, null, 2)}`);

  const { products, marketplaces, pool: rawPool, mode, draft_name, economic_config, publication_step } = req.body;
  const user_id = req.user.id;
  const company_id = req.user.company_id;
  const metadata = getRequestMetadata(req);


    // IDs fijos para testing (los que proporcionaste)
    const SIM_JOB_ID = 6;
    const SIM_BATCH_ID = 'c5a4e469-5b04-4772-88e7-684d980c5122';

  // === VALIDACIONES ===
  if (!['draft', 'publish', 'quick', 'advanced'].includes(mode)) {
    return res.status(400).json({ success: false, msg: "mode_invalid" });
  }
  if (!Array.isArray(products) || products.length === 0) {
    return res.status(400).json({ success: false, msg: "products_required" });
  }
  if (!Array.isArray(marketplaces) || marketplaces.length === 0) {
    return res.status(400).json({ success: false, msg: "marketplaces_required" });
  }

  // === NUEVO: Validar publication_step ===
  const step = publication_step !== undefined ? parseInt(publication_step) : 3; // Default: 3 (Resumen completado)
  if (!Number.isInteger(step) || step < 0 || step > 5) {
    return res.status(400).json({ 
      success: false, 
      msg: "publication_step_invalid",
      details: "El paso debe ser un entero entre 0 y 5"
    });
  }
  
  const batch_id = uuidv4();

  // === Normalizar pool seleccionado ===
  let pool = rawPool || null;
  if (pool && !pool.primary_warehouse && Array.isArray(pool.warehouses) && pool.warehouses.length > 0) {
    pool.primary_warehouse = pool.warehouses[0];
  }

  const poolId = pool?.id || pool?.pool_id || null;

  if (!pool || !pool.primary_warehouse) {
    // Fallback: buscar un almacén activo de la empresa
    const activeWarehouses = await WarehouseRepository.getActiveWarehouses(company_id, null);
    if (!Array.isArray(activeWarehouses) || activeWarehouses.length === 0) {
      return res.status(400).json({
        success: false,
        msg: "pool_required",
        details: "Debe seleccionar un pool con primary_warehouse o tener un almacén activo disponible"
      });
    }

    const fallback = activeWarehouses[0];
    pool = {
      primary_warehouse: {
        warehouse_id: fallback.id,
        branch_id: null
      },
      warehouses: [
        { warehouse_id: fallback.id, branch_id: null }
      ]
    };
  }

  // Validar marketplaces (solo para verificar que existen)
  const marketplaceIds = [...new Set(marketplaces.map(mp => Number(mp.marketplace_id || mp.id)))];
  const validation = await MarketplaceRepository.findByIds(marketplaceIds);
  if (!validation.valid) {
    return res.status(400).json({ success: false, msg: "someMarketplacesNotFound" });
  }

  // ✅ Determinar job_type según el modo
  const isDraft = mode === 'draft';
  const actualMode = isDraft ? 'quick' : mode;
  const job_type = isDraft ? 'draft' : 'publish';

  // ✅ Calcular total de productos × marketplaces para el job
  const totalExpected = products.length * marketplaces.length;

  // ✅ Crear job padre
  // 🔑 IMPORTANTE: Guardar TODOS los datos originales del frontend + campos calculados
  const jobRecord = await JobRepository.create({
    user_id: req.user.id,
    company_id: req.user.company_id,
    job_type: job_type,
    mode: actualMode,
    batch_id: batch_id,
    publication_step: step,  // ← NUEVO: Guardar paso de la publicación
    total_products: totalExpected,  // ← ✅ Pasar total esperado
    config: {
      // 🔑 GUARDAR DATOS ORIGINALES DEL FRONTEND (exactamente como llegan)
      ...req.body,  // ← Esto incluye: products, marketplaces, pool, mode, economic_config, draft_name, publication_step, etc.
      
      // 🔑 CAMPOS CALCULADOS/ADICIONALES (para uso interno)
      pool_id: poolId,  // ← ID del pool calculado
      _processed_at: new Date().toISOString(),  // ← Timestamp de procesamiento
      _total_expected: totalExpected  // ← Total calculado
    }
  });

  // 🔑 Extraer el ID (jobRecord es un objeto con propiedad 'id')
  const jobId = jobRecord?.id;

  // ✅ Validar que jobId sea válido
  if (!jobId || isNaN(jobId)) {
    logger.error('[Controller] jobId inválido:', { jobRecord });
    return res.status(500).json({
      success: false,
      msg: "job_creation_failed",
      details: "No se pudo obtener el ID del job creado"
    });
  }

  // ✅ Crear JobProducts para cada combinación producto × credential
  for (const product of products) {
    for (const mpConfig of marketplaces) {
      await JobProductRepository.create({
        job_id: jobId,  // ← ✅ jobId ya es un número
        product_id: product.id,
        marketplace_id: mpConfig.marketplace_id,
        credential_id: mpConfig.id,
        product_payload: product ? JSON.parse(JSON.stringify(product)) : null,
        marketplace_payload: mpConfig ? JSON.parse(JSON.stringify(mpConfig)) : null,
        status: 'pending',
        attempt_count: 0
      });
    }
  }

  // ✅ Log de creación
  await LogRepository.create({
    user_id: metadata.user_id,
    action: 'publishing_job.created',
    description: `Job creado: ${jobId} - ${products.length} productos × ${marketplaces.length} marketplaces`,
    ip_address: metadata.ip_address,
    user_agent: metadata.user_agent,
    status: 'success',
    meta: {
      job_id: jobId,
      batch_id,
      product_count: products.length,
      marketplace_count: marketplaces.length,
      mode: actualMode,
      total_expected: totalExpected
    }
  });

  // ✅ Responder inmediatamente (background job)
  return res.status(202).json({
    success: true,
    message: isDraft 
      ? "Borrador guardado exitosamente" 
      : "Publicación en proceso en segundo plano",
    job_id: jobId,  // ← ✅ jobId es número, NO jobId.id
    batch_id: batch_id,
    tasks_count: totalExpected,
    status: 'pending'
  });
},
  async publishDraft(req, res) {
  logger.info(`${req.user?.name || 'Unknown'} - Publicando draft`);
  logger.info(`Datos recibidos:\n ${JSON.stringify(req.body)}`);

  const { task_id, mode } = req.body;
  const user_id = req.user.id;
  const metadata = getRequestMetadata(req);

  try {
    // 1. Obtener tarea draft
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

    // 2. Validar entidades
    const marketplace = await MarketplaceRepository.findById(task.marketplace_id);
    const warehouse = await WarehouseRepository.findById(task.warehouse_id);
    const product = await ProductRepository.findById(task.product_id);
    let credential = await MarketplaceCredentialRepository.findById(task.credential_id);

    if (!marketplace || !warehouse || !product || !credential) {
      return res.status(400).json({ 
        success: false, 
        msg: "related_entity_not_found" 
      });
    }

    // 3. ✅ RENOVAR TOKEN SI ES NECESARIO (antes de publicar)
    try {
      credential = await ProductPublishingTaskController.refreshSingleCredential(
        credential,
        marketplace,
        user_id
      );
    } catch (refreshError) {
      if (refreshError.message.startsWith('auth_required:')) {
        const auth_url = refreshError.message.replace('auth_required:', '');
        return res.status(401).json({
          success: false,
          msg: "auth_required",
          auth_url: auth_url
        });
      }
      throw refreshError;
    }

    // 4. Actualizar tarea a pending
    await ProductPublishingTaskRepository.updateStatus(task, 'pending', {
      publishing_mode: mode || task.publishing_mode,
      attempt_count: (task.attempt_count || 0) + 1
    });

    // 5. ✅ REPUBLICAR con credencial actualizada
    const result = await PublishingService.republishProduct(
      task,
      marketplace,
      credential,
      user_id
    );

    // 6. Actualizar task
    await ProductPublishingTaskRepository.updateTask(task, {
      status: result.success ? 'published' : 'failed',
      error_message: result.success ? null : result.error,
      error_details: result.success ? null : result.details,
      external_id: result.success ? result.external_id : task.external_id,
      external_url: result.success ? result.data?.permalink : task.external_url,
      attempt_count: (task.attempt_count || 0) + 1,
      last_attempt_at: new Date(),
      api_response: result.data || task.api_response,
      published_at: result.success ? new Date() : task.published_at
    });

    // 7. Logs y respuesta
    if (result.success) {
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
          task_id: task.id,
          product_id: task.product_id,
          external_id: result.external_id,
          external_url: result.external_url
        }
      });
    } else {
      await LogRepository.create({
        user_id: metadata.user_id,
        action: 'publishing_task.draft_publish_failed',
        description: `Draft ${task_id} falló: ${result.error}`,
        ip_address: metadata.ip_address,
        user_agent: metadata.user_agent,
        status: 'error',
        meta: { task_id, product_id: task.product_id, error: result.error }
      });

      return res.status(200).json({
        success: false,
        message: "Publicación fallida",
        data: {
          task_id: task.id,
          product_id: task.product_id,
          error: result.error,
          error_details: result.details,
          attempt_count: (task.attempt_count || 0) + 1
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
          credential_id: draft.credential_id,
          credential_name: draft.credential?.name,
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

  /**
   * Obtiene un borrador por batch_id o job_id para edición
   * POST /api/publishing-draft-get
   * Body: { batch_id: 'uuid', job_id: 123 } (al menos uno)
   */
  async getDraft(req, res) {
    const { batch_id, job_id } = req.body;
    const { company_id } = req.user;
    const metadata = getRequestMetadata(req);

    try {
      // 1. Validar que al menos un identificador sea proporcionado
      if (!batch_id && !job_id) {
        return res.status(400).json({
          success: false,
          msg: "missing_identifier",
          details: "Debe proporcionar batch_id o job_id"
        });
      }

      // 2. Obtener job usando batch_id (PRIORITARIO) o job_id
      let job;
      if (batch_id) {
        job = await JobRepository.findByBatchId(batch_id, company_id);
      } else {
        job = await JobRepository.findById(job_id);
        
        // Validar que pertenece a la empresa
        if (job && job.company_id !== company_id) {
          job = null;
        }
      }
      
      if (!job) {
        return res.status(404).json({
          success: false,
          msg: "draft_not_found"
        });
      }

      // 3. Validar que es un draft
      if (job.job_type !== 'draft') {
        return res.status(400).json({
          success: false,
          msg: "not_a_draft",
          details: "El job no es un borrador"
        });
      }

      // 4. Validar integridad de datos (productos existen)
      const productIds = job.config?.products?.map(p => p.id) || [];
      if (productIds.length > 0) {
        const existingProducts = await ProductRepository.findByIds(productIds);
        
        if (existingProducts.length !== productIds.length) {
          const missingIds = productIds.filter(id => 
            !existingProducts.find(p => p.id === id)
          );
          
          logger.warn(`[getDraft] Productos faltantes en borrador ${job.id}:`, missingIds);
          
          // Retornar warning al frontend
          return res.status(200).json({
            success: true,
            data: {
              job_id: job.id,
              batch_id: job.batch_id,
              draft_name: job.draft_name,
              mode: job.mode,
              publication_step: job.publication_step,
              pool: job.config?.pool,
              products: [],
              marketplaces: [],
              economic_config: job.config?.economic_config,
              created_at: job.createdAt,
              updated_at: job.updatedAt
            },
            warnings: {
              missing_products: missingIds,
              message: `Algunos productos ya no existen (${missingIds.length}). Se recomienda revisar.`
            }
          });
        }
      }

      // 5. Validar que las credenciales siguen activas
      const credentialIds = job.config?.marketplaces?.map(m => m.id) || [];
      if (credentialIds.length > 0) {
        const existingCredentials = await MarketplaceCredentialRepository.findByIds(credentialIds);
        
        if (existingCredentials.length !== credentialIds.length) {
          const missingCreds = credentialIds.filter(id => 
            !existingCredentials.find(c => c.id === id)
          );
          
          logger.warn(`[getDraft] Credenciales faltantes en borrador ${job.id}:`, missingCreds);
        }
      }

      // 6. Obtener job_products relacionados
      const jobProducts = await JobProductRepository.findAll({
        where: { job_id: job.id }
      });

      // 7. Reconstruir datos para el frontend
      // 🔑 IMPORTANTE: Devolver el config COMPLETO tal cual se guardó + datos enriquecidos
      const draftData = {
        job_id: job.id,
        batch_id: job.batch_id,
        draft_name: job.draft_name,
        mode: job.mode,
        publication_step: job.publication_step,
        created_at: job.createdAt,
        updated_at: job.updatedAt,
        
        // 🔑 CONFIG COMPLETO (datos originales del frontend)
        config: job.config,  // ← Contiene TODOS los datos originales: products, marketplaces, pool, economic_config, etc.
        
        // 🔑 DATOS ENRIQUECIDOS (para conveniencia del frontend)
        products: jobProducts.map(jp => ({
          id: jp.product_id,
          ...jp.product_payload
        })),
        marketplaces: jobProducts
          .map(jp => jp.marketplace_payload)
          .filter((mp, index, self) =>
            index === self.findIndex(m => m.id === m.id)
          ),
        total_products: jobProducts.length
      };

      // 8. Registrar log de acceso
      await LogRepository.create({
        user_id: metadata.user_id,
        action: 'publishing_draft.loaded',
        description: `Borrador ${job.id} cargado para edición`,
        ip_address: metadata.ip_address,
        user_agent: metadata.user_agent,
        status: 'success',
        meta: {
          job_id: job.id,
          batch_id: job.batch_id,
          publication_step: job.publication_step
        }
      });

      return res.status(200).json({
        success: true,
        data: draftData
      });

    } catch (error) {
      logger.error('[Controller] Error al obtener borrador:', error);
      return res.status(500).json({
        success: false,
        msg: "error_fetching_draft",
        error: error.message
      });
    }
  },

  /**
   * Lista todos los borradores de un usuario/empresa
   * POST /api/publishing-draft-list
   * Body: { company_id, user_id } (user_id es opcional, si no se pasa usa req.user.id)
   */
  async listDraftsByUser(req, res) {
    const { company_id, user_id } = req.body;
    const userId = user_id || req.user.id;
    const companyId = company_id || req.user.company_id;
    const metadata = getRequestMetadata(req);

    try {
      // 1. Validar que se proporcione company_id
      if (!companyId) {
        return res.status(400).json({
          success: false,
          msg: "company_id_required",
          details: "Debe proporcionar company_id"
        });
      }

      // 2. Obtener jobs tipo draft del usuario/empresa
      const drafts = await JobRepository.findAll({
        company_id: companyId,
        user_id: userId,
        job_type: 'draft',
        status: 'pending',
        limit: 100,
        includeDetails: true
      });

      // 3. Enriquecer con información adicional
      const enrichedDrafts = await Promise.all(
        drafts.map(async (draft) => {
          // 🔑 USAR REPOSITORIOS: Obtener conteo de job_products
          const { total: totalProducts, statusCounts } = await JobProductRepository.getStatusCounts(draft.id);

          // 🔑 USAR REPOSITORIOS: Obtener nombres de productos y marketplaces
          const productIds = draft.config?.products?.map(p => p.id) || [];
          const products = productIds.length > 0 
            ? await ProductRepository.findByIds(productIds)
            : [];
          
          const marketplaceIds = draft.config?.marketplaces?.map(m => m.id) || [];
          const marketplaces = marketplaceIds.length > 0
            ? await MarketplaceCredentialRepository.findByIds(marketplaceIds)
            : [];

          return {
            job_id: draft.id,
            batch_id: draft.batch_id,
            draft_name: draft.draft_name,
            mode: draft.mode,
            publication_step: draft.publication_step,
            created_at: draft.createdAt,
            updated_at: draft.updatedAt,
            
            // 🔑 CONFIG COMPLETO (datos originales del frontend)
            config: draft.config,  // ← Contiene TODOS los datos originales
            
            // 🔑 DATOS ENRIQUECIDOS (para conveniencia del frontend)
            products: {
              total: products.length,
              items: products.map(p => ({
                id: p.id,
                name: p.name,
                sku: p.sku
              }))
            },
            marketplaces: {
              total: marketplaces.length,
              items: marketplaces.map(m => ({
                id: m.id,
                name: m.name || m.seller_email,
                marketplace_name: m.marketplace?.name || 'Marketplace'
              }))
            },
            stats: {
              total_products: totalProducts,
              pending: statusCounts['pending'] || 0,
              success: statusCounts['success'] || 0,
              error: statusCounts['error'] || 0
            }
          };
        })
      );

      // 4. Registrar log
      await LogRepository.create({
        user_id: metadata.user_id,
        action: 'publishing_draft.list',
        description: `Listado de borradores: ${enrichedDrafts.length} encontrados`,
        ip_address: metadata.ip_address,
        user_agent: metadata.user_agent,
        status: 'success',
        meta: {
          company_id: companyId,
          user_id: userId,
          draft_count: enrichedDrafts.length
        }
      });

      return res.status(200).json({
        success: true,
        drafts: enrichedDrafts,
        count: enrichedDrafts.length
      });

    } catch (error) {
      logger.error('[Controller] Error al listar borradores:', error);
      return res.status(500).json({
        success: false,
        msg: "error_listing_drafts",
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
        tasks = await ProductPublishingTaskRepository.findAllByCompany(company_id, user_id);
      }

       const mapped = tasks.map(t => ({
      id: t.id,
      product_id: t.product_id,
      product_name: t.product?.name || 'N/A',
      product_image: t.product?.images?.[0] || 'products/default.jpg',  // ← ✅ Safe access
      marketplace_id: t.marketplace_id,
      marketplace_name: t.marketplace?.name || 'N/A',
      credential_id: t.credential_id,
      credential_name: t.credential?.name || 'N/A',
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
      updated_at: t.updatedAt,
      // ✅ Campo calculado para identificar warnings fácilmente
      has_warnings: t.status === 'published_with_warnings' || 
                    (t.error_details && typeof t.error_details === 'object' && t.error_details.has_warnings === true) ||
                    (Array.isArray(t.error_details?.warnings) && t.error_details.warnings.length > 0)
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
              published_with_warnings: 0,  // ✅ Nuevo contador para warnings
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
          case 'published_with_warnings': 
            grouped[task.batch_id].summary.published_with_warnings++; 
            break;
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
async retryBatch(req, res) {
  logger.info(`${req.user?.name || 'Unknown'} - Republicando productos`);
  logger.info(`Datos recibidos: \n ${JSON.stringify(req.body)}`);

  const { tasks } = req.body;
  const user_id = req.user.id;
  const results = [];

  for (const { task_id, job_id } of tasks) {
    try {
      // 1. Obtener task
      const task = await ProductPublishingTaskRepository.findById(task_id);
      if (!task) {
        results.push({ task_id, success: false, error: 'task_not_found' });
        continue;
      }

      // 2. Obtener marketplace y credential
      const marketplace = await MarketplaceRepository.findById(task.marketplace_id);
      let credential = await MarketplaceCredentialRepository.findById(task.credential_id);

      if (!marketplace || !credential) {
        results.push({ task_id, success: false, error: 'marketplace_or_credential_not_found' });
        continue;
      }

      // 3. ✅ RENOVAR TOKEN SI ES NECESARIO
      try {
        credential = await ProductPublishingTaskController.refreshSingleCredential(
          credential,
          marketplace,
          user_id
        );
      } catch (refreshError) {
        logger.warn(`[retryBatch] No se pudo renovar token para task ${task_id}: ${refreshError.message}`);
        results.push({
          task_id,
          success: false,
          error: refreshError.message.startsWith('auth_required') ? 'auth_required' : refreshError.message,
          error_details: refreshError.message.startsWith('auth_required')
            ? { auth_url: refreshError.message.split(':')[1] }
            : null
        });
        continue; // Continuar con el siguiente task
      }

      // 4. ✅ REPUBLICAR con credencial actualizada
      const result = await PublishingService.republishProduct(
        task,
        marketplace,
        credential,
        user_id
      );

      // 5. ✅ Actualizar JobProduct si hay job_id
      if (job_id) {
        try {
          // Buscar JobProduct por job_id + product_id + marketplace_id + credential_id
          const jobProduct = await JobProductRepository.findByProductAndMarketplace(
            job_id,
            task.product_id,
            task.marketplace_id,
            task.credential_id
          );

          if (jobProduct) {
            // Determinar status para JobProduct (mapeo desde ProductPublishingTask)
            const jobProductStatus = result.status === 'published' || result.status === 'published_with_warnings'
              ? 'success'
              : result.status === 'failed'
                ? 'error'
                : jobProduct.status;

            await JobProductRepository.update(jobProduct, {
              status: jobProductStatus,
              external_id: result.external_id || jobProduct.external_id,
              external_url: result.external_url || jobProduct.external_url,
              error_message: result.success ? null : (result.error || jobProduct.error_message),
              error_details: result.success ? null : (result.error_details || result.details || jobProduct.error_details),
              attempt_count: (jobProduct.attempt_count || 0) + 1,
              last_attempt_at: new Date()
            });

            logger.info(`[retryBatch] JobProduct ${jobProduct.id} actualizado: ${jobProductStatus}`);
          }

          // 6. ✅ Actualizar progreso del Job
          await JobRepository.recalculateProgress(job_id);

        } catch (jobError) {
          logger.warn(`[retryBatch] Error actualizando Job/JobProduct: ${jobError.message}`);
          // No bloquear el flujo, continuar
        }
      }

      results.push({
        task_id,
        success: result.success,
        external_id: result.external_id,
        error: result.success ? null : result.error,
        error_details: result.success ? null : (result.error_details || result.details),
        has_warnings: result.has_warnings || false,
        warnings: result.warnings || null,
        status: result.status  // ← ✅ Incluir status para que el front sepa el estado real
      });

    } catch (error) {
      logger.error(`[retryBatch] Error republicando task ${task_id}:`, error);

      const currentTask = await ProductPublishingTaskRepository.findById(task_id);
      await ProductPublishingTaskRepository.updateTask(currentTask || { id: task_id }, {
        status: 'failed',
        error_message: error.message,
        attempt_count: ((currentTask?.attempt_count) || 0) + 1,
        last_attempt_at: new Date()
      });

      // ✅ Actualizar JobProduct en caso de error
      if (job_id) {
        try {
          const jobProduct = await JobProductRepository.findByProductAndMarketplace(
            job_id,
            currentTask?.product_id || task.product_id,
            currentTask?.marketplace_id || task.marketplace_id,
            currentTask?.credential_id || task.credential_id
          );

          if (jobProduct) {
            await JobProductRepository.update(jobProduct, {
              status: 'error',
              error_message: error.message,
              attempt_count: (jobProduct.attempt_count || 0) + 1,
              last_attempt_at: new Date()
            });

            await JobRepository.recalculateProgress(job_id);
          }
        } catch (jobError) {
          logger.warn(`[retryBatch] Error actualizando JobProduct en error: ${jobError.message}`);
        }
      }

      results.push({
        task_id,
        success: false,
        error: error.message,
        error_details: error.response?.data || null
      });
    }
  }

  const successCount = results.filter(r => r.success).length;

  return res.json({
    success: true,
    total: results.length,
    successful: successCount,
    failed: results.length - successCount,
    results
  });
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
},

/**
 * Actualiza el payload de una tarea de publicación específica
 * PUT /api/publishing-tasks/:id/payload
 */
async updatePayload(req, res) {
  logger.info(`${req.user?.name || 'Unknown'} - Actualiza payload de tarea`);
  logger.info(`Datos recibidos: \n ${JSON.stringify(req.body)}`);
  const { payload, task_id } = req.body;
  const metadata = getRequestMetadata(req);

  try {
    // ✅ Buscar tarea con relaciones
    const task = await ProductPublishingTaskRepository.findById(task_id);
    if (!task) {
      return res.status(404).json({
        success: false,
        message: "task_not_found"
      });
    }
    // ✅ Validar que la tarea esté en estado editable
    // ✅ published_with_warnings es editable para permitir corregir warnings y republicar
    const editableStatuses = ['draft', 'failed', 'pending', 'published_with_warnings'];
    if (!editableStatuses.includes(task.status)) {
      return res.status(400).json({
        success: false,
        msg: "invalid_status",
        message: `No se puede editar el payload en estado: ${task.status}`
      });
    }

    // ✅ Actualizar payload vía repository
    const updatedTask = await ProductPublishingTaskRepository.updatePayload(
      task,
      payload
    );

    // ✅ Registrar auditoría
    await LogRepository.create({
      user_id: metadata.user_id,
      action: 'publishing_task.update_payload',
      description: `Payload actualizado para tarea ${task_id}`,
      ip_address: metadata.ip_address,
      user_agent: metadata.user_agent,
      status: 'success',
      meta: { 
        task_id,
        payload_keys: Object.keys(payload),
        updated_at: updatedTask.updatedAt
      }
    });

    // ✅ Respuesta exitosa (solo campos esenciales para no saturar)
    return res.status(200).json({ 
      success: true,
      message: "Payload actualizado correctamente",
      task: { 
        task_id: updatedTask.id, 
        status: updatedTask.status,
        payload: updatedTask.payload,
        updated_at: updatedTask.updatedAt
      } 
    });

  } catch (error) {
    logger.error(`Error actualizando payload:\n ${JSON.stringify(error.message)}`);
    
    // ✅ Registrar error en auditoría
    await LogRepository.create({
      user_id: metadata.user_id,
      action: 'publishing_task.update_payload',
      description: `Error al actualizar payload: ${error.message}`,
      ip_address: metadata.ip_address,
      user_agent: metadata.user_agent,
      status: 'error',
      meta: { task_id, error: error.message }
    });

    return res.status(500).json({ 
      success: false,
      msg: "internal_error",
      error: error.message 
    });
  }
},
};

module.exports = ProductPublishingTaskController;
