const Joi = require('joi');

const storeProductSchema = Joi.object({
  sku: Joi.string().max(100).required(),
  name: Joi.string().max(255).required(),
  description: Joi.string().allow(null, '').optional(),
  status: Joi.number().integer().min(0).max(3).optional(),
  category_id: Joi.number().integer().positive().optional().allow(null),
  base_price: Joi.number().precision(2).positive().optional().allow(null),
  company_id: Joi.number().integer().positive().required(),
  user_id: Joi.number().integer().positive().optional().allow(null),
  branch_id: Joi.number().integer().positive().optional().allow(null)
});

const updateProductSchema = Joi.object({
  id: Joi.number().required(),
  sku: Joi.string().max(100).optional(),
  name: Joi.string().max(255).optional(),
  description: Joi.string().allow(null, '').optional(),
  status: Joi.number().integer().min(0).max(3).optional(),
  category_id: Joi.number().integer().positive().optional().allow(null),
  base_price: Joi.number().precision(2).positive().optional().allow(null),
  company_id: Joi.number().integer().positive().optional(),
  user_id: Joi.number().integer().positive().optional().allow(null),
  branch_id: Joi.number().integer().positive().optional().allow(null)
});

const idProductSchema = Joi.object({
  id: Joi.number().required()
});

const listProductsSchema = Joi.object({
  company_id: Joi.number().integer().positive().required(),
  user_id: Joi.number().allow(null).empty('').optional(),
  branch_id: Joi.number().allow(null).empty('').optional()
});

module.exports = {
  storeProductSchema,
  updateProductSchema,
  idProductSchema,
  listProductsSchema
};