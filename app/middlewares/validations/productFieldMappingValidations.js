// src/validations/productFieldMappingValidation.js
const Joi = require('joi');

const baseMappingSchema = Joi.object({
  internal_field: Joi.string().max(100).required(),
  external_field: Joi.string().max(100).required(),
  required: Joi.boolean().optional(),
  data_type: Joi.string()
    .valid('string', 'number', 'boolean', 'array', 'object')
    .optional()
    .default('string'),
  direction: Joi.string()
    .valid('export', 'import', 'both')
    .optional()
    .default('export'),
  default_value: Joi.string().optional().allow(null),
  validation_rules: Joi.object().optional().allow(null)
}).options({ stripUnknown: true }); // Elimina campos no definidos en el esquema

const createSchema = Joi.object({
  marketplace_id: Joi.number().integer().positive().required(),
  ...baseMappingSchema.keys // hereda los campos de baseMappingSchema
});

const bulkCreateSchema = Joi.object({
  marketplace_id: Joi.number().integer().positive().required(),
  mappings: Joi.array()
    .items(baseMappingSchema)
    .min(1)
    .required()
    .messages({
      'array.min': 'Debe proporcionar al menos un mapeo.',
      'array.base': 'El campo "mappings" debe ser un array.'
    })
});

const updateSchema = Joi.object({
  id: Joi.number().integer().positive().required(),
  external_field: Joi.string().max(100).optional(),
  required: Joi.boolean().optional(),
  data_type: Joi.string()
    .valid('string', 'number', 'boolean', 'array', 'object')
    .optional(),
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
  bulkCreateProductFieldMappingSchema: bulkCreateSchema, // ✅ Nuevo esquema
  updateProductFieldMappingSchema: updateSchema,
  idProductFieldMappingSchema: idSchema,
  listProductFieldMappingSchema: listSchema
};