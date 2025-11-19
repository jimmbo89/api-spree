const Joi = require('joi');

const baseSchema = {
  name: Joi.string().max(255).required(),
  type: Joi.number().integer().valid(0, 1).optional(),
  address: Joi.string().max(255).allow(null, '').optional(),
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
});

module.exports = {
  storeWarehouseSchema,
  updateWarehouseSchema,
  idWarehouseSchema,
  listWarehouseSchema
};