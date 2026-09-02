const { Op } = require("sequelize");
const { getUserId } = require("../../config/context");
const logger = require("../../config/logger");
const {
  JobRepository,
  JobProductRepository,
  NotificationRepository,
  ProductPublishingTaskRepository,
  ProductMarketplaceLinkRepository,
  MarketplaceCredentialRepository
} = require("../repositories");
const { verifyMercadoLibreItem } = require("../services/MarketplaceItemVerificationService");
const PublicationAuditService = require("../services/PublicationAuditService");
const checkIsError = (item) => {
  if (!item) return false;
  const isFailedStatus = item.status === 'error' || item.status === 'failed';
  const hasMsgNoWarnings = item.error_message && !item.error_details?.warnings;
  return isFailedStatus || hasMsgNoWarnings;
};

const checkIsWarning = (item) => {
  if (!item) return false;
  return Array.isArray(item.error_details?.warnings) && item.error_details.warnings.length > 0;
};

const checkCanEdit = (item) => {
  if (!item) return false;
  return !item.is_fixed && (checkIsError(item) || checkIsWarning(item));
};

function parseJsonMaybe(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;

  try {
    const parsed = JSON.parse(value);
    // Algunas tareas antiguas guardaron JSON serializado dos veces.
    return typeof parsed === 'string' ? parseJsonMaybe(parsed) : parsed;
  } catch (error) {
    return null;
  }
}

const PUBLICATION_FIELD_LABELS = {
  description: 'descripción',
  plain_text: 'descripción',
  title: 'título',
  name: 'nombre',
  price: 'precio',
  available_quantity: 'cantidad disponible',
  category_id: 'categoría',
  primarycategory: 'categoría',
  listing_type_id: 'tipo de publicación',
  condition: 'condición',
  pictures: 'imágenes',
  attributes: 'atributos',
  brand: 'marca',
  model: 'modelo',
  sellersku: 'SKU',
  sku: 'SKU',
  packageheight: 'alto del paquete',
  packagelength: 'largo del paquete',
  packagewidth: 'ancho del paquete',
  packageweight: 'peso del paquete',
  stock: 'stock'
};

function publicationFieldLabel(value) {
  const key = String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  return PUBLICATION_FIELD_LABELS[key]
    || PUBLICATION_FIELD_LABELS[key.replace(/^(item|body)/, '')]
    || null;
}

function uniqueMessages(messages) {
  return [...new Set(messages.filter(Boolean).map((message) => String(message).trim()).filter(Boolean))];
}

function publicationFieldText(field) {
  return field ? `el campo «${field}»` : 'un dato obligatorio';
}

function translateFalabellaDetail(detail) {
  const text = String(detail || '').trim();
  const normalized = text.toLowerCase();
  if (!text || normalized === 'validation_failed') return null;

  // En “Campo requerido ausente: description” el nombre viene tras “:”.
  // Debe evaluarse antes del patrón genérico, que capturaría “requerido”.
  const fieldMatch = text.match(/(?:campo requerido ausente|missing required field)\s*:\s*([a-z0-9_ -]+)/i)
    || text.match(/(?:campo|required field|field)\s+['"]?([a-z0-9_ -]+?)['"]?(?:\s+(?:ausente|is|required|with|no|cannot\s+be\s+empty|can't\s+be\s+empty))/i);
  const field = publicationFieldLabel(fieldMatch?.[1]);
  if (normalized.includes('campo requerido ausente') || normalized.includes('required') || normalized.includes('missing') || normalized.includes('cannot be empty') || normalized.includes("can't be empty")) {
    return `Falta completar ${publicationFieldText(field)}.`;
  }
  if (normalized.includes('precio debe ser mayor a 0') || (field === 'precio' && normalized.includes('greater than'))) {
    return 'El precio debe ser mayor que $0.';
  }
  if (normalized.includes('invalid') || normalized.includes('no válido') || normalized.includes('not valid')) {
    return `Valor no válido para ${publicationFieldText(field)}.`;
  }
  if (normalized.includes('does not exist') || normalized.includes('no existe')) {
    return `Valor de ${publicationFieldText(field)} no disponible en Falabella.`;
  }
  if (normalized.includes('format error') || normalized.includes('formato')) {
    return `Formato no válido${field ? ` para ${publicationFieldText(field)}` : ' en datos de publicación'}.`;
  }
  if (normalized.includes('already') || normalized.includes('duplicate') || normalized.includes('duplicad')) {
    return 'Falabella ya está procesando una publicación igual. Intenta nuevamente en unos minutos.';
  }
  return 'Falabella rechazó un dato de publicación. Revisa campos obligatorios y valores permitidos de categoría.';
}

function humanizeMercadoLibreCause(cause = {}) {
  const code = String(cause.code || cause.error || '').toLowerCase();
  const references = Array.isArray(cause.references) ? cause.references : [];
  const field = publicationFieldLabel(references[0] || cause.field);

  if (code === 'item.description.type.invalid') return 'La descripción debe contener solo texto plano.';
  if (code === 'body.required_fields' || code === 'body.required_fileds') {
    return `Falta completar ${publicationFieldText(field)}.`;
  }
  if (code === 'body.invalid_field_types') return `Formato no válido${field ? ` para ${publicationFieldText(field)}` : ' en un dato de publicación'}.`;
  if (code === 'item.price.invalid') return 'El precio no cumple requisitos de la categoría.';
  if (code === 'item.category_id.invalid') return 'La categoría seleccionada no permite esta publicación.';
  if (code === 'item.official_store_id.invalid' || code === 'body.invalid_official_store_id') {
    return 'La cuenta no está autorizada para la tienda oficial indicada.';
  }
  if (code === 'validation_error') return 'Mercado Libre rechazó datos de la publicación. Revisa requisitos de categoría.';
  return `Mercado Libre rechazó ${field ? publicationFieldText(field) : 'un dato de la publicación'}. Revisa requisitos de categoría.`;
}

function humanizeMercadoLibreError(details, error) {
  const validation = details?.validation || details || {};
  const causes = [
    ...(Array.isArray(details?.marketplace_errors) ? details.marketplace_errors : []),
    ...(Array.isArray(validation?.errors) ? validation.errors : []),
    ...(Array.isArray(details?.cause) ? details.cause : [])
  ];
  const messages = uniqueMessages(causes.map(humanizeMercadoLibreCause));
  const status = Number(validation?.status || details?.status || error?.status_code || 0);

  if (messages.length) return { message: messages[0], details: messages.join(' ') };
  if (status === 401) return { message: 'La conexión con Mercado Libre expiró.', details: 'Vuelve a conectar la cuenta de Mercado Libre e intenta nuevamente.' };
  if (status === 403) return { message: 'La cuenta no tiene permisos para publicar en Mercado Libre.', details: 'Revisa permisos y configuración de la cuenta.' };
  if (status === 404) return { message: 'Mercado Libre no encontró un recurso requerido para publicar.', details: 'Revisa categoría, tipo de publicación y configuración seleccionada.' };
  if (status === 409) return { message: 'Mercado Libre detectó un conflicto al publicar.', details: 'Revisa si producto ya fue publicado e intenta nuevamente.' };
  if (status === 429) return { message: 'Mercado Libre limitó temporalmente las solicitudes.', details: 'Intenta nuevamente en unos minutos.' };
  if (status >= 500) return { message: 'Mercado Libre no pudo procesar la publicación temporalmente.', details: 'Intenta nuevamente en unos minutos.' };
  return { message: 'Mercado Libre no pudo publicar el producto.', details: 'Revisa datos obligatorios y requisitos de categoría.' };
}

function humanizeJobPublicationError(error = {}) {
  const details = parseJsonMaybe(error.error_details);
  const code = String(details?.error_code || error.error_message || '').trim().toLowerCase();
  const itemState = normalizeMarketplaceItemState(details);

  if (code.includes('credential is not defined')) {
    return {
      message: 'No se pudo completar la publicación.',
      details: 'Error interno al resolver la credencial de publicación. Intenta nuevamente.'
    };
  }

  if (code === 'falabella_publication_failed' || Array.isArray(details?.failed_items)) {
    const affected = (Array.isArray(details?.failed_items) ? details.failed_items : [])
      .map((item) => {
        const messages = (Array.isArray(item?.details) ? item.details : [item?.error])
          .map(translateFalabellaDetail)
          .filter(Boolean);
        return messages.length ? `${item?.sku ? `Variante ${item.sku}: ` : ''}${messages.join(' ')}` : null;
      })
      .filter(Boolean);
    return {
      message: affected.length
        ? `No se pudo publicar en Falabella. ${affected.join(' ')}`
        : 'No se pudo publicar en Falabella. Revise los datos requeridos del producto.',
      details: affected.join(' ') || 'Falabella rechazó la publicación por datos requeridos incompletos.'
    };
  }

  if (itemState?.status === 'paused') {
    const isSellerPause = itemState.sub_status.includes('paused_by_seller');
    return {
      message: isSellerPause
        ? 'La publicación quedó pausada en Mercado Libre por configuración del vendedor.'
        : 'La publicación quedó pausada en Mercado Libre.',
      details: isSellerPause
        ? 'Puedes activarla desde la cuenta de Mercado Libre cuando esté lista para vender.'
        : 'Revisa el estado de la publicación en Mercado Libre.'
    };
  }

  const marketplace = String(error.marketplace_name || error.marketplace_domain || details?.marketplace || '').toLowerCase();
  const isMercadoLibre = marketplace.includes('mercado')
    || code.includes('mercadolibre')
    || details?.marketplace_errors
    || details?.marketplace_primary_error
    || details?.validation;
  if (isMercadoLibre) return humanizeMercadoLibreError(details || {}, error);

  const isFalabella = marketplace.includes('falabella') || code.includes('falabella') || details?.feed || details?.feed_id;
  if (isFalabella) {
    return {
      message: 'Falabella no pudo publicar el producto.',
      details: translateFalabellaDetail(details?.marketplace_error?.error_message || error.error_message)
    };
  }

  return {
    message: 'No se pudo completar la publicación.',
    details: 'El marketplace rechazó la publicación. Revisa datos obligatorios antes de reintentar.'
  };
}

function presentJobPublicationError(error = {}) {
  const presentation = humanizeJobPublicationError(error);
  return {
    ...error,
    error_message: presentation.message,
    error_details: presentation.details
  };
}

function normalizeMarketplaceItemState(details) {
  const parsedDetails = parseJsonMaybe(details);
  if (!parsedDetails || typeof parsedDetails !== 'object') return null;

  const rawState = parsedDetails.marketplace_item_state || parsedDetails.verification || null;
  if (!rawState || typeof rawState !== 'object') return null;

  const status = String(rawState.status || '').trim().toLowerCase() || null;
  const subStatus = Array.isArray(rawState.sub_status)
    ? rawState.sub_status.map((value) => String(value).trim()).filter(Boolean)
    : rawState.sub_status
      ? [String(rawState.sub_status).trim()].filter(Boolean)
      : [];

  return {
    ...rawState,
    status,
    sub_status: subStatus,
    sub_status_text: rawState.sub_status_text || (subStatus.length > 0 ? subStatus.join(', ') : null)
  };
}

function extractPausedStatusFromWarnings(details) {
  const parsedDetails = parseJsonMaybe(details);
  if (!parsedDetails || typeof parsedDetails !== 'object') return null;

  const warnings = Array.isArray(parsedDetails.warnings) ? parsedDetails.warnings : [];
  for (const warning of warnings) {
    const message = String(warning?.message || warning?.text || warning?.detail || '').toLowerCase();
    if (!message) continue;

    if (message.includes('estado paused') || message.includes('status paused')) {
      return {
        status: 'paused',
        sub_status: [],
        sub_status_text: null,
        source: 'legacy_warnings'
      };
    }
  }

  return null;
}

function isTransientMarketplaceItem(details) {
  const state = normalizeMarketplaceItemState(details);
  if (state?.status === 'under_review') return true;
  if (state?.status === 'paused') return true;

  const legacyState = extractPausedStatusFromWarnings(details);
  return legacyState?.status === 'paused';
}

function isMercadoLibrePictureProcessingState(snapshot) {
  return snapshot?.status === 'paused'
    && Array.isArray(snapshot.sub_status)
    && snapshot.sub_status.some((value) => String(value).toLowerCase() === 'picture_download_pending');
}

function buildMarketplaceItemStateSnapshot(item, verification, source = 'jobs-finished-list') {
  const subStatus = Array.isArray(item?.sub_status)
    ? item.sub_status
    : item?.sub_status
      ? [item.sub_status]
      : [];

  return {
    marketplace: 'mercadolibre',
    status: String(item?.status || '').trim().toLowerCase() || null,
    sub_status: subStatus,
    sub_status_text: subStatus.length > 0 ? subStatus.join(', ') : null,
    verified: !!verification?.verified,
    item_found: !!verification?.item_found,
    note: verification?.note || null,
    attempts: verification?.attempts || 0,
    checked_at: new Date().toISOString(),
    source
  };
}

function deriveJobPublicationStatus(stats = {}, jobStatus = 'pending') {
  const total = Number(stats.total || 0);
  const processed = Number(stats.processed || 0);
  const pending = Number(stats.pending || 0);
  const processing = Number(stats.processing || 0);
  const retrying = Number(stats.retrying || 0);
  const errors = Number(stats.errors || 0);

  if (total > 0 && processed >= total) {
    return errors > 0 ? 'completed_with_errors' : 'completed';
  }

  if (pending > 0 || processing > 0 || retrying > 0 || processed > 0) {
    return 'processing';
  }

  return jobStatus || 'pending';
}

function isJobPublicationActive(stats = {}, jobStatus = 'pending') {
  const derivedStatus = deriveJobPublicationStatus(stats, jobStatus);
  return derivedStatus === 'pending' || derivedStatus === 'processing';
}

async function refreshPausedMarketplaceItemStateForJob(job) {
  try {
    const jobProducts = await JobProductRepository.findAllErrorsByJob(job, {
      includePayloads: false,
      includeDetails: true,
      limit: 200
    });

    const pausedItems = jobProducts.filter((item) =>
      isTransientMarketplaceItem(item.error_details)
    );
    logger.info(
      `[JobController.listFinishedJobs][marketplace-refresh] job_id=${job?.id || 'unknown'} ` +
      `job_products=${jobProducts.length} transient_detected=${pausedItems.length}`
    );

    if (pausedItems.length === 0) return;

    const seenTaskIds = new Set();

    for (const item of pausedItems) {
      if (!item.task_id || seenTaskIds.has(String(item.task_id))) {
        continue;
      }
      seenTaskIds.add(String(item.task_id));

      const previousState = normalizeMarketplaceItemState(item.error_details) || extractPausedStatusFromWarnings(item.error_details) || null;

      const task = await ProductPublishingTaskRepository.findById(item.task_id);
      if (!task || !task.external_id || !task.credential_id) {
        continue;
      }

      const credential = await MarketplaceCredentialRepository.findById(task.credential_id);
      const accessToken = credential?.access_token || null;
      if (!accessToken) {
        logger.warn(
          `[JobController.listFinishedJobs][marketplace-refresh] skip task_id=${task.id} item=${task.external_id} reason=missing_access_token`
        );
        continue;
      }

      logger.info(
        `[JobController.listFinishedJobs][marketplace-refresh] querying marketplace item=${task.external_id} task_id=${task.id}`
      );

      const verification = await verifyMercadoLibreItem({
        itemId: task.external_id,
        accessToken,
        maxAttempts: 2,
        baseDelayMs: 800,
        timeoutMs: 10000
      });

      if (!verification?.ok || !verification.item_found) {
        logger.warn(
          `[JobController.listFinishedJobs][marketplace-refresh] item=${task.external_id} verification_failed=${verification?.error || 'unknown'}`
        );
        continue;
      }

      const snapshot = buildMarketplaceItemStateSnapshot(verification.item, verification);
      const stateChanged = String(previousState?.status || '').toLowerCase() !== String(snapshot.status || '').toLowerCase();

      logger.info(
        `[JobController.listFinishedJobs][marketplace-refresh] item=${task.external_id} ` +
        `previous=${previousState?.status || 'unknown'} -> current=${snapshot.status || 'unknown'} ` +
        `sub_status=${snapshot.sub_status_text || 'none'} ` +
        `ml_response=${JSON.stringify({
          id: verification.item?.id || task.external_id,
          title: verification.item?.title || null,
          status: verification.item?.status || null,
          sub_status: verification.item?.sub_status || [],
          category_id: verification.item?.category_id || null,
          price: verification.item?.price ?? null,
          available_quantity: verification.item?.available_quantity ?? null,
          permalink: verification.item?.permalink || null,
          last_updated: verification.item?.last_updated || null
        })}`
      );

      const currentDetails = task.error_details && typeof task.error_details === 'object'
        ? task.error_details
        : {};
      const mergedDetails = {
        ...currentDetails,
        marketplace_item_state: snapshot
      };

      const isActive = snapshot.status === 'active';
      const shouldKeepWarning = snapshot.status && !isActive;
      const errorMessage = shouldKeepWarning
        ? (Array.isArray(snapshot.sub_status) && snapshot.sub_status.includes('paused_by_seller')
          ? 'La publicación quedó pausada en Mercado Libre por configuración del vendedor.'
          : 'La publicación presenta una advertencia de estado en Mercado Libre.')
        : null;

      const taskUpdateData = {
        error_message: errorMessage,
        error_details: shouldKeepWarning ? mergedDetails : null,
        api_response: verification.item
      };
      const isPictureProcessing = isMercadoLibrePictureProcessingState(snapshot);

      if (isActive && ['published_with_warnings', 'processing'].includes(task.status)) {
        taskUpdateData.status = 'published';
      } else if (shouldKeepWarning && task.status === 'published') {
        taskUpdateData.status = isPictureProcessing ? 'processing' : 'published_with_warnings';
      }

      await ProductPublishingTaskRepository.updateTask(task, taskUpdateData);

      await JobProductRepository.update(item, {
        status: 'success',
        error_message: errorMessage,
        error_details: shouldKeepWarning ? mergedDetails : null,
        external_id: verification.item.id || item.external_id || task.external_id || null,
        external_url: verification.item.permalink || item.external_url || task.external_url || null
      });

      const linkExternalId = verification.item.id || task.external_id || null;
      const existingLink = await ProductMarketplaceLinkRepository.findByMarketplaceExternalId(
        task.marketplace_id,
        linkExternalId,
        task.company_id || null,
        task.branch_id || null,
        task.credential_id || null,
        task.user_id || null
      );

      if (existingLink) {
        await existingLink.update({
          status: isPictureProcessing ? 'processing' : (snapshot.status || 'unpublished'),
          external_url: verification.item.permalink || task.external_url || null,
          published_stock: task.payload?.available_quantity || null,
          published_payload: task.payload || null,
          last_synced_at: new Date()
        });
      } else if (task.company_id || task.branch_id) {
        const linkScope = task.company_id
          ? { company_id: task.company_id, branch_id: null }
          : { company_id: null, branch_id: task.branch_id || null };

        await ProductMarketplaceLinkRepository.upsert({
          product_id: task.product_id,
          marketplace_id: task.marketplace_id,
          credential_id: task.credential_id,
          user_id: task.user_id || null,
          ...linkScope,
          status: isPictureProcessing ? 'processing' : (snapshot.status || 'unpublished'),
          external_id: linkExternalId,
          external_url: verification.item.permalink || task.external_url || null,
          published_stock: task.payload?.available_quantity || null,
          published_payload: task.payload || null,
          last_synced_at: new Date()
        });
      } else {
        logger.warn(
          `[JobController.listFinishedJobs][marketplace-refresh] skip link update task_id=${task.id} item=${task.external_id} reason=missing_company_or_branch_context`
        );
      }

      logger.info(
        `[JobController.listFinishedJobs][paused-refresh] action=${stateChanged ? 'state_changed_and_synced' : 'state_refreshed'} ` +
        `task_id=${task.id} job_product_id=${item.id} link_updated=${!!existingLink || !!(task.company_id || task.branch_id)}`
      );
    }
  } catch (error) {
    logger.warn(`[JobController.listFinishedJobs] No se pudo refrescar paused items del job ${job?.id}: ${error.message}`);
  }
}

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
    const jobStatus = deriveJobPublicationStatus(stats, job.status);

    // 6. Obtener progreso por canal/marketplace (para las tarjetas)
    const channels = await JobProductRepository.getStatsByJobAndMarketplace(jobId);

    // ✅ 7. Obtener errores detallados SOLO si el job terminó y se solicitan productos
let errorsByChannel = {};
let attentionItemsByChannel = {};
if (['completed', 'completed_with_errors', 'failed'].includes(jobStatus) && include_products === 'true') {
  const attentionItems = await JobProductRepository.findAllErrorsByJob(job, {
    includePayloads: true,
    includeDetails: true,
    includeTransientAttention: true,
    limit: 200 // Límite para no sobrecargar la respuesta
  });
  const allErrors = attentionItems.filter((item) => item.attention_type === 'error');

  attentionItemsByChannel = attentionItems.reduce((acc, item) => {
    const key = item.credential_id;
    if (!acc[key]) acc[key] = [];
    acc[key].push(item);
    return acc;
  }, {});
  
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
    job_status: job.status,
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
      errors: (errorsByChannel[ch.credential_id] || []).map(presentJobPublicationError),
      attention_items: (attentionItemsByChannel[ch.credential_id] || []).map((item) => (
        item.attention_type === 'error' ? presentJobPublicationError(item) : item
      ))
    })),
    products: include_products === 'true' 
      ? await JobProductRepository.findAllByJob(jobId, { 
          limit: 50, 
          includePayloads: false,
          includeDetails: true,
          includePublicationState: true
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
      
    // 1. 🔹 Obtener jobs candidatos y filtrar por estado real de publicación
      const activeJobs = await JobRepository.findAll({
      user_id,
      company_id,
      job_type: 'publish',
      status: { [Op.in]: ['pending', 'processing', 'completed', 'completed_with_errors', 'failed'] },
      limit: 50
    });
    
    // 3. 🔹 Respuesta con jobs (formato requerido por UI)
    const jobsByChannel = await Promise.all(activeJobs.map(async (job) => {
      const stats = await JobProductRepository.getStatsByJob(job.id);
      const derivedStatus = deriveJobPublicationStatus(stats, job.status);

      if (!isJobPublicationActive(stats, job.status)) {
        return [];
      }

      const channels = await JobProductRepository.getStatsByJobAndMarketplace(job.id);
      const attentionItems = await JobProductRepository.findAllErrorsByJob(job, {
        includePayloads: false,
        includeDetails: true,
        includeTransientAttention: true,
        limit: 200
      });
      const errorsByCredential = attentionItems
        .filter((item) => item.attention_type === 'error')
        .reduce((acc, item) => {
          const key = item.credential_id;
          if (!acc[key]) acc[key] = [];
          acc[key].push(presentJobPublicationError(item));
          return acc;
        }, {});

      if (!Array.isArray(channels) || channels.length === 0) {
        const fallbackMarketplace = job.config?.marketplaces?.[0];
        return [{
          job_id: String(job.id),
          batch_id: job.batch_id,
          status: derivedStatus,
          job_status: job.status,
          marketplace_name: fallbackMarketplace?.marketplace_name || fallbackMarketplace?.name || null,
          credential_id: fallbackMarketplace?.credential_id || fallbackMarketplace?.id || null,
          created_at: job.createdAt ? new Date(job.createdAt).toISOString() : null,
          total_products: stats.total || job.total_products,
          successful: stats.successful ?? job.successful,
          errors_count: stats.errors ?? job.errors_count,
          percentage: stats.total > 0 ? Math.round((stats.processed / stats.total) * 100) : (job.percentage || 0),
          errors: errorsByCredential[fallbackMarketplace?.credential_id || fallbackMarketplace?.id] || []
        }];
      }

      return channels.map(channel => ({
        job_id: String(job.id),
        batch_id: job.batch_id,
        status: derivedStatus,
        job_status: job.status,
        marketplace_name: channel.marketplace_name,
        credential_id: channel.credential_id,
        created_at: job.createdAt ? new Date(job.createdAt).toISOString() : null,
        total_products: channel.total ?? stats.total ?? job.total_products,
        successful: channel.published ?? stats.successful ?? job.successful,
        errors_count: channel.failed ?? stats.errors ?? job.errors_count,
        percentage: channel.percentage ?? (stats.total > 0 ? Math.round((stats.processed / stats.total) * 100) : job.percentage),
        errors: errorsByCredential[channel.credential_id] || []
      }));
    }));

    return res.json({
      data: {
        jobs: jobsByChannel.flat()
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
    let title;
    if (job.status === 'completed' && errorChannels === 0) {
      title = 'Publicación exitosa';
    } else if (job.status === 'completed_with_errors' || errorChannels > 0) {
      title = 'Publicación finalizada con errores';
    } else {
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
      title,
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
      title = 'Publicación exitosa';
      description = `Publicación completada en ${channels?.length || 1} marketplace${(channels?.length || 1) > 1 ? 's' : ''}`;
    } else if (job.status === 'completed_with_errors') {
      title = 'Publicación con errores';
      description = `${completedChannels} marketplace${completedChannels > 1 ? 's' : ''} completado${completedChannels > 1 ? 's' : ''}, ${errorChannels} con errores`;
    } else {
      title = 'Publicación fallida';
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
  },

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
    } = req.body || {};

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

    await Promise.all(jobs.map((job) => refreshPausedMarketplaceItemStateForJob(job)));

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
        user_email: job.user?.email || null,
        user_avatar: job.user?.image || null,
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
async getJobDetail(req, res) {
  try {
    // ✅ 1. Desestructurar con nombre correcto: 'id' (no jobId)
    const { id, company_id, tab = 'summary', error_filters = {} } = req.body;

    if (!company_id || !id) {
      return res.status(400).json({ success: false, msg: 'id_and_company_id_required' });
    }

    // ✅ 2. Obtener job desde Repository
    const job = await JobRepository.findById(id, { includeUser: true });

    if (!job || job.company_id !== company_id) {
      return res.status(404).json({ success: false, msg: 'job_not_found' });
    }

    // ✅ 3. Validar estado finalizado
    if (!['completed', 'completed_with_errors', 'failed'].includes(job.status)) {
      return res.status(400).json({
        success: false,
        msg: 'job_not_finished',
        hint: 'Los procesos en ejecución se consultan desde el wizard o navbar'
      });
    }

    // ✅ 4. Inicializar baseResponse CON data siempre definido
    const baseResponse = {
      success: true,
      data: {
        job: {
          id: job.id,
          batch_id: job.batch_id,
          display_id: `J-${String(job.id).padStart(5, '0')}`,
          status: job.status,
          createdAt: job.completed_at || job.createdAt,
          user_name: job.user?.name || 'N/A',
          total_products: job.total_products,
          published: job.successful,
          errors: job.errors_count,
          percentage: job.percentage,
          config: job.config || {},
          error_summary: job.error_summary
        }
      }
    };

    // ✅ 5. Cargar datos según tab (usando 'id', no 'jobId')
    switch (tab) {
      case 'summary': {
        const avgPrice = job.config?.avg_price || 0;
        const avgCommission = job.config?.commission_rate || 0.17;
        const estimatedSales = job.successful * avgPrice;
        
        // ✅ Validar que data existe antes de asignar
        if (baseResponse.data) {
          baseResponse.data.summary = {
            estimated_sales: estimatedSales,
            commissions: estimatedSales * avgCommission,
            estimated_profit: estimatedSales * (1 - avgCommission),
            note: 'Incluye costos de producto solo si existen. No incluye costos de envío.'
          };
        }
        break;
      }

      case 'channels': {
        // ✅ CORRECCIÓN: usar 'id' en lugar de 'jobId'
        const channels = await JobProductRepository.getStatsByJobAndMarketplace(id);
        
        if (baseResponse.data) {
          baseResponse.data.channels = channels.map(ch => ({
            credential_id: ch.credential_id,
            marketplace_id: ch.marketplace_id,
            marketplace_name: ch.marketplace_name,
            credential_name: ch.credential_name,
            status: ch.status,
            total: ch.total,
            published: ch.published,
            failed: ch.failed,
            percentage: ch.percentage
          }));
        }
        break;
      }

      case 'errors': {
  const { status: errorStatus = 'all', search: errorSearch } = error_filters;
  
  // ✅ Obtener errores con payloads y detalles completos
  const errors = await JobProductRepository.findAllErrorsByJob(job, {
    includePayloads: true,
    includeDetails: true,  // ← Incluye error_details con warnings
    limit: 200
  });

  // Filtrar por estado
  let filteredErrors = errors;
  if (errorStatus === 'with_error') {
    filteredErrors = errors.filter(e => !e.is_fixed && checkIsError(e));
  } else if (errorStatus === 'with_warnings') {
    filteredErrors = errors.filter(e => !e.is_fixed && checkIsWarning(e));
  } else if (errorStatus === 'fixed') {
    filteredErrors = errors.filter(e => e.is_fixed);
  }

  // Búsqueda textual
  if (errorSearch) {
    const term = errorSearch.toLowerCase();
    filteredErrors = filteredErrors.filter(e =>
      e.product_name?.toLowerCase().includes(term) ||
      e.sku?.toLowerCase().includes(term) ||
      e.error_message?.toLowerCase().includes(term)
    );
  }

  // Agrupar por marketplace
  const groupedByMarketplace = filteredErrors.reduce((acc, error) => {
    const key = error.credential_id;
    if (!acc[key]) {
      acc[key] = {
        credential_id: error.credential_id,
        marketplace_name: error.marketplace_name,
        marketplace_domain: error.marketplace_domain,
        items: []
      };
    }
    acc[key].items.push({
      task_id: error.task_id,        // ✅ ID de ProductPublishingTask
      product_id: error.product_id,
      product_name: error.product_name,
      sku: error.sku,
      product_image: error.product_image,
      marketplace_id: error.marketplace_id,
      credential_id: error.credential_id,
      marketplace_name: error.marketplace_name,
      ...(() => {
        const presentation = humanizeJobPublicationError(error);
        return {
          error_message: presentation.message,
          // Vista usuario: sin códigos internos, JSON crudo ni mensajes en inglés.
          error_details: presentation.details
        };
      })(),
      payload: error.payload,              // ✅ Payload desde ProductPublishingTask
      is_fixed: error.is_fixed || false,
      fixed_payload: error.fixed_payload || null,
      status: error.status,
      created_at: error.created_at
    });
    return acc;
  }, {});

  const fixedCount = filteredErrors.filter(e => e.is_fixed).length;
  const totalCount = filteredErrors.length;

  baseResponse.data.errors = {
    total: totalCount,
    fixed: fixedCount,
    pending: totalCount - fixedCount,
    grouped: Object.values(groupedByMarketplace),
    can_republish: fixedCount > 0
  };
  break;
}
      
      // ✅ Caso por defecto para tabs no reconocidos
      default: {
        logger.warn(`[getJobDetail] Tab no reconocido: ${tab}, usando 'summary' por defecto`);
        // No hacer nada, retornar solo el job base
      }
    }

    return res.json(baseResponse);

  } catch (error) {
    logger.error(`[JobController.getJobDetail] Error: ${error.message}`, { 
      stack: error.stack,
      body: req.body  // 🔹 Para debug: ver qué se recibió
    });
    return res.status(500).json({
      success: false,
      msg: 'fetch_job_detail_failed',
      error: error.message
    });
  }
},

async updateTaskPayload(req, res) {
  try {
    const { taskId } = req.params;
    const { company_id, user_id, payload } = req.body;

    if (!company_id || !user_id || !payload) {
      return res.status(400).json({ success: false, msg: 'missing_required_fields' });
    }

    // 1. Buscar la tarea en ProductPublishingTask
    const task = await ProductPublishingTask.findByPk(taskId, {
      include: [{ model: Job, as: 'job', attributes: ['id', 'company_id', 'status'] }]
    });

    if (!task || task.company_id !== company_id) {
      return res.status(404).json({ success: false, msg: 'task_not_found' });
    }

    // 2. Validar que el job esté finalizado (solo se puede corregir post-ejecución)
    if (!['completed', 'completed_with_errors', 'failed'].includes(task.job?.status)) {
      return res.status(400).json({
        success: false,
        msg: 'job_not_finished',
        hint: 'Las correcciones solo aplican a procesos finalizados'
      });
    }

    // 3. Actualizar payload (NO republica, solo guarda la corrección)
    //    Marcamos el registro como "corregido" para UI
    const updated = await task.update({
      payload: payload,                    // ✅ Nuevo payload corregido
      error_message: null,                 // ✅ Limpiar error visual
      is_fixed: true,                      // ✅ Flag para UI (campo nuevo sugerido)
      fixed_at: new Date(),
      fixed_by: user_id
    });

    // 4. Logging
    logger.info(`[JobController.updateTaskPayload] Payload corregido: Task ${taskId} por User ${user_id}`, {
      batch_id: task.batch_id,
      product_id: task.product_id,
      marketplace_id: task.marketplace_id
    });

    return res.json({
      success: true,
      message: 'Corrección guardada. Pendiente de republicar.',
      data: {
        task_id: updated.id,
        is_fixed: true,
        updated_at: updated.updatedAt
      }
    });

  } catch (error) {
    logger.error(`[JobController.updateTaskPayload] Error: ${error.message}`, { stack: error.stack });
    return res.status(500).json({
      success: false,
      msg: 'update_payload_failed',
      error: error.message
    });
  }
},
async republishFromJob(req, res) {
  try {
    const { jobId } = req.params;
    const { company_id, user_id, task_ids = [] } = req.body;

    if (!company_id || !user_id || !task_ids.length) {
      return res.status(400).json({ success: false, msg: 'missing_required_fields' });
    }

    // 1. Verificar job original
    const originalJob = await Job.findByPk(jobId);
    if (!originalJob || originalJob.company_id !== company_id) {
      return res.status(404).json({ success: false, msg: 'job_not_found' });
    }

    // 2. Obtener tareas a republicar con sus datos completos
    const tasksToRepublish = await ProductPublishingTask.findAll({
      where: {
        id: { [Op.in]: task_ids },
        batch_id: originalJob.batch_id,
        company_id
      },
      include: [
        { model: Product, as: 'product' },
        { model: Marketplace, as: 'marketplace' },
        { model: MarketplaceCredential, as: 'credential' }
      ]
    });

    if (tasksToRepublish.length === 0) {
      return res.status(400).json({ success: false, msg: 'no_valid_tasks_to_republish' });
    }

    // 3. Crear NUEVO job padre para la republicación (no modificar el original)
    const newBatchId = `BATCH-REPUB-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    
    const newJob = await Job.create({
      user_id,
      company_id,
      batch_id: newBatchId,
      job_type: 'publish',
      mode: 'republish',                    // ✅ Diferenciar de publicación inicial
      draft_name: `Repubicación desde Job #${originalJob.id}`,
      status: 'pending',
      total_products: tasksToRepublish.length,
      processed: 0,
      successful: 0,
      errors_count: 0,
      percentage: 0,
      config: {
        ...originalJob.config,
        republished_from: originalJob.id,   // ✅ Trazabilidad
        republished_tasks: task_ids
      },
      error_summary: null,
      started_at: null,
      completed_at: null
    });

    // 4. Crear JobProduct entries para el nuevo job (con payloads corregidos)
    const jobProductsData = tasksToRepublish.map(task => ({
      job_id: newJob.id,
      product_id: task.product_id,
      marketplace_id: task.marketplace_id,
      credential_id: task.credential_id,
      status: 'pending',
      product_payload: task.payload,        // ✅ Usar payload corregido
      marketplace_payload: null,            // Se generará en el proceso
      attempt_count: 0
    }));

    await JobProduct.bulkCreate(jobProductsData);

    const auditProducts = tasksToRepublish.map((task) => ({
      sku: task.product?.sku || null,
      name: task.product?.name || null,
      stock: task.payload?.publishStock ?? task.payload?.stock ?? task.payload?.available_quantity ?? null
    }));
    const auditMarketplaces = tasksToRepublish.map((task) => ({
      name: task.marketplace?.name || null,
      domain: task.marketplace?.domain || null,
      credential_name: task.credential?.name || null
    }));

    await PublicationAuditService.recordProcessEvent(req, originalJob.get ? originalJob.get({ plain: true }) : originalJob, 'process.reprocessed', {
      description: `Proceso #${originalJob.id} reprocesado mediante proceso #${newJob.id}`,
      related_resource_type: 'job',
      related_resource_id: newJob.id,
      products: auditProducts,
      marketplaces: auditMarketplaces,
      new_value: {
        reprocess_job_id: newJob.id,
        tasks_count: tasksToRepublish.length
      },
      metadata: {
        reprocess_job_id: newJob.id,
        reprocessed_tasks_count: tasksToRepublish.length
      }
    });

    await PublicationAuditService.recordProcessEvent(req, newJob.get ? newJob.get({ plain: true }) : newJob, 'process.created', {
      description: `Proceso #${newJob.id} originado desde proceso #${originalJob.id}`,
      origin_job_id: originalJob.id,
      products: auditProducts,
      marketplaces: auditMarketplaces,
      new_value: {
        status: newJob.status,
        total_products: newJob.total_products
      },
      metadata: {
        origin_job_id: originalJob.id,
        reprocessed_tasks_count: tasksToRepublish.length
      }
    });

    // 5. Disparar proceso en background (ej: mediante cola o worker)
    //    Aquí puedes integrar con tu sistema de colas (Bull, Bee-Queue, etc.)
    //    Ejemplo: await publishingQueue.add('publish', { jobId: newJob.id });

    // 6. Logging y respuesta
    logger.info(`[JobController.republishFromJob] Nuevo job de republicación creado: ${newJob.id}`, {
      original_job: originalJob.id,
      batch_id: newBatchId,
      tasks_count: tasksToRepublish.length,
      user_id
    });

    return res.json({
      success: true,
      message: `Republicación iniciada para ${tasksToRepublish.length} productos`,
      data: {
        new_job_id: newJob.id,
        batch_id: newBatchId,
        tasks_republished: tasksToRepublish.length,
        // Opcional: redirigir al nuevo job
        redirect_url: `/publications/jobs/${newJob.id}?tab=summary`
      }
    });

  } catch (error) {
    logger.error(`[JobController.republishFromJob] Error: ${error.message}`, { stack: error.stack });
    return res.status(500).json({
      success: false,
      msg: 'republish_failed',
      error: error.message
    });
  }
},

  async deleteDraft(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Elimina borrador (job)`);
    logger.info(`Datos recibidos: ${JSON.stringify(req.body)}`);

    const { job_id } = req.body;
    const userId = req.user.id;

    try {
      if (!job_id) {
        return res.status(400).json({
          success: false,
          msg: 'job_id_required',
          message: 'Se requiere el ID del borrador'
        });
      }

      const job = await JobRepository.findById(job_id);

      if (!job) {
        return res.status(404).json({
          success: false,
          msg: 'draft_not_found',
          message: 'Borrador no encontrado'
        });
      }

      if (job.job_type !== 'draft') {
        return res.status(400).json({
          success: false,
          msg: 'not_a_draft',
          message: 'Solo se pueden eliminar borradores'
        });
      }

      const terminalStatuses = ['completed', 'completed_with_errors', 'failed', 'cancelled'];
      if (terminalStatuses.includes(job.status)) {
        return res.status(400).json({
          success: false,
          msg: 'draft_already_finished',
          message: 'No se puede eliminar un borrador que ya fue procesado o finalizado'
        });
      }

      await PublicationAuditService.recordDraftCancelled(req, job);
      await JobRepository.delete(job_id);

      logger.info(`Borrador eliminado: Job ID ${job_id} por usuario ${userId}`);

      res.status(200).json({
        success: true,
        message: 'Borrador eliminado correctamente',
        job_id: job.id
      });

    } catch (error) {
      logger.error(`[JobController.deleteDraft] Error: ${error.message}`, { stack: error.stack });
      return res.status(500).json({
        success: false,
        msg: 'delete_draft_failed',
        message: 'Error al eliminar el borrador',
        error: error.message
      });
    }
  }
};

module.exports = JobController
