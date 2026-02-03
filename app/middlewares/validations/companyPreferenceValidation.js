const Joi = require('joi');

const companyPreferenceSchema = Joi.object({
  company_id: Joi.number().integer().positive().required(),
  timezone: Joi.string().max(50).default('America/Santiago'),
  language: Joi.string().max(10).default('es-CL'),
  date_format: Joi.string().valid('DD/MM/YYYY', 'YYYY-MM-DD', 'MM/DD/YYYY').default('DD/MM/YYYY')
});

module.exports = { companyPreferenceSchema };