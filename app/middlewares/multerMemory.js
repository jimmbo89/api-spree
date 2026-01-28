const multer = require('multer');
const path = require('path');

const multerMemory = (fieldConfig, options = {}) => {
  const {
    maxSize = 5, // MB
    allowedTypes = ['image', 'pdf', 'document'] // 'image', 'pdf', 'document'
  } = options;

  if (!fieldConfig || Object.keys(fieldConfig).length === 0) {
    throw new Error('fieldConfig es requerido');
  }

  // Configuración de tipos de archivo permitidos
  const fileConfig = {
    image: {
      extensions: ['.jpg', '.jpeg', '.png', '.gif', '.webp'],
      mimetypes: [
        'image/jpeg',
        'image/jpg',
        'image/png',
        'image/gif',
        'image/webp'
      ]
    },
    pdf: {
      extensions: ['.pdf'],
      mimetypes: ['application/pdf']
    },
    document: {
      extensions: ['.pdf', '.doc', '.docx', '.xls', '.xlsx'],
      mimetypes: [
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      ]
    }
  };

  // Obtener extensiones y MIME types permitidos según configuración
  const allowedExtensions = [];
  const allowedMimetypes = [];

  allowedTypes.forEach(type => {
    if (fileConfig[type]) {
      allowedExtensions.push(...fileConfig[type].extensions);
      allowedMimetypes.push(...fileConfig[type].mimetypes);
    }
  });

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

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxSize * 1024 * 1024 }, // Convertir MB a bytes
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
          return res.status(400).json({ error: `El archivo es demasiado grande. Máximo ${maxSize} MB.` });
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
          return res.status(400).json({ error: `El campo "${fieldName}" solo acepta un archivo.` });
        }
        if (config.multiple && files.length > config.maxCount) {
          return res.status(400).json({ error: `El campo "${fieldName}" acepta máximo ${config.maxCount} archivos.` });
        }

        organizedFiles[fieldName] = config.multiple ? files : files[0];
      }

      req.files = organizedFiles;
      next();
    });
  };
};

module.exports = multerMemory;