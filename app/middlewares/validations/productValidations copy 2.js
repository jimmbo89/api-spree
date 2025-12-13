const Joi = require('joi');

const productBaseSchema = {
  sku: Joi.string().max(100).required(),
  name: Joi.string().max(255).required(),
  description: Joi.string().allow(null, '').optional(),
  brand: Joi.string().max(100).required(),
  model: Joi.string().max(100).optional().allow(null, ''),
  condition: Joi.string().valid('new', 'used', 'refurbished', 'not_specified').default('new'),
  gtin: Joi.string().max(50).optional().allow(null, ''),
  mpn: Joi.string().max(100).optional().allow(null, ''),
  warranty_months: Joi.number().integer().min(0).optional().allow(null),
  warranty_text: Joi.string().max(255).optional().allow(null, ''),
  weight_grams: Joi.number().integer().min(0).optional().allow(null),
  length_cm: Joi.number().precision(2).min(0).optional().allow(null),
  width_cm: Joi.number().precision(2).min(0).optional().allow(null),
  height_cm: Joi.number().precision(2).min(0).optional().allow(null),
  attributes: Joi.array().items(
    Joi.object({
      id: Joi.string().required(),
      name: Joi.string().optional(),
      value: Joi.alternatives().try(Joi.string(), Joi.number(), Joi.boolean()).required(),
      unit: Joi.string().optional()
    })
  ).optional().default([]),
  status: Joi.number().integer().min(0).max(3).optional(),
  category_id: Joi.number().integer().positive().optional().allow(null),
  base_price: Joi.number().precision(2).positive().optional().allow(null),
  company_id: Joi.number().integer().positive().required(),
  user_id: Joi.number().integer().positive().optional().allow(null),
  branch_id: Joi.number().integer().positive().optional().allow(null),
  images: Joi.array()
    .items(Joi.string().pattern(/\.(jpg|jpeg|png|gif|webp)$/i))
    .optional().default([]),
  sync_meta: Joi.object().optional().default({}),
  warehouses: Joi.string()
      .custom((value, helpers) => {
        try {
          if (value) {
            const parsed = JSON.parse(value);
            // Solo validar que sea un objeto, sin restricciones internas
            if (typeof parsed !== 'object' || parsed === null) {
              return helpers.message('product debe ser un objeto JSON válido');
            }
          }
          return value;
        } catch (error) {
          return helpers.message('product debe ser un JSON válido');
        }
      })
      .optional(),
};

const storeProductSchema = Joi.object({
  ...productBaseSchema
});

const updateProductSchema = Joi.object({
  id: Joi.number().required(),
  ...Object.fromEntries(
    Object.entries(productBaseSchema).map(([key, schema]) => [key, schema.optional()])
  )
});

const idProductSchema = Joi.object({
  id: Joi.number().required()
});

const listProductsSchema = Joi.object({
  company_id: Joi.number().allow(null).empty('').optional(),
  user_id: Joi.number().allow(null).empty('').optional(),
  branch_id: Joi.number().allow(null).empty('').optional(),
  brand: Joi.string().optional().allow(''),
  status: Joi.number().integer().min(0).max(3).optional(),
  has_gtin: Joi.boolean().optional()
});

const mercadoLibreProductSchema = Joi.object({
  ...productBaseSchema,
  family_name: Joi.string().max(100).optional(),
  listing_type_id: Joi.string().valid('bronze', 'silver', 'gold', 'gold_special', 'gold_premium').optional(),
  shipping: Joi.object({
    mode: Joi.string().valid('me2', 'not_specified', 'custom').optional(),
    free_shipping: Joi.boolean().optional(),
    dimensions: Joi.string().optional()
  }).optional()
});

module.exports = {
  storeProductSchema,
  updateProductSchema,
  idProductSchema,
  listProductsSchema,
  mercadoLibreProductSchema
};