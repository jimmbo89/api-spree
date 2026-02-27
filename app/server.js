require('dotenv').config({ quiet: true });

const express = require("express");
const app = express();
//const session = require('express-session');
const { sequelize } = require('./models/index');
const cors = require('cors');
const logger = require('../config/logger');
const JobBackgroundProcessor = require('./services/JobBackgroundProcessor');

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
    'X-Company-ID',
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

// === INICIAR SERVIDOR ===
const server = app.listen(PORT, '0.0.0.0', async () => {
  try {
    logger.info(`🚀 Servidor escuchando en http://0.0.0.0:${PORT}/api`);

    // ✅ Conectar a la base de datos
    await sequelize.authenticate();
    logger.info('✅ Conexión a la base de datos exitosa');

    // ✅ INICIAR BACKGROUND PROCESSOR (solo después de que DB esté lista)
    JobBackgroundProcessor.start();
    logger.info('✅ JobBackgroundProcessor iniciado');

  } catch (error) {
    logger.error('❌ Error al iniciar servidor:', error);
    process.exit(1);
  }
});

// Ctrl+C en terminal
process.on('SIGINT', async () => {
  logger.info('🛑 SIGINT recibido (Ctrl+C), cerrando gracefulmente...');
  await gracefulShutdown();
});

// Señal de cPanel para reiniciar/detener app
process.on('SIGTERM', async () => {
  logger.info('🛑 SIGTERM recibido (cPanel), cerrando gracefulmente...');
  await gracefulShutdown();
});

// Función centralizada de shutdown
async function gracefulShutdown() {
  try {
    // 1. Detener el background processor primero
    JobBackgroundProcessor.stop();
    logger.info('🔄 Background processor detenido');

    // 2. Cerrar conexión a la base de datos
    await sequelize.close();
    logger.info('🔄 Conexión a BD cerrada');

    // 3. Cerrar servidor HTTP
    server.close(() => {
      logger.info('🔌 Servidor HTTP cerrado');
      process.exit(0);
    });

    // Forzar salida si server.close() se cuelga (timeout 10s)
    setTimeout(() => {
      logger.warn('⚠️ Timeout en server.close(), forzando salida');
      process.exit(1);
    }, 10000);

  } catch (error) {
    logger.error('❌ Error en shutdown:', error);
    process.exit(1);
  }
}