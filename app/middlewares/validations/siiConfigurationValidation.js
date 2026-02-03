const Joi = require('joi');

const siiConfigSchema = Joi.object({
  company_id: Joi.number().integer().positive().required(),
  rut: Joi.string().pattern(/^\d{7,8}-[\dkK]$/).required(),
  legal_name: Joi.string().max(255).required(),
  sii_environment: Joi.string().valid('production', 'certification').default('certification'),
  contributor_type: Joi.string().max(50).required()
});

module.exports = { siiConfigSchema };