// validations/poolValidationSchemas.js
const Joi = require('joi');

const poolBaseSchema = {
  name: Joi.string().max(100).required(),
  description: Joi.string().allow(null, '').optional(),
  company_id: Joi.number().integer().positive().required(),
  user_id: Joi.number().integer().positive().optional().allow(null),
  is_active: Joi.boolean().default(true)
};

const poolWarehouseSchema = Joi.object({
  warehouse_id: Joi.number().integer().positive().required(),
  is_primary: Joi.boolean().default(false),
  position: Joi.number().integer().min(0).default(0)
});

const storePoolSchema = Joi.object({
  ...poolBaseSchema,
  warehouses: Joi.array()
    .items(poolWarehouseSchema)
    .min(1)
    .required()
    .custom((warehouses, helpers) => {
      const primaryCount = warehouses.filter(w => w.is_primary).length;
      if (primaryCount > 1) {
        return helpers.error('any.invalid', { message: 'Solo puede haber un almacén principal por pool' });
      }
      if (primaryCount === 0) {
        warehouses[0].is_primary = true;
      }
      return warehouses;
    })
});

const updatePoolSchema = Joi.object({
  id: Joi.number().integer().positive().required(),
  ...Object.fromEntries(
    Object.entries(poolBaseSchema).map(([key, schema]) => [key, schema.optional()])
  ),
  warehouses: Joi.array()
    .items(poolWarehouseSchema)
    .optional()
    .custom((warehouses, helpers) => {
      if (warehouses && warehouses.length > 0) {
        const primaryCount = warehouses.filter(w => w.is_primary).length;
        if (primaryCount > 1) {
          return helpers.error('any.invalid', { message: 'Solo puede haber un almacén principal por pool' });
        }
        if (primaryCount === 0) {
          warehouses[0].is_primary = true;
        }
      }
      return warehouses;
    })
});

const idPoolSchema = Joi.object({
  id: Joi.number().integer().positive().required()
});

const listPoolsSchema = Joi.object({
  company_id: Joi.number().integer().positive().optional(),
  user_id: Joi.number().integer().positive().optional().allow(null),
  is_active: Joi.boolean().optional()
});

module.exports = {
  storePoolSchema,
  updatePoolSchema,
  idPoolSchema,
  listPoolsSchema
};