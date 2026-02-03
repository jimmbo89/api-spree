// schemas/siiCafSchema.js
const Joi = require('joi');

const uploadCafSchema = Joi.object({
  company_id: Joi.number().integer().positive().required(),
  certificate_id: Joi.number().integer().positive().required(),
  caf_xml: Joi.string().required()
});

module.exports = { uploadCafSchema };