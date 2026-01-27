const Joi = require('joi');

const billingOrderBaseSchema = {
  company_id: Joi.number().integer().positive().required(),
  current_plan_id: Joi.number().integer().positive().required(),
  target_plan_id: Joi.number().integer().positive().required(),
  billing_cycle: Joi.string().valid('monthly', 'annual').required(),
  type: Joi.string().valid('upgrade', 'downgrade', 'renewal', 'reactivation', 'past_due_payment').required(),
  total_amount: Joi.number().precision(2).positive().required(),
  currency: Joi.string().default('USD'),
  payment_method: Joi.string().valid('payment_link', 'transfer_proof', 'invoice_sii').required(),
  payment_link_url: Joi.string().uri().optional().when('payment_method', { is: 'payment_link', then: Joi.required() }),
  proof_url: Joi.string().uri().optional(),
  invoice_request: Joi.object().optional(),
  effective_date: Joi.date().iso().optional()
};

const storeBillingOrderSchema = Joi.object({ ...billingOrderBaseSchema });

const updateBillingOrderSchema = Joi.object({
  id: Joi.number().integer().positive().required(),
  status: Joi.string().valid('paid', 'rejected', 'canceled').optional(),
  paid_at: Joi.date().iso().optional(),
  proof_url: Joi.string().uri().optional()
});

const idBillingOrderSchema = Joi.object({
  id: Joi.number().integer().positive().required()
});

const listBillingOrdersSchema = Joi.object({
  company_id: Joi.number().integer().positive().optional(),
  status: Joi.string().valid('pending_payment', 'paid', 'rejected', 'canceled').optional(),
  type: Joi.string().valid('upgrade', 'downgrade', 'renewal', 'reactivation', 'past_due_payment').optional(),
  page: Joi.number().integer().min(1).optional().default(1),
  limit: Joi.number().integer().min(1).max(100).optional().default(20)
});

module.exports = {
  storeBillingOrderSchema,
  updateBillingOrderSchema,
  idBillingOrderSchema,
  listBillingOrdersSchema
};