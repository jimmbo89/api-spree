const Joi = require('joi');

const storeCompanySchema = Joi.object({
  business_type_id: Joi.number().integer().positive().required(),
  plan_id: Joi.number().integer().positive().optional(), // 👈 NUEVO
  name: Joi.string().max(255).required(),
  description: Joi.string().allow(null, '').optional(),
  rut: Joi.string().max(50).required(),
  address: Joi.string().max(255).allow(null, '').optional(),
  city: Joi.string().max(100).allow(null, '').optional(),
  country: Joi.string().max(100).allow(null, '').optional(),
  phone: Joi.string().max(20).allow(null, '').optional(),
  email: Joi.string().email().max(255).optional().allow(null, ''),
  warehouse: Joi.string()
    .custom((value, helpers) => {
      try {
        const parsed = JSON.parse(value);
        // Validación básica del objeto warehouse
        if (typeof parsed !== 'object' || parsed === null) {
          return helpers.message('warehouse debe ser un objeto JSON válido');
        }
        return value;
      } catch (error) {
        return helpers.message('warehouse debe ser un JSON válido');
      }
    })
    .optional(),
  image: Joi.any()
    .custom((value, helpers) => {
      if (value) {
        const validMimeTypes = ['image/jpg', 'image/jpeg', 'image/png', 'image/gif'];
        if (!validMimeTypes.includes(value.mimetype || value.type)) {
          return helpers.message('El archivo debe ser una imagen válida (jpg, jpeg, png, gif)');
        }
        const maxSize = 500 * 1024; // 500 KB
        if (value.size > maxSize) {
          return helpers.message('El archivo debe pesar máximo 500 KB');
        }
      }
      return value;
    })
    .optional()
});

const updateCompanySchema = Joi.object({
  id: Joi.number().required(),
  business_type_id: Joi.number().integer().positive().optional().allow(null),
  plan_id: Joi.number().integer().positive().optional(), // 👈 NUEVO
  name: Joi.string().max(255).allow(null, '').optional(),
  description: Joi.string().allow(null, '').optional(),
  rut: Joi.string().max(50).allow(null, '').optional(),
  address: Joi.string().max(255).allow(null, '').optional(),
  city: Joi.string().max(100).allow(null, '').optional(),
  country: Joi.string().max(100).allow(null, '').optional(),
  phone: Joi.string().max(20).allow(null, '').optional(),
  email: Joi.string().email().max(255).optional().allow(null, ''),
  image: Joi.any()
    .custom((value, helpers) => {
      if (value) {
        const validMimeTypes = ['image/jpg', 'image/jpeg', 'image/png', 'image/gif'];
        if (!validMimeTypes.includes(value.mimetype || value.type)) {
          return helpers.message('El archivo debe ser una imagen válida (jpg, jpeg, png, gif)');
        }
        const maxSize = 500 * 1024;
        if (value.size > maxSize) {
          return helpers.message('El archivo debe pesar máximo 500 KB');
        }
      }
      return value;
    })
    .optional()
});

const idCompanySchema = Joi.object({
  id: Joi.number().required(),
});

const byUserIdSchema = Joi.object({
  user_id: Joi.number().allow(null).empty('').optional(),
});

const companyIdSchema = Joi.object({
  company_id: Joi.number().integer().positive().required().messages({
    'number.base': 'El company_id debe ser un número entero',
    'any.required': 'El campo "company_id" es obligatorio'
  })
});

module.exports = {
  storeCompanySchema,
  updateCompanySchema,
  idCompanySchema,
  byUserIdSchema,
  companyIdSchema
};