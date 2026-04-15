const Joi = require('joi');

const variantDefinitionSchema = Joi.object({
  name: Joi.string().max(100).required().messages({
    'string.empty': 'El campo "name" no puede estar vacio',
    'any.required': 'El campo "name" es obligatorio',
    'string.max': 'El campo "name" debe tener maximo 100 caracteres'
  }),
  company_id: Joi.number().integer().positive().allow(null).optional().messages({
    'number.base': 'El campo "company_id" debe ser un numero entero',
    'any.only': 'El campo "company_id" debe ser positivo'
  }),
  type: Joi.string().max(50).optional().allow(null).messages({
    'string.max': 'El campo "type" debe tener maximo 50 caracteres'
  }),
  cant: Joi.number().integer().optional().allow(null).messages({
    'number.base': 'El campo "cant" debe ser un numero entero'
  }),
  values: Joi.array().items(
    Joi.object({
      name: Joi.string().max(100).required(),
      code: Joi.string().max(50).optional().allow(null)
    })
  ).optional()
});

const updateVariantDefinitionSchema = Joi.object({
  id: Joi.number().integer().positive().required().messages({
    'number.base': 'El ID debe ser un numero entero',
    'any.required': 'El campo "id" es obligatorio'
  }),
  name: Joi.string().max(100).optional().messages({
    'string.max': 'El campo "name" debe tener maximo 100 caracteres'
  }),
  company_id: Joi.number().integer().positive().allow(null).optional().messages({
    'number.base': 'El campo "company_id" debe ser un numero entero',
    'any.only': 'El campo "company_id" debe ser positivo'
  }),
  type: Joi.string().max(50).optional().allow(null).messages({
    'string.max': 'El campo "type" debe tener maximo 50 caracteres'
  }),
  cant: Joi.number().integer().optional().allow(null).messages({
    'number.base': 'El campo "cant" debe ser un numero entero'
  }),
  values: Joi.array().items(
    Joi.object({
      id: Joi.number().integer().positive().optional(),
      name: Joi.string().max(100).optional(),
      code: Joi.string().max(50).optional().allow(null)
    })
  ).optional()
});

const listVariantDefinitionSchema = Joi.object({
  company_id: Joi.number().integer().positive().allow(null).optional().messages({
    'number.base': 'El campo "company_id" debe ser un numero entero'
  })
});

const idVariantDefinitionSchema = Joi.object({
  id: Joi.number().integer().positive().required().messages({
    'number.base': 'El ID debe ser un numero entero',
    'any.required': 'El campo "id" es obligatorio'
  })
});

module.exports = {
  variantDefinitionSchema,
  updateVariantDefinitionSchema,
  listVariantDefinitionSchema,
  idVariantDefinitionSchema
};
