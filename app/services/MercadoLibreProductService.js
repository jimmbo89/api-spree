'use strict';

const axios = require('axios');
const PublishingAdapterFactory = require('./adapters/PublishingAdapterFactory');
const {
  MarketplaceCredentialRepository,
  UserMarketplaceCredentialRepository
} = require('../repositories');

const ML_API = 'https://api.mercadolibre.com';
const REQUEST_TIMEOUT = 15000;

function normalizedNumber(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function isMercadoLibreCredential(credential) {
  const domain = String(
    credential?.marketplace?.domain || credential?.domain || ''
  ).toLowerCase();

  return domain.includes('mercadolibre');
}

function errorWithStatus(message, statusCode, code, details = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  if (details) error.details = details;
  return error;
}

class MercadoLibreProductService {
  static async userCanUseCredential({ credential, user, companyId }) {
    if (user?.role_id) return true;

    if (Number(credential.user_id) === Number(user?.id)) {
      return true;
    }

    return UserMarketplaceCredentialRepository.hasActiveAccess({
      userId: user?.id,
      marketplaceCredentialId: credential.id,
      companyId
    });
  }

  static async resolveCredential({ credentialId, companyId, user }) {
    const normalizedCompanyId = normalizedNumber(companyId);
    if (!normalizedCompanyId) {
      throw errorWithStatus(
        'No se pudo determinar la empresa para consultar Mercado Libre',
        400,
        'company_id_required'
      );
    }

    if (credentialId !== undefined && credentialId !== null) {
      const credential = await MarketplaceCredentialRepository.findById(credentialId);

      if (!credential) {
        throw errorWithStatus(
          'La credencial de Mercado Libre no existe',
          404,
          'mercadolibre_credential_not_found'
        );
      }

      if (Number(credential.company_id) !== normalizedCompanyId) {
        throw errorWithStatus(
          'La credencial no pertenece a la empresa indicada',
          403,
          'mercadolibre_credential_forbidden'
        );
      }

      if (!credential.active || !credential.marketplace?.active) {
        throw errorWithStatus(
          'La credencial de Mercado Libre está inactiva',
          409,
          'mercadolibre_credential_inactive'
        );
      }

      if (!isMercadoLibreCredential(credential)) {
        throw errorWithStatus(
          'La credencial indicada no corresponde a Mercado Libre',
          422,
          'invalid_mercadolibre_credential'
        );
      }

      const allowed = await this.userCanUseCredential({
        credential,
        user,
        companyId: normalizedCompanyId
      });

      if (!allowed) {
        throw errorWithStatus(
          'No tienes acceso a esta credencial de Mercado Libre',
          403,
          'mercadolibre_credential_forbidden'
        );
      }

      return credential;
    }

    const credentials = await MarketplaceCredentialRepository.findByCompany(
      normalizedCompanyId
    );

    for (const credential of credentials) {
      if (!credential.active || !credential.marketplace?.active) continue;
      if (!isMercadoLibreCredential(credential)) continue;

      const allowed = await this.userCanUseCredential({
        credential,
        user,
        companyId: normalizedCompanyId
      });

      if (allowed) return credential;
    }

    throw errorWithStatus(
      'No existe una credencial activa de Mercado Libre autorizada para esta empresa y usuario',
      409,
      'mercadolibre_credential_required'
    );
  }

  static async fetchProduct({ productId, credential, companyId, userId }) {
    const marketplace = credential.marketplace || {
      id: credential.marketplace_id,
      domain: credential.domain,
      name: credential.marketplace_name
    };

    const adapter = PublishingAdapterFactory.getAdapter(
      marketplace,
      companyId,
      null,
      userId,
      credential
    );

    const credentialStatus = await adapter.ensureValidCredentials();
    if (!credentialStatus?.valid) {
      throw errorWithStatus(
        credentialStatus?.message || 'Mercado Libre requiere autorización',
        401,
        credentialStatus?.error || 'mercadolibre_auth_required',
        {
          auth_required: Boolean(credentialStatus?.auth_required),
          auth_url: credentialStatus?.auth_url || null
        }
      );
    }

    const activeCredential = adapter.credential || credential;
    const encodedProductId = encodeURIComponent(String(productId).trim());
    const endpoint = `${ML_API}/products/${encodedProductId}`;

    try {
      const response = await axios.get(endpoint, {
        headers: {
          Authorization: `Bearer ${activeCredential.access_token}`,
          Accept: 'application/json'
        },
        timeout: REQUEST_TIMEOUT
      });

      return {
        resource: 'products',
        product_id: String(productId).trim(),
        credential: {
          id: activeCredential.id || credential.id,
          marketplace_id: activeCredential.marketplace_id || credential.marketplace_id,
          company_id: activeCredential.company_id || credential.company_id,
          seller_id: activeCredential.seller_id || credential.seller_id || null
        },
        marketplace_status: response.status,
        data: response.data
      };
    } catch (error) {
      const marketplaceStatus = Number(error.response?.status);
      const marketplaceResponse = error.response?.data || null;

      const statusCode = [400, 401, 403, 404, 429].includes(marketplaceStatus)
        ? marketplaceStatus
        : 502;

      throw errorWithStatus(
        marketplaceResponse?.message
          || `Mercado Libre respondió con estado ${marketplaceStatus || 'desconocido'}`,
        statusCode,
        marketplaceResponse?.error || 'mercadolibre_product_request_failed',
        {
          marketplace_status: marketplaceStatus || null,
          marketplace_response: marketplaceResponse
        }
      );
    }
  }

  static async getProduct({ productId, resource, credentialId, companyId, user }) {
    if ((resource || 'products') !== 'products') {
      throw errorWithStatus(
        'El recurso soportado para este endpoint es products',
        400,
        'unsupported_mercadolibre_resource'
      );
    }

    const credential = await this.resolveCredential({
      credentialId,
      companyId,
      user
    });

    return this.fetchProduct({
      productId,
      credential,
      companyId,
      userId: user?.id
    });
  }
}

module.exports = MercadoLibreProductService;
