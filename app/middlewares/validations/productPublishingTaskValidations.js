const Joi = require('joi');

const storeSchema = Joi.object({
  mode: Joi.string().valid('quick', 'advanced', 'manual', 'draft', 'publish').required(), // ✅ Agregado 'draft', 'publish' y 'manual'
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
  // ✅ marketplaces es opcional cuando mode === 'draft' (se guarda solo el producto)
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
  })).min(1).optional(),
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

const publishedProductsSchema = Joi.object({
  company_id: Joi.number().integer().positive().optional(),
  user_id: Joi.number().integer().positive().optional(),
  marketplace_id: Joi.number().integer().positive().optional(),
  product_id: Joi.number().integer().positive().optional(),
  start_date: Joi.date().optional().allow(null),
  end_date: Joi.date().optional().allow(null)
});

const updateMercadoLibreItemSchema = Joi.object({
  company_id: Joi.number().integer().positive().optional(),
  user_id: Joi.number().integer().positive().optional(),
  marketplace_id: Joi.number().integer().positive().required(),
  credential_id: Joi.number().integer().positive().required(),
  branch_id: Joi.number().integer().positive().optional(),
  external_id: Joi.string().trim().min(1).max(255).required(),
  status: Joi.string().valid('active', 'paused', 'closed').optional(),
  price: Joi.number().precision(2).min(0).optional(),
  available_quantity: Joi.number().integer().min(0).optional()
})
  .or('status', 'price', 'available_quantity')
  .custom((value, helpers) => {
    if (value.status === 'closed' && (value.price !== undefined || value.available_quantity !== undefined)) {
      return helpers.error('any.custom', {
        message: 'status_closed_cannot_combine_with_price_or_stock'
      });
    }

    return value;
  }, 'Mercado Libre item update validation');

const listWithProductSchema = Joi.object({
  company_id: Joi.number().integer().positive().required(),
  user_id: Joi.number().integer().optional(),
  product_id: Joi.number().integer().positive().required()
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
const publishDraftLegacySchema = Joi.object({
  task_id: Joi.number().integer().positive().required(),
  mode: Joi.string().valid('quick', 'advanced', 'manual').optional() // Modo de publicación
}).unknown(true);

const publishDraftJobSchema = Joi.object({
  job_id: Joi.number().integer().positive().required(),
  action: Joi.string().valid('update', 'publish').required(),
  mode: Joi.string().valid('quick', 'advanced', 'manual', 'draft', 'publish').optional(),
  pool: Joi.object().optional(),
  products: Joi.array().items(Joi.object({
    id: Joi.number().integer().positive().required()
  }).unknown(true)).min(1).required(),
  // ✅ marketplaces es opcional cuando action === 'update', requerido cuando action === 'publish'
  marketplaces: Joi.array().items(Joi.object({
    id: Joi.number().integer().positive().required(),
    marketplace_id: Joi.number().integer().positive().optional()
  }).unknown(true)).min(1).optional(),
  draft_name: Joi.string().max(255).optional(),
  publication_step: Joi.number().integer().min(0).max(5).optional(),
  economic_config: Joi.object().optional(),
  meta: Joi.object().optional()
}).unknown(true);

const publishDraftSchema = Joi.alternatives().try(
  publishDraftJobSchema,
  publishDraftLegacySchema
);

module.exports = {
  storeProductPublishingTaskSchema: storeSchema,
  updateProductPublishingTaskStatusSchema: updateStatusSchema,
  listProductPublishingTaskSchema: listSchema,
  listProductPublishingTaskWithProductSchema: listWithProductSchema,
  listDraftsByUserSchema: listDraftsByUserSchema, // ✅ Nuevo
  publishedProductsSchema: publishedProductsSchema,
  updateMercadoLibreItemSchema: updateMercadoLibreItemSchema,
  retryProductPublishingTaskSchema: retrySchema,
  publishDraftSchema: publishDraftSchema // ✅ Nuevo
};

