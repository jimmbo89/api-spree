// src/validations/marketplaceValidation.js
const Joi = require('joi');

const mappingSchema = Joi.object({
  internal_field: Joi.string().required(),
  external_field: Joi.string().required(),
  required: Joi.boolean().optional(),
  data_type: Joi.string().valid('string', 'number', 'boolean', 'array', 'object').optional(),
  direction: Joi.string().valid('export', 'import', 'both').optional(),
  default_value: Joi.string().optional().allow(null, ''),
  validation_rules: Joi.object().optional().allow(null)
});

const storeSchema = Joi.object({
  name: Joi.string().max(100).required().messages({
    'string.empty': 'El campo «name» no puede estar vacío.',
    'string.max': 'El campo «name» no puede superar los 100 caracteres.',
    'any.required': 'El campo «name» es obligatorio.'
  }),
  description: Joi.string().max(255).optional().allow(null, '').messages({
    'string.max': 'El campo «description» no puede superar los 255 caracteres.'
  }),
  type: Joi.number().integer().valid(0, 1).required().messages({
    'number.base': 'El campo «type» debe ser un número entero.',
    'number.integer': 'El campo «type» debe ser un número entero.',
    'any.only': 'El campo «type» solo puede tener los valores 0 o 1.',
    'any.required': 'El campo «type» es obligatorio.'
  }),
  domain: Joi.string().uri().optional().allow(null, '').messages({
    'string.uri': 'El campo «domain» debe ser una URL válida, por ejemplo «https://dominio.test».'
  }),
  // 🔑 Campos OAuth explícitos
  client_id: Joi.string().optional(), // requerido en lógica de negocio si active=true
  client_secret: Joi.string().optional(),
  redirect_uri: Joi.string().uri().optional().allow(null, ''),
  scopes: Joi.string().optional().allow(null, ''),
  active: Joi.boolean().optional(),
  mappings: Joi.array().items(mappingSchema).optional()
}).messages({
  'object.unknown': 'El campo «{#key}» no está permitido en esta solicitud.'
});

const updateSchema = Joi.object({
  id: Joi.number().integer().positive().required(),
  name: Joi.string().max(100).optional(),
  description: Joi.string().max(255).optional().allow(null, ''),
  type: Joi.number().integer().valid(0, 1).optional(),
  domain: Joi.string().uri().optional().allow(null, ''),
  client_id: Joi.string().optional(),
  client_secret: Joi.string().optional(),
  redirect_uri: Joi.string().uri().optional().allow(null, ''),
  scopes: Joi.string().optional().allow(null, ''),
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
