const Joi = require('joi');

const siiCertificateSchema = Joi.object({
  company_id: Joi.number().integer().positive().required(),
  certificate_path: Joi.any()
    .custom((value, helpers) => {
      if (value) {
        const maxSize = 5 * 1024 * 1024; // 5 MB
        if (value.size > maxSize) {
          return helpers.message('El certificado debe pesar máximo 5 MB');
        }
      }
      return value;
    })
    .required(),
    is_valid: Joi.boolean().required(),
  password: Joi.string().min(4).required(),
  document_types_enabled: Joi.array().items(Joi.string().valid('invoice', 'receipt', 'credit_note')).required(),
  folios_available: Joi.object().pattern(Joi.string(), Joi.number().integer().min(0)).required()
});

module.exports = { siiCertificateSchema };