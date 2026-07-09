const Joi = require('joi');

const baseSchema = {
  code: Joi.string().max(50).required(),
  name: Joi.string().max(255).required(),
  description: Joi.string().max(1000).allow(null, '').optional(),
  type: Joi.string().valid('central', 'tienda', 'frio', 'inflamable', 'externo').optional(),
  address: Joi.string().max(255).allow(null, '').optional(),
  city: Joi.string().max(120).allow(null, '').optional(),
  region: Joi.string().max(120).allow(null, '').optional(),
  country: Joi.string().max(120).allow(null, '').optional(),
  latitude: Joi.number().min(-90).max(90).precision(8).allow(null).optional(),
  longitude: Joi.number().min(-180).max(180).precision(8).allow(null).optional(),
  capacity_max_units: Joi.number().integer().min(0).allow(null).optional(),
  allow_mermas: Joi.boolean().optional(),
  rotation_policy: Joi.string().valid('FIFO', 'LIFO', 'FEFO').optional(),
  status: Joi.string().valid('activo', 'inactivo', 'delete').optional(),
  company_id: Joi.number().integer().positive().optional().empty('').allow(null),
  branch_id: Joi.number().integer().positive().optional().empty('').allow(null),
  user_id: Joi.number().integer().positive().optional().empty('').allow(null),
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
};

const storeWarehouseSchema = Joi.object(baseSchema);
const updateWarehouseSchema = Joi.object({
  id: Joi.number().required(),
  ...baseSchema
});
const idWarehouseSchema = Joi.object({ id: Joi.number().required() });
const listWarehouseSchema = Joi.object({
  company_id: Joi.number().allow(null).empty('').optional(),
  branch_id: Joi.number().allow(null).empty('').optional(),
  user_id: Joi.number().allow(null).empty('').optional(),
  include_products: Joi.boolean().truthy('true').falsy('false').optional(),
  status: Joi.string().valid('activo', 'inactivo', 'delete').optional(),
  type: Joi.string().valid('central', 'tienda', 'frio', 'inflamable', 'externo').optional(),
});

module.exports = {
  storeWarehouseSchema,
  updateWarehouseSchema,
  idWarehouseSchema,
  listWarehouseSchema
};
