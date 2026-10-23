'use strict';

const Joi = require('joi');

const optionsSchema = Joi.object({
  page_size: Joi.number().integer().min(1).max(100).optional(),
  request_concurrency: Joi.number().integer().min(1).max(4).optional(),
  max_items: Joi.number().integer().positive().optional(),
  include_descriptions: Joi.boolean().optional(),
  include_prices: Joi.boolean().optional(),
  include_sale_price: Joi.boolean().optional(),
  include_user_products: Joi.boolean().optional(),
  include_family: Joi.boolean().optional(),
  include_family_members: Joi.boolean().optional(),
  include_stock: Joi.boolean().optional(),
  include_fulfillment: Joi.boolean().optional()
}).default({});

const companyId = Joi.number().integer().positive().optional();

const startMarketplacePreviewSchema = Joi.object({
  company_id: companyId,
  credential_id: Joi.number().integer().positive().required(),
  options: optionsSchema
});

const operationSchema = Joi.object({
  company_id: companyId,
  preview_id: Joi.string().guid({ version: ['uuidv4'] }).required()
});

const itemsMarketplacePreviewSchema = operationSchema.keys({
  cursor: Joi.alternatives().try(
    Joi.number().integer().min(1),
    Joi.string().pattern(/^[1-9]\d*$/)
  ).optional(),
  limit: Joi.number().integer().min(1).max(100).default(100)
});

const detailMarketplacePreviewSchema = operationSchema.keys({
  item_id: Joi.number().integer().positive().required(),
  refresh: Joi.boolean().default(false)
});

module.exports = {
  startMarketplacePreviewSchema,
  statusMarketplacePreviewSchema: operationSchema,
  itemsMarketplacePreviewSchema,
  cancelMarketplacePreviewSchema: operationSchema,
  detailMarketplacePreviewSchema
};
