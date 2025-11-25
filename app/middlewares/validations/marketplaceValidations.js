// src/validations/marketplaceValidation.js
const Joi = require('joi');

const mappingSchema = Joi.object({
  internalField: Joi.string().required(),
  externalField: Joi.string().required(),
  required: Joi.boolean().optional(),
  dataType: Joi.string().valid('string', 'number', 'boolean', 'array', 'object').optional(),
  direction: Joi.string().valid('export', 'import', 'both').optional(),
  defaultValue: Joi.string().optional().allow(null),
  validationRules: Joi.object().optional().allow(null)
});

const storeSchema = Joi.object({
  company_id: Joi.number().integer().positive().required(),
  user_id: Joi.number().integer().positive().optional().allow(null),
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
  company_id: Joi.number().integer().positive().optional(),
  user_id: Joi.number().integer().positive().optional().allow(null),
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
  idMarketplaceSchema: idSchema
};