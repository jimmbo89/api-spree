const logger = require("../../config/logger");
const { SiiCertificateRepository, CompanyRepository, TenantLogRepository } = require("../repositories");
const { sequelize } = require('../models');

const SiiCertificateController = {
  async store(req, res) {
    const { company_id, password, document_types_enabled, folios_available, uploaded_at, expires_at } = req.body;
    const file = req.files?.certificate_file;

    if (!file) {
      return res.status(400).json({ success: false, message: "Certificado es requerido" });
    }

    const company = await CompanyRepository.findById(company_id);
    if (!company) return res.status(404).json({ success: false, message: "Compañía no encontrada" });

    const t = await sequelize.transaction();
    try {
      const cert = await SiiCertificateRepository.createWithFile(
        { company_id, password, document_types_enabled, folios_available, uploaded_at, expires_at },
        file,
        { transaction: t }
      );
      await t.commit();
      return res.status(200).json({ success: true, cert, message: "Certificado cargado correctamente." });
    } catch (err) {
      if (t && !t.finished) await t.rollback();
      logger.error("SiiCertificateController->store: " + err.message);
      return res.status(500).json({ success: false, message: "Certificado inválido o expirado.", details: err.message });
    }
  },
    async upload(req, res) {
    try {
      if (!req.file) {
        return res.status(400).json({ 
          success: false, 
          message: "Archivo de certificado requerido" 
        });
      }

      const { company_id } = req.body;
      const password = req.body.password;

      if (!password) {
        return res.status(400).json({ 
          success: false, 
          message: "Contraseña del certificado requerida" 
        });
      }

      const company = await CompanyRepository.findById(company_id);
      if (!company) {
        return res.status(404).json({ 
          success: false, 
          message: "Compañía no encontrada" 
        });
      }

      const t = await sequelize.transaction();
      try {
        const certificateManager = new CertificateManager();
        const validation = await certificateManager.validateCertificate(
          req.file.buffer,
          password
        );

        if (!validation.isValid) {
          throw new Error(validation.message || 'Certificado inválido');
        }

        const certDir = `storage/certificates/${company_id}`;
        if (!fs.existsSync(certDir)) {
          fs.mkdirSync(certDir, { recursive: true });
        }

        const filename = `cert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.pfx`;
        const certPath = `${certDir}/${filename}`;
        fs.writeFileSync(certPath, req.file.buffer);

        const passwordHash = await certificateManager.hashPassword(password);

        const certificate = await SiiCertificateRepository.create({
          company_id: company_id,
          certificate_path: certPath,
          password_hash: passwordHash,
          uploaded_at: new Date(),
          expires_at: validation.expiresAt,
          is_valid: true,
          document_types_enabled: []
        }, { transaction: t });

        await TenantLogRepository.create({
          company_id: company_id,
          user_id: req.user?.id,
          module: 'sii',
          event_type: 'create',
          action: 'Certificado SII subido',
          description: `Certificado válido hasta ${validation.expiresAt}`,
          result: 'success'
        }, { transaction: t });

        await t.commit();

        return res.status(201).json({
          success: true,
          message: 'Certificado cargado correctamente',
           data: {
            id: certificate.id,
            expires_at: certificate.expires_at,
            is_valid: certificate.is_valid
          }
        });
      } catch (err) {
        if (t && !t.finished) await t.rollback();
        throw err;
      }
    } catch (err) {
      logger.error("SIICertificateController->upload: " + err.message);
      return res.status(500).json({ 
        success: false, 
        message: "Error al subir certificado.",
        details: err.message 
      });
    }
  },

  async show(req, res) {
    try {
      const { company_id } = req.body;
      
      const company = await CompanyRepository.findById(company_id);
      if (!company) {
        return res.status(404).json({ 
          success: false, 
          message: "Compañía no encontrada" 
        });
      }

      const certificate = await SiiCertificateRepository.findActiveByCompanyId(company_id);
      
      if (!certificate) {
        return res.status(404).json({ 
          success: false, 
          message: "Certificado no encontrado" 
        });
      }

      return res.status(200).json({
        success: true,
         data: {
          id: certificate.id,
          uploaded_at: certificate.uploaded_at,
          expires_at: certificate.expires_at,
          is_valid: certificate.is_valid,
          document_types_enabled: certificate.document_types_enabled
        }
      });
    } catch (err) {
      logger.error("SIICertificateController->show: " + err.message);
      return res.status(500).json({ 
        success: false, 
        message: "Error al obtener certificado.",
        details: err.message 
      });
    }
  }
};

module.exports = SiiCertificateController;