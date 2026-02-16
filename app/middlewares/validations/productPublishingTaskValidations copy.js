// src/validations/productPublishingTaskValidation.js
const Joi = require('joi');

const storeSchema = Joi.object({
  mode: Joi.string().valid('quick', 'advanced').required(),
  pool: Joi.object({
    id: Joi.number().integer().positive().required(),
    name: Joi.string().optional(),
    warehouses: Joi.array().items(Joi.object({
      warehouse_id: Joi.number().integer().positive().required()
    })).min(1).required(),
    primary_warehouse: Joi.object({
      warehouse_id: Joi.number().integer().positive().required()
    }).required()
  }).required(),
  products: Joi.array().items(Joi.object({
    id: Joi.number().integer().positive().required(),
    variants: Joi.array().items(Joi.object({
      id: Joi.number().integer().positive().required(),
      publish: Joi.boolean().required(),
      publishStock: Joi.number().integer().min(0).required()
    })).optional()
  })).min(1).required(),
  marketplaces: Joi.array().items(Joi.object({
    id: Joi.string().required(), // Puede ser string (ej: 'ml')
    publishing_config: Joi.object({
      priceMode: Joi.string().valid('auto', 'fixed').required(),
      fixedPrice: Joi.number().min(0).allow(null),
      stockMode: Joi.string().valid('pool', 'limit').required(),
      stockLimit: Joi.number().min(0).allow(null),
      allowPromotions: Joi.boolean().required()
    }).required()
  })).min(1).required(),
  meta: Joi.object().optional()
}).unknown(true);

const updateStatusSchema = Joi.object({
  id: Joi.number().integer().positive().required(),
  status: Joi.string().valid('pending', 'published', 'error', 'out_of_sync', 'archived').required(),
  error_message: Joi.string().optional().allow(null),
  external_id: Joi.string().optional().allow(null),
  external_url: Joi.string().optional().allow(null)
});

const listSchema = Joi.object({
  company_id: Joi.number().integer().positive().required(),
  user_id: Joi.number().integer().optional(),
  status: Joi.string().valid('pending', 'published', 'error', 'out_of_sync', 'archived').optional()
});

const retrySchema = Joi.object({
  task_id: Joi.number().integer().positive().required(),
  payload: Joi.object().optional() // 👈 payload corregido por el usuario
});

module.exports = {
  storeProductPublishingTaskSchema: storeSchema,
  updateProductPublishingTaskStatusSchema: updateStatusSchema,
  listProductPublishingTaskSchema: listSchema,
  retryProductPublishingTaskSchema: retrySchema
};