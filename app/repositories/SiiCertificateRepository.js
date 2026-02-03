// repositories/siiCertificateRepository.js
const { SIICertificate } = require("../models");
const logger = require("../../config/logger");
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');

const SIICertificateRepository = {
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

    const cert = await SIICertificate.create({
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
    return await SIICertificate.findOne({
      where: { 
        company_id,
        is_valid: true
      },
      order: [['uploaded_at', 'DESC']],
      ...options
    });
  },

  async findById(cert_id, options = {}) {
    return await SIICertificate.findByPk(cert_id, options);
  },

  async findByCompanyId(company_id, options = {}) {
    return await SIICertificate.findAll({
      where: { company_id },
      order: [['uploaded_at', 'DESC']],
      ...options
    });
  },

  async update(cert_id, data, options = {}) {
    const cert = await SIICertificate.findByPk(cert_id);
    if (!cert) throw new Error("Certificado no encontrado");
    await cert.update(data, options);
    logger.info(`Certificado actualizado ID ${cert_id}`);
    return cert;
  },

  async invalidate(cert_id, options = {}) {
    const cert = await SIICertificate.findByPk(cert_id);
    if (!cert) throw new Error("Certificado no encontrado");
    await cert.update({ is_valid: false }, options);
    logger.info(`Certificado invalidado ID ${cert_id}`);
    return cert;
  },

  async delete(cert_id, options = {}) {
    const cert = await SIICertificate.findByPk(cert_id);
    if (!cert) throw new Error("Certificado no encontrado");

    if (fs.existsSync(cert.certificate_path)) {
      fs.unlinkSync(cert.certificate_path);
    }

    await cert.destroy(options);
    logger.info(`Certificado eliminado ID ${cert_id}`);
    return { success: true };
  }
};

module.exports = SIICertificateRepository;