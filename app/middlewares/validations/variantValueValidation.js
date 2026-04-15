const Joi = require('joi');

const variantValueSchema = Joi.object({
  variant_definition_id: Joi.number().integer().positive().required().messages({
    'number.base': 'El campo "variant_definition_id" debe ser un numero entero',
    'any.required': 'El campo "variant_definition_id" es obligatorio'
  }),
  name: Joi.string().max(100).required().messages({
    'string.empty': 'El campo "name" no puede estar vacio',
    'any.required': 'El campo "name" es obligatorio',
    'string.max': 'El campo "name" debe tener maximo 100 caracteres'
  }),
  code: Joi.string().max(50).optional().allow(null).messages({
    'string.max': 'El campo "code" debe tener maximo 50 caracteres'
  })
});

const updateVariantValueSchema = Joi.object({
  id: Joi.number().integer().positive().required().messages({
    'number.base': 'El ID debe ser un numero entero',
    'any.required': 'El campo "id" es obligatorio'
  }),
  variant_definition_id: Joi.number().integer().positive().optional().messages({
    'number.base': 'El campo "variant_definition_id" debe ser un numero entero'
  }),
  name: Joi.string().max(100).optional().messages({
    'string.max': 'El campo "name" debe tener maximo 100 caracteres'
  }),
  code: Joi.string().max(50).optional().allow(null).messages({
    'string.max': 'El campo "code" debe tener maximo 50 caracteres'
  })
});

const listVariantValueSchema = Joi.object({
  variant_definition_id: Joi.number().integer().positive().required().messages({
    'number.base': 'El campo "variant_definition_id" debe ser un numero entero',
    'any.required': 'El campo "variant_definition_id" es obligatorio'
  })
});

const idVariantValueSchema = Joi.object({
  id: Joi.number().integer().positive().required().messages({
    'number.base': 'El ID debe ser un numero entero',
    'any.required': 'El campo "id" es obligatorio'
  })
});

module.exports = {
  variantValueSchema,
  updateVariantValueSchema,
  listVariantValueSchema,
  idVariantValueSchema
};
