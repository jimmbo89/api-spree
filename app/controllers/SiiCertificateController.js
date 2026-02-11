const logger = require("../../config/logger");
const { SiiCertificateRepository, CompanyRepository, TenantLogRepository } = require("../repositories");
const { sequelize } = require('../models');
const CertificateManager = require("../services/SII/CertificateManager");
const { destroy } = require("./RoleController");

const SiiCertificateController = {

  async list(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Busca certificados de la company`);
    logger.info(`Datos obtenidos body: ${JSON.stringify(req.body)}`);
    try {
      const { company_id } = req.body;
      // Verificar que la compañía exista
      const company = await CompanyRepository.findById(company_id);
      if (!company) {
        return res.status(404).json({ 
          success: false, 
          message: "Compañía no encontrada" 
        });
      }

      // Obtener todos los certificados
      const certificates = await SiiCertificateRepository.findByCompanyId(company_id);

      // Formatear la respuesta para excluir datos sensibles (como la ruta del archivo)
      const formattedCertificates = certificates.map(cert => ({
        id: cert.id,
        uploaded_at: cert.uploaded_at,
        expires_at: cert.expires_at,
        is_valid: cert.is_valid,
        document_types_enabled: cert.document_types_enabled,
        folios_available: cert.folios_available
      }));

      return res.status(200).json({
        success: true,
          certificates: formattedCertificates
      });

    } catch (err) {
      logger.error("SIICertificateController->list: " + err.message);
      return res.status(500).json({ 
        success: false, 
        message: "Error al listar los certificados.",
        details: err.message 
      });
    }
  },
  async store(req, res) {
    const { company_id, password, document_types_enabled, folios_available, uploaded_at, expires_at } = req.body;
    const file = req.file?.certificate_file;

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

  async createOrUpdate(req, res) {
    logger.info(`${req.user?.name || "Unknown"} - Crea o edita sii cerstificate`);
    logger.info("Datos recibidos del SiiCertificate:");
    logger.info(JSON.stringify(req.body));
    try {
      const { company_id, id } = req.body;
      
       const company = await CompanyRepository.findById(company_id);
      if (!company) {
        return res.status(404).json({ success: false, message: "Compañía no encontrada" });
      }

      const t = await sequelize.transaction();
      try {
        // ✅ Llamada única al repositorio
        const certificateRecord = await SiiCertificateRepository.createOrUpdate(
          { ...req.body, company_id },
          req.files?.certificate_path, // Pasa el archivo directamente
          { transaction: t }
        );

        const action = id ? 'actualizado' : 'cargado';
        await TenantLogRepository.create({
          company_id,
          user_id: req.user?.id,
          module: 'sii',
          event_type: id ? 'update' : 'create',
          action: `Certificado SII ${action}`,
          description: `Certificado ${action} correctamente`,
          result: 'success'
        }, { transaction: t });

        await t.commit();

        return res.status(200).json({
          success: true,
          message: `Certificado ${action} correctamente`,
           data: {
            id: certificateRecord.id,
            expires_at: certificateRecord.expires_at,
            is_valid: certificateRecord.is_valid
          }
        });

      } catch (err) {
        if (t && !t.finished) await t.rollback();
        throw err;
      }
    } catch (err) {
      logger.error("SIICertificateController->createOrUpdate: " + err.message);
      return res.status(500).json({ 
        success: false, 
        message: "Error al procesar el certificado.",
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
  },

   async destroy(req, res) {
    try {
      const { id } = req.body;
      const certificate = await SiiCertificateRepository.findById(id);
      
      if (!certificate) {
        return res.status(404).json({ 
          success: false, 
          message: "Certificado no encontrado" 
        });
      }

      await SiiCertificateRepository.delete(certificate);

      return res.status(200).json({
        success: true,
         message: 'Certificado eliminado correctamente'
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