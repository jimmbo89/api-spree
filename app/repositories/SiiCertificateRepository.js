// repositories/siiCertificateRepository.js
const { SiiCertificate } = require("../models");
const logger = require("../../config/logger");
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const FileService = require("../services/FileService");
const CertificateManager = require("../services/SII/CertificateManager");
const { NOW } = require("sequelize");

const SiiCertificateRepository = {
  async createWithFile(data, file, options = {}) {
    const { company_id, password, document_types_enabled, folios_available, uploaded_at, expires_at } = data;
    
    const certDir = path.join(__dirname, '../../storage/certificates', company_id.toString());
    if (!fs.existsSync(certDir)) {
      fs.mkdirSync(certDir, { recursive: true });
    }

    const filename = `cert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.pfx`;
    const certPath = path.join(certDir, filename);
    fs.writeFileSync(certPath, file.buffer);

    const passwordHash = await bcrypt.hash(password, 10);

    const cert = await SiiCertificate.create({
      company_id,
      certificate_path: certPath,
      password_hash: passwordHash,
      uploaded_at: uploaded_at || new Date(),
      expires_at: expires_at || new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      document_types_enabled: document_types_enabled || [],
      folios_available: folios_available || {},
      is_valid: true
    }, options);

    logger.info(`Certificado SII creado ID ${cert.id} para tenant ${company_id}`);
    return cert;
  },

  async findActiveByCompanyId(company_id, options = {}) {
    return await SiiCertificate.findOne({
      where: { 
        company_id,
        is_valid: true
      },
      order: [['uploaded_at', 'DESC']],
      ...options
    });
  },

  async findByCompanyId(company_id, options = {}) {
  return await SiiCertificate.findAll({
    where: { company_id },
    order: [['uploaded_at', 'DESC']], // Del más reciente al más antiguo
    ...options
  });
},

  async findById(cert_id, options = {}) {
    return await SiiCertificate.findByPk(cert_id, options);
  },

  async findByCompanyId(company_id, options = {}) {
    return await SiiCertificate.findAll({
      where: { company_id },
      order: [['uploaded_at', 'DESC']],
      ...options
    });
  },

  async create(data, file, options = {}) {
  // 1. Hashear la contraseña ANTES de crear el registro
   const encryptedPassword = await CertificateManager.encryptPassword(data.password);

  // 2. Crear el registro con los datos básicos
  const certificate = await SiiCertificate.create({
    company_id: data.company_id,
    password_hash: encryptedPassword, // <-- Contraseña hasheada
    uploaded_at: new Date(),
    is_valid: true, // Se asume válido hasta que se valide el archivo
    certificate_path: 'certificates/temp.pfx' // Placeholder temporal
  }, options);

  // 3. Si se subió un archivo, validar y actualizar con los datos reales
  if (file) {
    const certificateBuffer = fs.readFileSync(file.path);
    
    // Validar el certificado
    const validation = await CertificateManager.validateCertificate(
      certificateBuffer, 
      data.password // Se usa la contraseña en texto plano para la validación
    );
    
    if (!validation.isValid) {
      await certificate.destroy(options);
      throw new Error(validation.message || 'Certificado inválido');
    }

    // Renombrar el archivo
    const newFilename = await FileService.generateCertificateFilename(
      data.company_id, 
      certificate.id, 
      file.originalname
    );
    const newPath = `certificates/${newFilename}`;
    const finalPath = await FileService.renameFile(file, newPath);

    // 4. ACTUALIZAR EL REGISTRO CON LOS DATOS DE VALIDACIÓN
    await certificate.update({
      certificate_path: finalPath,
      expires_at: validation.expiresAt,
      document_types_enabled: validation.documentTypes, // Puedes extraer esto de la validación si lo necesitas
      is_valid: validation.isValid
    }, options);
  }

  return certificate;
},

  /**
   * Actualiza un certificado SII existente.
   */
  async update(certificate, data, file, options = {}) {
    const { password_hash, is_valid } = data;

    // 1. Si se sube un nuevo archivo, manejar el reemplazo
    if (file) {
    const certificateBuffer = fs.readFileSync(file.path);
    
    // Validar el certificado
    const validation = await CertificateManager.validateCertificate(
      certificateBuffer, 
      data.password // Se usa la contraseña en texto plano para la validación
    );

     if (!validation.isValid) {
      await certificate.destroy(options);
      throw new Error(validation.message || 'Certificado inválido');
    }

    if (certificate.certificate_path && certificate.certificate_path !== 'certificates/temp.pfx') {
      await FileService.deleteFile(certificate.certificate_path);
    }

       const newFilename = await FileService.generateCertificateFilename(
      data.company_id, 
      certificate.id, 
      file.originalname
    );
     const newPath = `certificates/${newFilename}`;
    const finalPath = await FileService.renameFile(file, newPath);
    
    // 4. ACTUALIZAR EL REGISTRO CON LOS DATOS DE VALIDACIÓN
    
      data.certificate_path = finalPath,
      data.expires_at = validation.expiresAt,
      data.document_types_enabled = validation.documentTypes, // Puedes extraer esto de la validación si lo necesitas
      data.is_valid = validation.isValid

    }
    
    data.uploaded_at = new Date();
    // 2. Actualizar los campos en la BD
    const fieldsToUpdate = ['password_hash', 'is_valid', 'certificate_path', 'expires_at', 'document_types_enabled'];
    const updatedData = {};
      if (data.password) {
      const encryptedPassword = await CertificateManager.encryptPassword(data.password);
      updatedData.password_hash = JSON.stringify(encryptedPassword);
    }
    for (const field of fieldsToUpdate) {
      if (data[field] !== undefined) {
        updatedData[field] = data[field];
      }
    }

    if (Object.keys(updatedData).length > 0) {
      await certificate.update(updatedData, options);
      logger.info(`Certificado SII actualizado ID ${certificate.id}`);
    }

    return certificate;
  },

  // Método helper para facilitar el uso desde el controlador
  async createOrUpdate(data, file, options = {}) {
    const { id } = data;
    if (id) {
      const existing = await SiiCertificate.findByPk(id, options);
      if (!existing) throw new Error('Certificado no encontrado');
      return await this.update(existing, data, file, options);
    } else {
      return await this.create(data, file, options);
    }
  },
  async invalidate(cert_id, options = {}) {
    const cert = await SiiCertificate.findByPk(cert_id);
    if (!cert) throw new Error("Certificado no encontrado");
    await cert.update({ is_valid: false }, options);
    logger.info(`Certificado invalidado ID ${cert_id}`);
    return cert;
  },

  async delete(certificate, options = {}) {
    if (certificate.certificate_path && certificate.certificate_path !== 'certificates/temp.pfx') {
      await FileService.deleteFile(certificate.certificate_path);
    }
    return await certificate.destroy();
  }
};

module.exports = SiiCertificateRepository;