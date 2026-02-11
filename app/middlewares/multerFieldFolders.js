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
  'txt': ['text/plain'],
    'pfx': ['application/x-pkcs12', 'application/pkcs12'],
  'p12': ['application/x-pkcs12', 'application/pkcs12'],
  'xml': ['application/xml', 'text/xml']
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
const { UPLOAD_BASE_PATH } = require('../../config/upload'); // ← Ruta base configurable

const multerFieldFolders = (fieldConfig, maxFileSize = 2 * 1024 * 1024) => {
  if (!fieldConfig || Object.keys(fieldConfig).length === 0) {
    throw new Error('fieldConfig es requerido y no puede estar vacío');
  }

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
        return cb(new Error(`Campo no permitido1: ${file.fieldname}`));
      }

      // ✅ Usar UPLOAD_BASE_PATH en lugar de 'public'
      const folder = path.join(UPLOAD_BASE_PATH, config.folder);

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

  // ... resto del código (fileFilter, upload, etc.) permanece igual
  // Solo cambia el destino físico

  // (Mantén el resto exactamente como lo tienes)
  const fileFilter = function (req, file, cb) {
    const config = normalizedConfig[file.fieldname];
    if (!config) {
      return cb(new Error(`Campo no permitido2: ${file.fieldname}`));
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

  const upload = multer({
    storage,
    limits: { fileSize: maxFileSize },
    fileFilter
  }).any();

  return (req, res, next) => {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      req.files = {};
      return next();
    }

    upload(req, res, (err) => {
      if (err) {
        if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({
            error: `El archivo es demasiado grande. Máximo ${maxFileSize / (1024 * 1024)} MB.`
          });
        }
        return res.status(400).json({ error: err.message });
      }

      const rawFiles = Array.isArray(req.files) ? req.files : [];
      const organizedFiles = {};
      const fieldNames = Object.keys(normalizedConfig);

      for (const fieldName of fieldNames) {
        const config = normalizedConfig[fieldName];
        const files = rawFiles.filter(file => file.fieldname === fieldName);

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

      req.files = organizedFiles;
      next();
    });
  };
};

module.exports = multerFieldFolders;