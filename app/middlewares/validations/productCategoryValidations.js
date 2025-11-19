const Joi = require('joi');

const productCategorySchema = Joi.object({
  name: Joi.string().required().messages({
    'string.empty': 'El campo "name" no puede estar vacío',
    'any.required': 'El campo "name" es obligatorio'
  }),
  status: Joi.boolean().optional(),
  description: Joi.string().allow(null, '').optional()
});

const updateProductCategorySchema = Joi.object({
  id: Joi.number().integer().positive().required().messages({
    'number.base': 'El ID debe ser un número entero',
    'any.required': 'El campo "id" es obligatorio'
  }),
  name: Joi.string().allow(null, '').optional(),
  status: Joi.boolean().optional(),
  description: Joi.string().allow(null, '').optional()
});

const idProductCategorySchema = Joi.object({
  id: Joi.number().integer().positive().required().messages({
    'number.base': 'El ID debe ser un número entero',
    'any.required': 'El campo "id" es obligatorio'
  })
});

module.exports = {
  productCategorySchema,
  updateProductCategorySchema,
  idProductCategorySchema
};