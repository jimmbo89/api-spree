// controllers/MarketplaceCredentialController.js
const { getUserId } = require('../../config/context');
const logger = require('../../config/logger');
const {
  MarketplaceCredentialRepository,
  MarketplaceRepository,
  LogRepository
} = require('../repositories');
const PublishingAdapterFactory = require('../services/adapters/PublishingAdapterFactory');
const EncryptionService = require('../services/EncryptionService');
const { getRequestMetadata } = require('../util/requestUtil');
function formatSequelizeValidationError(error) {
  if (error.name === 'SequelizeValidationError' && error.errors?.length) {
    return error.errors.map(err => {
      const field = err.path || 'campo desconocido';
      const message = err.message || 'validación fallida';
      return `${field}: ${message}`;
    }).join('; ');
  }
  return error.message;
}
const MarketplaceCredentialController = {

  async index(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Lista credenciales del usuario`);

    const userId = req.user.id;
    const { marketplace_id } = req.query || req.body;

    try {
      const credentials = await MarketplaceCredentialRepository.findByUser(userId, marketplace_id);

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
      const userId = req.user.id;

      const credentials = await MarketplaceCredentialRepository.findByUser(userId);

      const safeCredentials = credentials.map(cred => {
        const item = {
          id: cred.id,
          marketplace_id: cred.marketplace_id,
          name: cred.name,
          country: cred.country,
          active: cred.active,
          access_token: cred.access_token ? '••••••••' : null,
          expires_at: cred.expires_at,
          seller_email: cred.seller_email,
          seller_id: cred.seller_id,
          api_key: cred.api_key ? '........' : null,
          additional_data: cred.additional_data,
          created_at: cred.createdAt,
          updated_at: cred.updatedAt,
          marketplace: cred.marketplace
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
  const metadata = getRequestMetadata(req);

  try {
    // 1. Validar marketplace existe
    const marketplace = await MarketplaceRepository.findById(marketplace_id);
    if (!marketplace) {
      return res.status(400).json({ success: false, message: "Marketplace no encontrado" });
    }

    // 2. Validaciones de duplicados (name y credentials)
    const nameExists = await MarketplaceCredentialRepository.existsByName(
      marketplace_id, userId, name
    );
    if (nameExists) {
      return res.status(409).json({
        success: false,
        message: 'Ya existe una conexión con este nombre para este marketplace'
      });
    }

    const credentialsExist = await MarketplaceCredentialRepository.existsByCredentials(
      marketplace_id, userId, { seller_email, seller_id, api_key }
    );
    if (credentialsExist) {
      return res.status(409).json({
        success: false,
        message: 'Ya existe una conexión con las mismas credenciales para este marketplace'
      });
    }

    // 3. Detectar tipo de autenticación del marketplace
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

   // 5. Flujo OAuth (MercadoLibre): Guardar + Iniciar flujo de autorización
    if (isOAuth) {
      // ✅ Guardar credenciales base y CAPTURAR el registro creado
      const newCredential = await MarketplaceCredentialRepository.createOrUpdate({
        marketplace_id,
        user_id: userId,
        name,
        country,
        // Tokens se obtendrán después de la autorización
        access_token: null,
        refresh_token: null,
        expires_at: null,
        active: false
      });

        logger.info(`[store] Nueva credencial creada:`, {
        id: newCredential?.id,
        marketplace_id: newCredential?.marketplace_id,
        user_id: newCredential?.user_id
      });

      // ✅ EJECUTAR LÓGICA DE OAUTH con la credencial recién creada
      const adapter = PublishingAdapterFactory.getAdapter(
        marketplace, 
        null, // companyId
        null, // branchId
        userId,
        newCredential.id  // ← CLAVE: Pasar ID de la NUEVA credencial
      );
      
      if (!adapter) {
        return res.status(400).json({ success: false, message: "Adaptador no disponible" });
      }

      const status = await adapter.ensureValidCredentials();

      if (status.valid) {
        // Ya está conectado (caso raro al crear, pero posible)
        return res.status(201).json({ 
          success: true, 
          message: "Ya conectado",
          credential_id: newCredential.id
        });
      } else if (status.auth_required) {
        // ✅ DEVOLVER URL DE AUTORIZACIÓN - ESTO ES CLAVE
        return res.status(409).json({
          success: false,
          auth_required: true,
          auth_url: status.auth_url,
          message: status.message,
          credential_id: newCredential.id  // ← Para referencia del frontend
        });
      } else {
        return res.status(400).json({
          success: false,
          error: status.error || "Error al iniciar conexión OAuth"
        });
      }
    }

    // Fallback por seguridad
    return res.status(400).json({
      success: false,
      message: "Tipo de autenticación no reconocido"
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
  const { id } = req.body; // ← CAMBIO: Ahora recibe credential_id

  try {
    // 1. Obtener la credencial específica por ID
    const credential = await MarketplaceCredentialRepository.findById(id);
    
    if (!credential) {
      return res.status(404).json({ 
        success: false, 
        message: "Credencial no encontrada" 
      });
    }

    // 2. Verificar propiedad del usuario
    if (credential.user_id !== userId) {
      return res.status(403).json({ 
        success: false, 
        message: "No autorizado" 
      });
    }

    // 3. Obtener datos del marketplace asociado
    const marketplace = await MarketplaceRepository.findById(credential.marketplace_id);
    if (!marketplace) {
      return res.status(400).json({ 
        success: false, 
        message: "Marketplace no encontrado" 
      });
    }

    // 4. Crear adapter pasando la credencial específica
    const adapter = PublishingAdapterFactory.getAdapter(
      marketplace, 
      null, // companyId
      null, // branchId
      userId,
      credential// ← NUEVO: Pasar credencial específica
    );
    
    if (!adapter) {
      return res.status(400).json({ 
        success: false, 
        message: "Adaptador no disponible" 
      });
    }

    // 5. Ejecutar validación/refresh con la credencial específica
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
      if (existing.user_id !== req.user.id) {
        return res.status(403).json({ msg: "No autorizado" });
      }

      // 3. Validaciones de duplicados (solo si los campos cambiaron)
      if (name && name !== existing.name) {
        const nameExists = await MarketplaceCredentialRepository.existsByName(
          existing.marketplace_id,
          req.user.id,
          name,
          id
        );
        if (nameExists) {
          return res.status(409).json({ 
            msg: 'Ya existe otra conexión con este nombre para este marketplace' 
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
          req.user.id,
          { seller_email, seller_id, api_key },
          id
        );
        if (credentialsExist) {
          return res.status(409).json({ 
            msg: 'Ya existe otra conexión con las mismas credenciales para este marketplace' 
          });
        }
      }

      // 4. Preparar datos para actualización parcial (solo campos enviados)
      const updatePayload = {};
      if (name !== undefined) updatePayload.name = name;
      if (country !== undefined) updatePayload.country = country;
      if (seller_email !== undefined) updatePayload.seller_email = seller_email;
      if (seller_id !== undefined) updatePayload.seller_id = seller_id;
      if (api_key !== undefined) updatePayload.api_key = api_key;
      if (active !== undefined) updatePayload.active = active;

      // 5. Ejecutar actualización parcial
      const credential = await MarketplaceCredentialRepository.updatePartial(id, updatePayload);

      // 6. Log de éxito
      await LogRepository.create({
        user_id: metadata.user_id,
        action: 'marketplace_credential.update',
        description: `Credenciales actualizadas para marketplace ${credential.marketplace_id}`,
        ip_address: metadata.ip_address,
        user_agent: metadata.user_agent,
        status: 'success',
        meta: { id: credential.id, updated_fields: Object.keys(updatePayload) }
      });

      // 7. Respuesta segura (sin tokens)
      const { access_token: _, refresh_token: __, api_key: ___, ...safeCredential } = credential;
      res.status(200).json({ 
        message: "Credenciales actualizadas correctamente", 
        credential: safeCredential 
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
      
      // Manejar errores específicos
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
      if (credential.user_id !== req.user.id) {
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
      if (credential.user_id !== req.user.id) {
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