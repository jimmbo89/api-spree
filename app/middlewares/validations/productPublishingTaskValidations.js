// src/validations/productPublishingTaskValidation.js
const Joi = require('joi');

const storeSchema = Joi.object({
  products: Joi.array().items(
    Joi.object({
      product_id: Joi.number().integer().positive().required(),
      // Incluir campos necesarios para transformación: name, price, stock, etc.
    })
  ).min(1).required(),
  marketplace_id: Joi.number().integer().positive().required(),
  warehouse_id: Joi.number().integer().positive().required()
});

const updateStatusSchema = Joi.object({
  id: Joi.number().integer().positive().required(),
  status: Joi.string().valid('pending', 'published', 'error', 'out_of_sync', 'archived').required(),
  error_message: Joi.string().optional().allow(null),
  external_id: Joi.string().optional().allow(null),
  external_url: Joi.string().optional().allow(null)
});

const listSchema = Joi.object({
  company_id: Joi.number().integer().positive().required(),
  status: Joi.string().valid('pending', 'published', 'error', 'out_of_sync', 'archived').optional()
});

module.exports = {
  storeProductPublishingTaskSchema: storeSchema,
  updateProductPublishingTaskStatusSchema: updateStatusSchema,
  listProductPublishingTaskSchema: listSchema
};