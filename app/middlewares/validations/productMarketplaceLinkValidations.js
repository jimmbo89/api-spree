// src/validations/productMarketplaceLinkValidation.js
const Joi = require('joi');

const contextValidation = (value, helpers) => {
  const { company_id, branch_id } = value;
  if ((company_id && branch_id) || (!company_id && !branch_id)) {
    return helpers.message('Debe proporcionar exactamente company_id o branch_id');
  }
  return value;
};

const storeSchema = Joi.object({
  product_id: Joi.number().integer().positive().required(),
  marketplace_id: Joi.number().integer().positive().required(),
  company_id: Joi.number().integer().positive().optional(),
  branch_id: Joi.number().integer().positive().optional(),
  status: Joi.string().valid('published', 'unpublished', 'out_of_sync').optional(),
  external_id: Joi.string().optional().allow(null),
  external_url: Joi.string().optional().allow(null)
}).custom(contextValidation);

const listSchema = Joi.object({
  marketplace_id: Joi.number().integer().positive().required(),
  company_id: Joi.number().integer().positive().optional(),
  branch_id: Joi.number().integer().positive().optional()
}).custom(contextValidation);

module.exports = {
  storeProductMarketplaceLinkSchema: storeSchema,
  listProductMarketplaceLinkSchema: listSchema
};