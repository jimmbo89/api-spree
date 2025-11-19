const Joi = require('joi');

const storeWarehouseProductSchema = Joi.object({
  // product_id es opcional si se envían datos de producto
  product_id: Joi.number().integer().positive().optional(),

  // Datos de producto (requeridos si no hay product_id)
  sku: Joi.when('product_id', {
    is: Joi.exist(),
    then: Joi.string().max(100).optional(),
    otherwise: Joi.string().max(100).required()
  }),
  name: Joi.when('product_id', {
    is: Joi.exist(),
    then: Joi.string().max(255).optional(),
    otherwise: Joi.string().max(255).required()
  }),
  description: Joi.string().allow(null, '').optional(),
  status: Joi.number().integer().min(0).max(3).optional(),
  category_id: Joi.number().integer().positive().optional().allow(null),
  base_price: Joi.number().precision(2).positive().optional().allow(null),
  branch_id: Joi.number().integer().positive().optional().allow(null),

  // WarehouseProduct fields
  warehouse_id: Joi.number().integer().positive().required(),
  stock: Joi.number().integer().min(0).optional(),
  price: Joi.number().precision(2).positive().optional().allow(null),
  published: Joi.boolean().optional(),
  company_id: Joi.number().integer().positive().optional(),
  user_id: Joi.number().integer().positive().optional().allow(null),
  image: Joi.any()
    .custom((value, helpers) => {
      if (value) {
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
    .optional()
})
// Validación personalizada: si no hay product_id, deben existir sku y name
.custom((value, helpers) => {
  if (!value.product_id && (!value.sku || !value.name)) {
    return helpers.message('Si no se proporciona product_id, se requieren sku y name');
  }
  return value;
});


const updateWarehouseProductSchema = Joi.object({
  id: Joi.number().required(),
  product_id: Joi.number().integer().positive().optional(),
  warehouse_id: Joi.number().integer().positive().optional(),
  stock: Joi.number().integer().min(0).optional(),
  price: Joi.number().precision(2).positive().optional().allow(null),
  published: Joi.boolean().optional(),
  company_id: Joi.number().integer().positive().optional().allow(null),
  branch_id: Joi.number().integer().positive().optional().allow(null),
  user_id: Joi.number().integer().positive().optional().allow(null),
  image: Joi.any()
    .custom((value, helpers) => {
      if (value) {
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
    .optional()
});

const idWarehouseProductSchema = Joi.object({
  id: Joi.number().required()
});

const listWarehouseProductSchema = Joi.object({
  company_id: Joi.number().integer().positive().required(),
  user_id: Joi.number().allow(null).empty('').optional(),
  branch_id: Joi.number().allow(null).empty('').optional(),
  warehouse_id: Joi.number().allow(null).empty('').optional()
});

const transferSchema = Joi.object({
  product_id: Joi.number().integer().positive().required(),
  from_warehouse_id: Joi.number().integer().positive().required(),
  to_warehouse_id: Joi.number().integer().positive().required(),
  quantity: Joi.number().integer().min(1).required()
});

const bulkUploadSchema = Joi.object({
  warehouse_id: Joi.number().integer().positive().required(),
  file: Joi.any()
    .meta({ swaggerType: 'file' })
    .custom((value, helpers) => {
      if (!value) {
        return helpers.message('Archivo es obligatorio');
      }
      const validMimeTypes = [
        'text/csv',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      ];
      if (!validMimeTypes.includes(value.mimetype)) {
        return helpers.message('Formato no soportado. Use CSV o XLSX.');
      }
      const maxSize = 5 * 1024 * 1024; // 5 MB
      if (value.size > maxSize) {
        return helpers.message('El archivo debe pesar máximo 5 MB');
      }
      return value;
    })
    .required()
});

module.exports = {
  storeWarehouseProductSchema,
  updateWarehouseProductSchema,
  idWarehouseProductSchema,
  listWarehouseProductSchema,
  transferSchema,
  bulkUploadSchema
};