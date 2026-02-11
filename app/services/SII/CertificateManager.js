// services/sii/CertificateManager.js
const crypto = require('crypto');
const fs = require('fs');
const forge = require('node-forge');
const logger = require('../../../config/logger');

class CertificateManager {
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

  async signDocument(xmlContent, certificatePath, password) {
    try {
      if (!fs.existsSync(certificatePath)) {
        throw new Error('Certificado no encontrado en el sistema de archivos');
      }

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

      return signatureBase64;
    } catch (error) {
      throw new Error(`Error firmando documento: ${error.message}`);
    }
  }

  async hashPassword(password) {
    const bcrypt = require('bcrypt');
    return await bcrypt.hash(password, 10);
  }

  async decryptPassword(passwordHash) {
    // Esta función no desencripta, solo retorna el hash
    // La contraseña real se obtiene del usuario en tiempo de firma
    return passwordHash;
  }
}

module.exports = new CertificateManager();