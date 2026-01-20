// app/validations/userCompanySchemas.js
const Joi = require('joi');

const VALID_STATUSES = [-1, 0, 1]; // -1: pending, 0: inactive, 1: active

const createUserCompanySchema = Joi.object({
  user_id: Joi.number().integer().positive().required(),
  company_id: Joi.number().integer().positive().required(),
  role_id: Joi.number().integer().positive().required(),
  status: Joi.number().integer().valid(...VALID_STATUSES).optional().default(-1),
  invited_by: Joi.number().integer().positive().optional().allow(null),
  invitation_token: Joi.string().max(255).optional().allow(null, ''),
  expires_at: Joi.date().optional().allow(null)
});

const updateUserCompanyStatusSchema = Joi.object({
  id: Joi.number().integer().positive().required(),
  status: Joi.number().integer().valid(...VALID_STATUSES).required()
});

const updateUserCompanyRoleSchema = Joi.object({
  id: Joi.number().integer().positive().required(),
  role_id: Joi.number().integer().positive().required(),
});

const userCompanyIdSchema = Joi.object({
  id: Joi.number().integer().positive().required()
});

const userCompanyByUserAndCompanySchema = Joi.object({
  user_id: Joi.number().integer().positive().required(),
  company_id: Joi.number().integer().positive().required()
});

const userCompanyByTokenSchema = Joi.object({
  invitation_token: Joi.string().max(255).required()
});

const listUserCompanySchema = Joi.object({
  user_id: Joi.number().integer().positive().optional(),
  company_id: Joi.number().integer().positive().optional()
}).custom((value, helpers) => {
  if (!value.user_id && !value.company_id) {
    return helpers.message('Debe proporcionar al menos user_id o company_id');
  }
  return value;
});

const createMembershipRequestSchema = Joi.object({
  user_id: Joi.number().integer().positive().required(),
  company_id: Joi.number().integer().positive().required() // 👈 Ahora es un solo ID
});

module.exports = {
  createUserCompanySchema,
  updateUserCompanyStatusSchema,
  userCompanyIdSchema,
  userCompanyByUserAndCompanySchema,
  userCompanyByTokenSchema,
  listUserCompanySchema,
  updateUserCompanyRoleSchema,
  createMembershipRequestSchema
};