// app/validations/inventoryMovementValidation.js
const Joi = require('joi');

const getMovementsSchema = Joi.object({
  warehouse_id: Joi.number().integer().positive().optional(),
  product_id: Joi.number().integer().positive().optional(),
  variant_id: Joi.number().integer().positive().optional(),
  company_id: Joi.number().integer().positive().optional(),
  branch_id: Joi.number().integer().positive().optional(),
  reference_id: Joi.string().max(100).optional(),
  start_date: Joi.string().isoDate().optional().messages({
    'string.isoDate': 'start_date debe ser una fecha válida (YYYY-MM-DD)'
  }),
  end_date: Joi.string().isoDate().optional().messages({
    'string.isoDate': 'end_date debe ser una fecha válida (YYYY-MM-DD)'
  }),
  limit: Joi.number().integer().min(1).max(1000).optional().default(100),
  offset: Joi.number().integer().min(0).optional().default(0)
}).or('warehouse_id', 'product_id', 'variant_id', 'company_id', 'branch_id', 'reference_id')
  .messages({
    'object.missing': 'Debe proporcionar al menos un filtro: warehouse_id, product_id, variant_id, company_id, branch_id o reference_id'
  });

module.exports = {
  getMovementsSchema
};