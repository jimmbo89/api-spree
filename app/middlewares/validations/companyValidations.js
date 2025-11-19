const Joi = require('joi');

const storeCompanySchema = Joi.object({
  business_type_id: Joi.number().integer().positive().required(),
  name: Joi.string().max(255).required(),
  description: Joi.string().allow(null, '').optional(),
  rut: Joi.string().max(50).required(),
  address: Joi.string().max(255).allow(null, '').optional(),
  city: Joi.string().max(100).allow(null, '').optional(),
  country: Joi.string().max(100).allow(null, '').optional(),
  phone: Joi.string().max(20).allow(null, '').optional(),
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
  name: Joi.string().max(255).allow(null, '').optional(),
  description: Joi.string().allow(null, '').optional(),
  rut: Joi.string().max(50).allow(null, '').optional(),
  address: Joi.string().max(255).allow(null, '').optional(),
  city: Joi.string().max(100).allow(null, '').optional(),
  country: Joi.string().max(100).allow(null, '').optional(),
  phone: Joi.string().max(20).allow(null, '').optional(),
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

module.exports = {
  storeCompanySchema,
  updateCompanySchema,
  idCompanySchema,
  byUserIdSchema
};