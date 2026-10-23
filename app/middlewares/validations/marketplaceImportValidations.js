'use strict';

const Joi = require('joi');

const imageUrlSchema = Joi.string().trim().min(1).max(2000).custom((value, helpers) => {
  if (/^\/images\/(products|tmp)\/[^/]+$/.test(value)) return value;

  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('invalid_scheme');
    return value;
  } catch {
    return helpers.error('string.uri');
  }
});

const imageSchema = Joi.alternatives().try(
  imageUrlSchema,
  Joi.object({ url: imageUrlSchema.required() }).unknown(false)
);

const productSchema = Joi.object({
  sku: Joi.string().trim().max(255),
  name: Joi.string().trim().max(255),
  description: Joi.string().allow('', null),
  brand: Joi.string().allow('', null).max(255),
  model: Joi.string().allow('', null).max(255),
  condition: Joi.string().allow('', null).max(50),
  gtin: Joi.string().allow('', null).max(50),
  mpn: Joi.string().allow('', null).max(100),
  attributes: Joi.any(),
  warranty_months: Joi.number().integer().min(0).allow(null),
  warranty_text: Joi.string().allow('', null).max(255),
  weight_grams: Joi.number().integer().min(0).allow(null),
  length_cm: Joi.number().min(0).allow(null),
  width_cm: Joi.number().min(0).allow(null),
  height_cm: Joi.number().min(0).allow(null),
  product_measurements: Joi.any(),
  packaging_measurements: Joi.any(),
  category_id: Joi.number().integer().positive().allow(null),
  purchase_price: Joi.number().min(0).allow(null),
  sale_price: Joi.number().min(0).allow(null),
  state: Joi.number().integer().valid(1, 2),
  images: Joi.array().items(imageSchema).max(20)
}).unknown(false);

const warehouseSchema = Joi.object({
  warehouse_id: Joi.number().integer().positive().required(),
  active: Joi.boolean().optional(),
  minimum_stock: Joi.number().integer().min(0).optional(),
  price: Joi.number().min(0).optional(),
  purchase_price: Joi.number().min(0).optional(),
  stock: Joi.number().integer().min(0).optional(),
  quantity: Joi.number().integer().min(0).optional(),
  stock_operation: Joi.string().valid('set', 'add').default('set')
}).unknown(false);

const importItemSchema = Joi.object({
  item_id: Joi.number().integer().positive().required(),
  action: Joi.string().valid('create', 'update', 'skip').optional(),
  product: productSchema.optional(),
  purchase_price: Joi.number().min(0).allow(null).optional(),
  warehouses: Joi.array().items(warehouseSchema).max(100).optional(),
  inventory: Joi.object({
    warehouse_id: Joi.number().integer().positive(),
    stock: Joi.number().integer().min(0),
    quantity: Joi.number().integer().min(0),
    stock_operation: Joi.string().valid('set', 'add').default('set')
  }).unknown(false).optional()
}).unknown(false);

const operationSchema = Joi.object({
  company_id: Joi.number().integer().positive().optional(),
  import_id: Joi.string().guid({ version: ['uuidv4'] }).required()
});

const startMarketplaceImportSchema = Joi.object({
  company_id: Joi.number().integer().positive().optional(),
  preview_id: Joi.string().guid({ version: ['uuidv4'] }).required(),
  items: Joi.array().items(importItemSchema).min(1).max(100).required()
});

const listMarketplaceImportItemsSchema = operationSchema.keys({
  cursor: Joi.alternatives().try(
    Joi.number().integer().min(1),
    Joi.string().pattern(/^[1-9]\d*$/)
  ).optional(),
  limit: Joi.number().integer().min(1).max(100).default(100)
});

module.exports = {
  startMarketplaceImportSchema,
  statusMarketplaceImportSchema: operationSchema,
  itemsMarketplaceImportSchema: listMarketplaceImportItemsSchema,
  cancelMarketplaceImportSchema: operationSchema
};
