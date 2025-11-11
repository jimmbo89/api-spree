const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;

const multerMultiple = (fieldName, foldername) => {
    // Configuración del almacenamiento
    const storage = multer.diskStorage({
        destination: async function (req, file, cb) {
            const folder = foldername ? `public/${foldername}` : 'public/uploads';
            try {
                await fs.access(folder);
                cb(null, folder);
            } catch (error) {
                try {
                    await fs.mkdir(folder, { recursive: true });
                    cb(null, folder);
                } catch (mkdirError) {
                    cb(new Error(`Error al crear el directorio: ${mkdirError.message}`));
                }
            }
        },
        filename: function (req, file, cb) {
            // Genera un nombre único para el archivo
            const uniqueName = `${file.fieldname}-${Date.now()}${path.extname(file.originalname)}`;
            cb(null, uniqueName);
        }
    });

    // Configuración de Multer
    const mimeTypes = {
        'jpg': ['image/jpeg'],
        'jpeg': ['image/jpeg'],
        'png': ['image/png'],
        'gif': ['image/gif'],
        'pdf': ['application/pdf', 'application/octet-stream'],
        'doc': ['application/msword'],
        'docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
        'txt': ['text/plain']
    };

    const upload = multer({
        storage: storage,
        limits: { fileSize: 2 * 1024 * 1024 }, // Límite de tamaño: 2 MB
        fileFilter: function (req, file, cb) {
            const ext = path.extname(file.originalname).toLowerCase().slice(1);
            const allowedExts = Object.keys(mimeTypes);
    
            if (!allowedExts.includes(ext)) {
                return cb(new Error(`Extensiones permitidas: ${allowedExts.join(', ')}`));
            }
    
            const allowedMimes = mimeTypes[ext];
            if (allowedMimes.includes(file.mimetype)) {
                cb(null, true);
            } else {
                cb(new Error(`Tipo MIME no válido para ${ext}. Tipos permitidos: ${allowedMimes.join(', ')}`));
            }
        }
    }).any(); // Manejar cualquier campo de archivo dinámicamente
    
    // Middleware personalizado
    return async (req, res, next) => {
        try {
            // Verificar campos que no son archivos
            if (req.body.files) {
                req.body.files.forEach((file, index) => {
                    if (typeof file === 'string') {
                        // Si el campo es un string, no es un archivo
                        req.body.files[index] = { id: file, file: null };
                    }
                });
            }
    
            // Procesar archivos con Multer
            upload(req, res, (err) => {
                if (err) {
                    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
                        return res.status(400).json({ error: 'El archivo es demasiado grande. Máximo 2 MB.' });
                    }
                    return res.status(400).json({ error: err.message });
                }
                next();
            });
        } catch (error) {
            res.status(500).json({ error: 'Ocurrió un error en el servidor.' });
        }
    };
};

module.exports = multerMultiple;