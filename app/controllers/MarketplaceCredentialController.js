// controllers/MarketplaceCredentialController.js
const { getUserId } = require('../../config/context');
const logger = require('../../config/logger');
const {
  MarketplaceCredentialRepository,
  MarketplaceRepository,
  LogRepository,
  UserCompanyRepository,
  UserMarketplaceCredentialRepository
} = require('../repositories');
const PublishingAdapterFactory = require('../services/adapters/PublishingAdapterFactory');
const EncryptionService = require('../services/EncryptionService');
const ProductPublishingTaskController = require('./ProductPublishingTaskController');
const { getRequestMetadata } = require('../util/requestUtil');
function formatSequelizeValidationError(error) {
  if (error.name === 'SequelizeValidationError' && error.errors?.length) {
    return error.errors.map(err => {
      const field = err.path || 'campo desconocido';
      const message = err.message || 'validacion fallida';
      return `${field}: ${message}`;
    }).join('; ');
  }
  return error.message;
}

function resolveCompanyId(req) {
  const rawCompanyId =
    req.body?.company_id ??
    req.query?.company_id ??
    req.headers['x-company-id'] ??
    req.user?.company_id ??
    null;

  if (rawCompanyId === null || rawCompanyId === undefined || rawCompanyId === '') {
    return null;
  }

  const companyId = Number(rawCompanyId);
  return Number.isInteger(companyId) && companyId > 0 ? companyId : NaN;
}

const MarketplaceCredentialController = {

  async index(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Lista credenciales del usuario`);

    const companyId = resolveCompanyId(req);
    const { marketplace_id } = req.query || req.body;

    try {
      if (Number.isNaN(companyId)) {
        return res.status(400).json({
          success: false,
          message: 'company_id debe ser un numero entero positivo'
        });
      }

      if (!companyId) {
        return res.status(400).json({
          success: false,
          message: 'company_id es requerido para listar credenciales'
        });
      }

      const credentials = await MarketplaceCredentialRepository.findByCompany(companyId, marketplace_id);

      const safeCredentials = credentials.map(cred => {
        const { access_token, refresh_token, api_key, ...safe } = cred;
        return safe;
      });

      res.status(200).json({
        success: true,
        message: "Credenciales obtenidas exitosamente",
        credentials: safeCredentials,
        count: safeCredentials.length
      });
    } catch (error) {
      logger.error('MarketplaceCredentialController->index: ' + error.message);
      res.status(500).json({ success: false, error: 'Error del servidor' });
    }
  },

  async getByUser(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Obtiene credenciales por usuario`);

    try {
      const rawCompanyId = resolveCompanyId(req);
      const rawUserId = req.body?.user_id ?? null;
      const companyId = rawCompanyId;
      const userId = rawUserId != null && rawUserId !== ''
        ? Number(rawUserId)
        : null;

      if (Number.isNaN(companyId)) {
        return res.status(400).json({
          success: false,
          message: 'company_id debe ser un numero entero positivo'
        });
      }

      if (userId !== null && (!Number.isInteger(userId) || userId <= 0)) {
        return res.status(400).json({
          success: false,
          message: 'user_id debe ser un numero entero positivo'
        });
      }

      if (!companyId) {
        return res.status(400).json({
          success: false,
          message: 'company_id es requerido para listar credenciales'
        });
      }

      let credentials = await MarketplaceCredentialRepository.findByCompany(companyId, req.body?.marketplace_id ?? null);

      if (userId) {
        const membership = await UserCompanyRepository.findByUserIdAndCompanyId(userId, companyId);
        if (!membership) {
          return res.status(404).json({
            success: false,
            message: 'El usuario no tiene relación con la empresa indicada'
          });
        }

        credentials = await UserMarketplaceCredentialRepository.findActiveCredentialsByUserAndCompany(
          userId,
          companyId,
          null
        );

        if (req.body?.marketplace_id) {
          const marketplaceId = Number(req.body.marketplace_id);
          credentials = credentials.filter((cred) => Number(cred.marketplace_id) === marketplaceId);
        }
      }

      credentials = await ProductPublishingTaskController.refreshExpiredTokens(
        credentials,
        userId || req.user?.id || null
      );

      const safeCredentials = credentials.map(cred => {
        const item = {
          id: cred.id,
          user_id: cred.user_id,
          company_id: cred.company_id,
          marketplace_id: cred.marketplace_id,
          name: cred.name,
          country: cred.country,
          active: cred.active,
          access_token: cred.access_token ? '********' : null,
          expires_at: cred.expires_at,
          seller_email: cred.seller_email,
          seller_id: cred.seller_id,
          api_key: cred.api_key ? '........' : null,
          additional_data: cred.additional_data,
          created_at: cred.createdAt,
          updated_at: cred.updatedAt,
          marketplace: cred.marketplace,
          user_name: cred.user?.name || null,
          user_email: cred.user?.email || null,
          user_avatar: cred.user?.image || null,
          company_name: cred.company?.name || null
        };
        return item;
      });

      res.status(200).json({
        success: true,
        message: "Credenciales obtenidas exitosamente",
        credentials: safeCredentials
      });
    } catch (error) {
      logger.error('MarketplaceCredentialController->getByUser: ' + error.message);
      res.status(500).json({
        success: false,
        message: 'Error interno del servidor'
      });
    }
  },

 async store(req, res) {
  logger.info(`${req.user?.name || 'Unknown'} - Crea credencial de marketplace`);
  logger.info(`Datos recibidos: ${JSON.stringify(req.body)}`);

  const userId = req.user.id;
   const { marketplace_id, name, seller_email, seller_id, api_key, country } = req.body;
   const companyId = resolveCompanyId(req);
   const metadata = getRequestMetadata(req);
   let newCredential = null;

  try {
    if (Number.isNaN(companyId)) {
      return res.status(400).json({ success: false, message: 'company_id debe ser un numero entero positivo' });
    }

    if (!companyId) {
      return res.status(400).json({ success: false, message: 'company_id es requerido' });
    }

    if (!req.user?.role_id) {
      const membership = await UserCompanyRepository.findByUserIdAndCompanyId(userId, companyId);
      if (!membership) {
        return res.status(403).json({ success: false, message: 'No tienes acceso a la empresa indicada' });
      }
    }

    // 1. Validar marketplace existe
    const marketplace = await MarketplaceRepository.findById(marketplace_id);
    if (!marketplace) {
      return res.status(400).json({ success: false, message: "Marketplace no encontrado" });
    }

    // 2. Validaciones de duplicados (name y credentials)
    const nameExists = await MarketplaceCredentialRepository.existsByName(
      marketplace_id, companyId, name
    );
    if (nameExists) {
      return res.status(409).json({
        success: false,
        message: 'Ya existe una conexion con este nombre para este marketplace'
      });
    }

    const credentialsExist = await MarketplaceCredentialRepository.existsByCredentials(
      marketplace_id, companyId, { seller_email, seller_id, api_key }
    );
    if (credentialsExist) {
      return res.status(409).json({
        success: false,
        message: 'Ya existe una conexion con las mismas credenciales para este marketplace'
      });
    }

    // 3. Detectar tipo de autenticacion del marketplace
    const isOAuth = marketplace.client_id && marketplace.client_secret && marketplace.redirect_uri;
    const isManual = !isOAuth; // Falabella y similares

    // 4. Flujo MANUAL (Falabella): Guardar credenciales directamente
    if (isManual) {
      // Validar campos requeridos para manual
      if (!seller_email || !seller_id || !api_key) {
        return res.status(400).json({
          success: false,
          message: "Para este marketplace se requieren: seller_email, seller_id y api_key"
        });
      }

      await MarketplaceCredentialRepository.createOrUpdate({
        marketplace_id,
        user_id: userId,
        company_id: companyId,
        name,
        country,
        api_key,
        seller_email,
        seller_id,
        expires_at: null,
        active: true
      });

      await LogRepository.create({
        user_id: metadata.user_id,
        action: 'marketplace_credential.create',
        description: `Credencial manual creada para marketplace ${marketplace_id}`,
        ip_address: metadata.ip_address,
        user_agent: metadata.user_agent,
        status: 'success',
        meta: { marketplace_id, name }
      });

      return res.status(201).json({
        success: true,
        message: "Credenciales guardadas exitosamente"
      });
    }

   // 5. Flujo OAuth (MercadoLibre): Guardar + Iniciar flujo de autorizacion
    if (isOAuth) {
      // Guardar credenciales base y capturar el registro creado
      newCredential = await MarketplaceCredentialRepository.createOrUpdate({
        marketplace_id,
        user_id: userId,
        company_id: companyId,
        name,
        country,
        // Tokens se obtendran despues de la autorizacion
        access_token: null,
        refresh_token: null,
        expires_at: null,
        active: true  // La credencial se crea ACTIVA (el front detectara cuando expire)
      });

        logger.info(`[store] Nueva credencial creada:`, {
        id: newCredential?.id,
        marketplace_id: newCredential?.marketplace_id,
        user_id: newCredential?.user_id
      });

      // Ejecutar logica de OAuth con la credencial recien creada
      const adapter = PublishingAdapterFactory.getAdapter(
        marketplace, 
        companyId, // companyId
        null, // branchId
        userId,
        newCredential.id  // Clave: pasar ID de la nueva credencial
      );
      
      if (!adapter) {
        return res.status(400).json({ success: false, message: "Adaptador no disponible" });
      }

      const status = await adapter.ensureValidCredentials();

      if (status.valid) {
        // Ya esta conectado (caso raro al crear, pero posible)
        return res.status(201).json({ 
          success: true, 
          message: "Ya conectado",
          credential_id: newCredential.id
        });
      } else if (status.auth_required) {
        // Devolver URL de autorizacion
        return res.status(409).json({
          success: false,
          auth_required: true,
          auth_url: status.auth_url,
          message: status.message,
          credential_id: newCredential.id  // Para referencia del frontend
        });
      } else {
        return res.status(400).json({
          success: false,
          error: status.error || "Error al iniciar conexion OAuth"
        });
      }
    }

    // Fallback por seguridad
    return res.status(400).json({
      success: false,
      message: "Tipo de autenticacion no reconocido"
    });

  } catch (error) {
    if (newCredential?.id) {
      try {
        await MarketplaceCredentialRepository.deleteById(newCredential.id);
        logger.info(`[store] Credencial huérfana eliminada: ${newCredential.id}`);
      } catch (deleteError) {
        logger.error(`[store] No se pudo eliminar credencial huérfana ${newCredential.id}:`, deleteError.message);
      }
    }
    const errorMessage = formatSequelizeValidationError(error);
    await LogRepository.create({
      user_id: metadata?.user_id,
      action: 'marketplace_credential.create',
      description: `Error: ${errorMessage}`,
      ip_address: metadata?.ip_address,
      user_agent: metadata?.user_agent,
      status: 'error',
      meta: { marketplace_id, name, error: error.name }
    });
    logger.error(`MarketplaceCredentialController->store: ${JSON.stringify(error)}`);
    
    const statusCode = error.name === 'SequelizeValidationError' ? 400 : 500;
    return res.status(statusCode).json({
      success: false,
      message: errorMessage,
      errorType: error.name
    });
  }
},
  async refreshToken(req, res) {
  logger.info(`${req.user?.name || 'Unknown'} - Refresca credenciales de marketplace`);
  logger.info(`Datos recibidos: ${JSON.stringify(req.body)}`);
  
  const userId = req.user.id;
  const { id } = req.body; // Cambio: ahora recibe credential_id

  try {
    // 1. Obtener la credencial especifica por ID
    const credential = await MarketplaceCredentialRepository.findById(id);
    
    if (!credential) {
      return res.status(404).json({ 
        success: false, 
        message: "Credencial no encontrada" 
      });
    }

    if (!req.user?.role_id && Number(req.user?.company_id) !== Number(credential.company_id)) {
      return res.status(403).json({
        success: false,
        message: "No autorizado para esta credencial"
      });
    }

    // 2. Obtener datos del marketplace asociado
    const marketplace = await MarketplaceRepository.findById(credential.marketplace_id);
    if (!marketplace) {
      return res.status(400).json({ 
        success: false, 
        message: "Marketplace no encontrado" 
      });
    }

    // 4. Crear adapter pasando la credencial especifica
    const adapter = PublishingAdapterFactory.getAdapter(
      marketplace, 
      credential.company_id, // companyId
      null, // branchId
      userId,
      credential // Nuevo: pasar credencial especifica
    );
    
    if (!adapter) {
      return res.status(400).json({ 
        success: false, 
        message: "Adaptador no disponible" 
      });
    }

    // 4. Ejecutar validacion/refresh con la credencial especifica
    const status = await adapter.ensureValidCredentials();

    if (status.valid) {
      return res.status(200).json({ 
        success: true, 
        message: "Token refrescado correctamente",
        credential_id: credential.id
      });
    } else if (status.auth_required) {
      return res.status(409).json({
        success: false,
        auth_required: true,
        auth_url: status.auth_url,
        message: status.message,
        credential_id: credential.id
      });
    } else {
      return res.status(400).json({
        success: false,
        error: status.error || "Error al validar credenciales",
        credential_id: credential.id
      });
    }

  } catch (error) {
    logger.error('MarketplaceCredentialController->refreshToken: ' + error.message);
    return res.status(500).json({ 
      success: false, 
      message: 'Error interno del servidor', 
      details: error.message 
    });
  }
},

  async update(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Actualiza credenciales de marketplace`);
    logger.info(JSON.stringify(req.body));

    const { id, name, country, seller_email, seller_id, api_key, active } = req.body;
    const metadata = getRequestMetadata(req);

    try {
      // 1. Obtener registro actual para validaciones
      const existing = await MarketplaceCredentialRepository.findById(id);
      if (!existing) {
        return res.status(404).json({ msg: "credentialNotFound" });
      }

      // 2. Verificar propiedad
      if (!req.user?.role_id && Number(existing.company_id) !== Number(req.user?.company_id)) {
        return res.status(403).json({ msg: "No autorizado" });
      }

      // 3. Validaciones de duplicados (solo si los campos cambiaron)
      if (name && name !== existing.name) {
        const nameExists = await MarketplaceCredentialRepository.existsByName(
          existing.marketplace_id,
          existing.company_id,
          name,
          id
        );
        if (nameExists) {
          return res.status(409).json({ 
            msg: 'Ya existe otra conexion con este nombre para este marketplace' 
          });
        }
      }

      // Validar credenciales solo si cambiaron
      const credentialsChanged = 
        (seller_email && seller_email !== existing.seller_email) ||
        (seller_id && seller_id !== existing.seller_id) ||
        (api_key && api_key !== existing.api_key);

      if (credentialsChanged) {
        const credentialsExist = await MarketplaceCredentialRepository.existsByCredentials(
          existing.marketplace_id,
          existing.company_id,
          { seller_email, seller_id, api_key },
          id
        );
        if (credentialsExist) {
          return res.status(409).json({ 
            msg: 'Ya existe otra conexion con las mismas credenciales para este marketplace' 
          });
        }
      }

      // 4. Preparar datos para actualizacion parcial (solo campos enviados)
      const updatePayload = {};
      if (name !== undefined) updatePayload.name = name;
      if (country !== undefined) updatePayload.country = country;
      if (seller_email !== undefined) updatePayload.seller_email = seller_email;
      if (seller_id !== undefined) updatePayload.seller_id = seller_id;
      if (api_key !== undefined) updatePayload.api_key = api_key;
      if (active !== undefined) updatePayload.active = active;

      // 5. Ejecutar actualizacion parcial
      const credential = await MarketplaceCredentialRepository.updatePartial(id, updatePayload);

      // 6. Verificar conexion al marketplace (similar a warehouseMarketplaces)
      const marketplace = await MarketplaceRepository.findById(credential.marketplace_id);
      if (!marketplace) {
        return res.status(400).json({ msg: "Marketplace no encontrado" });
      }

      // Detectar si es OAuth (MercadoLibre) o Manual (Falabella)
      const isOAuth = marketplace.client_id && marketplace.client_secret && marketplace.redirect_uri;
      let connectionStatus = { valid: false, auth_required: false };

      if (isOAuth) {
        // Para OAuth, verificar/renovar token usando el adapter
        const adapter = PublishingAdapterFactory.getAdapter(
          marketplace,
          existing.company_id, // companyId
          null, // branchId
          req.user.id,
          credential.id  // Pasar credencial actualizada
        );

        if (adapter && typeof adapter.ensureValidCredentials === 'function') {
          connectionStatus = await adapter.ensureValidCredentials();
        }
      } else {
        // Para manual (Falabella), verificar que las credenciales existan
        connectionStatus = {
          valid: !!(credential.seller_email && credential.seller_id && credential.api_key),
          message: credential.api_key ? "Credenciales manuales configuradas" : "Credenciales incompletas"
        };
      }

      // 7. Log de exito
      await LogRepository.create({
        user_id: metadata.user_id,
        action: 'marketplace_credential.update',
        description: `Credenciales actualizadas para marketplace ${credential.marketplace_id} - Conexion: ${connectionStatus.valid ? 'OK' : 'Pendiente'}`,
        ip_address: metadata.ip_address,
        user_agent: metadata.user_agent,
        status: 'success',
        meta: { id: credential.id, updated_fields: Object.keys(updatePayload), connection_valid: connectionStatus.valid }
      });

      // 8. Respuesta segura (sin tokens) + estado de conexion
      const { access_token: _, refresh_token: __, api_key: ___, ...safeCredential } = credential;
      res.status(200).json({
        message: "Credenciales actualizadas correctamente",
        credential: safeCredential,
        connection: {
          valid: connectionStatus.valid,
          auth_required: connectionStatus.auth_required,
          auth_url: connectionStatus.auth_url,
          message: connectionStatus.message || (connectionStatus.valid ? "Conectado" : "Requiere atencion")
        }
      });

    } catch (error) {
      await LogRepository.create({
        user_id: metadata?.user_id,
        action: 'marketplace_credential.update',
        description: `Error: ${error.message}`,
        ip_address: metadata?.ip_address,
        user_agent: metadata?.user_agent,
        status: 'error',
        meta: { id: req.body?.id }
      });
      logger.error('MarketplaceCredentialController->update: ' + error.message);
      
      // Manejar errores especificos
      if (error.message === 'credentialNotFound') {
        return res.status(404).json({ msg: "credentialNotFound" });
      }
      if (error.message.includes('nombre') || error.message.includes('credenciales')) {
        return res.status(409).json({ msg: error.message });
      }
      
      res.status(500).json({ error: 'ServerError' });
    }
  },

  async show(req, res) {
    try {
      const { id } = req.params || req.body;
      if (!id) {
        return res.status(400).json({ msg: 'ID requerido' });
      }

      const credential = await MarketplaceCredentialRepository.findById(id);
      if (!credential) {
        return res.status(404).json({ msg: "CredentialNotFound" });
      }

      // Verificar propiedad
      if (!req.user?.role_id && Number(credential.company_id) !== Number(req.user?.company_id)) {
        return res.status(403).json({ msg: "No autorizado" });
      }

      const { access_token, refresh_token, api_key, ...safeCredential } = credential;
      res.status(200).json(safeCredential);
    } catch (error) {
      logger.error('MarketplaceCredentialController->show: ' + error.message);
      res.status(500).json({ error: 'ServerError' });
    }
  },

  async destroy(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Elimina credencial de marketplace`);

    const { id } = req.body;
    const metadata = getRequestMetadata(req);

    try {
      const credential = await MarketplaceCredentialRepository.findByDelete(id);
      if (!credential) {
        return res.status(404).json({ msg: 'CredencialNotFound' });
      }

      // Verificar propiedad
      if (!req.user?.role_id && Number(credential.company_id) !== Number(req.user?.company_id)) {
        return res.status(403).json({ msg: "No autorizado" });
      }

      await MarketplaceCredentialRepository.delete(credential);

      await LogRepository.create({
        user_id: metadata.user_id,
        action: 'marketplace_credential.delete',
        description: `Credencial para marketplace "${credential.marketplace.name}" eliminada`,
        ip_address: metadata.ip_address,
        user_agent: metadata.user_agent,
        status: 'success',
        meta: { id: credential.id, marketplace_id: credential.marketplace_id }
      });

      res.status(200).json({ message: "Credencial de marketplace eliminada correctamente" });
    } catch (error) {
      await LogRepository.create({
        user_id: metadata?.user_id,
        action: 'marketplace_credential.delete',
        description: `Error al eliminar credencial ID ${id}: ${error.message}`,
        ip_address: metadata?.ip_address,
        user_agent: metadata?.user_agent,
        status: 'error',
        meta: { id }
      });
      logger.error('MarketplaceController->destroy: ' + error.message);
      res.status(500).json({ error: 'ServerError', details: error.message });
    }
  }
};

module.exports = MarketplaceCredentialController;
