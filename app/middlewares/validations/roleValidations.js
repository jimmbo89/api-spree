// app/validations/roleValidation.js
const Joi = require('joi');

const roleSchema = Joi.object({
  name: Joi.string().max(100).required().messages({
    'string.empty': 'El campo "name" no puede estar vacío',
    'any.required': 'El campo "name" es obligatorio',
    'string.max': 'El campo "name" debe tener máximo 100 caracteres'
  }),
  status: Joi.boolean().optional(),
  description: Joi.string().allow(null, '').optional()
});

const updateRoleSchema = Joi.object({
  id: Joi.number().integer().positive().required().messages({
    'number.base': 'El ID debe ser un número entero',
    'any.required': 'El campo "id" es obligatorio'
  }),
  name: Joi.string().max(100).optional().messages({
    'string.max': 'El campo "name" debe tener máximo 100 caracteres'
  }),
  status: Joi.boolean().optional(),
  description: Joi.string().allow(null, '').optional()
});

const idRoleSchema = Joi.object({
  id: Joi.number().integer().positive().required().messages({
    'number.base': 'El ID debe ser un número entero',
    'any.required': 'El campo "id" es obligatorio'
  })
});

module.exports = {
  roleSchema,
  updateRoleSchema,
  idRoleSchema
};