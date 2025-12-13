// controllers/MarketplaceCredentialController.js
const logger = require('../../config/logger');
const {
  MarketplaceCredentialRepository,
  MarketplaceRepository,
  CompanyRepository,
  BranchRepository,
  LogRepository
} = require('../repositories');
const { getRequestMetadata } = require('../util/requestUtil');

const MarketplaceCredentialController = {

  async index(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Lista credenciales por contexto`);
    const { company_id, branch_id, marketplace_id } = req.body;
    const metadata = getRequestMetadata(req);

    try {
      
      if (company_id) {
        // Validar que la empresa exista
        const company = await CompanyRepository.findById(company_id);
        if (!company) {
          return res.status(400).json({ 
            success: false, 
            message: "Empresa no encontrada" 
          });
        }
      }
      
      if (branch_id) {
        // Validar que la sucursal exista
        const branch = await BranchRepository.findById(branch_id);
        if (!branch) {
          return res.status(400).json({ 
            success: false, 
            message: "Sucursal no encontrada" 
          });
        }
      }      

      // Validar que al menos uno de los dos (company_id o branch_id) esté presente
      if (!company_id && !branch_id) {
        return res.status(400).json({ 
          success: false, 
          message: "Debe proporcionar al menos company_id o branch_id" 
        });
      }

      const credentials = await MarketplaceCredentialRepository.findByContext(
      company_id, 
      branch_id, 
      marketplace_id
    );
     
      // Transformar resultados
      const transformedCredentials = credentials.map(credential => {
      // Ocultar client_secret real
      if (credential.client_secret) {
        credential.has_client_secret = true;
        credential.client_secret = '••••••••';
      } else {
        credential.has_client_secret = false;
        credential.client_secret = null;
      }
      
      return credential;
    });

      res.status(200).json({
        success: true,
        message: "Credenciales obtenidas exitosamente",
        credentials: transformedCredentials,
        count: transformedCredentials.length
      });

    } catch (error) {
      logger.error('MarketplaceCredentialController->index: ' + error.message);
      res.status(500).json({ 
        success: false, 
        error: 'Error del servidor' 
      });
    }
  },
  async store(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Guarda credenciales de marketplace`);
    const { marketplace_id, company_id, branch_id } = req.body;
    const metadata = getRequestMetadata(req);

    try {
      const marketplace = await MarketplaceRepository.findById(marketplace_id);
      if (!marketplace) return res.status(400).json({ msg: "marketplaceNotFound" });

      if (company_id) {
        const company = await CompanyRepository.findById(company_id);
        if (!company) return res.status(400).json({ msg: "companyNotFound" });
      }
      if (branch_id) {
        const branch = await BranchRepository.findById(branch_id);
        if (!branch) return res.status(400).json({ msg: "branchNotFound" });
      }

      const credential = await MarketplaceCredentialRepository.createOrUpdate(req.body);

      await LogRepository.create({
        user_id: metadata.user_id,
        action: 'marketplace_credential.create',
        description: `Credenciales guardadas para marketplace ${marketplace_id}`,
        ip_address: metadata.ip_address,
        user_agent: metadata.user_agent,
        status: 'success',
        meta: { id: credential.id }
      });

      res.status(201).json({ message: "Credenciales guardadas", credential: { id: credential.id } });
    } catch (error) {
      await LogRepository.create({
        user_id: metadata?.user_id,
        action: 'marketplace_credential.create',
        description: `Error: ${error.message}`,
        ip_address: metadata?.ip_address,
        user_agent: metadata?.user_agent,
        status: 'error',
        meta: null
      });
      logger.error('MarketplaceCredentialController->store: ' + error.message);
      res.status(500).json({ error: 'ServerError' });
    }
  },

  async update(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Actualiza credenciales de marketplace`);
    logger.info(JSON.stringify(req.body));
    const { marketplace_id, company_id, branch_id, id, ...credentialFields } = req.body;
    const metadata = getRequestMetadata(req);

    try {
      // Validar que la credencial exista
      const existing = await MarketplaceCredentialRepository.findById(id);
      if (!existing) {
        return res.status(404).json({ msg: "credentialNotFound" });
      }

      // Validar marketplace
       if (company_id !== undefined || branch_id !== undefined) {
      const marketplace = await MarketplaceRepository.findById(marketplace_id || existing.marketplace_id);
      if (!marketplace) return res.status(400).json({ msg: "marketplaceNotFound" });
       }
      // Validar contexto si se está cambiando
      if (company_id !== undefined || branch_id !== undefined) {
        if (company_id) {
          const company = await CompanyRepository.findById(company_id);
          if (!company) return res.status(400).json({ msg: "companyNotFound" });
        }
        if (branch_id) {
          const branch = await BranchRepository.findById(branch_id);
          if (!branch) return res.status(400).json({ msg: "branchNotFound" });
        }
      }

      // Construir payload completo para actualizar
      const updatedData = {
        id, // necesario para que upsert actualice el registro correcto
        marketplace_id: marketplace_id ?? existing.marketplace_id,
        company_id: company_id ?? existing.company_id,
        branch_id: branch_id ?? existing.branch_id,
        ...credentialFields
      };

      if (typeof updatedData.expires_at === 'number') {
        updatedData.expires_at = new Date(Date.now() + updatedData.expires_at);
      }

      // Validación de contexto (company_id XOR branch_id)
      if (
        (updatedData.company_id && updatedData.branch_id) ||
        (!updatedData.company_id && !updatedData.branch_id)
      ) {
        return res.status(400).json({
          msg: "Debe proporcionar exactamente company_id O branch_id"
        });
      }

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

      res.status(200).json({
        message: "Credenciales actualizadas correctamente",
        credential: { id: credential.id }
      });
    } catch (error) {
      await LogRepository.create({
        user_id: metadata?.user_id,
        action: 'marketplace_credential.update',
        description: `Error: ${error.message}`,
        ip_address: metadata?.ip_address,
        user_agent: metadata?.user_agent,
        status: 'error',
        meta: { id }
      });
      logger.error('MarketplaceCredentialController->update: ' + error.message);
      res.status(500).json({ error: 'ServerError' });
    }
  },

  async show(req, res) {
    try {
      const { marketplace_id, company_id, branch_id } = req.body;
      const credential = await MarketplaceCredentialRepository.findByMarketplaceAndContext(
        marketplace_id,
        company_id,
        branch_id
      );
      if (!credential) return res.status(404).json({ msg: "CredentialNotFound" });

      // ❌ Nunca devolver secrets en la respuesta
      res.status(200).json({
        id: credential.id,
        marketplace_id: credential.marketplace_id,
        company_id: credential.company_id,
        branch_id: credential.branch_id,
        client_id: credential.client_id,
        client_secret: credential.client_secret,
        redirect_uri: credential.redirect_uri,
        expires_at: credential.expires_at,
        scopes: credential.scopes,
        active: credential.active
      });
    } catch (error) {
      logger.error('MarketplaceCredentialController->show: ' + error.message);
      res.status(500).json({ error: 'ServerError' });
    }
  }
};

module.exports = MarketplaceCredentialController;