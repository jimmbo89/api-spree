const Joi = require('joi');

const imageFieldSchema = Joi.alternatives().try(
  Joi.string().max(255).allow(null, ''),
  Joi.any().custom((value, helpers) => {
    if (value && typeof value === 'object') {
      const validMimeTypes = ['image/jpg', 'image/jpeg', 'image/png', 'image/gif'];
      if (!validMimeTypes.includes(value.mimetype || value.type)) {
        return helpers.message('El archivo debe ser una imagen válida (jpg, jpeg, png, gif)');
      }
      const maxSize = 500 * 1024;
      if (value.size > maxSize) {
        return helpers.message('El archivo debe pesar máximo 500 KB');
      }
    }
    return value;
  })
);

const storeBranchSchema = Joi.object({
  name: Joi.string().max(255).required(),
  address: Joi.string().max(255).allow(null, '').optional(),
  city: Joi.string().max(100).allow(null, '').optional(),
  phone: Joi.string().max(20).allow(null, '').optional(),
  status: Joi.number().integer().optional(),
  company_id: Joi.number().integer().positive().optional().allow(null),
  user_id: Joi.number().integer().positive().optional().allow(null),
  warehouse: Joi.string()
      .custom((value, helpers) => {
        try {
          const parsed = JSON.parse(value);
          // Validación básica del objeto warehouse
          if (typeof parsed !== 'object' || parsed === null) {
            return helpers.message('warehouse debe ser un objeto JSON válido');
          }
          return value;
        } catch (error) {
          return helpers.message('warehouse debe ser un JSON válido');
        }
      })
      .optional(),
  image: imageFieldSchema.optional()
});

const updateBranchSchema = Joi.object({
  id: Joi.number().required(),
  name: Joi.string().max(255).allow(null, '').optional(),
  address: Joi.string().max(255).allow(null, '').optional(),
  city: Joi.string().max(100).allow(null, '').optional(),
  phone: Joi.string().max(20).allow(null, '').optional(),
  status: Joi.number().integer().valid(0, 1).optional(),
  company_id: Joi.number().integer().positive().optional().allow(null),
  user_id: Joi.number().integer().positive().optional().allow(null),
  image: imageFieldSchema.optional()
});

const idBranchSchema = Joi.object({
  id: Joi.number().required(),
});

const listBranchesSchema = Joi.object({
  company_id: Joi.number().allow(null).empty('').optional(),
  branch_id: Joi.number().allow(null).empty('').optional(),
  user_id: Joi.number().allow(null).empty('').optional(),
});

module.exports = {
  storeBranchSchema,
  updateBranchSchema,
  idBranchSchema,
  listBranchesSchema
};
