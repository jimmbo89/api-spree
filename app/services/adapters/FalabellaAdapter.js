// src/services/adapters/FalabellaAdapter.js
const BaseAdapter = require('./BaseAdapter');
const axios = require('axios');
const crypto = require('crypto');
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

  // ✅ Extraer categoría de Falabella desde el campo correcto
// ✅ CORREGIR: Usar this.credentialId para buscar los datos
getFalabellaCategory(productData) {
  // ✅ USAR credentialId (ej: 3) en lugar de marketplaceId (ej: 4)
  const falabellaData = productData.falabella?.[this.credentialId];
  
  if (falabellaData?.category?.category_id) {
    return {
      id: falabellaData.category.category_id,
      name: falabellaData.category.category_name || ''
    };
  }
  
  // Fallback: buscar en otros campos si existe
  if (productData.falabella?.[this.credentialId]?.category_id) {
    return {
      id: productData.falabella[this.credentialId].category_id,
      name: productData.falabella[this.credentialId].category_name || ''
    };
  }
  
  return null;
}

  // ✅ Preparar producto con datos específicos de Falabella
  async prepareProduct(productData) {
  // Extraer categoría de Falabella
  const category = this.getFalabellaCategory(productData);
  
  if (!category?.id) {
    throw new Error(`Categoría de Falabella no encontrada para el producto ${productData.id}.
      Debes asignar una categoría mediante la API de sugerencias primero.`);
  }

  // Obtener primer variante con precio válido
  const validVariant = productData.variants?.find(v => v.price > 0 && v.publish) ||
                       productData.variants?.[0] ||
                       { price: productData.price || 0, publishStock: productData.stock || 0 };

  // 🔑 Obtener atributos de la categoría (similar a MercadoLibre)
  let categoryAttributes = [];
  try {
    const { attributes, success } = await this.getCategoryAttributes(category.id);
    if (success) {
      categoryAttributes = attributes;
    }
  } catch (error) {
    logger.warn(`[FalabellaAdapter] No se pudieron obtener atributos de categoría ${category.id}: ${error.message}`);
  }

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
    package_height: productData.height_cm || 10,
    package_width: productData.width_cm || 10,
    package_length: productData.length_cm || 10,
    package_weight: productData.weight_grams ? (productData.weight_grams / 1000) : 0.5,
    
    // 🔑 Atributos de categoría (si existen)
    attributes: productData.falabella?.[this.marketplaceId]?.attributes || [],
    category_attributes: categoryAttributes,
    
    // Metadatos
    productId: productData.id,
    categoryName: category.name
  };

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

/*buildProductXml(product) {
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
  const height = Math.max(1, Number(product.package_height || 10));
  const width = Math.max(1, Number(product.package_width || 10));
  const length = Math.max(1, Number(product.package_length || 10));
  const weight = Math.max(0.001, Number(product.package_weight || 0.5));

  // ✅ Extraer atributos planos usando FeedName (ya debe venir como id desde el front/backend)
  const flatAttributes = {};

  if (Array.isArray(product.attributes)) {
    for (const attr of product.attributes) {
      const feedName = attr.id; // ← Debe ser el FeedName real (ej: "ConectividadDelMouse")
      let value = attr.value_id || attr.value_name || attr.value || '';

      // Saltar condition_type → va en ProductData
      if (feedName === 'condition_type' || feedName === 'ConditionType') {
        continue;
      }

      // Solo incluir si tiene valor
      if (value != null && value !== '') {
        flatAttributes[feedName] = value;
      }
    }
  }

  // ✅ Manejo especial de Variation
  // Según la doc: si la categoría tiene un atributo con FeedName = "Variation", DEBE incluirse
  const hasVariationAttribute = product.category_attributes?.some(attr => attr.id === 'Variation');
  if (hasVariationAttribute) {
    // Si el usuario no lo envió, usar valor por defecto seguro
    if (flatAttributes['Variation'] == null) {
      flatAttributes['Variation'] = '...';
    }
  }

  // ✅ Construir XML dinámico de atributos (solo nodos válidos)
  let dynamicAttrsXml = '';
  for (const [feedName, value] of Object.entries(flatAttributes)) {
    // Validar que sea un nombre XML válido (opcional, pero seguro)
    if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(feedName)) {
      dynamicAttrsXml += `\n    <${feedName}>${escape(String(value))}</${feedName}>`;
    }
  }

  // ✅ ConditionType: usar valor textual correcto ("Nuevo", no "New")
  let conditionType = 'Nuevo';
  const conditionAttr = product.attributes?.find(a => a.id === 'condition_type' || a.id === 'ConditionType');
  if (conditionAttr) {
    if (['Usado', 'usado', 'used'].includes(conditionAttr.value_name)) {
      conditionType = 'Usado';
    } else {
      conditionType = 'Nuevo';
    }
  }

  // ✅ XML final conforme a la documentación oficial
  return `<?xml version="1.0" encoding="UTF-8"?>
<Request>
  <Product>
    <SellerSku>${sku}</SellerSku>
    <Name>${name}</Name>
    <PrimaryCategory>${categoryId}</PrimaryCategory>
    <Description>${description}</Description>
    <Brand>${brand}</Brand>${dynamicAttrsXml}
    <BusinessUnits>
      <BusinessUnit>
        <OperatorCode>facl</OperatorCode>
        <Price>${price}</Price>
        <Stock>${stock}</Stock>
        <Status>active</Status>
      </BusinessUnit>
    </BusinessUnits>
    <ProductData>
      <ConditionType>${conditionType}</ConditionType>
      <PackageHeight>${height}</PackageHeight>
      <PackageWidth>${width}</PackageWidth>
      <PackageLength>${length}</PackageLength>
      <PackageWeight>${weight.toFixed(3)}</PackageWeight>
    </ProductData>
  </Product>
</Request>`;
}*/
/*buildProductXml(product) {
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
  const height = Math.max(1, Number(product.package_height || 10));
  const width = Math.max(1, Number(product.package_width || 10));
  const length = Math.max(1, Number(product.package_length || 10));
  const weight = Math.max(0.001, Number(product.package_weight || 0.5));

  // 🔑 Campos que NUNCA deben enviarse como atributos (estructura base fija de ProductCreate)
  const BASE_FIELDS = new Set([
    'SellerSku',
    'Name',
    'Brand',
    'Description',
    'PrimaryCategory',
    'ConditionType',
    'PackageHeight',
    'PackageWidth',
    'PackageLength',
    'PackageWeight'
  ]);

  const flatAttributes = {};

  if (Array.isArray(product.attributes)) {
    for (const attr of product.attributes) {
      const feedName = attr.id; // ← Debe ser el FeedName real
      const value = attr.value_id || attr.value_name || attr.value || '';

      // Saltar campos base (siempre están en la estructura XML)
      if (BASE_FIELDS.has(feedName) || !value) continue;

      flatAttributes[feedName] = value;
    }
  }

  // Manejo de Variation si la categoría lo exige
  const hasVariation = product.category_attributes?.some(a => a.id === 'Variation');
  if (hasVariation && flatAttributes['Variation'] == null) {
    flatAttributes['Variation'] = '...';
  }

  let dynamicAttrsXml = '';
  for (const [feedName, value] of Object.entries(flatAttributes)) {
    if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(feedName)) {
      dynamicAttrsXml += `\n    <${feedName}>${escape(String(value))}</${feedName}>`;
    }
  }

  // ConditionType desde atributos o por defecto
  let conditionType = 'Nuevo';
  const conditionAttr = product.attributes?.find(a =>
    ['condition_type', 'ConditionType'].includes(a.id)
  );
  if (conditionAttr && conditionAttr.value_name === 'Usado') {
    conditionType = 'Usado';
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<Request>
  <Product>
    <SellerSku>${sku}</SellerSku>
    <Name>${name}</Name>
    <PrimaryCategory>${categoryId}</PrimaryCategory>
    <Description>${description}</Description>
    <Brand>${brand}</Brand>${dynamicAttrsXml}
    <BusinessUnits>
      <BusinessUnit>
        <OperatorCode>facl</OperatorCode>
        <Price>${price}</Price>
        <Stock>${stock}</Stock>
        <Status>active</Status>
      </BusinessUnit>
    </BusinessUnits>
    <ProductData>
      <ConditionType>${conditionType}</ConditionType>
      <PackageHeight>${height}</PackageHeight>
      <PackageWidth>${width}</PackageWidth>
      <PackageLength>${length}</PackageLength>
      <PackageWeight>${weight.toFixed(3)}</PackageWeight>
    </ProductData>
  </Product>
</Request>`;
}*/
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

  // Incluir dimensiones
  productDataAttrs['PackageHeight'] = height;
  productDataAttrs['PackageWidth'] = width;
  productDataAttrs['PackageLength'] = length;
  productDataAttrs['PackageWeight'] = weight.toFixed(3);

  // ✅ Añadir atributos específicos de categoría a ProductData
  if (Array.isArray(product.attributes)) {
    for (const attr of product.attributes) {
      // Saltar campos base y Variation (va fuera de ProductData)
      if (['SellerSku', 'Name', 'Brand', 'Description', 'PrimaryCategory', 'Variation'].includes(attr.id)) {
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
    <Brand>${brand}</Brand>${variationXml}
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

    // ✅ 1) Ordenar alfabéticamente
    const sortedKeys = Object.keys(params).sort();

    // ✅ 2) CONSTRUIR QUERY ENCODEADA (igual que falabellaCategories) ← ¡CORREGIDO!
    const canonicalQuery = sortedKeys
      .map(k => `${this.rfc3986Encode(k)}=${this.rfc3986Encode(String(params[k]))}`)
      .join('&');

    logger.info(`[FalabellaAdapter] 🔍 String to sign (ENCODEADO):`);
    logger.info(canonicalQuery);

    // ✅ 3) FIRMAR LA QUERY ENCODEADA (igual que falabellaCategories) ← ¡CORREGIDO!
    const signatureHex = crypto
      .createHmac('sha256', this.credential.api_key.trim())
      .update(canonicalQuery, 'utf8')  // ← FIRMA VALORES ENCODEADOS
      .digest('hex');

    logger.info(`[FalabellaAdapter] ✅ Firma generada (HEX): ${signatureHex}`);

    // ✅ 4) Encodear la firma para la URL
    const signatureEncoded = this.rfc3986Encode(signatureHex);

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

    logger.info(`[FalabellaAdapter] 📦 XML Payload:`);
    logger.info(xmlPayload);

    // ✅ Enviar solicitud POST
    const response = await axios.post(apiUrl, xmlPayload, {
      headers,
      timeout: 15000
    });

      logger.info(`[FalabellaAdapter] ✅ Respuesta HTTP ${response.status}:`);
      logger.info(response.data);

      // ✅ Procesar respuesta
      const responseBody = response.data;
      
      if (responseBody.includes('<SuccessResponse>')) {
        // Extraer RequestId para seguimiento
        const requestIdMatch = responseBody.match(/<RequestId>([^<]+)<\/RequestId>/);
        
        return {
          success: true,
          external_id: transformedProduct.sku,
          data: {
            id: transformedProduct.sku,
            request_id: requestIdMatch ? requestIdMatch[1] : null,
            category_id: transformedProduct.PrimaryCategory,
            category_name: transformedProduct.categoryName
          }
        };
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
          payload: xmlPayload.substring(0, 200) + '...'
        };
      } else {
        logger.warn('[FalabellaAdapter] ⚠️ Respuesta inesperada:', responseBody.substring(0, 300));
        return { 
          success: false, 
          error: 'Respuesta inesperada de API de Falabella',
          payload: xmlPayload.substring(0, 200) + '...'
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