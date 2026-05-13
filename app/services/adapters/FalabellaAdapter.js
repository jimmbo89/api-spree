// src/services/adapters/FalabellaAdapter.js
const BaseAdapter = require('./BaseAdapter');
const axios = require('axios');
const crypto = require('crypto');
const { parseStringPromise } = require('xml2js');
const logger = require('../../../config/logger');
const { MarketplaceCredentialRepository } = require('../../repositories');
const MarketplaceTransformerFalabella = require('../MarketplaceTransformerFalabella');

class FalabellaAdapter extends BaseAdapter {
  static supportsCategoryPrediction() {
    return false;
  }

  static getTransformer() {
    return MarketplaceTransformerFalabella; // 🔑 Usar transformer específico
  }

    async ensureValidCredentials() {
    // ← NUEVO: Si hay credentialId, buscar por ID específico
    if (this.credentialId) {
    if (typeof this.credentialId === 'object' && this.credentialId !== null) {
      // Ya es el objeto completo
      this.credential = this.credentialId;
    } else {
      // Es un ID, buscar en repositorio
      this.credential = await MarketplaceCredentialRepository.findById(this.credentialId);
    }
  } else {
    // Fallback al comportamiento original
    this.credential = await MarketplaceCredentialRepository.findByMarketplaceAndUser(
      this.marketplaceId,
      this.userId
    );
  }


    if (!this.credential || !this.credential.seller_email || !this.credential.api_key) {
      return {
        valid: false,
        auth_required: true,
        message: "Se requieren credenciales de Falabella (Seller Email y API Key)"
      };
    }

    return { valid: true };
  }

  // ✅ RFC 3986 encode (igual que en GetCategorySuggestion que funcionó)
  rfc3986Encode(str) {
    return encodeURIComponent(str)
      .replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  }

  // ✅ Timestamp en formato ISO 8601 con zona horaria -03:00 (Chile)
  timestampMinus03(date = new Date()) {
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
           `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}-03:00`;
  }

  // ✅ XML escaping seguro
  escapeXml(str) {
    if (typeof str !== 'string') return String(str || '');
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  coerceNumber(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') {
      const parsed = Number(value.trim().replace(',', '.'));
      return Number.isFinite(parsed) ? parsed : null;
    }
    if (typeof value === 'object' && value !== null && 'value' in value) {
      return this.coerceNumber(value.value);
    }
    return null;
  }

  toCentimeters(measurement) {
    if (!measurement) return null;
    const value = this.coerceNumber(measurement);
    if (value === null) return null;
    const unit = String(measurement?.unit || 'cm').toLowerCase();

    switch (unit) {
      case 'm': return value * 100;
      case 'mm': return value / 10;
      case 'in': return value * 2.54;
      case 'ft': return value * 30.48;
      case 'cm':
      default: return value;
    }
  }

  toKilograms(measurement) {
    if (!measurement) return null;
    const value = this.coerceNumber(measurement);
    if (value === null) return null;
    const unit = String(measurement?.unit || 'g').toLowerCase();

    switch (unit) {
      case 'kg': return value;
      case 'g': return value / 1000;
      case 'lb': return value * 0.453592;
      case 'oz': return value * 0.0283495;
      default: return value;
    }
  }

  resolvePackageMeasurements(productData) {
    const productMeasurements = productData?.product_measurements || {};
    const dimensions = productMeasurements?.dimensions || {};

    const heightFromMeasurements = this.toCentimeters(dimensions.height);
    const widthFromMeasurements = this.toCentimeters(dimensions.width);
    const lengthFromMeasurements = this.toCentimeters(dimensions.length ?? dimensions.depth);
    const weightFromMeasurements = this.toKilograms(productMeasurements?.weight);

    const legacyHeight = this.coerceNumber(productData?.height_cm);
    const legacyWidth = this.coerceNumber(productData?.width_cm);
    const legacyLength = this.coerceNumber(productData?.length_cm);
    const legacyWeightKg = productData?.weight_grams != null
      ? this.coerceNumber(productData.weight_grams) / 1000
      : null;

    return {
      package_height: heightFromMeasurements ?? legacyHeight ?? 10,
      package_width: widthFromMeasurements ?? legacyWidth ?? 10,
      package_length: lengthFromMeasurements ?? legacyLength ?? 10,
      package_weight: weightFromMeasurements ?? legacyWeightKg ?? 0.5
    };
  }

  buildSignedQuery(params) {
    const sortedKeys = Object.keys(params).sort();
    const canonicalQuery = sortedKeys
      .map(k => `${this.rfc3986Encode(k)}=${this.rfc3986Encode(String(params[k]))}`)
      .join('&');

    const signatureHex = crypto
      .createHmac('sha256', this.credential.api_key.trim())
      .update(canonicalQuery, 'utf8')
      .digest('hex');

    return {
      canonicalQuery,
      signatureHex,
      signatureEncoded: this.rfc3986Encode(signatureHex)
    };
  }

  toArray(value) {
    if (value === null || value === undefined) return [];
    return Array.isArray(value) ? value : [value];
  }

  getFirstDefined(...values) {
    for (const value of values) {
      if (value !== null && value !== undefined) {
        if (Array.isArray(value)) {
          if (value.length > 0) return value[0];
          continue;
        }
        return value;
      }
    }
    return null;
  }

  resolveMarketplaceProductId(product) {
    const candidates = [
      product?.ProductId,
      product?.productIdentifier,
      product?.gtin,
      product?.ean,
      product?.upc,
      product?.isbn
    ];

    for (const candidate of candidates) {
      if (candidate === null || candidate === undefined) continue;
      const normalized = String(candidate).trim();
      if (!normalized) continue;
      if (normalized === String(product?.productId || '').trim()) continue;
      if (/^[0-9A-Za-z\-]{8,32}$/.test(normalized)) {
        return normalized;
      }
    }

    return null;
  }

  extractFeedNode(body) {
    if (!body || typeof body !== 'object') return null;

    return this.getFirstDefined(
      body.FeedDetail,
      body.Feed,
      body.Feeds?.FeedDetail,
      body.Feeds?.Feed,
      body.FeedDetails?.FeedDetail,
      body.FeedDetails?.Feed
    );
  }

  unwrapFeedSection(section) {
    if (!section || typeof section !== 'object' || Array.isArray(section)) {
      return section;
    }

    if (section.Error !== undefined) return section.Error;
    if (section.Errors !== undefined) return section.Errors;
    if (section.Warning !== undefined) return section.Warning;
    if (section.Warnings !== undefined) return section.Warnings;
    if (section.FeedError !== undefined) return section.FeedError;
    if (section.FeedErrors !== undefined) return section.FeedErrors;
    if (section.FeedWarning !== undefined) return section.FeedWarning;
    if (section.FeedWarnings !== undefined) return section.FeedWarnings;
    if (section.Item !== undefined) return section.Item;

    return section;
  }

  async parseFeedStatusResponse(responseData) {
    let parsed = responseData;

    if (typeof parsed === 'string') {
      const raw = parsed.trim();
      if (raw.startsWith('<')) {
        parsed = await parseStringPromise(raw, {
          explicitArray: false,
          trim: true
        });
      } else {
        try {
          parsed = JSON.parse(raw);
        } catch (error) {
          logger.warn(`[FalabellaAdapter] FeedStatus string no es XML ni JSON válido: ${raw.substring(0, 300)}`);
          return null;
        }
      }
    }

    const success = parsed?.SuccessResponse || parsed?.successResponse || parsed;
    const body = success?.Body || success?.body || parsed?.Body || parsed?.body;
    const feedDetail = this.extractFeedNode(body);

    if (feedDetail) {
      return {
        FeedID: this.getFirstDefined(feedDetail.Feed, feedDetail.FeedID, feedDetail.FeedId),
        Status: this.getFirstDefined(feedDetail.Status, feedDetail.FeedStatus),
        Action: this.getFirstDefined(feedDetail.Action, feedDetail.RequestAction),
        CreationDate: this.getFirstDefined(feedDetail.CreationDate, feedDetail.CreatedAt),
        UpdatedDate: this.getFirstDefined(feedDetail.UpdatedDate, feedDetail.UpdatedAt),
        Source: this.getFirstDefined(feedDetail.Source, feedDetail.Channel),
        TotalRecords: this.getFirstDefined(feedDetail.TotalRecords, feedDetail.TotalRecord, feedDetail.RecordsTotal),
        ProcessedRecords: this.getFirstDefined(feedDetail.ProcessedRecords, feedDetail.ProcessedRecord, feedDetail.RecordsProcessed),
        FailedRecords: this.getFirstDefined(feedDetail.FailedRecords, feedDetail.FailedRecord, feedDetail.RecordsFailed),
        FeedErrors: this.unwrapFeedSection(feedDetail.FeedErrors || feedDetail.Errors || feedDetail.Error),
        FeedWarnings: this.unwrapFeedSection(feedDetail.FeedWarnings || feedDetail.Warnings || feedDetail.Warning)
      };
    }

    logger.warn(`[FalabellaAdapter] FeedStatus respuesta no reconocida: ${JSON.stringify(parsed).substring(0, 1000)}`);
    return null;
  }

  async fetchFeedStatus(feedId) {
    const params = {
      Action: 'FeedStatus',
      FeedID: feedId,
      Format: 'JSON',
      Timestamp: this.timestampMinus03(),
      UserID: this.credential.seller_email.trim(),
      Version: '1.0'
    };

    const { canonicalQuery, signatureEncoded } = this.buildSignedQuery(params);
    const apiUrl = `https://sellercenter-api.falabella.com?${canonicalQuery}&Signature=${signatureEncoded}`;
    const response = await axios.get(apiUrl, { timeout: 15000 });
    const rawResponse = typeof response.data === 'string'
      ? response.data
      : JSON.stringify(response.data);

    logger.info(`[FalabellaAdapter] FeedStatus raw response (${feedId}):`);
    logger.info(rawResponse);

    const parsedFeed = await this.parseFeedStatusResponse(response.data);

    logger.info(`[FalabellaAdapter] FeedStatus parsed response (${feedId}):`);
    logger.info(JSON.stringify(parsedFeed));

    return parsedFeed;
  }

  normalizeFeedMessages(items) {
    if (!items) return [];

    let list = this.toArray(items);

    if (list.length === 1 && list[0] && typeof list[0] === 'object' && !Array.isArray(list[0])) {
      const nested = this.unwrapFeedSection(list[0]);
      if (nested !== list[0]) {
        list = this.toArray(nested);
      }
    }

    return list
      .filter(Boolean)
      .map(item => {
        if (typeof item === 'string') {
          return { field: null, sku: null, message: item, value: null };
        }

        return {
          field: item.Field || item.Attribute || item.Name || null,
          sku: item.SellerSku || item.SKU || item.SellerSKU || null,
          message: item.Message || item.Error || item.Warning || item.Description || item.Detail || 'Sin detalle',
          value: item.Value || item.Code || null
        };
      });
  }

  async pollFeedStatus(feedId, options = {}) {
    const maxAttempts = Number(options.maxAttempts || process.env.FALABELLA_FEED_STATUS_MAX_ATTEMPTS || 10);
    const intervalMs = Number(options.intervalMs || process.env.FALABELLA_FEED_STATUS_INTERVAL_MS || 3000);
    let lastFeed = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      lastFeed = await this.fetchFeedStatus(feedId);

      const currentStatus = String(lastFeed?.Status || '').toLowerCase();
      logger.info(`[FalabellaAdapter] Feed ${feedId} intento ${attempt}/${maxAttempts}: ${currentStatus || 'unknown'}`);

      if (['finished', 'error', 'canceled'].includes(currentStatus)) {
        return { feed: lastFeed, timedOut: false };
      }

      if (attempt < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, intervalMs));
      }
    }

    return { feed: lastFeed, timedOut: true };
  }

  buildFeedDrivenResult({ transformedProduct, requestId, feed, timedOut }) {
    const feedStatus = feed?.Status || 'unknown';
    const warnings = this.normalizeFeedMessages(feed?.FeedWarnings);
    const errors = this.normalizeFeedMessages(feed?.FeedErrors);
    const processedRecords = parseInt(feed?.ProcessedRecords || '0', 10);
    const failedRecords = parseInt(feed?.FailedRecords || '0', 10);
    const totalRecords = parseInt(feed?.TotalRecords || '0', 10);
    const feedData = {
      id: transformedProduct.sku,
      request_id: requestId,
      feed_id: feed?.FeedID || requestId,
      feed_status: feedStatus,
      action: feed?.Action || 'ProductCreate',
      source: feed?.Source || 'api',
      total_records: totalRecords,
      processed_records: processedRecords,
      failed_records: failedRecords,
      category_id: transformedProduct.PrimaryCategory,
      category_name: transformedProduct.categoryName,
      warnings,
      errors
    };

    if (timedOut) {
      return {
        success: false,
        error: 'Falabella sigue procesando el feed; no se pudo confirmar el estado final dentro del tiempo de espera',
        details: {
          error_code: 'feed_status_timeout',
          pending_review: true,
          feed: feedData
        },
        status_code: 202,
        external_id: transformedProduct.sku,
        data: feedData
      };
    }

    if (String(feedStatus).toLowerCase() === 'finished') {
      logger.info(`[FalabellaAdapter] Feed ${requestId} finalizado. Totales=${totalRecords} procesados=${processedRecords} fallidos=${failedRecords} warnings=${warnings.length} errors=${errors.length}`);

      if (failedRecords > 0 || errors.length > 0) {
        const errorMessage = errors.length > 0
          ? errors.map(item => item?.message).filter(Boolean).join(' | ')
          : 'Falabella rechazó o procesó con errores la creación del producto';

        return {
          success: false,
          error: errorMessage,
          details: {
            error_code: 'feed_failed',
            feed: feedData
          },
          external_id: transformedProduct.sku,
          data: feedData
        };
      }

      if (warnings.length > 0) {
        logger.warn(`[FalabellaAdapter] Producto publicado con advertencias confirmadas por FeedStatus`, warnings);
        return {
          success: true,
          external_id: transformedProduct.sku,
          has_warnings: true,
          warnings,
          data: feedData
        };
      }

      logger.info(`[FalabellaAdapter] Producto publicado exitosamente según FeedStatus`);
      return {
        success: true,
        external_id: transformedProduct.sku,
        data: feedData
      };
    }

    return {
      success: false,
      error: `Falabella devolvió estado final no exitoso para el feed: ${feedStatus}`,
      details: {
        error_code: 'feed_not_successful',
        feed: feedData
      },
      external_id: transformedProduct.sku,
      data: feedData
    };
  }
getFalabellaConfig(productData) {
  const falabellaConfigs = productData?.falabella;
  if (!falabellaConfigs || typeof falabellaConfigs !== 'object') {
    return null;
  }

  const candidateKeys = [
    this.credentialId,
    String(this.credentialId),
    Number.isFinite(Number(this.credentialId)) ? Number(this.credentialId) : null,
    this.marketplaceId,
    String(this.marketplaceId),
    Number.isFinite(Number(this.marketplaceId)) ? Number(this.marketplaceId) : null
  ].filter(value => value !== null && value !== undefined && value !== '');

  for (const key of candidateKeys) {
    if (Object.prototype.hasOwnProperty.call(falabellaConfigs, key)) {
      return falabellaConfigs[key];
    }
  }

  const configs = Object.values(falabellaConfigs).filter(item => item && typeof item === 'object');
  return configs[0] || null;
}

// ✅ Usar categoría marketplace-específica, no categoría general de Spree
getFalabellaCategory(productData) {
  const falabellaData = this.getFalabellaConfig(productData);
  if (!falabellaData) {
    return null;
  }

  const categoryId =
    falabellaData?.category?.category_id ||
    falabellaData?.category?.id ||
    falabellaData?.category_id ||
    null;

  if (!categoryId) {
    return null;
  }

  const categoryName =
    falabellaData?.category?.category_name ||
    falabellaData?.category?.name ||
    falabellaData?.category_name ||
    '';

  return {
    id: categoryId,
    name: categoryName
  };
}

// 🔑 NUEVO MÉTODO: Transformar imágenes a formato compatible con Falabella
// 🔑 MÉTODO COMPLETO: Transformar y normalizar imágenes a formato compatible con Falabella
_transformImages(images = []) {
  // ✅ Helper interno para normalizar una URL de imagen (igual que en frontend)
  const normalizeImageUrl = (url) => {
    if (!url || typeof url !== 'string') {
      return 'https://via.placeholder.com/600x600/e74c3c/ffffff?text=Error+URL';
    }
    
    url = url.trim();
    
    // ✅ Si ya es URL absoluta, retornarla tal cual
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return url;
    }
    
    // ✅ Obtener base URL desde variables de entorno o fallback
    const baseUrl = process.env.APP_URL || 'https://spree.api.klint.cl/api';
    
    // ✅ Remover slash inicial si existe
    if (url.startsWith('/')) {
      url = url.substring(1);
    }
    
    // ✅ Si la URL ya contiene la ruta de imágenes, construirla correctamente
    if (url.includes('warehouse_products/') || url.includes('products/')) {
      return `${baseUrl}/images/${url}`;
    }
    
    // ✅ Fallback: asumir que es una ruta relativa y prefijar con /images/
    return `${baseUrl}/images/${url}`;
  };

  // ✅ Validar entrada: si no es array, retornar array vacío
  if (!Array.isArray(images)) {
    return [];
  }
  
  // ✅ Procesar cada imagen: filtrar, normalizar y deduplicar
  const processed = images
    .filter(img => {
      // ✅ Filtrar null, undefined, strings vacíos o no-string
      return img && typeof img === 'string' && img.trim() !== '';
    })
    .map(img => {
      // ✅ Normalizar URL de cada imagen
      return normalizeImageUrl(img.trim());
    })
    .filter((url, index, self) => {
      // ✅ Eliminar duplicados manteniendo el orden original
      return self.indexOf(url) === index;
    });
  
  // ✅ Retornar máximo 10 imágenes (límite típico de marketplaces)
  return processed.slice(0, 10);
}
// ✅ Preparar producto con datos específicos de Falabella - VERSIÓN CORREGIDA
async prepareProduct(productData) {
  // Extraer categoría de Falabella usando credentialId
  const category = this.getFalabellaCategory(productData);
  
  if (!category?.id) {
    throw new Error(`Categoría de Falabella no encontrada para el producto ${productData.id}.
      Debes asignar una categoría mediante la API de sugerencias primero.`);
  }

  // Obtener primer variante con precio válido para cálculos
  const validVariant = productData.variants?.find(v => v.price > 0 && v.publish) ||
                       productData.variants?.[0] ||
                       { price: productData.price || 0, publishStock: productData.stock || 0 };

  // 🔑🔑 EXTRAER ATRIBUTOS: Priorizar falabella[credentialId].attributes, fallback a category.attributes
  let attributes = [];
  
  // ✅ PRIMERO: Intentar obtener desde falabella[credentialId].attributes (configuración manual del usuario)
  const falabellaConfig = this.getFalabellaConfig(productData);
  if (falabellaConfig?.attributes && Array.isArray(falabellaConfig.attributes) && falabellaConfig.attributes.length > 0) {
    attributes = falabellaConfig.attributes.map(attr => ({
      id: attr.id,
      name: attr.name,
      value_id: attr.value_id,
      value_name: attr.value_name,
      value: attr.value_name || attr.value_id, // Fallback para compatibilidad con transformers legacy
      example_value: attr.example_value || null
    }));
  }
  // ✅ SEGUNDO: Fallback a category.attributes (auto-asignación automática desde sugerencias)
  else if (falabellaConfig?.category?.attributes && Array.isArray(falabellaConfig.category.attributes) && falabellaConfig.category.attributes.length > 0) {
    attributes = falabellaConfig.category.attributes.map(attr => ({
      id: attr.id,
      name: attr.name,
      value_id: attr.value_id,
      value_name: attr.value_name,
      value: attr.value_name || attr.value_id,
      example_value: attr.example_value || null
    }));
  }

  const packageMeasurements = this.resolvePackageMeasurements(productData);

  const prepared = {
    // Campos obligatorios Falabella
    sku: productData.sku || `PROD-${productData.id}`,
    productName: productData.name?.trim() || 'Producto sin nombre',
    brand: (productData.brand || 'Genérica').trim(),
    price: validVariant.price > 0 ? validVariant.price : (productData.price || 0),
    stock: Math.max(0, Math.round(validVariant.publishStock || productData.totalPublishingStock || productData.stock || 0)),
    PrimaryCategory: category.id,
    
    // Descripción (requerida)
    description: (productData.description || 'Producto sin descripción').trim(),
    
    // Package dimensions (requeridos)
    package_height: packageMeasurements.package_height,
    package_width: packageMeasurements.package_width,
    package_length: packageMeasurements.package_length,
    package_weight: packageMeasurements.package_weight,
    
    // 🔑 ATRIBUTOS PROCESADOS (NUNCA vacío si hay obligatorios de tipo list auto-asignados)
    attributes: attributes,
    
    // 🔑 IMÁGENES transformadas a formato Falabella
    images: this._transformImages(productData.images || []),
    
    // Metadatos
    productId: productData.id,
    categoryName: category.name
  };

  // ✅ Ajuste de precio por configuración económica (si aplica)
  if (productData.economic_config) {
    const config = productData.economic_config;
    
    if (config.allow_price_adjustment && config.min_margin && config.commission_rate) {
      const basePrice = Number(prepared.price) || 0;
      const commissionRate = Number(config.commission_rate) || 0;
      const minMargin = Number(config.min_margin) / 100; // convertir a decimal
      
      // Calcular margen actual
      const currentMargin = 1 - commissionRate;
      
      // Solo ajustar si el margen actual es menor al mínimo deseado
      if (currentMargin < minMargin && basePrice > 0) {
        // Fórmula: precio_ajustado = base / (1 - comisión - margen_mínimo)
        const adjustedPrice = basePrice / (1 - commissionRate - minMargin);
        const roundedPrice = Math.ceil(adjustedPrice / 10) * 10; // Redondear a múltiplo de 10
        
        prepared.price = roundedPrice;
        
        logger.info(`[Falabella Adapter] 💰 Precio ajustado: $${basePrice} → $${roundedPrice} (margen: ${(minMargin * 100)}%)`);
      }
    }
  }

  logger.info(`[FalabellaAdapter] Producto preparado para publicación:\n ${JSON.stringify(prepared)}`);

  return prepared;
}

buildProductXml(product) {
  const escape = (str) => {
    if (typeof str !== 'string') return String(str || '');
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  };

  // Valores básicos obligatorios
  const sku = escape((product.sku || '').substring(0, 50));
  const name = escape((product.productName || 'Producto sin nombre').substring(0, 255));
  const brand = escape((product.brand || 'Genérica').substring(0, 50));
  const description = escape((product.description || 'Producto sin descripción').substring(0, 25000));
  const categoryId = Number(product.PrimaryCategory);
  const price = Number(product.price).toFixed(2);
  const stock = Math.max(0, Math.round(Number(product.stock)));
  const marketplaceProductId = this.resolveMarketplaceProductId(product);

  // Dimensiones del paquete
  const height = Math.max(1, Number(product.package_height || 10));
  const width = Math.max(1, Number(product.package_width || 10));
  const length = Math.max(1, Number(product.package_length || 10));
  const weight = Math.max(0.001, Number(product.package_weight || 0.5));

  // ✅ Atributos que van DENTRO de ProductData
  const productDataAttrs = {};

  // Siempre incluir ConditionType
  let conditionType = 'Nuevo';
  const conditionAttr = product.attributes?.find(a => 
    ['condition_type', 'ConditionType'].includes(a.id)
  );
  if (conditionAttr && conditionAttr.value_name === 'Usado') {
    conditionType = 'Usado';
  }
  productDataAttrs['ConditionType'] = conditionType;

  // Incluir dimensiones del paquete
  productDataAttrs['PackageHeight'] = height;
  productDataAttrs['PackageWidth'] = width;
  productDataAttrs['PackageLength'] = length;
  productDataAttrs['PackageWeight'] = weight.toFixed(3);

  // ✅🔑 AÑADIR ATRIBUTOS DE CATEGORÍA CON MAPEO CORRECTO PARA FALABELLA
  if (Array.isArray(product.attributes)) {
    for (const attr of product.attributes) {
      // Saltar campos base y Variation (va fuera de ProductData)
      if (['SellerSku', 'Name', 'Brand', 'Description', 'PrimaryCategory', 'Variation', 'ProductId', 'images', 'productId', 'categoryName'].includes(attr.id)) {
        continue;
      }

      // 🔑 PRIORIDAD: value_id para atributos con valores predefinidos (listas)
      // Falabella espera el ID del valor, no el nombre, para atributos de opción
      let value = attr.value_id || attr.value_name || attr.value || '';
      
      // ✅ Manejo especial para atributos numéricos con texto (ej: "3 meses" → "3")
      const numericAttrs = [
        'DuracionEnCondicionesPrevisiblesDeUso',
        'PlazoDeDisponibilidadDeRepuestos', 
        'PlazoDeDisponibilidadDeServicioTecnico',
        'WarrantyTime',
        'WarrantyMonths'
      ];
      
      if (numericAttrs.includes(attr.id) && typeof value === 'string') {
        const match = value.match(/^\d+/);
        if (match) value = match[0];
      }

      // ✅ Solo agregar si tiene valor válido y no vacío
      if (value !== '' && value !== null && value !== undefined) {
        productDataAttrs[attr.id] = value;
      }
    }
  }

  // ✅ Construir XML de ProductData
  let productDataXml = '';
  for (const [key, value] of Object.entries(productDataAttrs)) {
    // Validar que la clave sea un nombre XML válido
    if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
      productDataXml += `\n      <${key}>${escape(String(value))}</${key}>`;
    }
  }

  // ✅ Manejo de Variation (va en <Product>, no en ProductData)
  let variationXml = '';
  const variationAttr = product.attributes?.find(a => a.id === 'Variation');
  if (variationAttr) {
    let variationValue = variationAttr.value_name || variationAttr.value || '...';
    variationXml = `\n    <Variation>${escape(String(variationValue))}</Variation>`;
  } else {
    // Si no se envió, pero la categoría lo requiere, forzar "..." como fallback seguro
    variationXml = `\n    <Variation>...</Variation>`;
  }

  // ✅ XML final completo
  return `<?xml version="1.0" encoding="UTF-8"?>
<Request>
  <Product>
    <SellerSku>${sku}</SellerSku>
    <Name>${name}</Name>
    <PrimaryCategory>${categoryId}</PrimaryCategory>
    <Description>${description}</Description>
    <Brand>${brand}</Brand>${variationXml}${marketplaceProductId ? `\n    <ProductId>${escape(marketplaceProductId)}</ProductId>` : ''}
    <BusinessUnits>
      <BusinessUnit>
        <OperatorCode>facl</OperatorCode>
        <Price>${price}</Price>
        <Stock>${stock}</Stock>
        <Status>active</Status>
      </BusinessUnit>
    </BusinessUnits>
    <ProductData>${productDataXml}
    </ProductData>
  </Product>
</Request>`;
}
// 🔑 NUEVO MÉTODO: Obtener atributos de categoría
async getCategoryAttributes(categoryId) {
  try {
    const credentialStatus = await this.ensureValidCredentials();
    if (!credentialStatus.valid) {
      throw new Error('Credenciales inválidas');
    }

    const timestamp = this.timestampMinus03();
    const params = {
      Action: 'GetCategoryAttributes',
      Format: 'JSON',
      PrimaryCategory: categoryId.toString(),
      Timestamp: timestamp,
      UserID: this.credential.seller_email.trim(),
      Version: '1.0'
    };

    const sortedKeys = Object.keys(params).sort();
    const stringToSign = sortedKeys.map(k => `${k}=${params[k]}`).join('&');
    
    const signatureHex = crypto
      .createHmac('sha256', this.credential.api_key.trim())
      .update(stringToSign, 'utf8')
      .digest('hex');

    const urlParams = { ...params, Signature: signatureHex };
    const urlSortedKeys = ['Action', 'Format', 'PrimaryCategory', 'Signature', 'Timestamp', 'UserID', 'Version'];
    const urlQueryString = urlSortedKeys
      .map(k => `${this.rfc3986Encode(k)}=${this.rfc3986Encode(String(urlParams[k]))}`)
      .join('&');

    const apiUrl = `https://sellercenter-api.falabella.com?${urlQueryString}`;

    const response = await axios.get(apiUrl, { timeout: 10000 });
    
    if (response.data.SuccessResponse?.Body?.Attribute) {
      const attrs = response.data.SuccessResponse.Body.Attribute;
      const items = Array.isArray(attrs) ? attrs : [attrs];
      
      return {
        success: true,
        attributes: items.map(attr => ({
          id: attr.FeedName || attr.Name,
          name: attr.Label,
          is_mandatory: attr.isMandatory === "1" || attr.isMandatory === true,
          value_type: attr.AttributeType === 'option' ? 'list' : 'string',
          values: attr.Options?.Option 
            ? (Array.isArray(attr.Options.Option) 
                ? attr.Options.Option.map(opt => ({ id: opt.id, name: opt.Name }))
                : [{ id: attr.Options.Option.id, name: attr.Options.Option.Name }])
            : []
        }))
      };
    }
    
    return { success: false, attributes: [] };
  } catch (error) {
    logger.error(`[FalabellaAdapter] Error obteniendo atributos: ${error.message}`);
    return { success: false, attributes: [] };
  }
}

  // ✅ Validación específica para Falabella
  validateProduct(product) {
    const errors = [];
    const required = ['sku', 'productName', 'brand', 'price', 'stock', 'PrimaryCategory', 'description'];

    for (const field of required) {
      if (product[field] == null || (typeof product[field] === 'string' && product[field].trim() === '')) {
        errors.push(`Campo requerido ausente: ${field}`);
      }
    }

    // Validar que PrimaryCategory sea numérico
    if (product.PrimaryCategory && isNaN(Number(product.PrimaryCategory))) {
      errors.push(`PrimaryCategory debe ser un número entero válido. Recibido: ${product.PrimaryCategory}`);
    }

    // Validar precio y stock
    if (product.price <= 0) errors.push('El precio debe ser mayor a 0');
    if (product.stock < 0) errors.push('El stock no puede ser negativo');

    return {
      valid: errors.length === 0,
      errors
    };
  }
// ✅ Publicar producto con firma correcta (igual que GetCategorySuggestion que funcionó)
buildProductXml(product) {
  const escape = (str) => {
    if (typeof str !== 'string') return String(str || '');
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  };

  // Valores básicos obligatorios
  const sku = escape((product.sku || '').substring(0, 50));
  const name = escape((product.productName || 'Producto sin nombre').substring(0, 255));
  const brand = escape((product.brand || 'Genérica').substring(0, 50));
  const description = escape((product.description || 'Producto sin descripción').substring(0, 25000));
  const categoryId = Number(product.PrimaryCategory);
  const price = Number(product.price).toFixed(2);
  const stock = Math.max(0, Math.round(Number(product.stock)));
  const marketplaceProductId = this.resolveMarketplaceProductId(product);

  // Dimensiones del producto
  const height = Math.max(1, Number(product.package_height || 10));
  const width = Math.max(1, Number(product.package_width || 10));
  const length = Math.max(1, Number(product.package_length || 10));
  const weight = Math.max(0.001, Number(product.package_weight || 0.5));

  // ✅ Atributos que van DENTRO de ProductData
  const productDataAttrs = {};

  // Siempre incluir ConditionType
  let conditionType = 'Nuevo';
  const conditionAttr = product.attributes?.find(a => 
    ['condition_type', 'ConditionType'].includes(a.id)
  );
  if (conditionAttr && conditionAttr.value_name === 'Usado') {
    conditionType = 'Usado';
  }
  productDataAttrs['ConditionType'] = conditionType;

  // Incluir dimensiones
  productDataAttrs['PackageHeight'] = height;
  productDataAttrs['PackageWidth'] = width;
  productDataAttrs['PackageLength'] = length;
  productDataAttrs['PackageWeight'] = weight.toFixed(3);

  // ✅ Añadir atributos específicos de categoría a ProductData
  if (Array.isArray(product.attributes)) {
    for (const attr of product.attributes) {
      // Saltar campos base y Variation (va fuera de ProductData)
      if (['SellerSku', 'Name', 'Brand', 'Description', 'PrimaryCategory', 'Variation', 'ProductId', 'images', 'productId', 'categoryName'].includes(attr.id)) {
        continue;
      }

      // Para atributos de categoría, usar value_id si existe, sino value_name
      let value = attr.value_id || attr.value_name || attr.value || '';
      
      // Convertir valores numéricos si es necesario (ej: "3 meses" → "3")
      if (attr.id === 'DuracionEnCondicionesPrevisiblesDeUso' ||
          attr.id === 'PlazoDeDisponibilidadDeRepuestos' ||
          attr.id === 'PlazoDeDisponibilidadDeServicioTecnico') {
        // Extraer solo el número
        const match = value.match(/^\d+/);
        if (match) value = match[0];
      }

      if (value !== '') {
        productDataAttrs[attr.id] = value;
      }
    }
  }

  // ✅ Construir XML de ProductData
  let productDataXml = '';
  for (const [key, value] of Object.entries(productDataAttrs)) {
    if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
      productDataXml += `\n      <${key}>${escape(String(value))}</${key}>`;
    }
  }

  // ✅ Manejo de Variation (va en <Product>, no en ProductData)
  let variationXml = '';
  const variationAttr = product.attributes?.find(a => a.id === 'Variation');
  if (variationAttr) {
    let variationValue = variationAttr.value_name || variationAttr.value || '...';
    variationXml = `\n    <Variation>${escape(String(variationValue))}</Variation>`;
  } else {
    // Si no se envió, pero la categoría lo requiere (como en tu caso), forzar "..."
    // Esto cubre el caso donde el atributo es obligatorio pero no fue enviado explícitamente
    variationXml = `\n    <Variation>...</Variation>`;
  }

  // ✅ XML final
  return `<?xml version="1.0" encoding="UTF-8"?>
<Request>
  <Product>
    <SellerSku>${sku}</SellerSku>
    <Name>${name}</Name>
    <PrimaryCategory>${categoryId}</PrimaryCategory>
    <Description>${description}</Description>
    <Brand>${brand}</Brand>${variationXml}${marketplaceProductId ? `\n    <ProductId>${escape(marketplaceProductId)}</ProductId>` : ''}
    <BusinessUnits>
      <BusinessUnit>
        <OperatorCode>facl</OperatorCode>
        <Price>${price}</Price>
        <Stock>${stock}</Stock>
        <Status>active</Status>
      </BusinessUnit>
    </BusinessUnits>
    <ProductData>${productDataXml}
    </ProductData>
  </Product>
</Request>`;
}
  async publish(transformedProduct) {
    try {
      const credentialStatus = await this.ensureValidCredentials();
      if (!credentialStatus.valid) {
        return credentialStatus;
      }

      // Validar producto
      // Validar producto
    const validation = this.validateProduct(transformedProduct);
    if (!validation.valid) {
      logger.error(`[FalabellaAdapter] Validación fallida:`, validation.errors);
      return {
        success: false,
        error: 'validation_failed',
        details: validation.errors
      };
    }

    // ✅ Construir XML payload
    const xmlPayload = this.buildProductXml(transformedProduct);
    
    // ✅ Generar timestamp en hora de Chile (-03:00)
    const timestamp = this.timestampMinus03();

    // ✅ Parámetros para firma (orden alfabético)
    const params = {
      Action: 'ProductCreate',
      Format: 'XML',
      Timestamp: timestamp,
      UserID: this.credential.seller_email.trim(),
      Version: '1.0'
    };

    const { canonicalQuery, signatureHex, signatureEncoded } = this.buildSignedQuery(params);

    logger.info(`[FalabellaAdapter] 🔍 String to sign (ENCODEADO):`);
    logger.info(canonicalQuery);

    logger.info(`[FalabellaAdapter] ✅ Firma generada (HEX): ${signatureHex}`);

    // ✅ 5) Construir URL final: canonicalQuery + &Signature=firma_encodeada
    const urlQueryString = `${canonicalQuery}&Signature=${signatureEncoded}`;
    const baseUrl = 'https://sellercenter-api.falabella.com'; // ✅ SIN espacios al final
    const apiUrl = `${baseUrl}?${urlQueryString}`;
    
    logger.info(`[FalabellaAdapter] 🌐 URL final:`);
    logger.info(apiUrl);

    // ✅ Headers obligatorios (User-Agent es OBLIGATORIO para POST)
    const headers = {
      'Content-Type': 'application/xml; charset=UTF-8',
      'User-Agent': `${this.credential.seller_id || 'SC72B9D'}/Node/${process.versions.node}/PROPIA/FACL`
    };

    logger.info(`[FalabellaAdapter] 👤 Headers:`);
    logger.info(JSON.stringify(headers, null, 2));

    logger.info(`[FalabellaAdapter] 📦 XML Payload: \n ${JSON.stringify(xmlPayload)}`);

    // ✅ Enviar solicitud POST
    const response = await axios.post(apiUrl, xmlPayload, {
      headers,
      timeout: 15000
    });

      logger.info(`[FalabellaAdapter] ✅ Respuesta HTTP ${response.status}:`);
      logger.info(response.data);

      const responseBody = response.data;

      if (responseBody.includes('<SuccessResponse>')) {
        const requestIdMatch = responseBody.match(/<RequestId>([^<]+)<\/RequestId>/);
        const requestId = requestIdMatch ? requestIdMatch[1] : null;

        if (!requestId) {
          logger.warn('[FalabellaAdapter] SuccessResponse sin RequestId; no se puede consultar FeedStatus');
          return {
            success: false,
            error: 'Falabella respondió éxito técnico, pero no devolvió RequestId para validar el feed',
            details: { error_code: 'missing_request_id' }
          };
        }

        const { feed, timedOut } = await this.pollFeedStatus(requestId);
        return this.buildFeedDrivenResult({
          transformedProduct,
          requestId,
          feed,
          timedOut
        });
      } else if (responseBody.includes('<ErrorResponse>')) {
        const errorMsgMatch = responseBody.match(/<ErrorMessage>([^<]+)<\/ErrorMessage>/);
        const errorCodeMatch = responseBody.match(/<ErrorCode>([^<]+)<\/ErrorCode>/);
        const errorMsg = errorMsgMatch ? errorMsgMatch[1] : 'Error desconocido en API de Falabella';
        const errorCode = errorCodeMatch ? errorCodeMatch[1] : 'UNKNOWN';
        
        logger.error(`[FalabellaAdapter] ❌ Error API Falabella (Código ${errorCode}): ${errorMsg}`);
        return { 
          success: false, 
          error: `Falabella API Error ${errorCode}: ${errorMsg}`,
          status_code: response.status,
          payload: xmlPayload
        };
      } else {
        logger.warn('[FalabellaAdapter] ⚠️ Respuesta inesperada:', responseBody.substring(0, 300));
        return { 
          success: false, 
          error: 'Respuesta inesperada de API de Falabella',
          payload: xmlPayload
        };
      }

    } catch (err) {
      let errorMsg = 'Error desconocido al publicar en Falabella';
      
      if (err.response) {
        errorMsg = `Error HTTP ${err.response.status}: ${err.response.statusText}`;
        logger.error(`[FalabellaAdapter] ❌ Error HTTP:`, {
          status: err.response.status,
          statusText: err.response.statusText,
          data: typeof err.response.data === 'string' ? err.response.data.substring(0, 500) : err.response.data
        });
      } else if (err.request) {
        errorMsg = 'No se recibió respuesta de Falabella (timeout o problema de red)';
        logger.error(`[FalabellaAdapter] ❌ Error de red: timeout o conexión rechazada`);
      } else {
        errorMsg = err.message || 'Error interno';
        logger.error(`[FalabellaAdapter] ❌ Error local:`, err.message);
      }
      
      return { 
        success: false, 
        error: errorMsg,
        details: err.response?.data || err.message
      };
    }
  }

  static supports(marketplace) {
    return marketplace.id === 4 || marketplace.domain?.includes('falabella.cl');
  }
}

module.exports = FalabellaAdapter;
