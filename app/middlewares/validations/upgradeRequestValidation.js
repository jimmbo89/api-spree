const Joi = require('joi');

const upgradeRequestBaseSchema = {
  company_id: Joi.number().integer().positive().required(),
  user_id: Joi.number().integer().positive().optional(),
  current_plan_id: Joi.number().integer().positive().required(),
  target_plan_id: Joi.number().integer().positive().required(),
  billing_cycle: Joi.string().valid('monthly', 'annual').default('monthly'),
  message: Joi.string().max(1000).optional().allow(null, ''),
  status: Joi.string().valid('open', 'approved', 'rejected').default('open')
};

const storeUpgradeRequestSchema = Joi.object({ ...upgradeRequestBaseSchema });

const updateUpgradeRequestSchema = Joi.object({
  id: Joi.number().integer().positive().required(),
  status: Joi.string().valid('approved', 'rejected').required()
});

const idUpgradeRequestSchema = Joi.object({
  id: Joi.number().integer().positive().required()
});

const listUpgradeRequestsSchema = Joi.object({
  company_id: Joi.number().integer().positive().optional(),
  status: Joi.string().valid('open', 'approved', 'rejected').optional(),
  page: Joi.number().integer().min(1).optional().default(1),
  limit: Joi.number().integer().min(1).max(100).optional().default(20)
});

module.exports = {
  storeUpgradeRequestSchema,
  updateUpgradeRequestSchema,
  idUpgradeRequestSchema,
  listUpgradeRequestsSchema
};