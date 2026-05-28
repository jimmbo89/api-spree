const Joi = require('joi');

const noteSchema = Joi.object({
  note_id: Joi.string().optional().allow(null, ''),
  text: Joi.string().min(1).required(),
  created_at: Joi.date().iso().optional().allow(null),
  created_by_user_id: Joi.number().integer().positive().optional().allow(null),
  created_by_user_name: Joi.string().max(255).optional().allow(null, ''),
  raw_payload: Joi.object().optional().allow(null)
});

const refreshOrderSchema = Joi.object({
  id: Joi.number().integer().positive().required()
});

const updateOrderNotesSchema = Joi.object({
  id: Joi.number().integer().positive().required(),
  notes: Joi.array().items(
    Joi.alternatives().try(
      Joi.string().min(1),
      noteSchema
    )
  ).required()
});

const sendOrderMessageSchema = Joi.object({
  id: Joi.number().integer().positive().required(),
  text: Joi.string().trim().min(1).max(350).required()
});

module.exports = {
  refreshOrderSchema,
  updateOrderNotesSchema,
  sendOrderMessageSchema
};
