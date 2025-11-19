const multer = require('multer');
const path = require('path');

const uploadsDir = path.resolve(__dirname, '../../uploads');

const multerGeneric = (fieldName = 'file', maxFileSize = 5 * 1024 * 1024) => {
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
      cb(null, 'bulk-' + uniqueSuffix + path.extname(file.originalname));
    }
  });

  const fileFilter = (req, file, cb) => {
    if (file.mimetype === 'text/csv' ||
        file.mimetype === 'application/vnd.ms-excel' ||
        file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type'), false);
    }
  };

  return multer({
    storage,
    limits: { fileSize: maxFileSize },
    fileFilter
  }).single(fieldName);
};

module.exports = multerGeneric;