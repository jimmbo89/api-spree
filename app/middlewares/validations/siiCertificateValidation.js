const Joi = require('joi');

const fileConfig = {
  certificate: {
    mimetypes: ['application/x-pkcs12', 'application/pkcs12', 'application/x-pem-file', 'application/octet-stream'],
    extensions: ['.pfx', '.p12', '.pem']
  }
};

const siiCertificateSchema = Joi.object({
  company_id: Joi.number().integer().positive().required(),
  certificate_file: Joi.any()
    .custom((value, helpers) => {
      if (value) {
        const validMimes = fileConfig.certificate.mimetypes;
        const fileMimeType = value.mimetype || value.type;
        if (!validMimes.includes(fileMimeType)) {
          return helpers.message('El certificado debe ser .pfx, .p12 o .pem');
        }
        const maxSize = 5 * 1024 * 1024; // 5 MB
        if (value.size > maxSize) {
          return helpers.message('El certificado debe pesar máximo 5 MB');
        }
      }
      return value;
    })
    .required(),
  password: Joi.string().min(4).required(),
  document_types_enabled: Joi.array().items(Joi.string().valid('invoice', 'receipt', 'credit_note')).required(),
  folios_available: Joi.object().pattern(Joi.string(), Joi.number().integer().min(0)).required()
});

module.exports = { siiCertificateSchema };