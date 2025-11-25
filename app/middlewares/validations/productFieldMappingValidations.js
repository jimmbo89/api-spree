// src/validations/productFieldMappingValidation.js
const Joi = require('joi');

const createSchema = Joi.object({
  marketplace_id: Joi.number().integer().positive().required(),
  internal_field: Joi.string().max(100).required(),
  external_field: Joi.string().max(100).required(),
  required: Joi.boolean().optional(),
  data_type: Joi.string().valid('string', 'number', 'boolean', 'array', 'object').optional(),
  direction: Joi.string().valid('export', 'import', 'both').optional(),
  default_value: Joi.string().optional().allow(null),
  validation_rules: Joi.object().optional().allow(null)
});

const updateSchema = Joi.object({
  id: Joi.number().integer().positive().required(),
  external_field: Joi.string().max(100).optional(),
  required: Joi.boolean().optional(),
  data_type: Joi.string().valid('string', 'number', 'boolean', 'array', 'object').optional(),
  direction: Joi.string().valid('export', 'import', 'both').optional(),
  default_value: Joi.string().optional().allow(null),
  validation_rules: Joi.object().optional().allow(null)
});

const idSchema = Joi.object({
  id: Joi.number().integer().positive().required()
});

const listSchema = Joi.object({
  marketplace_id: Joi.number().integer().positive().required()
});

module.exports = {
  createProductFieldMappingSchema: createSchema,
  updateProductFieldMappingSchema: updateSchema,
  idProductFieldMappingSchema: idSchema,
  listProductFieldMappingSchema: listSchema
};