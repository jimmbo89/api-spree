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
  proof_file: Joi.any()
  .custom((value, helpers) => {
    if (value) {
      // Configuración de tipos de archivo permitidos
      const fileConfig = {
        image: {
          mimetypes: ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'],
          extensions: ['.jpg', '.jpeg', '.png', '.gif', '.webp']
        },
        pdf: {
          mimetypes: ['application/pdf'],
          extensions: ['.pdf']
        },
        document: {
          mimetypes: [
            'application/pdf',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.ms-excel',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          ],
          extensions: ['.pdf', '.doc', '.docx', '.xls', '.xlsx']
        }
      };

      // Combinar todos los MIME types permitidos
      const allValidMimeTypes = [
        ...fileConfig.image.mimetypes,
        ...fileConfig.pdf.mimetypes,
        ...fileConfig.document.mimetypes
      ];

      // Validar tipo de archivo
      const fileMimeType = value.mimetype || value.type;
      if (!allValidMimeTypes.includes(fileMimeType)) {
        return helpers.message('El archivo debe ser una imagen (jpg, jpeg, png, gif), PDF o documento (doc, xls)');
      }

      // Validar tamaño (500 KB como en el original)
      const maxSize = 500 * 1024; // 500 KB
      if (value.size > maxSize) {
        return helpers.message('El archivo debe pesar máximo 500 KB');
      }
    }
    return value;
  })
  .optional(),
  invoice_request: Joi.object().optional(),
  effective_date: Joi.date().iso().optional()
};

const storeBillingOrderSchema = Joi.object({ ...billingOrderBaseSchema });

const updateBillingOrderSchema = Joi.object({
  id: Joi.number().integer().positive().required(),
  status: Joi.string().valid('paid', 'rejected', 'canceled').optional(),
  paid_at: Joi.date().iso().optional(),
  proof_file: Joi.any()
    .custom((value, helpers) => {
      if (value) {
        // Configuración de tipos de archivo permitidos
        const fileConfig = {
          image: {
            mimetypes: ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'],
            extensions: ['.jpg', '.jpeg', '.png', '.gif', '.webp']
          },
          pdf: {
            mimetypes: ['application/pdf'],
            extensions: ['.pdf']
          },
          document: {
            mimetypes: [
              'application/pdf',
              'application/msword',
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              'application/vnd.ms-excel',
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            ],
            extensions: ['.pdf', '.doc', '.docx', '.xls', '.xlsx']
          }
        };

      // Combinar todos los MIME types permitidos
      const allValidMimeTypes = [
        ...fileConfig.image.mimetypes,
        ...fileConfig.pdf.mimetypes,
        ...fileConfig.document.mimetypes
      ];

      // Validar tipo de archivo
      const fileMimeType = value.mimetype || value.type;
      if (!allValidMimeTypes.includes(fileMimeType)) {
        return helpers.message('El archivo debe ser una imagen (jpg, jpeg, png, gif), PDF o documento (doc, xls)');
      }

      // Validar tamaño (500 KB como en el original)
      const maxSize = 500 * 1024; // 500 KB
      if (value.size > maxSize) {
        return helpers.message('El archivo debe pesar máximo 500 KB');
      }
    }
    return value;
  })
  .optional()
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