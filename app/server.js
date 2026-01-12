require('dotenv').config({ quiet: true });

const express = require("express");
const app = express();
//const session = require('express-session');
const { sequelize } = require('./models/index');
const cors = require('cors');
const logger = require('../config/logger');

// // Sesión
// app.use(session({
//   secret: process.env.SESSION_SECRET || 'mateomi-fallback-secret',
//   resave: false,
//   saveUninitialized: true
// }));

// CORS con múltiples orígenes
const PORT = process.env.PORT || 8081;
const ORIGIN = process.env.ALLOWED_ORIGIN || "http://localhost:3000";
const allowedOrigins = ORIGIN
  .split(',')
  .map(s => s.trim())
  .filter(Boolean); // Soporta uno o varios orígenes

app.use(cors({
  origin: function (origin, callback) {
    //logger.info('Origin recibido:', origin);
    if (!origin) return callback(null, true); // Postman, móvil, etc.
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Origen no permitido'), false);
  },
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'Cache-Control',
    'Pragma',
    'Expires',
    'X-Flow-Token',
    'X-Request-Id'
  ],
  credentials: true
}));

// Parseo de cuerpo
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
// Rutas
app.use('/api', require('./routes'));

// Iniciar servidor
const server = app.listen(process.env.PORT || 8081, '0.0.0.0', async () => {
  try {
    logger.info(`🚀 Servidor escuchando en http://0.0.0.0:${PORT}/api`);

    // ✅ Intentar conectar a la base de datos
    await sequelize.authenticate();
    // ✅ Log opcional con tu logger (si existe)
    if (logger && typeof logger.info === 'function') {
      logger.info('✅ Conexión a la base de datos exitosa'); 
    }
  } catch (error) {
    logger.error('❌ Error al conectar a la base de datos:', error);
    if (logger && typeof logger.error === 'function') {
      logger.error('❌ Error al conectar a la base de datos:', error);
    }
    process.exit(1);
  }
});


// Cierre elegante
process.on('SIGINT', async () => {
  try {
    logger.info('CloseOperation: Cerrando conexión a la base de datos...');
    await sequelize.close();
    logger.info('CloseOperation: Conexión cerrada.');
    server.close(() => {
      logger.info('CloseOperation: Servidor detenido.');
      process.exit(0);
    });
  } catch (error) {
    logger.error('CloseOperation: Error crítico:', error);
    process.exit(1);
  }
});