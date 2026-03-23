// validations/productValidationSchemas.js
const Joi = require('joi');

const productBaseSchema = {
  sku: Joi.string().max(100).required(),
  name: Joi.string().max(255).required(),
  description: Joi.string().allow(null, '').optional(),
  brand: Joi.string().max(100).required(),
  model: Joi.string().max(100).optional().allow(null, ''),
  condition: Joi.string()
    .valid('new', 'used', 'refurbished', 'not_specified')
    .default('new'),
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
  category_id: Joi.number().integer().positive().optional().allow(null),
  company_id: Joi.number().integer().positive().required(),
  user_id: Joi.number().integer().positive().optional().allow(null),
  images: Joi.array()
    .items(Joi.string().pattern(/\.(jpg|jpeg|png|gif|webp)$/i))
    .optional()
    .default([]),
  sync_meta: Joi.object().optional().default({}),
  state: Joi.number().integer().optional(),
};

const storeProductSchema = Joi.object({
  ...productBaseSchema,
  warehouses: Joi.array().items(
    Joi.object({
      id: Joi.number().integer().positive().required(),
      published: Joi.boolean().optional().default(false),
      price: Joi.number().precision(2).min(0).required(), // precio por almacén/variante
      stock: Joi.number().integer().min(0).required()    // stock por almacén/variante
    })
  ).optional().default([])
});

const assignWarehouseSchema = Joi.object({
  product_id: Joi.number().integer().positive().required(),
  company_id: Joi.number().integer().positive().required(),
  warehouse_config: Joi.array().items(
    Joi.object({
      warehouse_id: Joi.number().integer().positive().required(),
      active: Joi.boolean().optional().default(true),
      code: Joi.string().max(100).optional().allow(null, ''),
      variants: Joi.array().items(
        Joi.object({
          active: Joi.boolean().optional().default(true),
          local_sku: Joi.string().max(100).optional().allow(null, ''),
          price: Joi.number().precision(2).min(0).required(),
          purchase_price: Joi.number().precision(2).min(0).optional().default(0),
          stock: Joi.number().integer().min(0).required()
        })
      ).required()
    })
  ).min(1).required()
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
  branch_id: Joi.number().allow(null).empty('').optional(),
  user_id: Joi.number().allow(null).empty('').optional(),
  brand: Joi.string().optional().allow(''),
  has_gtin: Joi.boolean().optional(),
  state: Joi.number().allow(null).empty('').optional(),
});

const listByWarehouseIdsSchema = Joi.object({
  company_id: Joi.number().integer().required(),
  warehouse_ids: Joi.array()
    .items(Joi.number().integer().required())
    .min(1)
    .required()
    .label('warehouse_ids')
});

module.exports = {
  storeProductSchema,
  updateProductSchema,
  idProductSchema,
  listProductsSchema,
  listByWarehouseIdsSchema,
  assignWarehouseSchema
};