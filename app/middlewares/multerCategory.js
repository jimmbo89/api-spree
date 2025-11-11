const multer = require('multer');
const path = require('path');
const fs = require('fs').promises;

const multerCategory = (fieldName, foldername) => {
    // Configuración del almacenamiento
    const storage = multer.diskStorage({
        destination: async function (req, file, cb) {
            const folder = foldername ? `public/${foldername}` : 'public/uploads';
            try {
                // Verifica si la carpeta existe
                await fs.access(folder);
                cb(null, folder); // Si la carpeta existe, continúa
            } catch (error) {
                // Si no existe, intenta crearla
                try {
                    await fs.mkdir(folder, { recursive: true });
                    cb(null, folder); // Si la carpeta se crea correctamente
                } catch (mkdirError) {
                    // Manejo de errores al crear la carpeta
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
    // Mapeo de extensiones a MIME types permitidos
    const mimeTypes = {
        'jpg': ['image/jpeg'],
        'jpeg': ['image/jpeg'],
        'png': ['image/png'],
        'gif': ['image/gif'],
        'pdf': ['application/pdf', 'application/octet-stream'], // Permitir octet-stream para PDFs
        'doc': ['application/msword'],
        'docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
        'txt': ['text/plain']
    };

    const upload = multer({
        storage: storage,
        limits: { fileSize: 2 * 1024 * 1024 },
        fileFilter: function (req, file, cb) {
            const ext = path.extname(file.originalname).toLowerCase().slice(1);
            const allowedExts = Object.keys(mimeTypes);

            // Verificar extensión permitida
            if (!allowedExts.includes(ext)) {
                return cb(new Error(
                    `Extensiones permitidas: ${allowedExts.join(', ')}`
                ));
            }

            // Verificar MIME type correspondiente a la extensión
            const allowedMimes = mimeTypes[ext];
            if (allowedMimes.includes(file.mimetype)) {
                cb(null, true);
            } else {
                cb(new Error(
                    `Tipo MIME no válido para ${ext}. Tipos permitidos: ${allowedMimes.join(', ')}`
                ));
            }
        }
    }).single(fieldName);
    /*const upload = multer({
        storage: storage,
        limits: { fileSize: 500 * 1024 }, // Límite de tamaño: 500 KB
        fileFilter: function (req, file, cb) {
            // Validar tipo de archivo
            const filetypes = /jpg|jpeg|png|gif|pdf|doc|docx|txt/;
            const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
            const mimetype = filetypes.test(file.mimetype);

            if (mimetype && extname) {
                cb(null, true);
            } else {
                cb(new Error('Error: Solo se permiten imágenes (jpeg, jpg, png)'));
            }
        }
    }).single(fieldName);*/

    // Middleware personalizado
    return async (req, res, next) => {
        try {
            if (req.body.image && typeof req.body.image === 'string') {
                // Si `image` es un string, omite el procesamiento
                return next();
            }

            if (req.body.archive && typeof req.body.archive === 'string') {
                // Si `image` es un string, omite el procesamiento
                return next();
            }


            // Procesar archivo si no es un string
            upload(req, res, (err) => {
                if (err) {
                    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
                        return res.status(400).json({ error: 'El archivo es demasiado grande. Máximo 500 KB.' });
                    }
                    return res.status(400).json({ error: err.message });
                }
                next();
            });
        } catch (error) {
            // Manejo de errores no anticipados
            res.status(500).json({ error: 'Ocurrió un error en el servidor.' });
        }
    };
};

module.exports = multerCategory;
