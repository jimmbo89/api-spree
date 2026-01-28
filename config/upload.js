// config/upload.js
const path = require('path');

// Puedes usar una variable de entorno para mayor flexibilidad
const UPLOAD_BASE_PATH = process.env.UPLOAD_BASE_PATH || path.resolve(__dirname, '..', 'public');

module.exports = {
  UPLOAD_BASE_PATH
};