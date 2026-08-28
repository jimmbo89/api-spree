const logger = require('../../config/logger');
const { Op } = require('sequelize');
const {
  AuditEventRepository,
  CompanyRepository,
  BranchRepository,
  PoolRepository,
  UserAclScopeRepository,
  UserCompanyRepository,
  WarehouseRepository,
  UserMarketplaceCredentialRepository
} = require('../repositories');
const {
  AuditEvent,
  MarketplaceCredential,
  Product,
  User,
  UserCompany
} = require('../models');

const MODULE_LABELS = {
  product: 'Productos',
  warehouse: 'Almacenes',
  marketplace: 'Marketplaces',
  publication_draft: 'Borradores de publicación',
  process: 'Procesos',
  published_product: 'Productos publicados',
  sales: 'Ventas',
  user: 'Usuarios',
  membership: 'Membresías',
  sii: 'SII'
};

const RESULT_LABELS = {
  success: 'Exitoso',
  error: 'Error',
  failed: 'Fallido',
  warning: 'Con advertencias',
  pending: 'Pendiente'
};

const ACTOR_TYPE_LABELS = {
  user: 'Usuario',
  system: 'Sistema',
  marketplace: 'Marketplace',
  automatic_process: 'Proceso automático',
  external_integration: 'Integración externa'
};

const RESOURCE_TYPE_LABELS = {
  product: 'Producto',
  product_variant: 'Variante de producto',
  warehouse: 'Almacén',
  warehouse_product: 'Producto en almacén',
  company: 'Empresa',
  marketplace_credential: 'Conexión marketplace',
  publication_draft: 'Borrador de publicación',
  process: 'Proceso',
  published_product: 'Producto publicado',
  marketplace_order: 'Venta',
  marketplace_order_note: 'Nota de venta',
  marketplace_order_message: 'Mensaje de venta',
  job: 'Proceso',
  user: 'Usuario',
  user_company: 'Membresía'
};

const ACTION_LABELS = {
  'product.created': 'Producto creado',
  'product.updated': 'Producto actualizado',
  'product.attributes_updated': 'Atributos modificados',
  'product.warehouse_configured': 'Configuración de almacén modificada',
  'product.bulk_imported': 'Productos importados',
  'product.deleted': 'Producto eliminado',
  'product.state_changed': 'Estado del producto modificado',
  'product.archived': 'Producto archivado',
  'product.unarchived': 'Producto desarchivado',
  'product.activated': 'Producto activado',
  'product.inactivated': 'Producto inactivado',
  'product.variant_created': 'Variante creada',
  'product.variant_updated': 'Variante modificada',
  'product.variant_deleted': 'Variante eliminada',

  'warehouse.created': 'Almacén creado',
  'warehouse.updated': 'Cambios generales',
  'warehouse.deleted': 'Almacén eliminado',
  'warehouse.status_changed': 'Estado del almacén modificado',
  'warehouse.product_added': 'Producto agregado',
  'warehouse.product_config_updated': 'Configuración de producto modificada',
  'warehouse.product_removed': 'Producto eliminado',
  'warehouse.stock_entry': 'Entrada de existencias',
  'warehouse.stock_exit': 'Salida de existencias',
  'warehouse.stock_adjustment': 'Ajuste de existencias',
  'warehouse.transfer': 'Transferencia',
  'warehouse.bulk_transfer': 'Transferencia masiva',
  'warehouse.bulk_operation': 'Operación masiva',

  'marketplace.connection_created': 'Conexión creada',
  'marketplace.connection_authenticated': 'Conexión autenticada',
  'marketplace.token_renewed': 'Token renovado',
  'marketplace.connection_updated': 'Configuración modificada',
  'marketplace.external_account_changed': 'Cuenta externa modificada',
  'marketplace.connection_disconnected': 'Conexión desconectada',
  'marketplace.connection_deleted': 'Conexión eliminada',

  'publication_draft.created': 'Borrador creado',
  'publication_draft.products_added': 'Productos agregados',
  'publication_draft.products_removed': 'Productos eliminados',
  'publication_draft.marketplaces_added': 'Marketplaces agregados',
  'publication_draft.marketplaces_removed': 'Marketplaces eliminados',
  'publication_draft.attributes_changed': 'Atributos modificados',
  'publication_draft.price_changed': 'Precio modificado',
  'publication_draft.prepared_stock_changed': 'Stock preparado modificado',
  'publication_draft.executed': 'Publicación ejecutada',
  'publication_draft.cancelled': 'Publicación cancelada',

  'process.created': 'Proceso creado',
  'process.started': 'Proceso iniciado',
  'process.stopped': 'Proceso detenido',
  'process.failed': 'Proceso fallido',
  'process.finished': 'Proceso finalizado',
  'process.reprocessed': 'Proceso reprocesado',

  'published_product.created': 'Publicación realizada',
  'published_product.price_changed': 'Precio modificado',
  'published_product.stock_changed': 'Stock modificado',
  'published_product.synced': 'Publicación sincronizada',
  'published_product.paused': 'Publicación pausada',
  'published_product.reactivated': 'Publicación reactivada',
  'published_product.deleted': 'Publicación eliminada',
  'published_product.reprocessed': 'Publicación reprocesada',
  'published_product.marketplace_status_changed': 'Estado informado por marketplace',

  'sales.received': 'Nueva venta recibida',
  'sales.order_created': 'Orden creada en Spree',
  'sales.stock_deducted': 'Stock descontado',
  'sales.stock_reversed': 'Stock revertido',
  'sales.synced': 'Venta sincronizada',
  'sales.status_changed': 'Estado de venta modificado',
  'sales.refreshed': 'Venta actualizada manualmente',
  'sales.note_added': 'Nota interna agregada',
  'sales.message_sent': 'Mensaje enviado',

  'user.created': 'Usuario creado',
  'user.associated': 'Usuario asociado',
  'user.destroy': 'Usuario desasociado',
  'user.list': 'Listado de usuarios',
  'user.pool_warehouse_roles': 'Datos para alta de usuario',
  'user.invited': 'Usuario invitado',
  'user.invite': 'Usuario invitado',
  'user.invite.accept': 'Invitación aceptada',
  'user.updated': 'Usuario actualizado',
  'user.access_updated': 'Accesos de usuario actualizados',
  'user.status_changed': 'Estado del usuario modificado',
  'user.company_role_updated': 'Rol de usuario actualizado',
  'membership.updated': 'Membresía actualizada',
  'membership.status_changed': 'Estado de membresía modificado'
};

const FIELD_LABELS = {
  marketplace_name: 'Marketplace',
  marketplace_domain: 'Dominio del marketplace',
  marketplace: 'Marketplace',
  credential_name: 'Credencial',
  brand: 'Marca',
  model: 'Modelo',
  condition: 'Condición',
  gtin: 'GTIN',
  mpn: 'MPN',
  warehouse_name: 'Almacén',
  warehouse_code: 'Código del almacén',
  source_warehouse_name: 'Almacén origen',
  destination_warehouse_name: 'Almacén destino',
  branch_name: 'Sucursal',
  pool_name: 'Pool',
  job_name: 'Proceso',
  company_name: 'Empresa',
  role_name: 'Rol',
  previous_role_name: 'Rol anterior',
  invitation_method: 'Método de invitación',
  invited_email: 'Correo invitado',
  total_users: 'Total de usuarios',
  is_new_user: 'Usuario nuevo',
  action_text: 'Acción',
  target_user_name: 'Usuario objetivo',
  source: 'Origen',
  status: 'Estado',
  active: 'Estado',
  state: 'Estado del producto',
  previous_status: 'Estado anterior',
  new_status: 'Estado nuevo',
  price: 'Precio',
  sale_price: 'Precio de venta',
  purchase_price: 'Precio de compra',
  stock: 'Existencias',
  available_quantity: 'Cantidad disponible',
  published_stock: 'Existencias publicadas',
  quantity: 'Cantidad',
  sku: 'SKU',
  code: 'Código',
  product_sku: 'SKU del producto',
  local_sku: 'SKU local',
  local_code: 'Código local',
  codigo_local: 'Código local',
  minimum_stock: 'Stock mínimo',
  stock_minimo: 'Stock mínimo',
  existencias_iniciales: 'Existencias iniciales',
  precio_venta: 'Precio de venta',
  precio_compra: 'Precio de compra',
  precio_promocional: 'Precio promocional',
  estado: 'Estado',
  publicar: 'Publicar',
  variante: 'Variante',
  variants_detail: 'Detalle de variantes',
  previous_stock: 'Stock anterior',
  previous_sale_price: 'Precio de venta anterior',
  previous_purchase_price: 'Precio de compra anterior',
  variant: 'Variante',
  name: 'Nombre',
  title: 'Título',
  description: 'Descripción',
  seller_email: 'Correo de cuenta externa',
  seller_id: 'Cuenta externa',
  user_name: 'Usuario',
  user_email: 'Correo del usuario',
  warehouses: 'Almacenes',
  pools: 'Pools',
  marketplace_credentials: 'Credenciales marketplace',
  previous_warehouses: 'Almacenes anteriores',
  previous_pools: 'Pools anteriores',
  previous_marketplace_credentials: 'Credenciales marketplace anteriores',
  authenticated_by_user_name: 'Autenticado por',
  external_account: 'Cuenta externa',
  external_status: 'Estado externo',
  marketplace_status: 'Estado del marketplace',
  error_message: 'Mensaje de error',
  reason: 'Motivo',
  field: 'Campo',
  old_value: 'Valor anterior',
  previous_value: 'Valor anterior',
  new_value: 'Valor nuevo',
  current_value: 'Valor actual',
  before: 'Antes',
  after: 'Después',
  changed_fields: 'Campos modificados',
  bulk: 'Masivo',
  notes: 'Notas',
  movement_type: 'Tipo de movimiento',
  transfer_side: 'Lado de transferencia',
  reference_type: 'Tipo de referencia',
  operation: 'Operación',
  row_number: 'Fila',
  warnings: 'Advertencias',
  total_value: 'Valor total',
  unit_price: 'Precio unitario',
  purchase_price: 'Precio de compra',
  stock_before: 'Stock anterior',
  stock_after: 'Stock posterior',
  initial_stock_total: 'Stock inicial total',
  attributes_updated: 'Atributos modificados',
  images_updated: 'Imágenes modificadas',
  variants_updated: 'Variantes modificadas',
  variants_count: 'Cantidad de variantes',
  variants_configured: 'Variantes configuradas',
  attributes_count: 'Cantidad de atributos',
  warehouses_count: 'Cantidad de almacenes',
  product_label: 'Producto',
  products: 'Productos',
  marketplaces: 'Marketplaces',
  warehouse_label: 'Almacén',
  source_warehouse_label: 'Almacén origen',
  destination_warehouse_label: 'Almacén destino',
  source_type: 'Tipo de origen',
  source: 'Origen',
  publication_step: 'Paso de publicación',
  job_type: 'Tipo de proceso',
  mode: 'Modo de publicación',
  total_expected: 'Total esperado',
  total_products: 'Total de productos',
  products_count: 'Cantidad de productos',
  marketplaces_count: 'Cantidad de marketplaces',
  stock_total: 'Stock total',
  notes_count: 'Cantidad de notas',
  cantidad_de_notas: 'Cantidad de notas',
  notas: 'Notas',
  texto: 'Texto',
  creado_por: 'Creado por',
  fecha: 'Fecha',
  longitud_del_mensaje: 'Longitud del mensaje',
  destinatario: 'Destinatario',
  canal: 'Canal',
  messages_count: 'Cantidad de mensajes',
  text_length: 'Longitud del texto',
  refresh_source: 'Fuente de actualización',
  fallback_error: 'Error alternativo',
  batch_id: 'Lote',
  reprocess_job_id: 'ID del reproceso',
  origin_job_id: 'ID del proceso origen',
  reprocessed_tasks_count: 'Cantidad de tareas reprocesadas',
  total_total: 'Total',
  external_url: 'URL externa',
  order_status: 'Estado de la venta',
  payment_status: 'Estado del pago',
  total_amount: 'Total de la venta',
  currency: 'Moneda',
  buyer_name: 'Comprador',
  seller_name: 'Vendedor',
  shipping_status: 'Estado del envío',
  payment_method: 'Método de pago',
  shipping_city: 'Ciudad de envío',
  shipping_region: 'Región de envío',
  subtotal: 'Subtotal',
  shipping_total: 'Costo de envío',
  discount_total: 'Descuento total',
  tax_total: 'Impuestos',
  invoice_type: 'Tipo de documento',
  lote: 'Lote',
  modalidad: 'Modalidad',
  paso_de_publicacion: 'Paso de publicación',
  cantidad_de_productos: 'Cantidad de productos',
  cantidad_de_marketplaces: 'Cantidad de marketplaces',
  stock_total_preparado: 'Stock total preparado',
  productos: 'Productos',
  productos_configurados: 'Productos configurados',
  marketplaces_configurados: 'Marketplaces configurados',
  marketplaces_asignados: 'Marketplaces asignados',
  producto: 'Producto',
  credencial: 'Credencial',
  dominio: 'Dominio',
  tipo_de_proceso: 'Tipo de proceso',
  total_esperado: 'Total esperado',
  proceso_origen: 'Proceso origen',
  proceso_reproceso: 'Proceso de reproceso',
  tareas_reprocesadas: 'Tareas reprocesadas',
  estado_anterior: 'Estado anterior',
  total_de_productos_publicados: 'Total de productos publicados',
  estado_de_publicacion: 'Estado de publicación',
  precio_publicado: 'Precio publicado',
  stock_publicado: 'Stock publicado',
  tiene_advertencias: 'Tiene advertencias',
  sincronizado_desde: 'Sincronizado desde',
  origen: 'Origen',
  auth_type: 'Tipo de autenticación',
  auth_required: 'Requiere autenticación',
  triggered_by: 'Activado por',
  connection_valid: 'Conexión válida',
  updated_fields: 'Campos modificados',
  access_token_configured: 'Token de acceso configurado',
  refresh_token_configured: 'Token de renovación configurado',
  api_key_configured: 'Clave API configurada',
  access_token: 'Token de acceso',
  refresh_token: 'Token de renovación',
  api_key: 'Clave API',
  additional_data: 'Datos adicionales',
  additional_data_configured: 'Datos adicionales configurados',
  expires_at: 'Expira el',
  expires_in: 'Expira en',
  country: 'País',
  feed_confirmed: 'Confirmación del marketplace',
  topic: 'Tipo de notificación',
  seller_sku: 'SKU del vendedor',
  elapsed_minutes: 'Minutos transcurridos',
  stage: 'Etapa',
  error: 'Error',
  successful: 'Exitosos',
  errors_count: 'Errores',
  processed: 'Procesados',
  percentage: 'Porcentaje',
  batch: 'Lote',
  total: 'Total',
  created: 'Creados',
  updated: 'Actualizados',
  deleted: 'Eliminados',
  failed: 'Fallidos'
};

const HUMANIZE_TOKEN_LABELS = {
  product: 'producto',
  products: 'productos',
  warehouse: 'almacén',
  warehouses: 'almacenes',
  marketplace: 'marketplace',
  marketplaces: 'marketplaces',
  credential: 'credencial',
  credentials: 'credenciales',
  publication: 'publicación',
  publications: 'publicaciones',
  draft: 'borrador',
  drafts: 'borradores',
  process: 'proceso',
  processes: 'procesos',
  published: 'publicado',
  published_product: 'producto publicado',
  sales: 'ventas',
  sale: 'venta',
  order: 'venta',
  orders: 'ventas',
  note: 'nota',
  message: 'mensaje',
  user: 'usuario',
  system: 'sistema',
  automatic: 'automático',
  integration: 'integración',
  external: 'externo',
  connected: 'conectado',
  disconnected: 'desconectado',
  authenticated: 'autenticado',
  created: 'creado',
  updated: 'actualizado',
  deleted: 'eliminado',
  changed: 'modificado',
  modified: 'modificado',
  added: 'agregado',
  removed: 'eliminado',
  renewed: 'renovado',
  cancelled: 'cancelado',
  canceled: 'cancelado',
  executed: 'ejecutado',
  started: 'iniciado',
  stopped: 'detenido',
  finished: 'finalizado',
  paused: 'pausado',
  reactivated: 'reactivado',
  synced: 'sincronizado',
  received: 'recibido',
  failed: 'fallido',
  warning: 'con advertencias',
  pending: 'pendiente',
  success: 'exitoso',
  error: 'error',
  stock: 'stock',
  price: 'precio',
  quantity: 'cantidad',
  available: 'disponible',
  status: 'estado',
  previous: 'anterior',
  current: 'actual',
  new: 'nuevo',
  old: 'anterior',
  source: 'origen',
  destination: 'destino',
  branch: 'sucursal',
  pool: 'pool',
  ml: 'Mercado Libre',
  fb: 'Falabella',
  job: 'proceso',
  task: 'tarea',
  type: 'tipo',
  count: 'cantidad',
  total: 'total',
  expected: 'esperado',
  refresh: 'actualización',
  edit: 'edición',
  update: 'actualización',
  webhook: 'notificación web',
  payload: 'carga útil',
  text: 'texto',
  length: 'longitud',
  url: 'URL',
  id: 'ID',
  api: 'API',
  http: 'HTTP',
  https: 'HTTPS',
  json: 'JSON',
  xml: 'XML',
  sku: 'SKU',
  ean: 'EAN',
  gtin: 'GTIN',
  mpn: 'MPN',
  ip: 'IP',
  resource: 'recurso',
  related: 'relacionado',
  actor: 'actor',
  module: 'módulo',
  result: 'resultado',
  description: 'descripción',
  brand: 'marca',
  name: 'nombre',
  title: 'título',
  image: 'imagen',
  images: 'imágenes',
  variant: 'variante',
  variants: 'variantes',
  attribute: 'atributo',
  attributes: 'atributos',
  token: 'token',
  account: 'cuenta',
  domain: 'dominio',
  email: 'correo',
  reason: 'motivo',
  change: 'cambio',
  changes: 'cambios',
  field: 'campo',
  fields: 'campos',
  configured: 'configurado',
  configuration: 'configuración',
  valid: 'válido',
  required: 'requerido',
  import: 'importación',
  bulk_import: 'importación masiva',
  product_creation: 'creación de producto',
  marketplace_credential_create: 'creación de credencial marketplace',
  marketplace_credential_refresh: 'renovación de credencial marketplace',
  marketplace_credential_update: 'actualización de credencial marketplace',
  marketplace_token_refresh: 'renovación de token marketplace',
  spree_marketplace_edit: 'edición desde Spree hacia marketplace',
  adapter: 'adaptador',
  automatic: 'automático',
  manual_update: 'actualización manual',
  user_requested: 'solicitado por usuario',
  timeout: 'tiempo agotado',
  job_process: 'procesamiento de proceso',
  entry: 'entrada',
  exit: 'salida',
  fifo: 'FIFO',
  lot: 'lote',
  matched: 'coincidente'
};

const VALUE_LABELS = {
  origin: 'Origen',
  destination: 'Destino',
  entry: 'Entrada',
  exit: 'Salida',
  transfer: 'Transferencia',
  transfer_exit: 'Salida de transferencia',
  transfer_entry: 'Entrada de transferencia',
  draft: 'Borrador',
  publish: 'Publicación',
  quick: 'Rápido',
  advanced: 'Avanzado',
  manual: 'Manual',
  republish: 'Republicación',
  sync: 'Sincronización',
  processing: 'Procesando',
  spree: 'Spree',
  webhook: 'Notificación web',
  marketplace_webhook: 'Notificación del marketplace',
  draft_payload_edit: 'Edición de borrador',
  manual_refresh: 'Actualización manual',
  refresh: 'Actualización',
  spree_marketplace_edit: 'Edición desde Spree hacia marketplace',
  bulk_import: 'Importación masiva',
  product_creation: 'Creación de producto',
  warehouse_product_update: 'Actualización de producto en almacén',
  warehouse_product_create: 'Producto agregado al almacén',
  warehouse_product_delete: 'Producto eliminado del almacén',
  marketplace_credential_create: 'Creación de credencial marketplace',
  marketplace_credential_refresh: 'Renovación de credencial marketplace',
  marketplace_credential_update: 'Actualización de credencial marketplace',
  marketplace_token_refresh: 'Renovación de token marketplace',
  manual_update: 'Actualización manual',
  adapter: 'Adaptador',
  automatic: 'Automático',
  user_requested: 'Solicitado por usuario',
  timeout: 'Tiempo agotado',
  job_process: 'Procesamiento de proceso',
  bulk: 'Masivo',
  notes: 'Notas',
  stock: 'Existencias',
  created: 'Creado',
  updated: 'Actualizado',
  movement: 'Movimiento',
  value: 'Valor',
  price: 'Precio',
  quantity: 'Cantidad',
  status: 'Estado',
  name: 'Nombre',
  brand: 'Marca',
  model: 'Modelo',
  condition: 'Condición',
  description: 'Descripción',
  title: 'Título',
  attributes: 'Atributos',
  images: 'Imágenes',
  variants: 'Variantes',
  available_quantity: 'Cantidad disponible',
  published_stock: 'Existencias publicadas',
  external_url: 'URL externa',
  seller_email: 'Correo de cuenta externa',
  seller_id: 'Cuenta externa',
  country: 'País',
  expires_at: 'Fecha de expiración',
  active: 'Activo',
  inactive: 'Inactivo',
  connected: 'Conectado',
  disconnected: 'Desconectado',
  paid: 'Pagado',
  unpaid: 'Sin pagar',
  approved: 'Aprobado',
  rejected: 'Rechazado',
  returned: 'Devuelto',
  refunded: 'Reembolsado',
  in_progress: 'En preparación',
  shipped: 'Enviado',
  delivered: 'Entregado',
  ready_to_ship: 'Listo para enviar',
  not_delivered: 'No entregado',
  partially_paid: 'Pago parcial',
  payment_required: 'Pago pendiente',
  cancelled_by_marketplace: 'Cancelado por el marketplace',
  confirmed: 'Confirmado',
  cancelled: 'Cancelado',
  canceled: 'Cancelado',
  closed: 'Cerrado',
  deleted: 'Eliminado',
  pending: 'Pendiente',
  completed: 'Completado',
  completed_with_errors: 'Completado con errores',
  published: 'Publicado',
  published_with_warnings: 'Publicado con advertencias',
  not_published: 'No publicado',
  under_review: 'En revisión',
  failed: 'Fallido',
  error: 'Error',
  oauth: 'OAuth',
  fifo: 'FIFO',
  true: 'Sí',
  false: 'No'
};

function humanizeCode(value) {
  if (!value) return null;

  const parts = String(value)
    .split(/[._-]+/)
    .filter(Boolean);

  if (parts.length === 0) return null;

  const hasUnknownToken = parts.some((part) => {
    const normalized = part.toLowerCase();
    if (HUMANIZE_TOKEN_LABELS[normalized]) return false;
    if (/^\d+$/.test(part)) return false;
    if (/^[A-Z]{2,6}$/.test(part)) return false;
    return true;
  });

  if (hasUnknownToken) {
    return 'Dato técnico';
  }

  return parts
    .map((part) => HUMANIZE_TOKEN_LABELS[part.toLowerCase()] || part.toLowerCase())
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function getFieldLabel(key) {
  return FIELD_LABELS[key] || humanizeCode(key);
}

function getValueLabel(value) {
  if (value == null) return value;

  const normalized = String(value).trim();
  if (!normalized) return value;

  const directLabel = VALUE_LABELS[normalized.toLowerCase()];
  if (directLabel) return directLabel;

  if (!/[._-]/.test(normalized)) return value;

  return humanizeCode(normalized);
}

function toOptions(labels) {
  return Object.entries(labels).map(([value, label]) => ({ value, label }));
}

function normalizeOptionValue(value, { stringify = false } = {}) {
  if (value == null || value === '') return null;
  return stringify ? String(value) : value;
}

function makeOption(value, label, metadata = {}, options = {}) {
  const normalizedValue = normalizeOptionValue(value, options);
  if (normalizedValue == null) return null;

  return {
    value: normalizedValue,
    label: label || String(normalizedValue),
    ...metadata
  };
}

function dedupeOptions(options = []) {
  const map = new Map();

  for (const option of options) {
    if (!option || option.value == null) continue;
    const key = String(option.value);
    if (!map.has(key)) {
      map.set(key, option);
    }
  }

  return Array.from(map.values());
}

function buildActionOptionsByModule() {
  return Object.entries(ACTION_LABELS).reduce((acc, [value, label]) => {
    const module = value.split('.')[0];
    if (!acc[module]) acc[module] = [];
    acc[module].push({ value, label });
    return acc;
  }, {});
}

async function getUserScopeData(req, companyId) {
  if (req.user?.role_id) {
    return {
      has_full_access: true,
      warehouse_ids: null,
      pool_ids: null,
      marketplace_credential_ids: null,
      marketplace_ids: null
    };
  }

  const scopes = await UserAclScopeRepository.findByUserAndCompany(req.user.id, companyId);
  const allowedCredentials = await UserMarketplaceCredentialRepository.findActiveCredentialsByUserAndCompany(
    req.user.id,
    companyId
  );

  return {
    has_full_access: false,
    warehouse_ids: scopes.map(scope => Number(scope.warehouse_id)).filter(Boolean),
    pool_ids: scopes.map(scope => Number(scope.pool_id)).filter(Boolean),
    marketplace_credential_ids: allowedCredentials.map(row => Number(row.id)).filter(Boolean),
    marketplace_ids: allowedCredentials.map(row => Number(row.marketplace_id)).filter(Boolean)
  };
}

function applyScopeToWhere(scopeWhere) {
  return scopeWhere && (Object.keys(scopeWhere).length > 0 || Object.getOwnPropertySymbols(scopeWhere).length > 0)
    ? [scopeWhere]
    : [];
}

function mapUserOption(user) {
  if (!user) return null;

  const primary = user.name || user.user || user.email || `Usuario ${user.id}`;
  const subtitle = user.email && user.email !== primary ? user.email : null;
  return makeOption(user.id, primary, {
    subtitle,
    image: user.image || null,
    status: user.status
  }, { stringify: true });
}

async function getUserOptions(companyId) {
  const memberships = await UserCompany.findAll({
    where: {
      company_id: companyId,
      status: { [Op.ne]: 0 }
    },
    include: [{
      model: User,
      as: 'user',
      attributes: ['id', 'name', 'email', 'user', 'status'],
      required: true
    }],
    order: [[{ model: User, as: 'user' }, 'name', 'ASC']]
  });

  return dedupeOptions(memberships.map(membership => mapUserOption(membership.user)));
}

async function getMarketplaceAndCredentialOptions(companyId, scopeData) {
  const where = { company_id: companyId };
  if (!scopeData.has_full_access) {
    where.id = {
      [Op.in]: scopeData.marketplace_credential_ids.length > 0
        ? scopeData.marketplace_credential_ids
        : [0]
    };
  }

  const credentials = await MarketplaceCredential.findAll({
    where,
    attributes: ['id', 'name', 'seller_email', 'seller_id', 'marketplace_id', 'active'],
    include: [{
      association: 'marketplace',
      attributes: ['id', 'name', 'domain', 'active'],
      required: false
    }],
    order: [['name', 'ASC']]
  });

  const credentialOptions = credentials.map((credential) => {
    const marketplaceName = credential.marketplace?.name || 'Marketplace';
    const account = credential.seller_email || credential.seller_id || null;
    const subtitle = account
      ? `${marketplaceName} · ${account}`
      : marketplaceName;

    return makeOption(credential.id, credential.name, {
      subtitle,
      marketplace_id: credential.marketplace_id,
      marketplace_label: marketplaceName,
      active: credential.active
    });
  });

  const marketplaceOptions = dedupeOptions(credentials.map((credential) => makeOption(
    credential.marketplace_id,
    credential.marketplace?.name || `Marketplace ${credential.marketplace_id}`,
    {
      subtitle: credential.marketplace?.domain || null,
      domain: credential.marketplace?.domain || null,
      active: credential.marketplace?.active
    }
  )));

  return {
    marketplaces: marketplaceOptions,
    marketplace_credentials: dedupeOptions(credentialOptions)
  };
}

async function getWarehouseOptions(companyId, scopeData) {
  const warehouses = await WarehouseRepository.findFiltered({
    companyId,
    warehouseIds: scopeData.has_full_access ? null : scopeData.warehouse_ids,
    includeProducts: false
  });

  return dedupeOptions(warehouses.map(warehouse => makeOption(warehouse.id, warehouse.code
    ? `${warehouse.name} (${warehouse.code})`
    : warehouse.name, {
      image: warehouse.image || null,
      branch_label: warehouse.branchName || null,
      status: warehouse.status
    })));
}

async function getBranchOptions(companyId) {
  const branches = await BranchRepository.findFiltered({ companyId, status: 1 });

  return dedupeOptions(branches.map(branch => makeOption(branch.id, branch.name, {
    image: branch.image || null,
    status: branch.status
  })));
}

async function getPoolOptions(companyId, scopeData) {
  const pools = await PoolRepository.findFiltered({
    companyId,
    poolIds: scopeData.has_full_access ? null : scopeData.pool_ids,
    warehouseIds: scopeData.has_full_access ? null : scopeData.warehouse_ids
  });

  return dedupeOptions(pools.map(pool => makeOption(pool.id, pool.name, {
    is_active: pool.is_active,
    warehouse_count: pool.warehouse_count
  })));
}

function getProductImage(product) {
  const images = product?.images;
  if (Array.isArray(images)) return images[0] || null;
  if (typeof images === 'string') {
    try {
      const parsed = JSON.parse(images);
      if (Array.isArray(parsed)) return parsed[0] || null;
    } catch (error) {
      return images || null;
    }
  }

  return null;
}

async function getProductOptions(companyId) {
  const products = await Product.findAll({
    where: { company_id: companyId },
    attributes: ['id', 'sku', 'name', 'brand', 'images', 'state'],
    order: [['name', 'ASC']],
    limit: 500
  });

  return dedupeOptions(products.map(product => makeOption(product.id, product.name, {
    subtitle: product.sku || product.brand || null,
    image: getProductImage(product),
    sku: product.sku || null,
    state: product.state
  }, { stringify: true })));
}

async function getAuditedResourceOptions(companyId, scopeWhere) {
  const whereConditions = [
    { company_id: companyId },
    {
      resource_id: {
        [Op.ne]: null
      }
    },
    ...applyScopeToWhere(scopeWhere)
  ];

  const events = await AuditEvent.findAll({
    where: { [Op.and]: whereConditions },
    attributes: ['resource_type', 'resource_id', 'resource_label'],
    order: [['id', 'DESC']],
    limit: 500
  });

  return events.reduce((acc, event) => {
    if (!event.resource_type || !event.resource_id) return acc;

    if (!acc[event.resource_type]) acc[event.resource_type] = [];
    acc[event.resource_type].push(makeOption(
      event.resource_id,
      event.resource_label || `${RESOURCE_TYPE_LABELS[event.resource_type] || humanizeCode(event.resource_type)} ${event.resource_id}`,
      {},
      { stringify: true }
    ));

    return acc;
  }, {});
}

async function buildFilterOptions({ companyId, req, scopeWhere }) {
  const actionOptionsByModule = buildActionOptionsByModule();
  const scopeData = await getUserScopeData(req, companyId);
  const [
    users,
    marketplaceData,
    warehouses,
    branches,
    pools,
    products,
    auditedResourceOptions
  ] = await Promise.all([
    getUserOptions(companyId),
    getMarketplaceAndCredentialOptions(companyId, scopeData),
    getWarehouseOptions(companyId, scopeData),
    getBranchOptions(companyId),
    getPoolOptions(companyId, scopeData),
    getProductOptions(companyId),
    getAuditedResourceOptions(companyId, scopeWhere)
  ]);

  const resourceOptionsByType = Object.fromEntries(
    Object.entries(auditedResourceOptions).map(([type, options]) => [type, dedupeOptions(options)])
  );

  return {
    recommended_filters: [
      'module',
      // 'action',
      // 'result',
      'actor_type',
      // 'resource_type',
      'start',
      'end'
    ],
    advanced_filters: [
      'actor_id',
      'resource_type',
      // 'resource_id',
      // 'related_resource_type',
      // 'related_resource_id',
      // 'marketplace_id',
      'marketplace_credential_id',
      'product_id',
      // 'pool_id',
      'warehouse_id',
      // 'branch_id',
      // 'job_id',
      // 'origin_job_id',
      // 'correlation_id'
    ],
    fields: [
      {
        key: 'module',
        label: 'Módulo',
        type: 'select',
        options: toOptions(MODULE_LABELS)
      },
      {
        key: 'action',
        label: 'Acción',
        type: 'select',
        depends_on: 'module',
        options: toOptions(ACTION_LABELS),
        options_by_module: actionOptionsByModule
      },
      {
        key: 'result',
        label: 'Resultado',
        type: 'select',
        options: toOptions(RESULT_LABELS)
      },
      {
        key: 'actor_type',
        label: 'Tipo de actor',
        type: 'select',
        options: toOptions(ACTOR_TYPE_LABELS)
      },
      {
        key: 'actor_id',
        label: 'Actor',
        type: 'select',
        depends_on: 'actor_type',
        advanced: true,
        options_by_actor_type: {
          user: users,
          marketplace: marketplaceData.marketplaces,
          system: [
            { value: 'system', label: 'Sistema' },
            { value: 'spree', label: 'Spree' }
          ],
          automatic_process: [],
          external_integration: []
        },
        value_hint: 'Se envía el value estable del actor seleccionado'
      },
      {
        key: 'resource_type',
        label: 'Tipo de recurso',
        type: 'select',
        options: toOptions(RESOURCE_TYPE_LABELS)
      },
      // {
      //   key: 'resource_id',
      //   label: 'Recurso',
      //   type: 'select',
      //   depends_on: 'resource_type',
      //   advanced: true,
      //   options_by_resource_type: resourceOptionsByType,
      //   value_hint: 'Se envía el value estable del recurso seleccionado'
      // },
      // {
      //   key: 'related_resource_type',
      //   label: 'Tipo relacionado',
      //   type: 'select',
      //   options: toOptions(RESOURCE_TYPE_LABELS),
      //   advanced: true
      // },
      // {
      //   key: 'related_resource_id',
      //   label: 'Recurso relacionado',
      //   type: 'select',
      //   depends_on: 'related_resource_type',
      //   advanced: true,
      //   options_by_resource_type: resourceOptionsByType,
      //   value_hint: 'Se envía el value estable del recurso relacionado'
      // },
      // {
      //   key: 'marketplace_id',
      //   label: 'Marketplace',
      //   type: 'select',
      //   advanced: true,
      //   options: marketplaceData.marketplaces
      // },
      {
        key: 'marketplace_credential_id',
        label: 'Credencial marketplace',
        type: 'select',
        advanced: true,
        options: marketplaceData.marketplace_credentials
      },
      {
        key: 'product_id',
        label: 'Producto',
        type: 'select',
        advanced: true,
        options: products,
        value_hint: 'Se filtra como recurso de auditoría tipo producto'
      },
      // {
      //   key: 'pool_id',
      //   label: 'Pool',
      //   type: 'select',
      //   advanced: true,
      //   options: pools
      // },
      {
        key: 'warehouse_id',
        label: 'Almacén',
        type: 'select',
        advanced: true,
        options: warehouses
      },
      // {
      //   key: 'branch_id',
      //   label: 'Sucursal',
      //   type: 'select',
      //   advanced: true,
      //   options: branches
      // },
      // {
      //   key: 'job_id',
      //   label: 'Proceso',
      //   type: 'number',
      //   advanced: true
      // },
      // {
      //   key: 'origin_job_id',
      //   label: 'Proceso origen',
      //   type: 'number',
      //   advanced: true
      // },
      // {
      //   key: 'correlation_id',
      //   label: 'Correlación',
      //   type: 'text',
      //   advanced: true
      // },
      {
        key: 'start',
        label: 'Desde',
        type: 'date'
      },
      {
        key: 'end',
        label: 'Hasta',
        type: 'date'
      }
    ],
    dynamic_options: {
      users,
      marketplaces: marketplaceData.marketplaces,
      marketplace_credentials: marketplaceData.marketplace_credentials,
      products,
      warehouses,
      branches,
      pools,
      resources_by_type: resourceOptionsByType
    }
  };
}

function isSensitiveDisplayKey(key) {
  const normalized = String(key).toLowerCase();
  if (['credential_name', 'marketplace_credential_name'].includes(normalized)) return false;
  return /token|secret|password|authorization|api_key|access_token|refresh_token/i.test(normalized);
}

function isInternalIdDisplayKey(key) {
  return /(^id$|_id$|Id$|ids$|_ids$|correlation_id$|dedupe_key$)/i.test(String(key));
}

function shouldHideDisplayKey(key) {
  return isSensitiveDisplayKey(key) || isInternalIdDisplayKey(key) || [
    'draft_name',
    'resource',
    'audit_key',
    'raw_payload',
    'api_response',
    'error_details'
  ].includes(key);
}

function normalizePlainValue(value) {
  if (value && typeof value.get === 'function') {
    return value.get({ plain: true });
  }

  return value;
}

function parseDisplayValue(value) {
  const normalized = normalizePlainValue(value);

  if (typeof normalized !== 'string') return normalized;

  const trimmed = normalized.trim();
  if (!trimmed) return normalized;

  const looksLikeJson =
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'));

  if (!looksLikeJson) return normalized;

  try {
    return JSON.parse(trimmed);
  } catch (error) {
    return normalized;
  }
}

function getProductStateDisplayLabel(value) {
  const labels = {
    "-1": 'Archivado',
    0: 'Inactivo',
    1: 'Activo',
    2: 'Archivado'
  };
  return labels[Number(value)] || null;
}

const LITERAL_DISPLAY_VALUE_KEYS = new Set([
  'sku',
  'gtin',
  'mpn',
  'code',
  'product_sku',
  'local_sku',
  'local_code',
  'codigo_local',
  'warehouse_code',
  'warehouse_name',
  'product_label',
  'producto',
  'marketplace',
  'credencial',
  'dominio',
  'sincronizado_desde',
  'texto',
  'destinatario',
  'canal',
  'variant',
  'variante',
  'name',
  'title',
  'description',
  'seller_email',
  'seller_id',
  'ml_user_id'
]);

function formatDisplayValue(value, key = null) {
  const normalized = parseDisplayValue(value);

  if (normalized == null || normalized === '') return 'Sin valor';
  if (typeof normalized === 'boolean') return normalized ? 'Sí' : 'No';
  if (normalized instanceof Date) return normalized.toISOString();
  if (key === 'country') {
    const countries = { CL: 'Chile', PE: 'Perú', CO: 'Colombia', MX: 'México', AR: 'Argentina', BR: 'Brasil' };
    return countries[String(normalized).toUpperCase()] || String(normalized);
  }
  if (key === 'topic') {
    const topic = String(normalized).toLowerCase();
    if (topic.includes('order')) return 'Actualización de venta';
    if (topic.includes('shipment') || topic.includes('shipping')) return 'Actualización de envío';
    if (topic.includes('item') || topic.includes('product')) return 'Actualización de publicación';
    if (topic.includes('credential') || topic.includes('token')) return 'Actualización de conexión';
    return 'Notificación recibida';
  }
  if (key === 'expires_at' || /(?:_at|fecha)$/.test(String(key || ''))) {
    const date = new Date(normalized);
    if (!Number.isNaN(date.getTime())) {
      return new Intl.DateTimeFormat('es-CL', {
        dateStyle: 'medium',
        timeStyle: 'short'
      }).format(date);
    }
  }
  if (LITERAL_DISPLAY_VALUE_KEYS.has(key)) return String(normalized);
  if (key === 'state') {
    const stateLabel = getProductStateDisplayLabel(normalized);
    if (stateLabel) return stateLabel;
  }
  if (Array.isArray(normalized)) {
    if (normalized.length === 0) return 'Sin elementos';
    return normalized
      .map(item => formatDisplayValue(item))
      .filter(Boolean)
      .join(', ');
  }
  if (typeof normalized === 'object') {
    const entries = objectToDisplayRows(normalized);
    if (entries.length === 0) return 'Sin datos visibles';
    return entries.map(entry => `${entry.label}: ${entry.value}`).join(' | ');
  }

  return getValueLabel(String(normalized));
}

function objectToDisplayRows(value) {
  const normalized = parseDisplayValue(value);

  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
    return [];
  }

  return Object.entries(normalized)
    .filter(([key, entryValue]) => !shouldHideDisplayKey(key) && entryValue !== undefined)
    .map(([key, entryValue]) => ({
      key,
      label: getFieldLabel(key),
      value: formatDisplayValue(entryValue, key)
    }))
    .filter(row => row.value !== 'Sin datos visibles');
}

function buildDisplayContext(event) {
  const context = [
    { key: 'module', label: 'Módulo', value: MODULE_LABELS[event.module] || humanizeCode(event.module) }
  ];

  if (event.related_resource_type) {
    context.push({
      key: 'related_resource',
      label: 'Recurso relacionado',
      value: RESOURCE_TYPE_LABELS[event.related_resource_type] || humanizeCode(event.related_resource_type)
    });
  }

  return context.filter(row => row.value);
}

function buildDisplayChanges(changes) {
  const normalized = parseDisplayValue(changes);
  if (!Array.isArray(normalized)) return [];

  return normalized
    .filter(change => change && !shouldHideDisplayKey(change.field || change.key || ''))
    .map(change => {
      const field = change.field || change.key || change.attribute || 'change';
      return {
        field,
        field_label: getFieldLabel(field),
        previous: formatDisplayValue(change.old_value ?? change.previous_value ?? change.before, field),
        current: formatDisplayValue(change.new_value ?? change.current_value ?? change.after, field)
      };
    });
}

function buildDisplay(event, labels) {
  return {
    summary: {
      title: labels.action_label,
      module: labels.module_label,
      result: labels.result_label,
      description: event.description || labels.action_label,
      occurred_at: event.occurred_at
    },
    actor: {
      name: event.actor_name || labels.actor_type_label,
      type: labels.actor_type_label
    },
    resource: {
      label: event.resource_label || labels.resource_type_label,
      type: labels.resource_type_label
    },
    related_resource: event.related_resource_type ? {
      label: labels.related_resource_type_label,
      type: labels.related_resource_type_label
    } : null,
    context: buildDisplayContext(event),
    changes: buildDisplayChanges(event.changes),
    details: {
      previous_value: objectToDisplayRows(event.previous_value),
      new_value: objectToDisplayRows(event.new_value),
      metadata: objectToDisplayRows(event.metadata)
    }
  };
}

function mapEvent(event) {
  const labels = {
    module_label: MODULE_LABELS[event.module] || humanizeCode(event.module),
    action_label: ACTION_LABELS[event.action] || humanizeCode(event.action),
    result_label: RESULT_LABELS[event.result] || humanizeCode(event.result),
    actor_type_label: ACTOR_TYPE_LABELS[event.actor_type] || humanizeCode(event.actor_type),
    resource_type_label: RESOURCE_TYPE_LABELS[event.resource_type] || humanizeCode(event.resource_type),
    related_resource_type_label: RESOURCE_TYPE_LABELS[event.related_resource_type] || humanizeCode(event.related_resource_type)
  };

  return {
    id: event.id,
    company_id: event.company_id,
    occurred_at: event.occurred_at,
    module: event.module,
    module_label: labels.module_label,
    action: event.action,
    action_label: labels.action_label,
    result: event.result,
    result_label: labels.result_label,
    actor_type: event.actor_type,
    actor_type_label: labels.actor_type_label,
    actor_id: event.actor_id,
    actor_name: event.actor_name,
    resource_type: event.resource_type,
    resource_type_label: labels.resource_type_label,
    resource_id: event.resource_id,
    resource_label: event.resource_label,
    related_resource_type: event.related_resource_type,
    related_resource_type_label: labels.related_resource_type_label,
    related_resource_id: event.related_resource_id,
    marketplace_id: event.marketplace_id,
    marketplace_credential_id: event.marketplace_credential_id,
    pool_id: event.pool_id,
    warehouse_id: event.warehouse_id,
    branch_id: event.branch_id,
    job_id: event.job_id,
    origin_job_id: event.origin_job_id,
    parent_event_id: event.parent_event_id,
    previous_value: event.previous_value,
    new_value: event.new_value,
    changes: event.changes,
    description: event.description,
    metadata: event.metadata,
    correlation_id: event.correlation_id,
    created_at: event.createdAt,
    display: buildDisplay(event, labels)
  };
}

async function buildScopeWhere(req, companyId) {
  if (req.user?.role_id) return {};

  const scopes = await UserAclScopeRepository.findByUserAndCompany(req.user.id, companyId);
  const warehouseIds = scopes.map(scope => scope.warehouse_id).filter(Boolean);
  const poolIds = scopes.map(scope => scope.pool_id).filter(Boolean);
  const allowedCredentials = await UserMarketplaceCredentialRepository.findActiveCredentialsByUserAndCompany(
    req.user.id,
    companyId
  );
  const credentialIds = allowedCredentials
    .map(row => row.id)
    .filter(Boolean);
  const marketplaceIds = allowedCredentials
    .map(row => row.marketplace_id)
    .filter(Boolean);

  const and = [
    {
      [Op.or]: [
        { warehouse_id: null },
        ...(warehouseIds.length > 0 ? [{ warehouse_id: { [Op.in]: warehouseIds } }] : [])
      ]
    },
    {
      [Op.or]: [
        { pool_id: null },
        ...(poolIds.length > 0 ? [{ pool_id: { [Op.in]: poolIds } }] : [])
      ]
    },
    {
      [Op.or]: [
        { marketplace_credential_id: null },
        ...(credentialIds.length > 0 ? [{ marketplace_credential_id: { [Op.in]: credentialIds } }] : [])
      ]
    },
    {
      [Op.or]: [
        { marketplace_id: null },
        ...(marketplaceIds.length > 0 ? [{ marketplace_id: { [Op.in]: marketplaceIds } }] : [])
      ]
    }
  ];

  return { [Op.and]: and };
}

const AuditEventController = {
  async list(req, res) {
    try {
      const companyId = Number(req.body.company_id);
      const filters = { ...req.body };
      if (filters.product_id != null && filters.product_id !== '') {
        filters.resource_type = 'product';
        filters.resource_id = String(filters.product_id);
      }

      const company = await CompanyRepository.findById(companyId);

      if (!company) {
        return res.status(404).json({
          success: false,
          message: 'company_not_found'
        });
      }

      const scopeWhere = await buildScopeWhere(req, companyId);
      const result = await AuditEventRepository.list(filters, {
        where: {
          ...scopeWhere
        }
      });

      const response = {
        success: true,
        events: result.events.map(mapEvent),
        pagination: result.pagination
      };

      if (req.body.filters === true) {
        response.filter_options = await buildFilterOptions({ companyId, req, scopeWhere });
      }

      return res.status(200).json(response);
    } catch (error) {
      logger.error(`AuditEventController->list: ${error.message}`);
      return res.status(500).json({
        success: false,
        message: 'audit_events_list_error',
        error: error.message
      });
    }
  }
};

module.exports = AuditEventController;
