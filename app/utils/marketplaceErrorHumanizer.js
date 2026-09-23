// Catálogo de presentación basado en las respuestas documentadas por los marketplaces:
// Falabella: ProductCreate/FeedStatus/GetCategoryTree.
// Mercado Libre: Items validation, attributes and category validations.
// Los errores no catalogados conservan el detalle recibido para no inventar una causa.
const FIELD_LABELS = {
  description: 'descripción',
  plain_text: 'descripción',
  title: 'título',
  name: 'nombre',
  price: 'precio',
  available_quantity: 'cantidad disponible',
  category_id: 'categoría',
  primarycategory: 'categoría',
  listing_type_id: 'tipo de publicación',
  condition: 'condición',
  pictures: 'imágenes',
  attributes: 'atributos',
  brand: 'marca',
  model: 'modelo',
  sellersku: 'SKU',
  sku: 'SKU',
  packageheight: 'alto del paquete',
  packagelength: 'largo del paquete',
  packagewidth: 'ancho del paquete',
  packageweight: 'peso del paquete',
  sellerpackageheight: 'alto del paquete del vendedor',
  sellerpackagelength: 'largo del paquete del vendedor',
  sellerpackagewidth: 'ancho del paquete del vendedor',
  sellerpackageweight: 'peso del paquete del vendedor',
  gtin: 'código universal (GTIN)',
  unitsperpack: 'unidades por pack',
  saleformat: 'formato de venta',
  variations: 'variantes'
};

function parseJsonMaybe(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;

  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'string' ? parseJsonMaybe(parsed) : parsed;
  } catch (error) {
    return null;
  }
}

function normalizeCode(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeText(value) {
  return String(value || '')
    .trim()
    .toLocaleLowerCase('es')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function uniqueMessages(messages) {
  return [...new Set(
    messages
      .filter(Boolean)
      .map((message) => String(message).trim())
      .filter(Boolean)
  )];
}

function isCataloguedHumanMessage(message) {
  return !normalizeText(message).includes('detalle recibido');
}

function publicationFieldLabel(value) {
  const raw = String(value || '').trim();
  const key = raw.replace(/[^a-z0-9_]/gi, '').toLowerCase();
  return FIELD_LABELS[key]
    || FIELD_LABELS[key.replace(/^(item|body)/, '')]
    || raw
    || null;
}

function publicationFieldText(field) {
  return field ? `el campo «${field}»` : 'un dato obligatorio';
}

function extractFieldFromReference(value) {
  const text = String(value || '');
  const match = text.match(/(?:item|body)(?:\.[\w-]+)*\.?([\w-]+)$/i);
  return publicationFieldLabel(match?.[1] || text);
}

function extractAttributeLabels(text) {
  return uniqueMessages(
    [...String(text || '').matchAll(/\[([^\]]+)\]/g)]
      .map((match) => publicationFieldLabel(match[1]))
  );
}

function extractFirstNumber(text) {
  const match = String(text || '').match(/\b\d+\b/);
  return match ? match[0] : null;
}

function collectCauseObjects(details, error) {
  const sources = [
    details?.marketplace_errors,
    details?.marketplace_primary_error,
    details?.validation?.errors,
    details?.validation?.data?.cause,
    details?.validation?.cause,
    details?.data?.cause,
    details?.cause,
    details?.response?.data?.cause,
    error?.cause
  ];

  const causes = [];
  const visit = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value === 'object') {
      if (
        value.code || value.error_code || value.cause_id || value.message ||
        value.error_message || value.detail
      ) {
        causes.push(value);
      }
    }
  };

  sources.forEach(visit);

  if (details?.error_code || details?.code || details?.error_message || details?.message) {
    causes.push(details);
  }
  if (error?.error_code || error?.code || error?.error_message || error?.message) {
    causes.push(error);
  }

  const seen = new Set();
  return causes.filter((cause) => {
    const key = JSON.stringify({
      code: cause.code || cause.error_code || cause.error || null,
      cause_id: cause.cause_id || null,
      message: cause.message || cause.error_message || cause.detail || null
    });
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractOriginalMessage(cause, details, error) {
  return String(
    cause?.message
    || cause?.error_message
    || cause?.detail
    || details?.marketplace_error?.error_message
    || details?.marketplace_message
    || details?.message
    || error?.error_message
    || error?.message
    || ''
  ).trim() || null;
}

function translateGenericRawMessage(rawMessage, marketplaceName) {
  const text = String(rawMessage || '').trim();
  const normalized = normalizeText(text);
  if (!text) return null;

  if (normalized.includes('unauthorized') || normalized.includes('not authorized')) {
    return 'La cuenta no está autorizada para realizar esta publicación.';
  }
  if (normalized.includes('timeout') || normalized.includes('timed out')) {
    return 'La solicitud tardó demasiado. Intenta nuevamente.';
  }
  if (normalized.includes('rate limit') || normalized.includes('too many requests')) {
    return 'Se alcanzó el límite temporal de solicitudes. Intenta nuevamente en unos minutos.';
  }
  if (normalized.includes('invalid token') || normalized.includes('token expired')) {
    return 'La conexión con la cuenta expiró. Vuelve a conectar el marketplace.';
  }

  return `${marketplaceName} rechazó la publicación. Detalle recibido: «${text}»`;
}

function humanizeFalabellaMessage(message, code = null, field = null) {
  const text = String(message || code || '').trim();
  const normalized = normalizeText(text);
  const normalizedCode = normalizeCode(code);
  const fieldLabel = publicationFieldLabel(field);

  if (!text) {
    return 'Falabella rechazó la publicación, pero no entregó un detalle adicional.';
  }

  if (
    normalized.includes('categoria principal debe estar en un nivel inferior')
    || normalized.includes('primary category') && (
      normalized.includes('lower level')
      || normalized.includes('last level')
      || normalized.includes('leaf')
    )
  ) {
    return 'La categoría seleccionada es demasiado general. Selecciona una categoría más específica y de último nivel.';
  }

  if (
    normalized.includes('primary category') && normalized.includes('invalid')
    || normalized.includes('categoria') && (normalized.includes('invalida') || normalized.includes('no valida'))
    || normalizedCode.includes('category') && normalizedCode.includes('invalid')
  ) {
    return 'La categoría seleccionada no es válida o ya no está disponible en Falabella. Selecciona una categoría vigente.';
  }

  if (
    normalized.includes('invalid brand')
    || normalized.includes('marca invalida')
    || normalized.includes('marca no valida')
  ) {
    const brandMatch = text.match(
      /(?:invalid\s+brand|marca\s+inv[aá]lida|marca\s+no\s+válida)\s*:\s*(?:&quot;|&#34;|&#x22;|["'])(.*?)(?:&quot;|&#34;|&#x22;|["'])/i
    );
    const brand = brandMatch?.[1]?.trim();
    return brand
      ? `La marca «${brand}» no está registrada o autorizada para publicar en Falabella. Contacta al soporte técnico de Falabella para solicitar la validación y habilitación de la marca.`
      : 'La marca indicada no está registrada o autorizada para publicar en Falabella. Contacta al soporte técnico de Falabella para solicitar su validación y habilitación.';
  }

  if (normalized.includes('brand') && (normalized.includes('does not exist') || normalized.includes('not found'))
    || normalized.includes('marca') && (normalized.includes('no existe') || normalized.includes('no esta registrada'))) {
    return 'La marca indicada no está registrada o autorizada en Falabella. Contacta al soporte técnico de Falabella para solicitar su validación y habilitación.';
  }

  if (normalized.includes('format error') || normalized.includes('error de formato')) {
    return 'El formato de uno o más datos no es válido. Revisa los valores enviados según la categoría.';
  }

  if (normalized.includes('exact match') || normalized.includes('being processed') || normalized.includes('document is being processed')) {
    return 'Falabella ya está procesando una solicitud igual. Espera unos minutos antes de intentarlo nuevamente.';
  }

  if (normalized.includes('timestamp') && (normalized.includes('mandatory') || normalized.includes('obligatoria'))) {
    return 'No se pudo enviar la solicitud porque falta la fecha de la conexión con Falabella.';
  }
  if (normalized.includes('timestamp') && (normalized.includes('expired') || normalized.includes('expirada'))) {
    return 'La solicitud llegó fuera de tiempo. Intenta nuevamente.';
  }
  if (normalized.includes('invalid action') || normalized.includes('accion no valida')) {
    return 'La operación solicitada no es válida para Falabella.';
  }
  if (normalized.includes('version') && (normalized.includes('mandatory') || normalized.includes('obligatoria'))) {
    return 'Falta indicar la versión requerida para conectarse con Falabella.';
  }

  if (normalized.includes('required') || normalized.includes('missing') || normalized.includes('requerido') || normalized.includes('ausente')) {
    return `Falta completar ${publicationFieldText(fieldLabel)} para publicar en Falabella.`;
  }
  if (normalized.includes('price') && (normalized.includes('invalid') || normalized.includes('greater than') || normalized.includes('mayor'))) {
    return 'El precio no es válido para publicar en Falabella.';
  }
  if (normalized.includes('stock') && (normalized.includes('invalid') || normalized.includes('negative') || normalized.includes('negativo'))) {
    return 'La cantidad disponible no es válida para publicar en Falabella.';
  }
  if (normalized.includes('image') || normalized.includes('imagen')) {
    return 'Una o más imágenes no están disponibles o no cumplen los requisitos de Falabella.';
  }
  if (normalized.includes('sku') && (normalized.includes('duplicate') || normalized.includes('duplicad'))) {
    return 'El SKU ya está registrado o aparece repetido en la publicación.';
  }

  return translateGenericRawMessage(text, 'Falabella');
}

function humanizeMercadoLibreCause(cause = {}) {
  const code = normalizeCode(cause.code || cause.error_code || cause.error);
  const rawMessage = String(cause.message || cause.error_message || cause.detail || '').trim();
  const normalizedMessage = normalizeText(rawMessage);
  const references = Array.isArray(cause.references) ? cause.references : [];
  const field = publicationFieldLabel(cause.field) || extractFieldFromReference(references[0]);
  const attributes = extractAttributeLabels(rawMessage);

  if (code === 'item.attribute.invalid_sale_units') {
    return 'El formato de venta y la cantidad por paquete no coinciden. Si vendes por unidad, indica 1; si vendes un paquete, selecciona «Pack» y usa una cantidad mayor que 1.';
  }
  if (code === 'item.attribute.missing.seller.package.dimensions') {
    return 'Faltan datos del paquete del vendedor: alto, ancho, largo o peso.';
  }
  if (code === 'item.attribute.invalid.format.seller.package.dimensions') {
    return 'El formato de las dimensiones del paquete no es válido. Usa centímetros para las medidas y gramos para el peso.';
  }
  if (code === 'item.attribute.invalid.seller.package.dimensions') {
    return 'Las dimensiones o el peso del paquete del vendedor no tienen valores válidos.';
  }
  if (code === 'item.attribute.number_invalid_format') {
    return `El valor de ${publicationFieldText(field || 'atributos')} no tiene un formato numérico válido.`;
  }
  if (code === 'item.description.type.invalid') {
    return 'La descripción debe estar escrita como texto plano, sin etiquetas o formatos no permitidos.';
  }
  if (code === 'body.required_fields' || code === 'body.required_fileds') {
    if (normalizedMessage.includes('variation')) return 'Faltan datos obligatorios en una o más variantes.';
    return `Falta completar ${publicationFieldText(field)}.`;
  }
  if (code === 'body.invalid_field_types') {
    return `El formato de ${publicationFieldText(field)} no es válido.`;
  }
  if (code === 'item.price.invalid') {
    if (normalizedMessage.includes('minimum') || normalizedMessage.includes('minimo')) {
      return 'El precio está por debajo del mínimo permitido para esta categoría.';
    }
    if (normalizedMessage.includes('less than') || normalizedMessage.includes('maximum') || normalizedMessage.includes('maximo')) {
      return 'El precio supera el máximo permitido para esta categoría.';
    }
    return 'El precio no cumple los requisitos de esta categoría.';
  }
  if (code === 'item.category_id.invalid') {
    return 'La categoría seleccionada no permite publicaciones. Elige una categoría habilitada y de último nivel.';
  }
  if (code === 'item.attributes.missing_required' || code === 'item.attribute.missing_catalog_required' || code === 'item.attribute.missing_conditional_required') {
    const labels = attributes.length ? attributes.join(', ') : 'los atributos obligatorios';
    return `Falta completar ${labels} para esta categoría.`;
  }
  if (code === 'item.attributes.invalid_length' || code === 'item.attribute.values.name.invalid') {
    const labels = attributes.length ? attributes.join(', ') : 'uno de los atributos';
    return `El valor de ${labels} supera la longitud máxima permitida.`;
  }
  if (code === 'item.listing_type_id.requirespictures') {
    return 'Este tipo de publicación requiere agregar al menos una imagen.';
  }
  if (code === 'item.pictures.max') {
    const limit = extractFirstNumber(rawMessage);
    return limit
      ? `La categoría permite como máximo ${limit} imágenes.`
      : 'La publicación supera el máximo de imágenes permitido para la categoría.';
  }
  if (code === 'item.pictures.picture_not_found') {
    return 'Una de las imágenes indicadas no existe en Mercado Libre. Carga nuevamente una imagen válida.';
  }
  if (code === 'item.pictures.invalid_size') {
    return 'Las imágenes deben tener al menos 500 píxeles en uno de sus lados.';
  }
  if (code === 'item.pictures.unavailable') {
    return 'Mercado Libre no pudo procesar una imagen. Vuelve a cargarla o reemplázala.';
  }
  if (code === 'item.attributes.non_existent.limit_exceeded') {
    return 'Una variante contiene atributos no permitidos o repetidos para esta categoría.';
  }
  if (code === 'moderations.seller.not_authorized') {
    return 'La cuenta no está autorizada para publicar esta marca en la categoría seleccionada.';
  }
  if (code === 'item.attribute.product_identifier.invalid'
    || code === 'item.attribute.invalid_product_identifier'
    || code === 'item.attribute.product_identifier.invalid_format'
    || code === 'item.attribute.gtin_invalid_domain'
    || code === 'item.attribute.gtin_invalid_brand'
    || code === 'item.attribute.product_identifier.invalid_by_domain_catalog') {
    if (code.includes('brand')) return 'El código universal no corresponde a la marca indicada.';
    if (code.includes('domain')) return 'El código universal no corresponde a la categoría seleccionada.';
    if (code.includes('format')) return 'El código universal (GTIN) tiene un formato inválido.';
    return 'El código universal (GTIN) no es válido o ya está usado en otra publicación.';
  }
  if (code === 'item.attributes.deleted_required') {
    return 'No puedes eliminar un atributo obligatorio para esta categoría.';
  }
  if (code === 'item.title.minimum_length') {
    return 'El título necesita incluir más características principales del producto.';
  }
  if (code === 'item.descriptions.length_exceeded') {
    const limit = extractFirstNumber(rawMessage);
    return limit
      ? `La descripción supera el máximo permitido de ${limit} caracteres.`
      : 'La descripción supera la longitud máxima permitida.';
  }
  if (code === 'item.official_store_id.invalid' || code === 'body.invalid_official_store_id') {
    return 'La cuenta no tiene autorización para publicar en la tienda oficial indicada.';
  }
  if (code === 'item.video_id.dropped') {
    return 'El video no se incluirá en la publicación porque este formato ya no está habilitado.';
  }
  if (code === 'item.category_id.migrated') {
    return 'Mercado Libre actualizó automáticamente la categoría de la publicación.';
  }
  if (code === 'normalize.item.attribute.values' || code === 'create.item.attribute.business_conditional') {
    return 'Mercado Libre ajustará o completará automáticamente un atributo de la publicación.';
  }
  if (code === 'shipping.me2_adoption_mandatory') {
    return 'Mercado Envíos es obligatorio para esta cuenta y categoría; la configuración debe usar ese método.';
  }
  if (code === 'validation_error') {
    return 'Mercado Libre rechazó uno o más datos de la publicación. Revisa el detalle indicado.';
  }
  if (code === 'item.attributes.invalid' || code === 'attribute.invalid' || code === '3510') {
    return 'Uno o más atributos no son válidos para la categoría seleccionada.';
  }

  if (code.startsWith('shipping.')) {
    return 'La configuración de envío no es válida para la cuenta o la categoría seleccionada.';
  }
  if (code.startsWith('moderations.')) {
    return 'Mercado Libre no autorizó la publicación por una regla de cuenta, marca o categoría.';
  }
  if (code.startsWith('item.pictures.')) {
    return 'Una o más imágenes no cumplen los requisitos de Mercado Libre.';
  }
  if (code.startsWith('item.attributes.')) {
    return 'Uno o más atributos no cumplen los requisitos de la categoría.';
  }

  return translateGenericRawMessage(rawMessage || code, 'Mercado Libre');
}

function resolveMarketplace(error, details) {
  const source = normalizeText([
    error?.marketplace_name,
    error?.marketplace_domain,
    details?.marketplace,
    details?.marketplace_name
  ].filter(Boolean).join(' '));

  if (source.includes('mercado') || source.includes('meli')) return 'mercado_libre';
  if (source.includes('falabella')) return 'falabella';
  if (details?.validation || details?.marketplace_errors || details?.marketplace_primary_error) return 'mercado_libre';
  if (details?.feed || details?.feed_id || details?.failed_items || details?.marketplace_error) return 'falabella';
  return null;
}

function getValidationStatus(details, error) {
  return Number(
    details?.validation?.status
    || details?.status
    || error?.status_code
    || error?.status
    || 0
  );
}

function collectFalabellaMessages(details, error) {
  const messages = [];
  const visit = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value === 'string') {
      if (value.trim()) messages.push({ message: value.trim(), code: null, field: null });
      return;
    }
    if (typeof value !== 'object') return;

    const message = value.Message || value.message || value.ErrorMessage || value.error_message || value.Detail || value.detail || value.Reason || value.reason || value.error;
    const code = value.Code || value.code || value.ErrorCode || value.error_code || null;
    const field = value.Field || value.field || null;
    if (message || code) {
      messages.push({ message: message || code, code, field });
    }

    if (value.details) visit(value.details);
    [
      value.FeedErrors,
      value.feed_errors,
      value.Errors,
      value.Error,
      value.Warnings,
      value.Warning,
      value.product_errors
    ].forEach(visit);
  };

  [
    details?.marketplace_error,
    details?.feed?.errors,
    details?.feed?.FeedErrors,
    details?.feed,
    details?.feed_errors,
    details?.FeedErrors,
    details?.raw,
    details?.product_errors,
    details?.errors,
    details?.failed_items,
    /^[a-z0-9_.-]+$/i.test(String(error?.error_message || '').trim()) ? null : error?.error_message,
    error?.message
  ].forEach(visit);

  const seen = new Set();
  return messages.filter((entry) => {
    const key = `${entry.code || ''}|${entry.field || ''}|${entry.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function humanizeMercadoLibreError(details, error) {
  const causes = collectCauseObjects(details, error);
  const blockingCauses = causes.filter((cause) => normalizeText(cause.type) === 'error');
  const usableCauses = blockingCauses.length ? blockingCauses : causes;
  const humanMessages = uniqueMessages(usableCauses.map(humanizeMercadoLibreCause));
  const cataloguedMessages = humanMessages.filter(isCataloguedHumanMessage);
  const primaryCause = usableCauses[0] || null;
  const originalMessage = extractOriginalMessage(primaryCause, details, error);
  const code = primaryCause?.code
    || primaryCause?.error_code
    || primaryCause?.error
    || details?.error_code
    || error?.error_code
    || error?.error
    || null;
  const status = getValidationStatus(details, error);

  let message;
  let detail;
  if (cataloguedMessages.length) {
    message = `No se pudo publicar en Mercado Libre. ${cataloguedMessages[0]}`;
    detail = cataloguedMessages.join(' ');
  } else if (originalMessage) {
    message = translateGenericRawMessage(originalMessage, 'Mercado Libre');
    detail = message;
  } else if (status === 401) {
    message = 'No se pudo publicar en Mercado Libre porque la conexión expiró.';
    detail = 'Vuelve a conectar la cuenta de Mercado Libre e intenta nuevamente.';
  } else if (status === 403) {
    message = 'La cuenta no tiene permisos para publicar en Mercado Libre.';
    detail = 'Revisa los permisos y la configuración de la cuenta.';
  } else if (status === 404) {
    message = 'Mercado Libre no encontró un dato necesario para publicar.';
    detail = 'Revisa la categoría, el tipo de publicación y la configuración seleccionada.';
  } else if (status === 409) {
    message = 'Mercado Libre detectó un conflicto con la publicación.';
    detail = 'Revisa si el producto ya fue publicado e intenta nuevamente.';
  } else if (status === 429) {
    message = 'Mercado Libre limitó temporalmente las solicitudes.';
    detail = 'Intenta nuevamente en unos minutos.';
  } else if (status >= 500) {
    message = 'Mercado Libre no pudo procesar la publicación temporalmente.';
    detail = 'Intenta nuevamente en unos minutos.';
  } else {
    message = 'Mercado Libre no pudo publicar el producto.';
    detail = 'No se recibió un detalle adicional del marketplace.';
  }

  return {
    marketplace: 'mercado_libre',
    message,
    details: detail,
    code,
    cause_id: primaryCause?.cause_id || null,
    original_message: originalMessage,
    status,
    catalogued: cataloguedMessages.length > 0
  };
}

function humanizeFalabellaError(details, error) {
  const entries = collectFalabellaMessages(details, error);
  const primary = entries[0] || null;
  const originalMessage = primary?.message || null;
  const humanMessages = uniqueMessages(
    entries.map((entry) => humanizeFalabellaMessage(entry.message, entry.code, entry.field))
  );
  const cataloguedMessages = humanMessages.filter(isCataloguedHumanMessage);
  const code = primary?.code || details?.error_code || error?.error_code || null;

  return {
    marketplace: 'falabella',
    message: cataloguedMessages.length
      ? `No se pudo publicar en Falabella. ${cataloguedMessages[0]}`
      : originalMessage
        ? translateGenericRawMessage(originalMessage, 'Falabella')
        : 'Falabella no pudo publicar el producto.',
    details: cataloguedMessages.length
      ? cataloguedMessages.join(' ')
      : originalMessage
        ? translateGenericRawMessage(originalMessage, 'Falabella')
        : 'No se recibió un detalle adicional del marketplace.',
    code,
    cause_id: null,
    original_message: originalMessage,
    status: getValidationStatus(details, error),
    catalogued: cataloguedMessages.length > 0
  };
}

function humanizeMarketplaceError(error = {}) {
  const details = parseJsonMaybe(error.error_details) || {};
  const errorCode = normalizeCode(details?.error_code || error?.error_code || error?.error_message);
  const itemState = details?.marketplace_item_state || details?.verification || null;

  if (errorCode.includes('credential is not defined')) {
    return {
      marketplace: null,
      message: 'No se pudo completar la publicación.',
      details: 'Ocurrió un error interno al resolver la cuenta de publicación. Intenta nuevamente.',
      code: errorCode,
      cause_id: null,
      original_message: error.error_message || null,
      status: Number(error.status_code || error.status || 0),
      catalogued: true
    };
  }

  if (errorCode === 'auth_required' || errorCode.includes('invalid token') || errorCode.includes('token expired')) {
    return {
      marketplace: resolveMarketplace(error, details) || 'mercado_libre',
      message: 'La conexión con el marketplace expiró o no es válida.',
      details: 'Vuelve a conectar la cuenta e intenta nuevamente.',
      code: errorCode,
      cause_id: null,
      original_message: error.error_message || null,
      status: Number(error.status_code || error.status || 0),
      catalogued: true
    };
  }

  if (normalizeCode(itemState?.status) === 'paused') {
    const sellerPaused = Array.isArray(itemState?.sub_status)
      && itemState.sub_status.some((value) => normalizeCode(value) === 'paused_by_seller');
    return {
      marketplace: 'mercado_libre',
      message: sellerPaused
        ? 'La publicación quedó pausada en Mercado Libre por configuración del vendedor.'
        : 'La publicación quedó pausada en Mercado Libre.',
      details: sellerPaused
        ? 'Puedes activarla desde la cuenta de Mercado Libre cuando esté lista para vender.'
        : 'Revisa el estado de la publicación en Mercado Libre.',
      code: errorCode || null,
      cause_id: null,
      original_message: error.error_message || null,
      status: Number(error.status_code || error.status || 0),
      catalogued: true
    };
  }

  const marketplace = resolveMarketplace(error, details);

  if (marketplace === 'mercado_libre') return humanizeMercadoLibreError(details, error);
  if (marketplace === 'falabella') return humanizeFalabellaError(details, error);

  const originalMessage = String(error.error_message || error.message || '').trim() || null;
  return {
    marketplace: null,
    message: originalMessage
      ? `No se pudo completar la publicación. Detalle recibido: «${originalMessage}»`
      : 'No se pudo completar la publicación.',
    details: originalMessage || 'No se recibió un detalle adicional.',
    code: error.error_code || error.code || null,
    cause_id: null,
    original_message: originalMessage,
    status: Number(error.status_code || error.status || 0),
    catalogued: false
  };
}

function presentMarketplacePublicationError(error = {}) {
  const presentation = humanizeMarketplaceError(error);
  return {
    ...error,
    error_message: presentation.message,
    error_details: presentation.details,
    marketplace_error: {
      marketplace: presentation.marketplace,
      code: presentation.code,
      cause_id: presentation.cause_id,
      original_message: presentation.original_message,
      status: presentation.status,
      catalogued: presentation.catalogued
    },
    user_error_message: presentation.message,
    user_error_details: presentation.details
  };
}

module.exports = {
  parseJsonMaybe,
  humanizeMarketplaceError,
  presentMarketplacePublicationError,
  humanizeFalabellaMessage,
  humanizeMercadoLibreCause
};
