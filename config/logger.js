const winston = require('winston');
const { format } = winston;
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
const fs = require('fs');

// 1. Definir rutas
const logDir = path.join(process.cwd(), 'logs');
const errorLogDir = path.join(logDir, 'errors');
const combinedLogDir = path.join(logDir, 'combined');

// 2. Crear directorios (sin usar logger aún)
const createLogDirs = () => {
  try {
    [logDir, errorLogDir, combinedLogDir].forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
  } catch (err) {
    logger.error('Error crítico al crear directorios de logs:', err);
    process.exit(1);
  }
};

createLogDirs();

// 3. Configurar logger
const logger = winston.createLogger({
  level: 'info',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.errors({ stack: true }),
    format.printf(info => `${info.timestamp} ${info.level}: ${info.message}`)
  ),
  transports: [
    new winston.transports.Console({
      format: format.combine(
        format.colorize(),
        format.simple()
      )
    }),
    new DailyRotateFile({
      filename: 'error-%DATE%.log',
      dirname: errorLogDir,
      datePattern: 'YYYY-MM-DD',
      level: 'error',
      maxSize: '20m',
      maxFiles: '14d'
    }),
    new DailyRotateFile({
      filename: 'combined-%DATE%.log',
      dirname: combinedLogDir,
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '7d'
    })
  ],
  exceptionHandlers: [
    new winston.transports.File({
      filename: path.join(errorLogDir, 'exceptions.log')
    })
  ]
});

// Opcional: log de inicio (ahora sí puedes usar logger)
//logger.info('Logger inicializado correctamente');

module.exports = logger;