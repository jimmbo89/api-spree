// middlewares/siiCafUpload.js
const multer = require('multer');
const path = require('path');

const cafXmlUpload = multer({
  storage: multer.memoryStorage(), // ✅ Todo en memoria
  limits: { fileSize: 1 * 1024 * 1024 }, // 1 MB (más que suficiente para CAF)
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const isXml = ext === '.xml';
    const isXmlMimetype = file.mimetype === 'application/xml' || 
                         file.mimetype === 'text/xml';

    if (isXml && (isXmlMimetype || file.mimetype === 'application/octet-stream')) {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten archivos XML (.xml)'));
    }
  }
}).single('caf_xml'); // 👈 Solo un archivo, campo "caf_xml"

module.exports = cafXmlUpload;