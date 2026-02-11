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
  active: Joi.boolean().optional(),
    seller_email: Joi.string().email().optional().allow(null, '').messages({
    'string.email': 'El seller_email debe ser un correo electrónico válido'
  }),
  seller_id: Joi.string().optional().allow(null, '').messages({
    'string.base': 'El seller_id debe ser una cadena de texto'
  }),
  api_key: Joi.string().optional().allow(null, '').messages({
    'string.base': 'El api_key debe ser una cadena de texto'
  }),  
  // Datos adicionales
  additional_data: Joi.object().optional().allow(null).messages({
    'object.base': 'El additional_data debe ser un objeto JSON válido'
  })
});

const updateSchema = Joi.object({
  id: Joi.number().integer().positive().required(),
  access_token: Joi.string().optional(),
  refresh_token: Joi.string().optional().allow(null, ''),
  expires_at: Joi.date().optional().allow(null),
  active: Joi.boolean().optional(),
    seller_email: Joi.string().email().optional().allow(null, '').messages({
    'string.email': 'El seller_email debe ser un correo electrónico válido'
  }),
  seller_id: Joi.string().optional().allow(null, '').messages({
    'string.base': 'El seller_id debe ser una cadena de texto'
  }),
  api_key: Joi.string().optional().allow(null, '').messages({
    'string.base': 'El api_key debe ser una cadena de texto'
  }),  
  // Datos adicionales
  additional_data: Joi.object().optional().allow(null).messages({
    'object.base': 'El additional_data debe ser un objeto JSON válido'
  })
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