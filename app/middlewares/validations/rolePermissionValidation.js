const Joi = require('joi');

const VALID_STATUSES = [1, 2, 3];

const assignPermissionToRoleSchema = Joi.object({
  role_id: Joi.number().integer().positive().required(),
  permission_id: Joi.number().integer().positive().required(),
  status: Joi.number().integer().valid(...VALID_STATUSES).optional().default(1)
});

const updateRolePermissionSchema = Joi.object({
  id: Joi.number().integer().positive().required(),
  status: Joi.number().integer().valid(...VALID_STATUSES).required()
});

const roleIdSchema = Joi.object({
  role_id: Joi.number().integer().positive().required()
});

const idRolePermissionSchema = Joi.object({
  id: Joi.number().integer().positive().required()
});

const assignMultiplePermissionsToRoleSchema = Joi.object({
  role_id: Joi.number().integer().positive().required(),
  permission_ids: Joi.array().items(Joi.number().integer().positive()).min(1).required(),
  status: Joi.number().integer().valid(...VALID_STATUSES).optional().default(1)
});

const availablePermissionsForRoleSchema = Joi.object({
  role_id: Joi.number().integer().positive().required().messages({
    'number.base': 'El role_id debe ser un número entero',
    'any.required': 'El campo "role_id" es obligatorio'
  }),
  permission_id: Joi.number().integer().positive().optional().messages({
    'number.base': 'El permission_id debe ser un número entero'
  })
});

module.exports = {
  assignPermissionToRoleSchema,
  updateRolePermissionSchema,
  roleIdSchema,
  assignMultiplePermissionsToRoleSchema,
  idRolePermissionSchema,
  availablePermissionsForRoleSchema
};