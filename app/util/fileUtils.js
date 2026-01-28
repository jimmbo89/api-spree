// utils/fileUtils.js
const FILE_CONFIG = {
  image: {
    extensions: ['.jpg', '.jpeg', '.png', '.gif', '.webp'],
    mimetypes: [
      'image/jpeg',
      'image/jpg',
      'image/png',
      'image/gif',
      'image/webp'
    ]
  },
  pdf: {
    extensions: ['.pdf'],
    mimetypes: ['application/pdf']
  },
  document: {
    extensions: ['.pdf', '.doc', '.docx', '.xls', '.xlsx'],
    mimetypes: [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ]
  }
};

// Mapa de extensión → MIME type
const EXTENSION_TO_MIME = {};

// Llenar el mapa con todos los tipos conocidos
Object.values(FILE_CONFIG).forEach(type => {
  const { extensions, mimetypes } = type;
  extensions.forEach((ext, i) => {
    // Usar el mimetype correspondiente (índice coincidente)
    if (mimetypes[i]) {
      EXTENSION_TO_MIME[ext] = mimetypes[i];
    }
  });
});

// Asegurar casos comunes que podrían faltar
EXTENSION_TO_MIME['.jpeg'] = 'image/jpeg';
EXTENSION_TO_MIME['.jpg'] = 'image/jpeg';

function getMimeTypeFromExtension(filename) {
  const ext = filename.substring(filename.lastIndexOf('.')).toLowerCase();
  return EXTENSION_TO_MIME[ext] || 'application/octet-stream';
}

module.exports = {
  FILE_CONFIG,
  getMimeTypeFromExtension
};