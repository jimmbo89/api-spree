const Joi = require('joi');

// Esquema base con campos comunes
const baseCafSchema = {
  certificate_id: Joi.number().integer().positive().required().messages({
    'any.required': 'El ID del certificado es obligatorio',
    'number.base': 'El ID del certificado debe ser un número',
    'number.positive': 'El ID del certificado debe ser positivo'
  }),
  document_type: Joi.string().max(3).required().messages({
    'any.required': 'El tipo de documento es obligatorio',
    'string.max': 'El tipo de documento no puede exceder 3 caracteres'
  }),
  folio_start: Joi.number().integer().min(1).required().messages({
    'any.required': 'El folio inicial es obligatorio',
    'number.base': 'El folio inicial debe ser un número',
    'number.min': 'El folio inicial debe ser mayor o igual a 1'
  }),
  folio_end: Joi.number().integer().min(Joi.ref('folio_start')).required().messages({
    'any.required': 'El folio final es obligatorio',
    'number.base': 'El folio final debe ser un número',
    'number.min': 'El folio final debe ser mayor o igual al folio inicial'
  }),
  expiration_date: Joi.date().iso().optional().messages({
    'date.isoDate': 'La fecha de vencimiento debe estar en formato ISO (YYYY-MM-DD)'
  }),
  private_key: Joi.string().optional().allow('').messages({
    'string.base': 'La clave privada debe ser texto'
  })
};

// Para crear (no necesita ID)
const createCafSchema = Joi.object({
  ...baseCafSchema
}).messages({
  'object.unknown': 'Campo no permitido en la creación de CAF'
});

// Para actualizar (requiere ID)
const updateCafSchema = Joi.object({
  id: Joi.number().integer().positive().required().messages({
    'any.required': 'El ID del CAF es obligatorio para actualizar',
    'number.base': 'El ID del CAF debe ser un número',
    'number.positive': 'El ID del CAF debe ser positivo'
  }),
  ...baseCafSchema
}).messages({
  'object.unknown': 'Campo no permitido en la actualización de CAF'
});

// Solo para listar (mínimo requerido)
const listCafsSchema = Joi.object({
  certificate_id: Joi.number().integer().positive().required().messages({
    'any.required': 'Se requiere el ID del certificado para listar CAFs',
    'number.base': 'El ID del certificado debe ser un número',
    'number.positive': 'El ID del certificado debe ser positivo'
  })
});

module.exports = {
  createCafSchema,
  updateCafSchema,
  listCafsSchema
};