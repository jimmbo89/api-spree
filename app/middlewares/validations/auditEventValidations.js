const Joi = require('joi');

const nullableId = Joi.alternatives()
  .try(Joi.number().integer().positive(), Joi.string().trim().max(100))
  .optional()
  .allow(null, '');

const auditEventListSchema = Joi.object({
  company_id: Joi.number().integer().positive().required(),
  module: Joi.string().trim().max(80).optional(),
  action: Joi.string().trim().max(120).optional(),
  result: Joi.string().trim().max(30).optional(),
  actor_type: Joi.string().trim().max(40).optional(),
  actor_id: nullableId,
  resource_type: Joi.string().trim().max(80).optional(),
  resource_id: nullableId,
  related_resource_type: Joi.string().trim().max(80).optional(),
  related_resource_id: nullableId,
  marketplace_id: Joi.number().integer().positive().optional().allow(null),
  marketplace_credential_id: Joi.number().integer().positive().optional().allow(null),
  pool_id: Joi.number().integer().positive().optional().allow(null),
  warehouse_id: Joi.number().integer().positive().optional().allow(null),
  branch_id: Joi.number().integer().positive().optional().allow(null),
  job_id: Joi.number().integer().positive().optional().allow(null),
  origin_job_id: Joi.number().integer().positive().optional().allow(null),
  correlation_id: Joi.string().trim().max(100).optional().allow(null, ''),
  cursor: Joi.alternatives()
    .try(Joi.number().integer().positive(), Joi.string().trim().pattern(/^\d+$/))
    .optional()
    .allow(null, ''),
  start: Joi.date().iso().optional(),
  end: Joi.date().iso().optional(),
  date_from: Joi.date().iso().optional(),
  date_to: Joi.date().iso().optional(),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(100)
});

module.exports = { auditEventListSchema };
