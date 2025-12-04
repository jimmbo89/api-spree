const BaseAdapter = require('./BaseAdapter');
const axios = require('axios');
const crypto = require('crypto');
const logger = require('../../../config/logger');
const { MarketplaceCredentialRepository } = require('../../repositories');

class FalabellaAdapter extends BaseAdapter {
  static supportsCategoryPrediction() {
  return false;
}
  async ensureValidCredentials() {
    this.credential = await MarketplaceCredentialRepository.findByMarketplaceAndContext(
      this.marketplaceId,
      this.companyId,
      this.branchId
    );
    logger.info('[FalabellaAdapter] Credenciales obtenidas:', JSON.stringify(this.credential));

    if (!this.credential || !this.credential.client_id || !this.credential.access_token) {
      throw new Error('falabella_credentials_missing: se requieren client_id y access_token');
    }
  }

  buildProductXml(product) {
    const description = product.description || '';
    const escapedDescription = description.includes('<')
      ? `<![CDATA[${description}]]>`
      : this.escapeXml(description);

    return `
<Product>
  <SellerSku>${this.escapeXml(product.sku)}</SellerSku>
  <Name>${this.escapeXml(product.productName)}</Name>
  <PrimaryCategory>${Number(product.PrimaryCategory)}</PrimaryCategory>
  <Description>${escapedDescription}</Description>
  <Brand>${this.escapeXml(product.brand)}</Brand>
  ${product.productId ? `<ProductId>${this.escapeXml(String(product.productId))}</ProductId>` : ''}
  <BusinessUnits>
    <BusinessUnit>
      <OperatorCode>facl</OperatorCode>
      <Price>${Number(product.price).toFixed(2)}</Price>
      <Stock>${Math.max(0, Math.round(Number(product.stock)))}</Stock>
      <Status>active</Status>
    </BusinessUnit>
  </BusinessUnits>
  <ProductData>
    <ConditionType>Nuevo</ConditionType>
    <PackageHeight>10</PackageHeight>
    <PackageWidth>10</PackageWidth>
    <PackageLength>10</PackageLength>
    <PackageWeight>0.5</PackageWeight>
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

  async publish(transformedProduct) {
    try {
      await this.ensureValidCredentials();

      const required = ['sku', 'productName', 'brand', 'price', 'stock', 'PrimaryCategory'];
      for (const field of required) {
        if (transformedProduct[field] == null || transformedProduct[field] === '') {
          const error = `Campo requerido por Falabella ausente o vacío: ${field}`;
          logger.error(`[FalabellaAdapter] ${error}`);
          return { success: false, error };
        }
      }

      if (isNaN(Number(transformedProduct.PrimaryCategory))) {
        const error = `PrimaryCategory debe ser un número entero, recibido: ${transformedProduct.PrimaryCategory}`;
        logger.error(`[FalabellaAdapter] ${error}`);
        return { success: false, error };
      }

      const productXml = this.buildProductXml(transformedProduct);
      const xmlRequest = `<?xml version="1.0" encoding="UTF-8"?>\n<Request>\n${productXml}\n</Request>`;

      // === Generar timestamp en formato ISO8601 sin segundos, zona UTC ===
      const timestamp = new Date().toISOString().substring(0, 16) + '+0000';

      // === Parámetros para firmar (incluyendo Format=XML) ===
      const paramsToSign = {
        Action: 'ProductCreate',
        UserID: this.credential.client_id.trim(),
        Version: '1.0',
        Timestamp: timestamp,
        Format: 'XML'
      };

      // Ordenar alfabéticamente
      const sortedKeys = Object.keys(paramsToSign).sort();
      const encodedPairs = sortedKeys.map(key =>
        `${this.rawurlencode(key)}=${this.rawurlencode(String(paramsToSign[key]))}`
      );
      const stringToSign = encodedPairs.join('&');

      const signature = crypto
        .createHmac('sha256', this.credential.access_token.trim())
        .update(stringToSign, 'utf8')
        .digest('hex');

      logger.info('[Falabella] stringToSign:');
      logger.info(stringToSign);
      logger.info('[Falabella] signature:');
      logger.info(signature);

      // === Construir URL con query string firmada ===
      const urlParams = {
        ...paramsToSign,
        Signature: signature
      };
      const urlSortedKeys = Object.keys(urlParams).sort();
      const urlQueryString = urlSortedKeys.map(key =>
        `${this.rawurlencode(key)}=${this.rawurlencode(String(urlParams[key]))}`
      ).join('&');

      const apiUrl = `https://sellercenter-api.falabella.com?${urlQueryString}`;

      logger.info('URL completa para Falabella:');
      logger.info(apiUrl);

      // === Enviar XML como cuerpo crudo ===
      const response = await axios.post(apiUrl, xmlRequest, {
        headers: {
          'Content-Type': 'application/xml; charset=UTF-8'
        },
        timeout: 15000
      });

      const responseBody = response.data;
      logger.info('[FalabellaAdapter] Respuesta API:');
      logger.info(responseBody);

      // === Parsear respuesta ===
      if (responseBody.includes('<SuccessResponse>')) {
        const requestIdMatch = responseBody.match(/<RequestId>([^<]+)<\/RequestId>/);
        const requestId = requestIdMatch ? requestIdMatch[1] : null;

        return {
          success: true,
          data: {
            id: transformedProduct.sku,
            permalink: apiUrl,
            request_id: requestId
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
        logger.debug('Cuerpo de error:', err.response.data);
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