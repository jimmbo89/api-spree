// src/services/EncryptionService.js
const crypto = require('crypto');

class EncryptionService {
  static encrypt(text) {
    if (!text) return null;

    // Validar que ENCRYPTION_KEY exista
    if (!process.env.ENCRYPTION_KEY) {
      throw new Error('ENCRYPTION_KEY no está definida en .env');
    }

    // Usar una clave de 32 bytes (256 bits) para AES-256
    const key = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
    if (key.length !== 32) {
      throw new Error('ENCRYPTION_KEY debe ser una cadena hexadecimal de 64 caracteres (32 bytes)');
    }

    const iv = crypto.randomBytes(16); // Vector de inicialización aleatorio
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return `${iv.toString('hex')}:${encrypted}`;
  }

  static decrypt(encryptedText) {
    if (!encryptedText) return null;

    if (!process.env.ENCRYPTION_KEY) {
      throw new Error('ENCRYPTION_KEY no está definida en .env');
    }

    const key = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
    if (key.length !== 32) {
      throw new Error('ENCRYPTION_KEY debe ser una cadena hexadecimal de 64 caracteres (32 bytes)');
    }

    const [ivHex, encrypted] = encryptedText.split(':');
    if (!ivHex || !encrypted) {
      throw new Error('Texto cifrado inválido');
    }

    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }
}

module.exports = EncryptionService;