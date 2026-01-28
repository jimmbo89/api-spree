const Joi = require('joi');

const notificationBaseSchema = {
  title: Joi.string().max(255).required(),
  description: Joi.string().max(1000).optional().allow(null, ''),
  data: Joi.object().optional().default({}),
  status: Joi.number().integer().valid(0, 1, 2).optional().default(0),
  type: Joi.string().max(50).optional().allow(null, ''),
  firebaseId: Joi.string().max(255).optional().allow(null, ''),
  user_id: Joi.number().integer().positive().required(),
  company_id: Joi.number().integer().positive().required()
};

// ✅ Crear notificación
const storeNotificationSchema = Joi.object({
  ...notificationBaseSchema
});

// ✅ Actualizar notificación
const updateNotificationSchema = Joi.object({
  id: Joi.number().integer().positive().required(),
  title: Joi.string().max(255).optional(),
  description: Joi.string().max(1000).optional().allow(null, ''),
  type: Joi.string().max(50).optional().allow(null, ''),
  data: Joi.object().optional(),
  status: Joi.number().integer().valid(0, 1, 2).optional(),
  firebaseId: Joi.string().max(255).optional().allow(null, '')
});

// ✅ Por ID
const idNotificationSchema = Joi.object({
  id: Joi.number().integer().positive().required()
});

// ✅ Listar notificaciones
const listNotificationsSchema = Joi.object({
  user_id: Joi.number().integer().positive().optional(),
  company_id: Joi.number().integer().positive().optional(),
  status: Joi.number().integer().valid(0, 1, 2).optional(),
  search: Joi.string().max(100).optional().allow(''),
  page: Joi.number().integer().min(1).optional().default(1),
  limit: Joi.number().integer().min(1).max(100).optional().default(20)
});

const markAsReadSchema = Joi.object({
  ids: Joi.array().items(Joi.number().integer().positive()).min(1).required(),
  company_id: Joi.number().integer().positive().optional(),
  status: Joi.number().integer().required()
});

module.exports = {
  storeNotificationSchema,
  updateNotificationSchema,
  idNotificationSchema,
  listNotificationsSchema,
  markAsReadSchema
};