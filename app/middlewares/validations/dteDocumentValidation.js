// schemas/dteDocumentSchema.js
const Joi = require('joi');

const createDteSchema = Joi.object({
  company_id: Joi.number().integer().positive().required(),
  document_type: Joi.string().valid('33', '39', '61').required(),
  rut_receptor: Joi.string().pattern(/^\d{7,8}-[\dkK]$/).required(),
  razon_social_receptor: Joi.string().max(255).required(),
  giro_receptor: Joi.string().max(255).optional(),
  direccion_receptor: Joi.string().max(255).optional(),
  comuna_receptor: Joi.string().max(100).optional(),
  ciudad_receptor: Joi.string().max(100).optional(),
  monto_neto: Joi.number().precision(2).positive().required(),
  monto_iva: Joi.number().precision(2).positive().required(),
  monto_total: Joi.number().precision(2).positive().required(),
  fecha_emision: Joi.date().iso().required(),
  detalles: Joi.array().items(
    Joi.object({
      nombre: Joi.string().required(),
      cantidad: Joi.number().positive().required(),
      precio_unitario: Joi.number().precision(2).positive().required(),
      monto_item: Joi.number().precision(2).positive().required()
    })
  ).min(1).required(),
  referenced_document_id: Joi.number().integer().positive().optional(),
  order_id: Joi.number().integer().positive().optional(),
  order_type: Joi.string().valid('marketplace', 'spree', 'manual').optional()
});

const checkStatusSchema = Joi.object({
  company_id: Joi.number().integer().positive().required(),
  document_id: Joi.number().integer().positive().required()
});

module.exports = { createDteSchema, checkStatusSchema };