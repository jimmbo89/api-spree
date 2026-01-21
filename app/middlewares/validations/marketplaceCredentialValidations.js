// validations/marketplaceCredentialValidation.js
const Joi = require('joi');

// ⚠️ user_id NO se valida desde el body, se toma del token autenticado
// Por eso no aparece en el esquema

const storeSchema = Joi.object({
  marketplace_id: Joi.number().integer().positive().required(),
  // 🔑 Solo tokens
  access_token: Joi.string().required(), // requerido al crear
  refresh_token: Joi.string().optional().allow(null, ''),
  expires_at: Joi.date().optional().allow(null),
  active: Joi.boolean().optional()
});

const updateSchema = Joi.object({
  id: Joi.number().integer().positive().required(),
  access_token: Joi.string().optional(),
  refresh_token: Joi.string().optional().allow(null, ''),
  expires_at: Joi.date().optional().allow(null),
  active: Joi.boolean().optional()
});

const idSchema = Joi.object({
  id: Joi.number().integer().positive().required()
});

// Para endpoints como GET /credentials?marketplace_id=1
const findByUserSchema = Joi.object({
  marketplace_id: Joi.number().integer().positive().optional()
});

module.exports = {
  storeMarketplaceCredentialSchema: storeSchema,
  updateMarketplaceCredentialSchema: updateSchema,
  idMarketplaceCredentialSchema: idSchema,
  findByMarketplaceCredentialSchema: findByUserSchema // renombrado para claridad
};