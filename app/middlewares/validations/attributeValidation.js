const Joi = require('joi');

const attributeSchema = Joi.object({
  name: Joi.string().max(100).required().messages({
    'string.empty': 'El campo "name" no puede estar vacío',
    'any.required': 'El campo "name" es obligatorio',
    'string.max': 'El campo "name" debe tener máximo 100 caracteres'
  }),
  type: Joi.string().max(50).required().messages({
    'string.empty': 'El campo "type" no puede estar vacío',
    'any.required': 'El campo "type" es obligatorio',
    'string.max': 'El campo "type" debe tener máximo 50 caracteres'
  }),
  cant: Joi.number().integer().optional().allow(null).messages({
    'number.base': 'El campo "cant" debe ser un número entero'
  })
});

const updateAttributeSchema = Joi.object({
  id: Joi.number().integer().positive().required().messages({
    'number.base': 'El ID debe ser un número entero',
    'any.required': 'El campo "id" es obligatorio'
  }),
  name: Joi.string().max(100).optional().messages({
    'string.max': 'El campo "name" debe tener máximo 100 caracteres'
  }),
  type: Joi.string().max(50).optional().messages({
    'string.max': 'El campo "type" debe tener máximo 50 caracteres'
  }),
  cant: Joi.number().integer().optional().allow(null).messages({
    'number.base': 'El campo "cant" debe ser un número entero'
  })
});

const idAttributeSchema = Joi.object({
  id: Joi.number().integer().positive().required().messages({
    'number.base': 'El ID debe ser un número entero',
    'any.required': 'El campo "id" es obligatorio'
  })
});

module.exports = {
  attributeSchema,
  updateAttributeSchema,
  idAttributeSchema
};