'use strict';

const Joi = require('joi');

const mercadoLibreProductSchema = Joi.object({
  product_id: Joi.string()
    .trim()
    .min(3)
    .max(100)
    .pattern(/^[A-Za-z0-9_-]+$/)
    .required(),
  resource: Joi.string()
    .trim()
    .valid('products')
    .optional(),
  credential_id: Joi.number()
    .integer()
    .positive()
    .optional(),
  company_id: Joi.number()
    .integer()
    .positive()
    .optional()
});

module.exports = {
  mercadoLibreProductSchema
};
