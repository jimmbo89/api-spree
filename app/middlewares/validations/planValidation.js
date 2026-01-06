const Joi = require('joi');

const planSchema = Joi.object({
  name: Joi.string().max(50).required().messages({
    'string.empty': 'El campo "name" no puede estar vacío',
    'any.required': 'El campo "name" es obligatorio',
    'string.max': 'El campo "name" debe tener máximo 50 caracteres'
  }),
  description: Joi.string().allow(null, '').optional(),
  is_active: Joi.boolean().optional(),
  max_products: Joi.number().integer().allow(null).optional(),
  max_branches: Joi.number().integer().allow(null).optional(),
  max_stores: Joi.number().integer().allow(null).optional(),
  max_integrations: Joi.number().integer().allow(null).optional(),
  max_global_publications: Joi.number().integer().allow(null).optional(),
  max_pools: Joi.number().integer().allow(null).optional(),
  has_tenant_marketplace: Joi.boolean().optional(),
  has_custom_domain: Joi.boolean().optional(),
  has_multi_seller: Joi.boolean().optional(),
  has_headless_api: Joi.boolean().optional(),
  ia_level: Joi.string().max(20).allow(null, '').optional(),
  global_commission_rate: Joi.number().precision(2).min(0).max(100).allow(null).optional(),
  sort_order: Joi.number().integer().allow(null).optional()
});

const updatePlanSchema = Joi.object({
  id: Joi.number().integer().positive().required().messages({
    'number.base': 'El ID debe ser un número entero',
    'any.required': 'El campo "id" es obligatorio'
  }),
  name: Joi.string().max(50).optional().messages({
    'string.max': 'El campo "name" debe tener máximo 50 caracteres'
  }),
  description: Joi.string().allow(null, '').optional(),
  is_active: Joi.boolean().optional(),
  max_products: Joi.number().integer().allow(null).optional(),
  max_branches: Joi.number().integer().allow(null).optional(),
  max_stores: Joi.number().integer().allow(null).optional(),
  max_integrations: Joi.number().integer().allow(null).optional(),
  max_global_publications: Joi.number().integer().allow(null).optional(),
  max_pools: Joi.number().integer().allow(null).optional(),
  has_tenant_marketplace: Joi.boolean().optional(),
  has_custom_domain: Joi.boolean().optional(),
  has_multi_seller: Joi.boolean().optional(),
  has_headless_api: Joi.boolean().optional(),
  ia_level: Joi.string().max(20).allow(null, '').optional(),
  global_commission_rate: Joi.number().precision(2).min(0).max(100).allow(null).optional(),
  sort_order: Joi.number().integer().allow(null).optional()
});

const idPlanSchema = Joi.object({
  id: Joi.number().integer().positive().required().messages({
    'number.base': 'El ID debe ser un número entero',
    'any.required': 'El campo "id" es obligatorio'
  })
});

module.exports = {
  planSchema,
  updatePlanSchema,
  idPlanSchema
};