// app/middlewares/multerFieldFolders.js
const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;
const logger = require('../../config/logger');

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
        logger.error(`[multerFieldFolders] Campo no permitido en destination: ${file.fieldname}`);
        return cb(new Error(`Campo no permitido1: ${file.fieldname}`));
      }

      // Usar UPLOAD_BASE_PATH en lugar de 'public'
      const folder = path.join(UPLOAD_BASE_PATH, config.folder);
      logger.info(`[multerFieldFolders] destination field=${file.fieldname} originalname=${file.originalname} mimetype=${file.mimetype} folder=${folder}`);

      try {
        await fs.access(folder);
        cb(null, folder);
      } catch (error) {
        try {
          await fs.mkdir(folder, { recursive: true });
          cb(null, folder);
        } catch (mkdirError) {
          logger.error(`[multerFieldFolders] Error creando directorio ${folder}: ${mkdirError.message}`);
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
      logger.error(`[multerFieldFolders] Campo no permitido en fileFilter: ${file.fieldname}`);
      return cb(new Error(`Campo no permitido2: ${file.fieldname}`));
    }

    const ext = path.extname(file.originalname).toLowerCase().slice(1);
    const allowedExts = Object.keys(mimeTypes);

    logger.info(`[multerFieldFolders] fileFilter field=${file.fieldname} originalname=${file.originalname} mimetype=${file.mimetype} ext=${ext}`);

    if (!allowedExts.includes(ext)) {
      logger.error(`[multerFieldFolders] Extension no permitida field=${file.fieldname} originalname=${file.originalname} ext=${ext}`);
      return cb(new Error(`Extensiones permitidas: ${allowedExts.join(', ')}`));
    }

    const allowedMimes = mimeTypes[ext];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      logger.error(`[multerFieldFolders] MIME invalido field=${file.fieldname} originalname=${file.originalname} ext=${ext} mimetype=${file.mimetype} permitidos=${allowedMimes.join(', ')}`);
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
    logger.info(`[multerFieldFolders] ${req.method} ${req.originalUrl} content-type=${contentType} expected-fields=${Object.keys(normalizedConfig).join(',')}`);

    if (!contentType.includes('multipart/form-data')) {
      logger.info('[multerFieldFolders] Request no multipart. Se omite procesamiento de archivos.');
      req.files = {};
      return next();
    }

    upload(req, res, (err) => {
      if (err) {
        logger.error(`[multerFieldFolders] Upload error code=${err.code || 'N/A'} message=${err.message}`);
        if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({
            error: `El archivo es demasiado grande. Máximo ${maxFileSize / (1024 * 1024)} MB.`
          });
        }
        return res.status(400).json({ error: err.message });
      }

      const rawFiles = Array.isArray(req.files) ? req.files : [];
      logger.info(`[multerFieldFolders] Upload ok. rawFiles=${JSON.stringify(rawFiles.map(file => ({
        fieldname: file.fieldname,
        originalname: file.originalname,
        mimetype: file.mimetype,
        size: file.size,
        filename: file.filename,
        destination: file.destination
      })))} req.body.keys=${Object.keys(req.body || {}).join(',')}`);

      const organizedFiles = {};
      const fieldNames = Object.keys(normalizedConfig);

      for (const fieldName of fieldNames) {
        const config = normalizedConfig[fieldName];
        const files = rawFiles.filter(file => file.fieldname === fieldName);

        if (files.length === 0) continue;

        if (!config.multiple && files.length > 1) {
          logger.error(`[multerFieldFolders] Campo ${fieldName} recibio multiples archivos cuando solo acepta uno. count=${files.length}`);
          return res.status(400).json({
            error: `El campo "${fieldName}" solo acepta un archivo.`
          });
        }

        if (config.multiple && files.length > config.maxCount) {
          logger.error(`[multerFieldFolders] Campo ${fieldName} excedio maxCount. count=${files.length} max=${config.maxCount}`);
          return res.status(400).json({
            error: `El campo "${fieldName}" acepta máximo ${config.maxCount} archivos.`
          });
        }

        organizedFiles[fieldName] = config.multiple ? files : files[0];
      }

      req.files = organizedFiles;
      logger.info(`[multerFieldFolders] organizedFiles=${JSON.stringify(Object.fromEntries(Object.entries(organizedFiles).map(([key, value]) => [key, Array.isArray(value) ? value.map(file => ({ originalname: file.originalname, mimetype: file.mimetype, size: file.size, filename: file.filename })) : { originalname: value.originalname, mimetype: value.mimetype, size: value.size, filename: value.filename }])))} `);
      next();
    });
  };
};

module.exports = multerFieldFolders;
