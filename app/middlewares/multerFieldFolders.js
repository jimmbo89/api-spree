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
 * Middleware genérico para subir múltiples archivos a carpetas específicas
 * @param {Object} fieldMap - Ej: { logo: 'stores/logos', banner: 'stores/banners' }
 * @param {Number} maxFileSize - Tamaño máximo en bytes (opcional, default 2MB)
 */
const multerFieldFolders = (fieldMap, maxFileSize = 2 * 1024 * 1024) => {
  // Validar que fieldMap sea un objeto no vacío
  if (!fieldMap || Object.keys(fieldMap).length === 0) {
    throw new Error('fieldMap es requerido y no puede estar vacío');
  }

  const storage = multer.diskStorage({
    destination: async function (req, file, cb) {
      const subFolder = fieldMap[file.fieldname];
      if (!subFolder) {
        return cb(new Error(`Campo no permitido: ${file.fieldname}`));
      }

      const folder = `public/${subFolder}`;
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
      // Nombre único: timestamp + random + extensión
      const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1E9)}`;
      const ext = path.extname(file.originalname);
      cb(null, `${uniqueSuffix}${ext}`);
    }
  });

  const upload = multer({
    storage: storage,
    limits: { fileSize: maxFileSize },
    fileFilter: function (req, file, cb) {
      if (!fieldMap[file.fieldname]) {
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
    }
  }).fields(
    Object.keys(fieldMap).map(fieldName => ({
      name: fieldName,
      maxCount: 1
    }))
  );

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
      next();
    });
  };
};

module.exports = multerFieldFolders;