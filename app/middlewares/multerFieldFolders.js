// app/middlewares/multerFieldFolders.js
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;

const mimeTypes = {
  'jpg': ['image/jpeg'],
  'jpeg': ['image/jpeg'],
  'png': ['image/png'],
  'gif': ['image/gif'],
  'pdf': ['application/pdf'],
  'doc': ['application/msword'],
  'docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  'txt': ['text/plain']
};

/**
 * Middleware genérico para subir archivos (únicos o múltiples) a carpetas específicas.
 *
 * @param {Object} fieldConfig - Configuración por campo.
 *   Ej:
 *   {
 *     images: { folder: 'products/images', multiple: true, maxCount: 10 },
 *     logo: { folder: 'stores/logos', multiple: false }
 *   }
 *   o (retrocompatibilidad simplificada):
 *   {
 *     images: 'products/images'  → se asume multiple: false, maxCount: 1
 *   }
 * @param {Number} maxFileSize - Tamaño máximo por archivo en bytes (default: 2MB)
 */
const multerFieldFolders = (fieldConfig, maxFileSize = 2 * 1024 * 1024) => {
  if (!fieldConfig || Object.keys(fieldConfig).length === 0) {
    throw new Error('fieldConfig es requerido y no puede estar vacío');
  }

  // Normalizar fieldConfig para que todos los valores sean objetos
  const normalizedConfig = {};
  for (const [fieldName, value] of Object.entries(fieldConfig)) {
    if (typeof value === 'string') {
      normalizedConfig[fieldName] = {
        folder: value,
        multiple: false,
        maxCount: 1
      };
    } else if (typeof value === 'object' && value.folder) {
      normalizedConfig[fieldName] = {
        folder: value.folder,
        multiple: value.multiple ?? false,
        maxCount: value.maxCount ?? (value.multiple ? 10 : 1)
      };
    } else {
      throw new Error(`Configuración inválida para el campo: ${fieldName}`);
    }
  }

  const storage = multer.diskStorage({
    destination: async function (req, file, cb) {
      const config = normalizedConfig[file.fieldname];
      if (!config) {
        return cb(new Error(`Campo no permitido: ${file.fieldname}`));
      }

      const folder = `public/${config.folder}`;
      try {
        await fs.access(folder);
        cb(null, folder);
      } catch (error) {
        try {
          await fs.mkdir(folder, { recursive: true });
          cb(null, folder);
        } catch (mkdirError) {
          cb(new Error(`Error al crear directorio ${folder}: ${mkdirError.message}`));
        }
      }
    },
    filename: function (req, file, cb) {
      const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1E9)}`;
      const ext = path.extname(file.originalname);
      cb(null, `${uniqueSuffix}${ext}`);
    }
  });

  const fileFilter = function (req, file, cb) {
    const config = normalizedConfig[file.fieldname];
    if (!config) {
      return cb(new Error(`Campo no permitido: ${file.fieldname}`));
    }

    const ext = path.extname(file.originalname).toLowerCase().slice(1);
    const allowedExts = Object.keys(mimeTypes);

    if (!allowedExts.includes(ext)) {
      return cb(new Error(`Extensiones permitidas: ${allowedExts.join(', ')}`));
    }

    const allowedMimes = mimeTypes[ext];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Tipo MIME inválido para .${ext}. Permitidos: ${allowedMimes.join(', ')}`));
    }
  };

  // Configurar Multer: usar .any() + filtrar manualmente es más flexible
  const upload = multer({
    storage,
    limits: { fileSize: maxFileSize },
    fileFilter
  }).any(); // acepta cualquier campo, pero validamos con normalizedConfig

  return (req, res, next) => {
    upload(req, res, (err) => {
      if (err) {
        if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({
            error: `El archivo es demasiado grande. Máximo ${maxFileSize / (1024 * 1024)} MB.`
          });
        }
        return res.status(400).json({ error: err.message });
      }

      // Organizar req.files por campo (como lo haría .fields() o .array())
      const organizedFiles = {};
      const fieldNames = Object.keys(normalizedConfig);

      for (const fieldName of fieldNames) {
        const config = normalizedConfig[fieldName];
        const files = req.files.filter(file => file.fieldname === fieldName);

        if (files.length === 0) continue;

        if (!config.multiple && files.length > 1) {
          return res.status(400).json({
            error: `El campo "${fieldName}" solo acepta un archivo.`
          });
        }

        if (config.multiple && files.length > config.maxCount) {
          return res.status(400).json({
            error: `El campo "${fieldName}" acepta máximo ${config.maxCount} archivos.`
          });
        }

        organizedFiles[fieldName] = config.multiple ? files : files[0];
      }

      // Reemplazar req.files con el objeto organizado
      req.files = organizedFiles;

      next();
    });
  };
};

module.exports = multerFieldFolders;