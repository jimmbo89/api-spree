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

const MarketplaceCredentialController = {

  async index(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Lista credenciales del usuario`);

    const userId = req.user.id; // siempre del usuario autenticado
    const { marketplace_id } = req.query || req.body;

    try {
      const credentials = await MarketplaceCredentialRepository.findByUser(userId, marketplace_id);

      // ⚠️ Nunca devolver tokens en lista
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
    const userId = req.user.id; // siempre del token autenticado

    const credentials = await MarketplaceCredentialRepository.findByUser(userId);

    // Preparar respuesta segura (sin tokens ni secrets)
    /*const safeCredentials = credentials.map(cred => ({
      id: cred.id,
      marketplace_id: cred.marketplace_id,
      active: cred.active,
      access_token: cred.access_token ? '••••••••' : null, // solo para saber si existe
      expires_at: cred.expires_at,
      created_at: cred.createdAt,
      updated_at: cred.updatedAt,
      marketplace: cred.marketplace // ya viene sin client_secret
    }));*/

    const safeCredentials = credentials.map(cred => {
      const item = {
        id: cred.id,
          marketplace_id: cred.marketplace_id,
          active: cred.active,
          access_token: cred.access_token ? '••••••••' : null, // solo para saber si existe
          expires_at: cred.expires_at,
          seller_email: cred.seller_email,
          seller_id: cred.seller_id,
          api_key: cred.api_key ? '........' : null,
          additional_data: cred.additional_data,
          created_at: cred.createdAt,
          updated_at: cred.updatedAt,
          marketplace: cred.marketplace
      };

      logger.info('EncryptionService.decrypt(cred.access_token)');
      logger.info(EncryptionService.decrypt(cred.access_token));
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
/*async store(req, res) {
  logger.info(`${req.user?.name || 'Unknown'} - crea credenciales de marketplace`);
  logger.info('Datos recibidos:');
  logger.info(JSON.stringify(req.body));
  const userId = req.user.id;
  const { marketplace_id } = req.body;

  try {
    const marketplace = await MarketplaceRepository.findById(marketplace_id);
    if (!marketplace) {
      return res.status(400).json({ success: false, message: "Marketplace no encontrado" });
    }

    const adapter = PublishingAdapterFactory.getAdapter(marketplace, null, null, userId);
    if (!adapter) {
      return res.status(400).json({ success: false, message: "Adaptador no disponible" });
    }

    const status = await adapter.ensureValidCredentials();

    if (status.valid) {
      // Ya está conectado
      return res.status(201).json({ success: true, message: "Ya conectado" });
    } else if (status.auth_required) {
      // Devolver URL para redirección
      return res.status(409).json({
        success: false,
        auth_required: true,
        auth_url: status.auth_url,
        message: status.message
      });
    } else {
      return res.status(400).json({
        success: false,
        error: status.error || "Error al validar credenciales"
      });
    }

  } catch (error) {
    logger.error('MarketplaceCredentialController->store:', error.message);
    return res.status(500).json({ success: false, message: 'Error interno del servidor', details: error.message });
  }
},*/
// MarketplaceCredentialController.js
async store(req, res) {
  logger.info(`${req.user?.name || 'Unknown'} - Sincroniza con marketplace`);
  logger.info(`Datos recibidos:, ${JSON.stringify(req.body)}`);
  const userId = req.user.id;
  const { marketplace_id, seller_email, seller_id, api_key } = req.body;

  try {
    const marketplace = await MarketplaceRepository.findById(marketplace_id);
    if (!marketplace) {
      return res.status(400).json({ success: false, message: "Marketplace no encontrado" });
    }

    // 🔑 Detectar si es marketplace que requiere credenciales manuales
    //const isManualAuth = !marketplace.client_id || !marketplace.client_secret;
    
    /*if (isManualAuth) {
      // 🔑 Requiere credenciales del usuario
      if (!client_id || !client_secret) {
        // Pedir credenciales al usuario
        return res.status(409).json({
          success: false,
          auth_required: true,
          auth_type: 'manual',
          message: "Se requieren credenciales para este marketplace"
        });
      }*/
      
      // Guardar credenciales del usuario
      await MarketplaceCredentialRepository.createOrUpdate({
        marketplace_id,
        user_id: userId,
        api_key: api_key, // API Key → access_token
        seller_email: seller_email,
        seller_id: seller_id,
        expires_at: null,
        active: true
      });
      
      return res.status(201).json({ 
        success: true, 
        message: "Credenciales guardadas exitosamente" 
      });
    //}

    // 🔑 Flujo OAuth (MercadoLibre)
    const adapter = PublishingAdapterFactory.getAdapter(marketplace, null, null, userId);
    const status = await adapter.ensureValidCredentials();

    if (status.valid) {
      return res.status(201).json({ success: true, message: "Ya conectado" });
    } else if (status.auth_required) {
      return res.status(409).json({
        success: false,
        auth_required: true,
        auth_url: status.auth_url,
        message: status.message
      });
    }

  } catch (error) {
    logger.error(`MarketplaceCredentialController->store:, ${error.message}`);
    return res.status(500).json({ success: false, message: 'Error interno', details: error.message });
  }
},
async refreskToken(req, res) {
  logger.info(`${req.user?.name || 'Unknown'} - refresca credenciales de marketplace`);
  logger.info(`Datos recibidos:\n ${JSON.stringify(req.body)}`);
  const userId = getUserId();
  const { id } = req.body;

  try {
    const marketplace = await MarketplaceRepository.findById(id);
    if (!marketplace) {
      return res.status(400).json({ success: false, message: "Marketplace no encontrado" });
    }

    const adapter = PublishingAdapterFactory.getAdapter(marketplace, null, null, userId);
    if (!adapter) {
      return res.status(400).json({ success: false, message: "Adaptador no disponible" });
    }

    const status = await adapter.ensureValidCredentials();

    if (status.valid) {
      // Ya está conectado
      return res.status(201).json({ success: true, message: "Token refrescado correctamente" });
    } else if (status.auth_required) {
      // Devolver URL para redirección
      return res.status(409).json({
        success: false,
        auth_required: true,
        auth_url: status.auth_url,
        message: status.message
      });
    } else {
      return res.status(400).json({
        success: false,
        error: status.error || "Error al validar credenciales"
      });
    }

  } catch (error) {
    logger.error('MarketplaceCredentialController->refreshToken:', error.message);
    return res.status(500).json({ success: false, message: 'Error interno del servidor', details: error.message });
  }
},

  async update(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Actualiza credenciales de marketplace`);
    logger.info(JSON.stringify(req.body));

    const { id, access_token, refresh_token, expires_at, active, seller_email, seller_id, api_key, additional_data } = req.body;
    const metadata = getRequestMetadata(req);

    try {
      const existing = await MarketplaceCredentialRepository.findById(id);
      if (!existing) return res.status(404).json({ msg: "credentialNotFound" });

      // Verificar que el usuario sea dueño de la credencial
      if (existing.user_id !== req.user.id) {
        return res.status(403).json({ msg: "No autorizado" });
      }

      const updatedData = {
        id,
        user_id: req.user.id,
        marketplace_id: existing.marketplace_id,
        access_token,
        refresh_token,
        expires_at,
        active,
        seller_email,
        seller_id,
        api_key,
        additional_data
      };

      const credential = await MarketplaceCredentialRepository.createOrUpdate(updatedData);

      await LogRepository.create({
        user_id: metadata.user_id,
        action: 'marketplace_credential.update',
        description: `Credenciales actualizadas para marketplace ${credential.marketplace_id}`,
        ip_address: metadata.ip_address,
        user_agent: metadata.user_agent,
        status: 'success',
        meta: { id: credential.id }
      });

      const { access_token: _, refresh_token: __, ...safeCredential } = credential;
      res.status(200).json({ message: "Credenciales actualizadas correctamente", credential: safeCredential });
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
      res.status(500).json({ error: 'ServerError' });
    }
  },

  async show(req, res) {
    try {
      const { id } = req.params || req.body;
      if (!id) return res.status(400).json({ msg: 'ID requerido' });

      const credential = await MarketplaceCredentialRepository.findById(id);
      if (!credential) return res.status(404).json({ msg: "CredentialNotFound" });

      // Verificar propiedad
      if (credential.user_id !== req.user.id) {
        return res.status(403).json({ msg: "No autorizado" });
      }

      // ⚠️ Solo devolver lo necesario (sin tokens en frontend)
      const { access_token, refresh_token, ...safeCredential } = credential;
      res.status(200).json(safeCredential);
    } catch (error) {
      logger.error('MarketplaceCredentialController->show: ' + error.message);
      res.status(500).json({ error: 'ServerError' });
    }
  },

  async destroy(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Elimina credencial de marketplace`);

    const {id} =req.body;

    const metadata = getRequestMetadata(req);

    try {
      // 1. Buscar la credencial
      const credential = await MarketplaceCredentialRepository.findByDelete(id);
      if (!credential) return res.status(404).json({ msg: 'CredencialNotFound' });

      // 2. Eliminar la credencial usando el repositorio correcto
      await MarketplaceCredentialRepository.delete(credential); // <-- Aquí está el cambio

      // 3. Registrar el log de éxito
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
      // 4. Registrar el log de error
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