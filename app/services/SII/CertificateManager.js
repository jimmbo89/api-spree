// services/sii/CertificateManager.js
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const forge = require('node-forge');
const logger = require('../../../config/logger');
const { UPLOAD_BASE_PATH } = require('../../../config/upload');

class CertificateManager {
  constructor() {
    // ✅ Obtener clave de encriptación desde variable de entorno o generar una por defecto
    this.encryptionKey = this.getEncryptionKey();
    this.algorithm = 'aes-256-cbc';
  }

  /**
   * Obtener clave de encriptación
   * En producción, debe estar en variable de entorno
   */
  getEncryptionKey() {
    const key = process.env.CERTIFICATE_ENCRYPTION_KEY || process.env.ENCRYPTION_KEY;
    
    if (key) {
      // Validar longitud mínima (32 bytes para AES-256)
      if (key.length < 32) {
        logger.warn('⚠️  Clave de encriptación corta. Se recomienda mínimo 32 caracteres.');
        return key.padEnd(32, 'x').substring(0, 32);
      }
      return key.substring(0, 32);
    }

    // ✅ Generar clave por defecto para desarrollo (NO USAR EN PRODUCCIÓN)
    logger.warn('⚠️  Usando clave de encriptación por defecto. Configura CERTIFICATE_ENCRYPTION_KEY en producción.');
    return 'dev-default-key-32-bytes-123456';
  }

  /**
   * ✅ ENCRYPTAR contraseña con AES-256-CBC
   * Reemplaza hashPassword - ahora encripta en lugar de hacer hash
   */
  async encryptPassword(password) {
    try {
      if (!password || typeof password !== 'string') {
        throw new Error('Contraseña inválida para encriptar');
      }

      // Generar IV aleatorio
      const iv = crypto.randomBytes(16);
      
      // Crear cifrador
      const cipher = crypto.createCipheriv(this.algorithm, Buffer.from(this.encryptionKey), iv);
      
      // Encriptar
      let encrypted = cipher.update(password, 'utf8', 'hex');
      encrypted += cipher.final('hex');

      // Retornar objeto con IV y contenido encriptado
      const result = {
        iv: iv.toString('hex'),
        encrypted: encrypted,
        algorithm: this.algorithm
      };

      logger.debug(`Contraseña encriptada exitosamente (IV: ${iv.toString('hex').substring(0, 16)}...)`);
      
      return result;
    } catch (error) {
      logger.error(`Error encriptando contraseña: ${error.message}`);
      throw new Error(`Error encriptando contraseña: ${error.message}`);
    }
  }

  /**
   * ✅ DESENCRIPTAR contraseña con AES-256-CBC
   * Reemplaza decryptPassword - ahora desencripta en lugar de retornar el hash
   */
  async decryptPassword(encryptedData) {
    try {
      if (!encryptedData) {
        throw new Error('Datos encriptados no proporcionados');
      }

      // Parsear JSON si es string
      const data = typeof encryptedData === 'string' 
        ? JSON.parse(encryptedData) 
        : encryptedData;

      if (!data.iv || !data.encrypted) {
        throw new Error('Formato de datos encriptados inválido');
      }

      // Crear descifrador
      const iv = Buffer.from(data.iv, 'hex');
      const decipher = crypto.createDecipheriv(this.algorithm, Buffer.from(this.encryptionKey), iv);
      
      // Desencriptar
      let decrypted = decipher.update(data.encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      logger.debug(`Contraseña desencriptada exitosamente`);
      
      return decrypted;
    } catch (error) {
      logger.error(`Error desencriptando contraseña: ${error.message}`);
      logger.error(`Datos recibidos: ${JSON.stringify(encryptedData)}`);
      throw new Error(`Error desencriptando contraseña: ${error.message}`);
    }
  }

  /**
   * Validar certificado PFX
   */
  async validateCertificate(certificateBuffer, password) {
    try {
      if (!certificateBuffer || certificateBuffer.length === 0) {
        return {
          isValid: false,
          message: 'Certificado vacío o no válido',
          expiresAt: null
        };
      }

      if (!password || password.trim() === '') {
        return {
          isValid: false,
          message: 'Contraseña del certificado requerida',
          expiresAt: null
        };
      }

      // Validar que sea un archivo .pfx válido
      if (certificateBuffer.length < 100) {
        return {
          isValid: false,
          message: 'Archivo de certificado demasiado pequeño',
          expiresAt: null
        };
      }

      // Intentar leer el certificado con node-forge
      try {
        const p12Asn1 = forge.asn1.fromDer(certificateBuffer.toString('binary'));
        const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, password);
        // Extraer certificado
        const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
        const certBag = certBags[forge.pki.oids.certBag][0];
        const cert = certBag.cert;
        // Obtener fecha de expiración
        const expiresAt = new Date(cert.validity.notAfter);
        const today = new Date();
        
        if (expiresAt < today) {
          return {
            isValid: false,
            message: `Certificado expirado el ${expiresAt.toISOString().split('T')[0]}`,
            expiresAt: expiresAt,
            documentTypes: []
          };
        }

        let documentTypes = [];
        try {
          // OID específico del SII para tipos de documento
          const SII_DOCUMENT_TYPES_OID = '2.16.458.1.1';
          
          // Buscar la extensión en el certificado
          const extensions = cert.extensions || [];
          const docTypeExtension = extensions.find(ext => ext.id === SII_DOCUMENT_TYPES_OID);
          
          if (docTypeExtension && docTypeExtension.value) {
            // El valor está en formato ASN.1, lo parseamos
            const valueAsn1 = forge.asn1.fromDer(docTypeExtension.value);
            // El valor es una secuencia de enteros
            if (valueAsn1.type === forge.asn1.Type.SEQUENCE) {
              documentTypes = valueAsn1.value.map(item => {
                if (item.type === forge.asn1.Type.INTEGER) {
                  return item.value.toString(); // Ej: "33", "34", etc.
                }
                return null;
              }).filter(Boolean);
            }
          }
        } catch (extError) {
          logger.warn(`No se pudieron extraer tipos de documento del certificado: ${extError.message}`);
          // No fallamos si no se pueden extraer, solo dejamos el array vacío
        }

        return {
          isValid: true,
          message: 'Certificado válido',
          expiresAt: expiresAt,
          documentTypes: documentTypes,
          subject: cert.subject.getField('CN').value,
          issuer: cert.issuer.getField('CN').value
        };
      } catch (forgeError) {
        return {
          isValid: false,
          message: `Certificado inválido o contraseña incorrecta: ${forgeError.message}`,
          expiresAt: null
        };
      }
    } catch (error) {
      return {
        isValid: false,
        message: `Error validando certificado: ${error.message}`,
        expiresAt: null
      };
    }
  }

  /**
   * ✅ CORREGIDO: Firmar documento con certificado
   */
  async signDocument(xmlContent, certificatePath, password) {
    try {
      if (!certificatePath) {
        throw new Error('Ruta del certificado no especificada');
      }

      // ✅ Resolver ruta absoluta usando UPLOAD_BASE_PATH
      const absolutePath = path.isAbsolute(certificatePath)
        ? certificatePath
        : path.join(UPLOAD_BASE_PATH, certificatePath);

      logger.info(`Firmando documento con certificado: ${absolutePath}`);

      // ✅ Verificar que el archivo exista
      if (!fs.existsSync(absolutePath)) {
        logger.error(`Certificado no encontrado: ${absolutePath}`);
        logger.error(`Ruta relativa: ${certificatePath}`);
        logger.error(`UPLOAD_BASE_PATH: ${UPLOAD_BASE_PATH}`);
        
        // ✅ Intentar buscar en otras rutas comunes
        const alternativePaths = [
          path.join(process.cwd(), certificatePath),
          path.join(process.cwd(), 'uploads', certificatePath),
          path.join(process.cwd(), 'public', certificatePath)
        ];

        for (const altPath of alternativePaths) {
          if (fs.existsSync(altPath)) {
            logger.info(`Certificado encontrado en ruta alternativa: ${altPath}`);
            return await this.signWithCertificate(xmlContent, altPath, password);
          }
        }

        throw new Error(`Certificado no encontrado en el sistema de archivos. Ruta: ${absolutePath}`);
      }

      // ✅ Firmar con la ruta correcta
      return await this.signWithCertificate(xmlContent, absolutePath, password);

    } catch (error) {
      logger.error(`Error firmando documento: ${error.message}`);
      logger.error(`Stack: ${error.stack}`);
      throw new Error(`Error firmando documento: ${error.message}`);
    }
  }

  /**
   * Método auxiliar para firmar con certificado
   */
  async signWithCertificate(xmlContent, certificatePath, password) {
    try {
      const certBuffer = fs.readFileSync(certificatePath);
      const p12Asn1 = forge.asn1.fromDer(certBuffer.toString('binary'));
      const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, password);
      
      // Extraer clave privada
      const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
      const keyBag = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag][0];
      const privateKey = keyBag.key;
      
      // Crear firma SHA256 con RSA
      const md = forge.md.sha256.create();
      md.update(xmlContent, 'utf8');
      
      const signature = privateKey.sign(md);
      const signatureBase64 = forge.util.encode64(signature);

      logger.info(`Documento firmado exitosamente con certificado: ${certificatePath}`);
      return signatureBase64;

    } catch (error) {
      logger.error(`Error en signWithCertificate: ${error.message}`);
      throw new Error(`Error firmando documento: ${error.message}`);
    }
  }
}

module.exports = new CertificateManager();