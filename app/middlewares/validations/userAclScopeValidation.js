const Joi = require('joi');

const createUserAclScopeSchema = Joi.object({
  user_id: Joi.number().integer().positive().required(),
  company_id: Joi.number().integer().positive().required(),
  warehouse_id: Joi.number().integer().positive().optional().allow(null),
  pool_id: Joi.number().integer().positive().optional().allow(null)
}).custom((value, helpers) => {
  const { warehouse_id, pool_id } = value;
  if (warehouse_id === undefined && pool_id === undefined) {
    return helpers.message('Debe proporcionar warehouse_id o pool_id');
  }
  if (warehouse_id !== undefined && pool_id !== undefined) {
    return helpers.message('Solo puede asignar warehouse_id o pool_id, no ambos');
  }
  return value;
});

const userAclScopeIdSchema = Joi.object({
  id: Joi.number().integer().positive().required()
});

const userAclScopesByUserAndCompanySchema = Joi.object({
  user_id: Joi.number().integer().positive().required(),
  company_id: Joi.number().integer().positive().required()
});

module.exports = {
  createUserAclScopeSchema,
  userAclScopeIdSchema,
  userAclScopesByUserAndCompanySchema
};