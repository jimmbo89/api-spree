// app/validations/authValidation.js
const Joi = require('joi');

const registerSchema = Joi.object({
  name: Joi.string().min(2).max(255).required().messages({
    'string.min': 'El nombre debe tener al menos 2 caracteres',
    'string.max': 'El nombre no puede exceder los 255 caracteres',
    'any.required': 'El nombre es obligatorio'
  }),
  email: Joi.string().email().required().messages({
    'string.email': 'Debe ser un correo electrónico válido',
    'any.required': 'El correo es obligatorio'
  }),
  password: Joi.string().min(6).max(255).required().messages({
    'string.min': 'La contraseña debe tener al menos 6 caracteres',
    'any.required': 'La contraseña es obligatoria'
  }),
  role_id: Joi.number().integer().positive().optional().messages({
    'number.base': 'El role_id debe ser un número entero',
    'number.positive': 'El role_id debe ser positivo'
  }),
  status: Joi.boolean().optional().messages({
    'boolean.base': 'El campo "status" debe ser true o false'
  }),
  registration_date: Joi.date().iso().optional().messages({
    'date.isoDate': 'La "registration_date" debe tener formato ISO (YYYY-MM-DDTHH:mm:ssZ)'
  }),
  image: Joi.string().uri().optional().allow(null, '').empty('').messages({
    'string.uri': 'La imagen debe ser una URL válida'
  }),
  user: Joi.string().optional().allow(null, '').empty(''),
  email_verified_at: Joi.date().iso().optional().allow(null),
  remember_token: Joi.string().optional().allow(null, '').empty(''),
  external_id: Joi.string().optional().allow(null, '').empty(''),
  external_auth: Joi.string().optional().allow(null, '').empty('')
});

const updateSchema = Joi.object({
  name: Joi.string().min(2).max(255).optional().messages({
    'string.min': 'El nombre debe tener al menos 2 caracteres',
    'string.max': 'El nombre no puede exceder los 255 caracteres',
  }),
  email: Joi.string().email().optional().messages({
    'string.email': 'Debe ser un correo electrónico válido',
  }),
  role_id: Joi.number().integer().positive().optional().messages({
    'number.base': 'El role_id debe ser un número entero',
    'number.positive': 'El role_id debe ser positivo'
  }),
  status: Joi.boolean().optional().messages({
    'boolean.base': 'El campo "status" debe ser true o false'
  }),
  image: Joi.string().uri().optional().allow(null, '').empty('').messages({
    'string.uri': 'La imagen debe ser una URL válida'
  }),
  user: Joi.string().optional().allow(null, '').empty(''),
  remember_token: Joi.string().optional().allow(null, '').empty(''),
});

const loginSchema = Joi.object({
 email: Joi.string().min(3).required(),
  password: Joi.string().min(3).required().messages({
    'string.min': 'La contraseña debe tener al menos 3 caracteres',
    'any.required': 'La contraseña es obligatoria'
  })
});

const createUserSchema = Joi.object({
 // Datos del usuario
  name: Joi.string().min(2).max(255).required(),
  email: Joi.string().email().max(255).required(),
  user: Joi.string().max(100).required(), // username es obligatorio

  // Contraseña: obligatoria solo si no es invitación por email
  password: Joi.when('invitation_method', {
    is: 'direct',
    then: Joi.string().min(6).max(255).required(),
    otherwise: Joi.string().min(6).max(255).optional()
  }),

  // Método de invitación
  invitation_method: Joi.string().valid('email', 'direct').default('email'),

  // Contexto
  company_id: Joi.number().integer().positive().required(),
  role_id: Joi.number().integer().positive().required(),

  // Alcance operativo
  warehouses: Joi.alternatives().try(
    Joi.array().items(Joi.number().integer().positive()),
    Joi.string().custom((value, helpers) => {
      if (value === '' || value === null) return value;
      try {
        const parsed = JSON.parse(value);
        if (!Array.isArray(parsed)) {
          return helpers.message('El campo "warehouses" debe ser un array JSON válido');
        }
        return value;
      } catch (error) {
        return helpers.message('El campo "warehouses" debe ser un array JSON válido');
      }
    })
  ).optional(),
  pools: Joi.alternatives().try(
    Joi.array().items(Joi.number().integer().positive()),
    Joi.string().custom((value, helpers) => {
      if (value === '' || value === null) return value;
      try {
        const parsed = JSON.parse(value);
        if (!Array.isArray(parsed)) {
          return helpers.message('El campo "pools" debe ser un array JSON válido');
        }
        return value;
      } catch (error) {
        return helpers.message('El campo "pools" debe ser un array JSON válido');
      }
    })
  ).optional(),

});

// Actualizar usuario
const updateUserSchema = Joi.object({
  id: Joi.number().integer().positive().required(),
  company_id: Joi.number().integer().positive().required(),

  // Campos actualizables
  name: Joi.string().min(2).max(255).optional(),
  email: Joi.string().email().max(255).optional(),
  user: Joi.string().max(100).optional(),
  password: Joi.string().min(6).max(255).optional(),
  invitation_method: Joi.string().valid('email', 'direct').optional(),

  // Rol
  role_id: Joi.number().integer().positive().optional(),

  // ACL
  warehouses: Joi.alternatives().try(
    Joi.array().items(Joi.number().integer().positive()),
    Joi.string().custom((value, helpers) => {
      if (value === '' || value === null) return value;
      try {
        const parsed = JSON.parse(value);
        if (!Array.isArray(parsed)) {
          return helpers.message('El campo "warehouses" debe ser un array JSON válido');
        }
        return value;
      } catch (error) {
        return helpers.message('El campo "warehouses" debe ser un array JSON válido');
      }
    })
  ).optional(),
  pools: Joi.alternatives().try(
    Joi.array().items(Joi.number().integer().positive()),
    Joi.string().custom((value, helpers) => {
      if (value === '' || value === null) return value;
      try {
        const parsed = JSON.parse(value);
        if (!Array.isArray(parsed)) {
          return helpers.message('El campo "pools" debe ser un array JSON válido');
        }
        return value;
      } catch (error) {
        return helpers.message('El campo "pools" debe ser un array JSON válido');
      }
    })
  ).optional(),

  // Imagen: si se envía como string (ej: "users/default.jpg"), se permite
  image: Joi.string().optional() // solo para resetear a default
})
  .custom((value, helpers) => {
    const updatableFields = [
      'name', 'email', 'user', 'password', 'invitation_method',
      'role_id', 'warehouses', 'pools', 'image'
    ];
    const hasUpdate = updatableFields.some(field => value[field] !== undefined);
    if (!hasUpdate) {
      return helpers.message('Debe proporcionar al menos un campo para actualizar');
    }
    return value;
  });

module.exports = {
  registerSchema,
  loginSchema,
  updateSchema,
  createUserSchema,
  updateUserSchema
};
