const logger = require("../../config/logger");
const Joi = require('joi'); // Asegúrate de usar Joi para validaciones

const validateSchema = (schema) => {
  return (req, res, next) => {
    // Normalización de valores en req.body
    const normalizeValue = (value) => {
      if (value === "" || value === 0 || value === null) {
        return null;
      }
      return value;
    };

    const normalizeObject = (obj) => {
      for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
          if (typeof obj[key] === "object" && obj[key] !== null) {
            normalizeObject(obj[key]); // Llamada recursiva para objetos anidados
          } else {
            obj[key] = normalizeValue(obj[key]); // Normaliza valores primitivos
          }
        }
      }
    };

    // Si Multer procesó la imagen, ahora los datos deben estar en req.body
    if (req.file) {
      logger.info("Archivo recibido:", req.file); // Aquí puedes ver los detalles del archivo
    }

    // Normaliza req.body antes de la validación
    if (req.body) {
      normalizeObject(req.body);
    }

    // Valida los datos normalizados con Joi
    const { error } = schema.validate(req.body, { abortEarly: false });

    if (error) {
      logger.error(
        `Validation error in ${req.method} ${req.originalUrl} - Body: ${JSON.stringify(req.body)} - Errors: ${error.details
          .map((err) => err.message)
          .join(", ")}`
      );

      return res.status(400).json({
        msg: "Error de validación",
        details: error.details.map((err) => err.message),
      });
    }

    // Continua al siguiente middleware o controlador si no hay errores
    next();
  };
};

module.exports = validateSchema;
