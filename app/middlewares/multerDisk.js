// middlewares/multerDisk.js
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const { UPLOAD_BASE_PATH } = require('../../config/upload'); // Ajusta la ruta según tu estructura
const { FILE_CONFIG } = require('../util/fileUtils');

const multerDisk = (fieldConfig, options = {}) => {
  const {
    maxSize = 5, // MB
    allowedTypes = ['image', 'pdf', 'document']
  } = options;

  if (!fieldConfig || Object.keys(fieldConfig).length === 0) {
    throw new Error('fieldConfig es requerido');
  }

 const allowedExtensions = [];
  const allowedMimetypes = [];

allowedTypes.forEach(type => {
  if (FILE_CONFIG[type]) {
    allowedExtensions.push(...FILE_CONFIG[type].extensions);
    allowedMimetypes.push(...FILE_CONFIG[type].mimetypes);
  }
});

  // Normalizar configuración de campos
  const normalizedConfig = {};
  for (const [fieldName, value] of Object.entries(fieldConfig)) {
    if (typeof value === 'string') {
      normalizedConfig[fieldName] = { folder: value, multiple: false, maxCount: 1 };
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

  // 🗂️ Crear directorio temporal único por request (opcional pero recomendado)
  const tempDir = path.join(UPLOAD_BASE_PATH, 'tmp');

  // Configurar diskStorage
  const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
      try {
        // Carpeta base temporal
        await fs.mkdir(tempDir, { recursive: true });
        cb(null, tempDir);
      } catch (err) {
        cb(err);
      }
    },
    filename: (req, file, cb) => {
      // Nombre único: timestamp + originalname limpio
      const cleanName = file.originalname
        .toLowerCase()
        .replace(/[^a-z0-9._-]/g, '_');
      cb(null, `${Date.now()}_${cleanName}`);
    }
  });

  const upload = multer({
    storage,
    limits: { fileSize: maxSize * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const hasValidExtension = allowedExtensions.includes(ext);
      const hasValidMimetype = allowedMimetypes.includes(file.mimetype);

      if (hasValidExtension && hasValidMimetype) {
        cb(null, true);
      } else {
        const descriptions = allowedTypes.map(type => {
          if (type === 'image') return 'imágenes (JPG, PNG, GIF, WEBP)';
          if (type === 'pdf') return 'archivos PDF';
          if (type === 'document') return 'documentos (PDF, DOC, XLS)';
          return type;
        }).join(' o ');
        cb(new Error(`Solo se permiten ${descriptions}`));
      }
    }
  }).any(); // permite cualquier campo

  return (req, res, next) => {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      req.files = {};
      return next();
    }

    upload(req, res, async (err) => {
      if (err) {
        // Limpiar archivos temporales si hay error
        if (req.files?.length) {
          await cleanupTempFiles(req.files);
        }

        if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: `El archivo es demasiado grande. Máximo ${maxSize} MB.` });
        }
        return res.status(400).json({ error: err.message });
      }

      // Organizar archivos por campo
      const rawFiles = Array.isArray(req.files) ? req.files : [];
      const organizedFiles = {};
      const fieldNames = Object.keys(normalizedConfig);

      for (const fieldName of fieldNames) {
        const config = normalizedConfig[fieldName];
        const files = rawFiles.filter(file => file.fieldname === fieldName);
        if (files.length === 0) continue;

        if (!config.multiple && files.length > 1) {
          await cleanupTempFiles(files);
          return res.status(400).json({ error: `El campo "${fieldName}" solo acepta un archivo.` });
        }
        if (config.multiple && files.length > config.maxCount) {
          await cleanupTempFiles(files);
          return res.status(400).json({ error: `El campo "${fieldName}" acepta máximo ${config.maxCount} archivos.` });
        }

        organizedFiles[fieldName] = config.multiple ? files : files[0];
      }

      req.files = organizedFiles;
      next();
    });
  };
};

// 🔥 Función auxiliar: eliminar archivos temporales
async function cleanupTempFiles(files) {
  const fileList = Array.isArray(files) ? files : [files];
  for (const file of fileList) {
    if (file.path && typeof file.path === 'string') {
      try {
        await fs.unlink(file.path);
      } catch (e) {
        // Silencioso: no bloquear por error de limpieza
      }
    }
  }
}

module.exports = multerDisk;