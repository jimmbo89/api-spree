// src/validations/marketplaceValidation.js
const Joi = require('joi');
const mappingSchema = Joi.object({
  internal_field: Joi.string().required(),
  external_field: Joi.string().required(),
  required: Joi.boolean().optional(),
  data_type: Joi.string().valid('string', 'number', 'boolean', 'array', 'object').optional(),
  direction: Joi.string().valid('export', 'import', 'both').optional(),
  default_value: Joi.string().optional().allow(null),
  validation_rules: Joi.object().optional().allow(null)
});

const storeSchema = Joi.object({
  name: Joi.string().max(100).required(),
  description: Joi.string().max(255).optional().allow(null, ''),
  type: Joi.number().integer().valid(0, 1).required(),
  domain: Joi.string().uri().optional().allow(null, ''),
  config: Joi.object().optional().allow(null),
  active: Joi.boolean().optional(),
  mappings: Joi.array().items(mappingSchema).optional()
});

const updateSchema = Joi.object({
  id: Joi.number().integer().positive().required(),
  name: Joi.string().max(100).optional(),
  description: Joi.string().max(255).optional().allow(null, ''),
  type: Joi.number().integer().valid(0, 1).optional(),
  domain: Joi.string().uri().optional().allow(null, ''),
  config: Joi.object().optional().allow(null),
  active: Joi.boolean().optional(),
  mappings: Joi.array().items(mappingSchema).optional()
});

const idSchema = Joi.object({
  id: Joi.number().integer().positive().required()
});

module.exports = {
  storeMarketplaceSchema: storeSchema,
  updateMarketplaceSchema: updateSchema,
  idMarketplaceSchema: idSchema,
};