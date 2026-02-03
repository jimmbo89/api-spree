const BaseAdapter = require('./BaseAdapter');
const axios = require('axios');
const crypto = require('crypto');
const logger = require('../../../config/logger');
const { MarketplaceCredentialRepository } = require('../../repositories');
const MarketplaceTransformer = require('../MarketplaceTransformer');

class FalabellaAdapter extends BaseAdapter {
  static supportsCategoryPrediction() {
  return false;
}

static getTransformer() {
    return MarketplaceTransformer; // genérico
  }
  async ensureValidCredentials() {
  this.credential = await MarketplaceCredentialRepository.findByMarketplaceAndUser(
    this.marketplaceId,
    this.userId
  );

  // Validar que tenga Seller ID (refresh_token) y API Key (access_token)
  if (!this.credential || !this.credential.refresh_token || !this.credential.access_token) {
    return {
      valid: false,
      auth_required: true,
      message: "Se requieren credenciales de Falabella (Seller ID y API Key)"
    };
  }

  return { valid: true };
}

 // FalabellaAdapter.js - Método buildProductXml()
buildProductXml(product) {
  // Validar campos obligatorios según documentación
  const description = product.description || 'Producto sin descripción';
  const escapedDescription = description.includes('<')
    ? `<![CDATA[${description}]]>`
    : this.escapeXml(description);

  // Package dimensions (requeridos por Falabella)
  const packageHeight = product.package_height || 10;
  const packageWidth = product.package_width || 10;  
  const packageLength = product.package_length || 10;
  const packageWeight = product.package_weight || 0.5;

  return `
<Product>
  <SellerSku>${this.escapeXml(product.sku)}</SellerSku>
  <Name>${this.escapeXml(product.productName)}</Name>
  <PrimaryCategory>${Number(product.PrimaryCategory)}</PrimaryCategory>
  <Description>${escapedDescription}</Description>
  <Brand>${this.escapeXml(product.brand)}</Brand>
  <BusinessUnits>
    <BusinessUnit>
      <OperatorCode>facl</OperatorCode>
      <Price>${Number(product.price).toFixed(2)}</Price>
      <Stock>${Math.max(0, Math.round(Number(product.stock)))}</Stock>
      <Status>active</Status>
    </BusinessUnit>
  </BusinessUnits>
  <ProductData>
    <ConditionType>New</ConditionType>
    <PackageHeight>${packageHeight}</PackageHeight>
    <PackageWidth>${packageWidth}</PackageWidth>
    <PackageLength>${packageLength}</PackageLength>
    <PackageWeight>${packageWeight}</PackageWeight>
  </ProductData>
</Product>
`.trim();
}

  escapeXml(str) {
    if (typeof str !== 'string') return String(str);
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  // Función reutilizable para encoding compatible con PHP rawurlencode (RFC 3986)
  rawurlencode(str) {
    return encodeURIComponent(str)
      .replace(/!/g, '%21')
      .replace(/'/g, '%27')
      .replace(/\(/g, '%28')
      .replace(/\)/g, '%29')
      .replace(/\*/g, '%2A')
      .replace(/~/g, '%7E');
  }

  // FalabellaAdapter.js - Método prepareProduct()
async prepareProduct(productData) {
  // Obtener categoría de Falabella desde los datos del producto
  const falabellaData = productData.falabella?.[this.marketplaceId];
  const categoryId = falabellaData?.category_id || null;

  const prepared = {
    ...productData,
    // Mapear campos específicos de Falabella
    sku: productData.sku || String(productData.id),
    productName: productData.name || productData.title || 'Producto sin nombre',
    brand: productData.brand || 'Generic',
    price: productData.price || 0,
    stock: productData.stock ?? productData.totalPublishingStock ?? 0,
    PrimaryCategory: categoryId, // ← Este debe venir de la configuración del producto
    description: productData.description || 'Producto sin descripción',
    productId: productData.id,
    // Campos adicionales para PackageData
    package_height: productData.height_cm || 10,
    package_width: productData.width_cm || 10,
    package_length: productData.length_cm || 10,
    package_weight: productData.weight_grams ? (productData.weight_grams / 1000) : 0.5
  };

  logger.info(`[Falabella Adapter] Producto preparado:`, JSON.stringify(prepared, null, 2));
  return prepared;
}

  /**
   * Validar producto para Falabella
   */
  validateProduct(product) {
    const errors = [];
    const required = ['sku', 'productName', 'brand', 'price', 'stock', 'PrimaryCategory'];

    for (const field of required) {
      if (product[field] == null || product[field] === '') {
        errors.push(`Campo requerido ausente: ${field}`);
      }
    }

    if (product.PrimaryCategory && isNaN(Number(product.PrimaryCategory))) {
      errors.push('PrimaryCategory debe ser un número entero');
    }

    if (product.price <= 0) {
      errors.push('price debe ser mayor a 0');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }
 // FalabellaAdapter.js - Método publish()
async publish(transformedProduct) {
  try {
    const credentialStatus = await this.ensureValidCredentials();
    if (!credentialStatus.valid) {
      return credentialStatus;
    }

    // Validar campos requeridos del producto
    const requiredFields = ['sku', 'productName', 'brand', 'price', 'stock', 'PrimaryCategory'];
    for (const field of requiredFields) {
      if (transformedProduct[field] == null || transformedProduct[field] === '') {
        const error = `Campo requerido por Falabella ausente: ${field}`;
        logger.error(`[FalabellaAdapter] ${error}`);
        return { success: false, error };
      }
    }

    if (isNaN(Number(transformedProduct.PrimaryCategory))) {
      const error = `PrimaryCategory debe ser un número entero`;
      logger.error(`[FalabellaAdapter] ${error}`);
      return { success: false, error };
    }

    // Construir XML según documentación oficial
    const productXml = this.buildProductXml(transformedProduct);
    const xmlRequest = `<?xml version="1.0" encoding="UTF-8"?>\n<Request>\n${productXml}\n</Request>`;

    // Generar timestamp ISO8601 UTC
    const timestamp = new Date().toISOString().replace(/:\d+\.\d+Z$/, '+0000');

    // Parámetros para firma (según documentación Falabella)
    const paramsToSign = {
      Action: 'ProductCreate',
      UserID: 'yasmany@klint.cl',
      Version: '1.0',
      Timestamp: timestamp,
      Format: 'XML'
    };

    // Ordenar y firmar
    const sortedKeys = Object.keys(paramsToSign).sort();
    const encodedPairs = sortedKeys.map(key =>
      `${this.rawurlencode(key)}=${this.rawurlencode(String(paramsToSign[key]))}`
    );
    const stringToSign = encodedPairs.join('&');

    // Firmar con API Key (access_token)
    const signature = crypto
      .createHmac('sha256', this.credential.access_token.trim())
      .update(stringToSign, 'utf8')
      .digest('hex');

    // Construir URL
    const urlParams = {
      ...paramsToSign,
      Signature: signature
    };
    
    const urlSortedKeys = Object.keys(urlParams).sort();
    const urlQueryString = urlSortedKeys.map(key =>
      `${this.rawurlencode(key)}=${this.rawurlencode(String(urlParams[key]))}`
    ).join('&');

    const apiUrl = `https://sellercenter-api.falabella.com?${urlQueryString}`;

    // Enviar solicitud
    const response = await axios.post(apiUrl, xmlRequest, {
      headers: {
        'Content-Type': 'application/xml; charset=UTF-8'
      },
      timeout: 15000
    });

    const responseBody = response.data;

    // Parsear respuesta
    if (responseBody.includes('<SuccessResponse>')) {
      const requestIdMatch = responseBody.match(/<RequestId>([^<]+)<\/RequestId>/);
      return {
        success: true,
        external_id: transformedProduct.sku,
        data: {
          id: transformedProduct.sku,
          permalink: apiUrl,
          request_id: requestIdMatch ? requestIdMatch[1] : null
        }
      };
    } else if (responseBody.includes('<ErrorResponse>')) {
      const errorMsgMatch = responseBody.match(/<ErrorMessage>([^<]+)<\/ErrorMessage>/);
      const errorMsg = errorMsgMatch ? errorMsgMatch[1] : 'Error desconocido';
      logger.error(`[FalabellaAdapter] Error API: ${errorMsg}`);
      return { success: false, error: errorMsg };
    } else {
      logger.warn('[FalabellaAdapter] Respuesta inesperada:', responseBody);
      return { success: false, error: 'Respuesta inesperada de la API de Falabella' };
    }

  } catch (err) {
    let errorMsg = 'Error desconocido al publicar en Falabella';
    if (err.response) {
      errorMsg = `Error HTTP ${err.response.status}: ${err.response.statusText}`;
      logger.error(`[FalabellaAdapter] Error HTTP: ${errorMsg}`);
    } else if (err.request) {
      errorMsg = 'No se recibió respuesta de Falabella (timeout o red)';
      logger.error(`[FalabellaAdapter] Error de red: ${errorMsg}`);
    } else {
      errorMsg = err.message || 'Error interno';
      logger.error(`[FalabellaAdapter] Error local: ${errorMsg}`);
    }
    return { success: false, error: errorMsg };
  }
}

  static supports(marketplace) {
    return marketplace.domain?.includes('falabella.cl');
  }
}

module.exports = FalabellaAdapter;