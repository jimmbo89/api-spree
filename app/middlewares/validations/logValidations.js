// app/validations/logValidation.js
const Joi = require('joi');

const getLogsQuerySchema = Joi.object({
  start_date: Joi.string()
    .pattern(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .messages({
      'string.pattern.base': 'El campo "startDate" debe tener el formato YYYY-MM-DD'
    }),

  end_date: Joi.string()
    .pattern(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .messages({
      'string.pattern.base': 'El campo "endDate" debe tener el formato YYYY-MM-DD'
    }),

  user_id: Joi.number()
    .integer()
    .positive()
    .optional()
    .messages({
      'number.base': 'El campo "user_id" debe ser un número entero',
      'number.integer': 'El campo "user_id" debe ser un número entero',
      'number.positive': 'El campo "user_id" debe ser un número positivo'
    })
})
.options({ stripUnknown: true }); // Elimina campos no definidos en el esquema

module.exports = {
  getLogsQuerySchema
};