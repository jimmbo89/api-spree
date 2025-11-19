const path = require('path');
const fs = require('fs');
const logger = require('../../config/logger'); // Asegúrate de que este sea tu logger configurado

const ImageService = {
  // Mover archivo a un nuevo destino
  async moveFile(file, destination) {
    const newPath = path.join(__dirname, '..', '..', 'public', destination);

    try {
      await fs.promises.rename(file.path, newPath);
      logger.info(`Imagen movida exitosamente a: ${newPath}`);
      return destination;
    } catch (err) {
      logger.error(`Error al mover la imagen: ${err.message}`);
      throw new Error('Error al mover la imagen');
    }
  },

  // Eliminar archivo si existe
  async deleteFile(filepath) {
    const fullPath = path.join(__dirname, '..', '..', 'public', filepath);

    if (fs.existsSync(fullPath)) {
      try {
        await fs.promises.unlink(fullPath);
        logger.info(`Archivo eliminado exitosamente: ${fullPath}`);
      } catch (err) {
        logger.error(`Error al eliminar el archivo: ${err.message}`);
        throw new Error('Error al eliminar el archivo');
      }
    }
  },

  // Generar nombre de archivo único
  generateFilename(folder, id, originalName) {
    const extension = path.extname(originalName);
    return `${folder}/${id}${extension}`;
  },
};

module.exports = ImageService;
