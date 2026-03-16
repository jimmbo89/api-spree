/**
 * Genera una versión/timestamp para URLs de imágenes
 * Se usa para invalidar el caché del navegador cuando una imagen se actualiza
 * 
 * @param {string} filename - Nombre del archivo
 * @param {string} filepath - Ruta completa del archivo (opcional, para usar mtime real)
 * @returns {string} - String de versión para usar como query param
 */
function generateImageVersion(filename, filepath = null) {
  if (filepath && require('fs').existsSync(filepath)) {
    // Usar timestamp real del archivo
    const stats = require('fs').statSync(filepath);
    return stats.mtimeMs.toString();
  }
  
  // Fallback: usar timestamp actual o hash del nombre
  return Date.now().toString();
}

/**
 * Construye una URL de imagen con versión para caché
 * 
 * @param {string} folder - Carpeta de la imagen (ej: 'products', 'users')
 * @param {string} filename - Nombre del archivo
 * @param {string|null} version - Versión específica (opcional)
 * @param {boolean} protect - Si usa la ruta protegida (/images-protect)
 * @returns {string} - URL completa con query param de versión
 */
function imageUrl(folder, filename, version = null, protect = false) {
  const base = protect ? `/images-protect/${folder}/${filename}` : `/images/${folder}/${filename}`;
  
  if (version) {
    return `${base}?v=${version}`;
  }
  
  // Si no hay versión y el archivo existe, generar una basada en mtime
  try {
    const path = require('path');
    const { UPLOAD_BASE_PATH } = require('../../config/upload');
    const filepath = path.join(UPLOAD_BASE_PATH, folder, filename);
    
    if (require('fs').existsSync(filepath)) {
      const stats = require('fs').statSync(filepath);
      return `${base}?v=${stats.mtimeMs}`;
    }
  } catch (e) {
    // Silencioso: si falla, retornar sin versión
  }
  
  return base;
}

/**
 * Invalida el caché de una imagen generando nueva versión
 * 
 * @param {string} folder - Carpeta de la imagen
 * @param {string} filename - Nombre del archivo
 * @returns {string} - Nueva URL con versión actualizada
 */
function invalidateImageCache(folder, filename) {
  return imageUrl(folder, filename, Date.now().toString());
}

module.exports = {
  generateImageVersion,
  imageUrl,
  invalidateImageCache
};
