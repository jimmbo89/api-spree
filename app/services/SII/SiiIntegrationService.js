// services/sii/SIIIntegrationService.js
const SiiConfigurationRepository = require("../../repositories/SiiConfigurationRepository");
const SiiCertificateRepository = require("../../repositories/SiiCertificateRepository");
const DteDocumentRepository = require("../../repositories/DteDocumentRepository");
const TenantLogRepository = require("../../repositories/TenantLogRepository");
const SiiCafRepository = require("../../repositories/SiiCafRepository");
const DTEGenerator = require("./DTEGenerator");
const CertificateManager = require("./CertificateManager");
const CAFManager = require("./CAFManager");
const SIIConnectionService = require("./SIIConnectionService");
const logger = require("../../../config/logger");

class SiiIntegrationService {
  constructor() {
    this.dteGenerator = DTEGenerator;
    this.certificateManager = CertificateManager;
    this.cafManager = CAFManager;
    this.siiConnection = SIIConnectionService;
  }

  async configureSII(companyId, data, userId = null, options = {}) {
    const { rut, legal_name, sii_environment, contributor_type } = data;

    this.validateRUT(rut);

    const config = await SiiConfigurationRepository.createOrUpdate(
      {
        company_id: companyId,
        rut,
        legal_name,
        sii_environment: sii_environment || 'certification',
        contributor_type,
        is_connected: true,
        connected_at: new Date()
      },
      options
    );

    await TenantLogRepository.create({
      company_id: companyId,
      user_id: userId,
      module: 'sii',
      event_type: 'update',
      action: 'Configuración SII actualizada',
      description: `Ambiente: ${sii_environment || 'certification'}, RUT: ${rut}`,
      result: 'success'
    }, options);

    return {
      success: true,
      message: 'Integración con SII configurada correctamente',
       config
    };
  }

  async disconnectSII(companyId, userId = null, options = {}) {
    const config = await SiiConfigurationRepository.findByCompanyId(companyId);
    if (!config) {
      throw new Error('Configuración SII no encontrada');
    }

    await SiiConfigurationRepository.disconnect(companyId, options);

    await TenantLogRepository.create({
      company_id: companyId,
      user_id: userId,
      module: 'sii',
      event_type: 'update',
      action: 'Desconexión SII',
      description: `SII desconectado para empresa ${companyId}`,
      result: 'success'
    }, options);

    return {
      success: true,
      message: 'Integración con SII desconectada correctamente'
    };
  }

  async getIntegrationStatus(companyId, options = {}) {
    const config = await SiiConfigurationRepository.findByCompanyId(companyId);
    const certificate = await SiiCertificateRepository.findActiveByCompanyId(companyId);
    const cafs = await SiiCafRepository.findByCompanyId(companyId, options);
    if (!config) {
      return {
        estado_general: '🔴 No configurado',
        mensaje_estado: 'Debes configurar SII para emitir documentos.',
        configuracion: null,
        certificado: null,
        cafs: []
      };
    }

    let estadoGeneral = '🟠 Atención requerida';
    let mensajeEstado = '';

    if (config.is_connected) {
      if (certificate && certificate.is_valid) {
        const cafActivo = cafs.some(c => c.is_active && !c.is_exhausted);
        if (cafActivo) {
          estadoGeneral = '🟢 Operativo';
          mensajeEstado = 'La emisión de documentos electrónicos está operativa.';
        } else {
          estadoGeneral = '🟠 Atención requerida';
          mensajeEstado = 'No hay folios disponibles. Carga nuevos CAF.';
        }
      } else {
        estadoGeneral = '🟠 Atención requerida';
        mensajeEstado = 'Certificado no válido o expirado.';
      }
    } else {
      estadoGeneral = '🔴 No configurado';
      mensajeEstado = 'SII no está conectado. Configura la integración.';
    }

    return {
      estado_general: estadoGeneral,
      mensaje_estado: mensajeEstado,
      configuracion: config,
      certificado: certificate ? {
        id: certificate.id,
        uploaded_at: certificate.uploaded_at,
        expires_at: certificate.expires_at,
        is_valid: certificate.is_valid,
        dias_para_expirar: this.daysUntil(certificate.expires_at)
      } : null,
      cafs: cafs.map(caf => ({
        id: caf.id,
        document_type: caf.document_type,
        folios_disponibles: caf.remaining_count,
        vigencia: `${caf.issue_date} - ${caf.expiration_date}`,
        is_active: caf.is_active,
        is_exhausted: caf.is_exhausted,
        used_count: caf.used_count
      }))
    };
  }

  async issueDTE(documentId,  userId = null, options = {}) { // ✅ CORREGIDO: Recibe documentId, no companyId + data
    // 1. Obtener documento ya creado
    const document = await DteDocumentRepository.findById(documentId, options);
    if (!document) throw new Error('Documento DTE no encontrado');

    const companyId = document.company_id;

    // 2. Validar configuración SII
    const config = await this.validateSIISetup(companyId, options);

    // 3. Obtener CAF activo para el tipo de documento
    const caf = await SiiCafRepository.findActiveByCompanyAndType(
      companyId,
      document.document_type,
      options
    );

    if (!caf) {
      throw new Error('No hay CAF disponible para el tipo de documento solicitado');
    }

    // 4. Generar XML DTE con folio del documento (ya asignado desde el controlador)
    const dteData = {
      ...document.get({ plain: true }), // Obtener datos planos del modelo
      rut_emisor: config.rut,
      legal_name_emisor: config.legal_name
    };

    const { xmlDte } = await this.dteGenerator.generateDTE(dteData, caf);

    // 5. Obtener certificado y firmar
    const certificate = await SiiCertificateRepository.findActiveByCompanyId(companyId, options);
       // ✅ DESENCRIPTAR la contraseña del certificado
    const certificatePassword = await CertificateManager.decryptPassword(certificate.password_hash);

    // 5. Firmar documento
    const signature = await this.certificateManager.signDocument(
      xmlDte,
      certificate.certificate_path,
      certificatePassword // ✅ Usar contraseña desencriptada
    );

    // 6. Enviar al SII
    const siiResponse = await this.siiConnection.sendDTE(
      config.sii_environment,
      xmlDte,
      signature,
      config.rut
    );
    const siiResponseString = JSON.stringify(siiResponse);
    // 7. Actualizar documento con resultado
    await DteDocumentRepository.update(documentId, {
      sii_status: siiResponse.status === 'OK' ? 'aceptado' : 'rechazado',
      track_id: siiResponse.trackId,
      sii_response: siiResponseString,
      sii_error_code: siiResponse.status !== 'OK' ? siiResponse.errorCode : null,
      sii_error_message: siiResponse.status !== 'OK' ? siiResponse.message : null,
      xml_dte: xmlDte,
      xml_envio: signature // o el XML de envío completo según tu implementación
    }, options);

    // 8. Actualizar CAF (incrementar folio)
    await SiiCafRepository.incrementFolio(caf.id, options);

    // 9. Registrar log
    await TenantLogRepository.create({
      company_id: companyId,
      user_id: userId,
      module: 'sii',
      event_type: 'create',
      action: 'DTE emitido',
      description: `${document.document_type} ${document.folio} emitido a ${document.rut_receptor}`,
      meta: {
        document_id: documentId,
        folio: document.folio,
        monto_total: document.monto_total,
        track_id: siiResponse.trackId
      },
      result: siiResponse.status === 'OK' ? 'success' : 'error',
      error_message: siiResponse.status !== 'OK' ? siiResponse.message : null
    }, options);

    return {
      success: siiResponse.status === 'OK',
      message: siiResponse.status === 'OK' 
        ? 'Documento emitido correctamente' 
        : 'Documento rechazado por SII',
      sii_status: siiResponse.status === 'OK' ? 'aceptado' : 'rechazado',
      track_id: siiResponse.trackId,
      sii_response: siiResponse,
      xml_dte: xmlDte
    };
  }

  async checkDocumentStatus(companyId, documentId, userId = null, options = {}) {
    const document = await DteDocumentRepository.findById(documentId, options);
    
    if (!document || document.company_id !== companyId) {
      throw new Error('Documento no encontrado');
    }

    if (!document.track_id) {
      throw new Error('Documento no tiene Track ID para consultar');
    }

    const config = await SiiConfigurationRepository.findByCompanyId(companyId);
    if (!config) {
      throw new Error('Configuración SII no encontrada');
    }

    const statusResponse = await this.siiConnection.queryStatus(
      config.sii_environment,
      document.track_id
    );

    await DteDocumentRepository.update(documentId, {
      sii_status: statusResponse.estado === 'ACEPTADO' ? 'aceptado' : 'rechazado',
      sii_error_code: statusResponse.errorCode,
      sii_error_message: statusResponse.errorMessage
    }, options);

    /*await SIITransactionLogRepository.create({
      company_id: companyId,
      document_id: documentId,
      transaction_type: 'check_status',
      response_xml: statusResponse.rawResponse,
      response_status: statusResponse.estado,
      error_code: statusResponse.errorCode,
      error_message: statusResponse.errorMessage,
      endpoint: statusResponse.endpoint
    }, options);*/

    await TenantLogRepository.create({
      company_id: companyId,
      user_id: userId,
      module: 'sii',
      event_type: 'read',
      action: 'Consulta estado DTE',
      description: `Estado de ${document.document_type} ${document.folio}: ${statusResponse.estado}`,
      meta: {
        document_id: documentId,
        track_id: document.track_id,
        estado: statusResponse.estado
      },
      result: 'success'
    }, options);

    return {
      success: true,
       data: {
        document_type: document.document_type,
        folio: document.folio,
        current_status: document.sii_status,
        sii_estado: statusResponse.estado,
        sii_glosa: statusResponse.glosa,
        fecha_consulta: new Date()
      }
    };
  }

  async validateSIISetup(companyId, options = {}) {
    const config = await SiiConfigurationRepository.findByCompanyId(companyId);
    if (!config || !config.is_connected) {
      throw new Error('Configuración SII no encontrada. Debes configurar SII primero.');
    }

    if (!config.rut || !config.legal_name) {
      throw new Error('Datos legales incompletos. Configura RUT y razón social.');
    }

    const certificate = await SiiCertificateRepository.findActiveByCompanyId(companyId, options);
    if (!certificate) {
      throw new Error('Certificado SII no encontrado o inválido.');
    }

    const hasValidCAF = await SiiCafRepository.getNextAvailableCAF(
      companyId,
      null,
      options
    );

    if (!hasValidCAF) {
      throw new Error('No hay CAF disponible. Carga folios para emitir documentos.');
    }

    return config;
  }

  validateRUT(rut) {
    if (!rut) {
      throw new Error('RUT es requerido');
    }

    const cleanRut = rut.replace(/[.\-]/g, '');
    const rutPattern = /^\d{7,8}[0-9kK]{1}$/;

    if (!rutPattern.test(cleanRut)) {
      throw new Error('Formato de RUT inválido');
    }

    return true;
  }

  daysUntil(date) {
    if (!date) return null;
    const today = new Date();
    const target = new Date(date);
    const diffTime = target - today;
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  }

  async decryptCertificatePassword(passwordHash) {
    // En producción, aquí iría la lógica real de desencriptación
    // Por ahora, retornamos el hash (la contraseña real se obtiene del usuario)
    return passwordHash;
  }
}

module.exports = new SiiIntegrationService();