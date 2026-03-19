const Joi = require('joi');

const storeSchema = Joi.object({
  mode: Joi.string().valid('quick', 'advanced', 'draft', 'publish').required(), // ✅ Agregado 'draft' y 'publish'
  pool: Joi.object({
    id: Joi.number().integer().positive().required(),
    name: Joi.string().optional(),
    company_id: Joi.number().integer().positive().required(), // ✅ Nuevo
    user_id: Joi.number().integer().positive().optional(), // ✅ Nuevo
    warehouses: Joi.array().items(Joi.object({
      warehouse_id: Joi.number().integer().positive().required(),
      id: Joi.number().integer().positive().optional()
    })).min(1).required(),
    primary_warehouse: Joi.object({
      warehouse_id: Joi.number().integer().positive().required(),
      id: Joi.number().integer().positive().optional()
    }).required()
  }).required(),
  products: Joi.array().items(Joi.object({
    id: Joi.number().integer().positive().required(),
    name: Joi.string().optional(),
    variants: Joi.array().items(Joi.object({
      id: Joi.number().integer().positive().required(),
      publish: Joi.boolean().required(),
      publishStock: Joi.number().integer().min(0).required()
    })).optional()
  })).min(1).required(),
  marketplaces: Joi.array().items(Joi.object({
    id: Joi.number().integer().positive().required(), // ✅ Cambiado a number
    name: Joi.string().optional(),
    publishing_config: Joi.object({
      priceMode: Joi.string().valid('auto', 'fixed').required(),
      fixedPrice: Joi.number().min(0).allow(null),
      stockMode: Joi.string().valid('pool', 'limit').required(),
      stockLimit: Joi.number().min(0).allow(null),
      allowPromotions: Joi.boolean().required()
    }).required()
  })).min(1).required(),
  // ✅ Nuevos campos para drafts
  draft_name: Joi.string().max(255).optional(), // Nombre del borrador
  batch_id: Joi.string().guid({ version: ['uuidv4'] }).optional(), // UUID para agrupar
  publication_step: Joi.number().integer().min(0).max(5).optional(), // Paso de la publicación (0-5)
  meta: Joi.object().optional()
}).unknown(true);

const updateStatusSchema = Joi.object({
  id: Joi.number().allow(null).empty('').optional(),
  task_id: Joi.number().allow(null).empty('').optional(),
  status: Joi.string().valid('draft', 'pending', 'processing', 'published', 'failed', 'cancelled').required(), // ✅ Actualizado
  error_message: Joi.string().optional().allow(null),
  error_details: Joi.object().optional().allow(null), // ✅ Nuevo
  api_response: Joi.object().optional().allow(null), // ✅ Nuevo
  external_id: Joi.string().optional().allow(null),
  external_url: Joi.string().optional().allow(null),
  published_at: Joi.date().optional().allow(null), // ✅ Nuevo
  attempt_count: Joi.number().integer().min(1).optional() // ✅ Nuevo
});

const listSchema = Joi.object({
  company_id: Joi.number().integer().positive().required(),
  user_id: Joi.number().integer().optional(),
  status: Joi.string().valid('draft', 'pending', 'processing', 'published', 'failed', 'cancelled').optional(), // ✅ Actualizado
  batch_id: Joi.string().guid().optional() // ✅ Nuevo
});

// ✅ Nuevo schema para listar borradores por usuario/empresa
const listDraftsByUserSchema = Joi.object({
  company_id: Joi.number().integer().positive().optional(), // Si no se pasa, usa req.user.company_id
  user_id: Joi.number().integer().optional() // Si no se pasa, usa req.user.id
});

const retrySchema = Joi.object({
  task_id: Joi.number().integer().positive().required(),
  job_id: Joi.number().allow(null).empty('').optional(),
  payload: Joi.object().optional()
});

// ✅ Nuevo schema para publicar draft
const publishDraftSchema = Joi.object({
  task_id: Joi.number().integer().positive().required(),
  mode: Joi.string().valid('quick', 'advanced').optional() // Modo de publicación
});

module.exports = {
  storeProductPublishingTaskSchema: storeSchema,
  updateProductPublishingTaskStatusSchema: updateStatusSchema,
  listProductPublishingTaskSchema: listSchema,
  listDraftsByUserSchema: listDraftsByUserSchema, // ✅ Nuevo
  retryProductPublishingTaskSchema: retrySchema,
  publishDraftSchema: publishDraftSchema // ✅ Nuevo
};