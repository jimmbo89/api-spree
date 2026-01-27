const Joi = require('joi');

const subscriptionBaseSchema = {
  company_id: Joi.number().integer().positive().required(),
  plan_id: Joi.number().integer().positive().required(),
  status: Joi.string().valid('active', 'past_due', 'expired', 'canceled').default('active'),
  start_date: Joi.date().iso().required(),
  end_date: Joi.date().iso().optional().allow(null),
  renewal_date: Joi.date().iso().required(),
  billing_cycle: Joi.string().valid('monthly', 'annual').default('monthly')
};

const storeSubscriptionSchema = Joi.object({ ...subscriptionBaseSchema });

const updateSubscriptionSchema = Joi.object({
  id: Joi.number().integer().positive().required(),
  ...Object.fromEntries(
    Object.entries(subscriptionBaseSchema).map(([key, schema]) => [key, schema.optional()])
  )
});

const idSubscriptionSchema = Joi.object({
  id: Joi.number().integer().positive().required()
});

const listSubscriptionsSchema = Joi.object({
  company_id: Joi.number().integer().positive().optional(),
  plan_id: Joi.number().integer().positive().optional(),
  status: Joi.string().valid('active', 'past_due', 'expired', 'canceled').optional(),
  page: Joi.number().integer().min(1).optional().default(1),
  limit: Joi.number().integer().min(1).max(100).optional().default(20)
});

module.exports = {
  storeSubscriptionSchema,
  updateSubscriptionSchema,
  idSubscriptionSchema,
  listSubscriptionsSchema
};