const Joi = require('joi');

// Schema para crear atributo
const attributeSchema = Joi.object({
  name: Joi.string().max(100).required().messages({
    'string.empty': 'El campo "name" no puede estar vacío',
    'any.required': 'El campo "name" es obligatorio',
    'string.max': 'El campo "name" debe tener máximo 100 caracteres'
  }),
  company_id: Joi.number().integer().positive().allow(null).optional().messages({
    'number.base': 'El campo "company_id" debe ser un número entero',
    'any.only': 'El campo "company_id" debe ser positivo'
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

// Schema para actualizar atributo
const updateAttributeSchema = Joi.object({
  id: Joi.number().integer().positive().required().messages({
    'number.base': 'El ID debe ser un número entero',
    'any.required': 'El campo "id" es obligatorio'
  }),
  name: Joi.string().max(100).optional().messages({
    'string.max': 'El campo "name" debe tener máximo 100 caracteres'
  }),
  company_id: Joi.number().integer().positive().allow(null).optional().messages({
    'number.base': 'El campo "company_id" debe ser un número entero',
    'any.only': 'El campo "company_id" debe ser positivo'
  }),
  type: Joi.string().max(50).optional().messages({
    'string.max': 'El campo "type" debe tener máximo 50 caracteres'
  }),
  cant: Joi.number().integer().optional().allow(null).messages({
    'number.base': 'El campo "cant" debe ser un número entero'
  })
});

// Schema para listar atributos (acepta company_id como filtro)
const listAttributeSchema = Joi.object({
  company_id: Joi.number().integer().positive().allow(null).optional().messages({
    'number.base': 'El campo "company_id" debe ser un número entero'
  }),
  usage: Joi.boolean().optional()
});

// Schema para eliminar atributo (solo ID)
const idAttributeSchema = Joi.object({
  id: Joi.number().integer().positive().required().messages({
    'number.base': 'El ID debe ser un número entero',
    'any.required': 'El campo "id" es obligatorio'
  })
});

module.exports = {
  attributeSchema,
  updateAttributeSchema,
  listAttributeSchema,
  idAttributeSchema
};