const Joi = require('joi');

// Schema para crear categoría
const productCategorySchema = Joi.object({
  name: Joi.string().required().messages({
    'string.empty': 'El campo "name" no puede estar vacío',
    'any.required': 'El campo "name" es obligatorio'
  }),
  company_id: Joi.number().integer().positive().allow(null).optional().messages({
    'number.base': 'El campo "company_id" debe ser un número entero',
    'any.only': 'El campo "company_id" debe ser positivo'
  }),
  status: Joi.boolean().optional(),
  description: Joi.string().allow(null, '').optional()
});

// Schema para actualizar categoría
const updateProductCategorySchema = Joi.object({
  id: Joi.number().integer().positive().required().messages({
    'number.base': 'El ID debe ser un número entero',
    'any.required': 'El campo "id" es obligatorio'
  }),
  name: Joi.string().allow(null, '').optional(),
  company_id: Joi.number().integer().positive().allow(null).optional().messages({
    'number.base': 'El campo "company_id" debe ser un número entero',
    'any.only': 'El campo "company_id" debe ser positivo'
  }),
  status: Joi.boolean().optional(),
  description: Joi.string().allow(null, '').optional()
});

// Schema para listar categorías (acepta company_id como filtro)
const listProductCategorySchema = Joi.object({
  company_id: Joi.number().integer().positive().allow(null).optional().messages({
    'number.base': 'El campo "company_id" debe ser un número entero'
  })
});

// Schema para eliminar categoría (solo ID)
const idProductCategorySchema = Joi.object({
  id: Joi.number().integer().positive().required().messages({
    'number.base': 'El campo «id» debe ser un número entero positivo.',
    'number.integer': 'El campo «id» debe ser un número entero.',
    'number.positive': 'El campo «id» debe ser mayor que cero.',
    'any.required': 'El campo «id» es obligatorio.'
  })
}).messages({
  'object.unknown': 'El campo «{#key}» no está permitido en esta solicitud.'
});

module.exports = {
  productCategorySchema,
  updateProductCategorySchema,
  listProductCategorySchema,
  idProductCategorySchema
};
