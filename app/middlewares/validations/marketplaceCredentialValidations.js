// validations/marketplaceCredentialValidation.js
const Joi = require('joi');

const contextValidation = (value, helpers) => {
  const { company_id, branch_id } = value;
  if ((company_id && branch_id) || (!company_id && !branch_id)) {
    return helpers.message('Debe proporcionar exactamente company_id o branch_id');
  }
  return value;
};

const storeSchema = Joi.object({
  marketplace_id: Joi.number().integer().positive().required(),
  company_id: Joi.number().integer().positive().optional(),
  branch_id: Joi.number().integer().positive().optional(),
  // 🔑 Campos OAuth (opcional en Joi, validación lógica en controlador)
  client_id: Joi.string().optional(),
  client_secret: Joi.string().optional(),
  redirect_uri: Joi.string().uri().optional(),
  access_token: Joi.string().optional().allow(null, ''),
  refresh_token: Joi.string().optional().allow(null, ''),
  expires_at: Joi.date().optional().allow(null),
  scopes: Joi.string().optional().allow(null, ''),
  active: Joi.boolean().optional()
});

const updateSchema = Joi.object({
  id: Joi.number().integer().positive().required(),
  client_id: Joi.string().optional(),
  client_secret: Joi.string().optional(),
  redirect_uri: Joi.string().uri().optional(),
  access_token: Joi.string().optional(),
  refresh_token: Joi.string().optional().allow(null, ''),
  expires_at: Joi.date().optional().allow(null),
  scopes: Joi.string().optional().allow(null, ''),
  active: Joi.boolean().optional()
});

const idSchema = Joi.object({
  id: Joi.number().integer().positive().required()
});

const findByMarketplaceSchema = Joi.object({
  marketplace_id: Joi.number().integer().positive().optional(),
  company_id: Joi.number().integer().positive().optional(),
  branch_id: Joi.number().integer().positive().optional()
});

module.exports = {
  storeMarketplaceCredentialSchema: storeSchema,
  updateMarketplaceCredentialSchema: updateSchema,
  idMarketplaceCredentialSchema: idSchema,
  findByMarketplaceCredentialSchema: findByMarketplaceSchema
};