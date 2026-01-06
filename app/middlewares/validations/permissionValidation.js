const Joi = require('joi');

const permissionSchema = Joi.object({
  name: Joi.string().max(100).required().messages({
    'string.empty': 'El campo "name" no puede estar vacío',
    'any.required': 'El campo "name" es obligatorio',
    'string.max': 'El campo "name" debe tener máximo 100 caracteres'
  }),
  description: Joi.string().max(255).allow(null, '').optional(),
  service: Joi.string().max(50).allow(null, '').optional(),
  resource: Joi.string().max(50).allow(null, '').optional(),
  action: Joi.string().max(30).allow(null, '').optional(),
  is_conditional: Joi.boolean().optional()
});

const updatePermissionSchema = Joi.object({
  id: Joi.number().integer().positive().required().messages({
    'number.base': 'El ID debe ser un número entero',
    'any.required': 'El campo "id" es obligatorio'
  }),
  name: Joi.string().max(100).optional().messages({
    'string.max': 'El campo "name" debe tener máximo 100 caracteres'
  }),
  description: Joi.string().max(255).allow(null, '').optional(),
  service: Joi.string().max(50).allow(null, '').optional(),
  resource: Joi.string().max(50).allow(null, '').optional(),
  action: Joi.string().max(30).allow(null, '').optional(),
  is_conditional: Joi.boolean().optional()
});

const idPermissionSchema = Joi.object({
  id: Joi.number().integer().positive().required().messages({
    'number.base': 'El ID debe ser un número entero',
    'any.required': 'El campo "id" es obligatorio'
  })
});

module.exports = {
  permissionSchema,
  updatePermissionSchema,
  idPermissionSchema
};