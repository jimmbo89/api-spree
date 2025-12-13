const multer = require('multer');
const path = require('path');
const fs = require('fs');
const logger = require("../../config/logger");

const multerImage = (fieldName, foldername) => {
    // Configuración del almacenamiento con creación de carpeta SÍNCRONA
    const storage = multer.diskStorage({
        destination: function (req, file, cb) {
            const folder = foldername ? `public/${foldername}` : 'public/uploads';
            
            // Crear carpeta de forma SÍNCRONA si no existe
            try {
                if (!fs.existsSync(folder)) {
                    fs.mkdirSync(folder, { recursive: true });
                    logger.info(`Carpeta creada: ${folder}`);
                }
                cb(null, folder);
            } catch (error) {
                logger.error(`Error al crear carpeta ${folder}: ${error.message}`);
                cb(new Error(`Error al crear el directorio: ${error.message}`));
            }
        },
        filename: function (req, file, cb) {
            // Genera un nombre único para el archivo
            const uniqueName = `${file.fieldname}-${Date.now()}${path.extname(file.originalname)}`;
            cb(null, uniqueName);
        }
    });

    // Configuración de Multer
    const upload = multer({
        storage: storage,
        limits: { fileSize: 500 * 1024 }, // Límite de tamaño: 500 KB
        fileFilter: function (req, file, cb) {
            // Validar tipo de archivo
            const filetypes = /jpeg|jpg|png|gif/;
            const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
            const mimetype = filetypes.test(file.mimetype);

            if (mimetype && extname) {
                cb(null, true);
            } else {
                cb(new Error('Error: Solo se permiten imágenes (jpeg, jpg, png, gif)'));
            }
        }
    }).single(fieldName);

    // Middleware personalizado
    return (req, res, next) => {
        logger.info(`Multer middleware - Field: ${fieldName}, Has file: ${!!req.file}, Body image: ${req.body?.image}`);
        
        try {
            // Si viene imagen como string (ya existe o es default), pasar al siguiente middleware
            if (req.body && req.body.image && typeof req.body.image === 'string') {
                logger.info('Imagen recibida como string, omitiendo upload de multer');
                return next();
            }

            // Procesar archivo
            upload(req, res, (err) => {
                if (err) {
                    logger.error(`Error en multer upload: ${err.message}`);
                    
                    if (err instanceof multer.MulterError) {
                        switch (err.code) {
                            case 'LIMIT_FILE_SIZE':
                                return res.status(400).json({ 
                                    error: 'El archivo es demasiado grande. Máximo 500 KB.' 
                                });
                            case 'LIMIT_UNEXPECTED_FILE':
                                return res.status(400).json({ 
                                    error: `Campo de archivo inesperado. Use: ${fieldName}` 
                                });
                            default:
                                return res.status(400).json({ 
                                    error: `Error al subir archivo: ${err.message}` 
                                });
                        }
                    }
                    
                    // Error de validación u otro error
                    return res.status(400).json({ 
                        error: `Error en archivo: ${err.message}` 
                    });
                }
                
                logger.info(`Multer procesado - File: ${req.file ? req.file.filename : 'none'}`);
                next();
            });
            
        } catch (error) {
            logger.error(`Error en middleware multerImage: ${error.message}`);
            logger.error(error.stack);
            res.status(500).json({ 
                error: 'Ocurrió un error en el servidor al procesar la imagen.' 
            });
        }
    };
};

module.exports = multerImage;