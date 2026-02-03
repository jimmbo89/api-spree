// schemas/tenantLogSchema.js
const Joi = require('joi');

// Schema para crear logs (usado internamente por el sistema)
const createLogSchema = Joi.object({
  company_id: Joi.number().integer().positive().required(),
  user_id: Joi.number().integer().positive().optional().allow(null),
  module: Joi.string()
    .valid('sii', 'configuracion', 'documentos', 'notificaciones')
    .required(),
  event_type: Joi.string()
    .valid('create', 'update', 'delete', 'error', 'success')
    .required(),
  action: Joi.string().max(255).required(),
  description: Joi.string().max(1000).optional().allow(null, ''),
  meta: Joi.object().optional().allow(null),  // ✅ Corregido: meta (no metadata)
  ip_address: Joi.string()
    .ip({ version: ['ipv4', 'ipv6'] })
    .optional()
    .allow(null, ''),
  user_agent: Joi.string().max(500).optional().allow(null, ''),
  result: Joi.string()
    .valid('success', 'error', 'warning')
    .required(),
  error_message: Joi.string().max(1000).optional().allow(null, '')
})
  .required()
  .messages({
    'object.base': 'El cuerpo de la solicitud es requerido',
    'any.required': '{#label} es requerido',
    'string.empty': '{#label} no puede estar vacío'
  });

// Schema para consultar logs (API pública)
const getLogsSchema = Joi.object({
  company_id: Joi.number().integer().positive().required(),
  module: Joi.string()
    .valid('sii', 'configuracion', 'documentos', 'notificaciones')
    .optional(),
  event_type: Joi.string()
    .valid('create', 'update', 'delete', 'error', 'success')
    .optional(),
  result: Joi.string()
    .valid('success', 'error', 'warning')
    .optional(),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(10),
  date_from: Joi.date().iso().optional(),
  date_to: Joi.date().iso().optional()
})
  .required()
  .messages({
    'object.base': 'Parámetros de consulta requeridos',
    'any.required': '{#label} es requerido en los parámetros'
  });

module.exports = { createLogSchema, getLogsSchema };