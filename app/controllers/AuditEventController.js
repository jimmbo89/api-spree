const logger = require('../../config/logger');
const { Op } = require('sequelize');
const {
  AuditEventRepository,
  CompanyRepository,
  UserAclScopeRepository,
  UserMarketplaceCredentialRepository
} = require('../repositories');

const MODULE_LABELS = {
  product: 'Productos',
  warehouse: 'Almacenes',
  marketplace: 'Marketplaces',
  publication_draft: 'Borradores de publicación',
  process: 'Procesos',
  published_product: 'Productos publicados',
  sales: 'Ventas',
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
  marketplace_credential: 'Conexión marketplace',
  publication_draft: 'Borrador de publicación',
  process: 'Proceso',
  published_product: 'Producto publicado',
  marketplace_order: 'Venta',
  marketplace_order_note: 'Nota de venta',
  marketplace_order_message: 'Mensaje de venta',
  job: 'Proceso'
};

const ACTION_LABELS = {
  'product.created': 'Producto creado',
  'product.updated': 'Producto actualizado',
  'product.attributes_updated': 'Atributos modificados',
  'product.warehouse_configured': 'Configuración de almacén modificada',
  'product.bulk_imported': 'Productos importados',
  'product.deleted': 'Producto eliminado',
  'product.state_changed': 'Estado del producto modificado',
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
  'warehouse.stock_entry': 'Entrada de stock',
  'warehouse.stock_exit': 'Salida de stock',
  'warehouse.stock_adjustment': 'Ajuste de stock',
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
  'sales.message_sent': 'Mensaje enviado'
};

const FIELD_LABELS = {
  marketplace_name: 'Marketplace',
  marketplace_domain: 'Dominio del marketplace',
  marketplace: 'Marketplace',
  credential_name: 'Credencial',
  warehouse_name: 'Almacén',
  source_warehouse_name: 'Almacén origen',
  destination_warehouse_name: 'Almacén destino',
  branch_name: 'Sucursal',
  pool_name: 'Pool',
  job_name: 'Proceso',
  source: 'Origen',
  status: 'Estado',
  previous_status: 'Estado anterior',
  new_status: 'Estado nuevo',
  price: 'Precio',
  sale_price: 'Precio de venta',
  purchase_price: 'Precio de compra',
  stock: 'Stock',
  available_quantity: 'Stock disponible',
  published_stock: 'Stock publicado',
  quantity: 'Cantidad',
  sku: 'SKU',
  name: 'Nombre',
  title: 'Título',
  description: 'Descripción',
  seller_email: 'Correo de cuenta externa',
  external_account: 'Cuenta externa',
  external_status: 'Estado externo',
  marketplace_status: 'Estado del marketplace',
  error_message: 'Mensaje de error',
  reason: 'Motivo',
  batch: 'Lote',
  total: 'Total',
  created: 'Creados',
  updated: 'Actualizados',
  deleted: 'Eliminados',
  failed: 'Fallidos'
};

function humanizeCode(value) {
  if (!value) return null;

  return String(value)
    .split(/[._-]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function getFieldLabel(key) {
  return FIELD_LABELS[key] || humanizeCode(key);
}

function isSensitiveDisplayKey(key) {
  return /token|secret|password|authorization|credential|access_token|refresh_token/i.test(String(key));
}

function isInternalIdDisplayKey(key) {
  return /(^id$|_id$|Id$|ids$|_ids$|correlation_id$|dedupe_key$)/i.test(String(key));
}

function shouldHideDisplayKey(key) {
  return isSensitiveDisplayKey(key) || isInternalIdDisplayKey(key);
}

function normalizePlainValue(value) {
  if (value && typeof value.get === 'function') {
    return value.get({ plain: true });
  }

  return value;
}

function formatDisplayValue(value) {
  const normalized = normalizePlainValue(value);

  if (normalized == null || normalized === '') return 'Sin valor';
  if (typeof normalized === 'boolean') return normalized ? 'Sí' : 'No';
  if (normalized instanceof Date) return normalized.toISOString();
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

  return String(normalized);
}

function objectToDisplayRows(value) {
  const normalized = normalizePlainValue(value);

  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
    return [];
  }

  return Object.entries(normalized)
    .filter(([key, entryValue]) => !shouldHideDisplayKey(key) && entryValue !== undefined)
    .map(([key, entryValue]) => ({
      key,
      label: getFieldLabel(key),
      value: formatDisplayValue(entryValue)
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

  const metadataRows = objectToDisplayRows(event.metadata)
    .filter(row => !['source', 'source_type'].includes(row.key));

  return [
    ...context.filter(row => row.value),
    ...metadataRows
  ];
}

function buildDisplayChanges(changes) {
  if (!Array.isArray(changes)) return [];

  return changes
    .filter(change => change && !shouldHideDisplayKey(change.field || change.key || ''))
    .map(change => {
      const field = change.field || change.key || change.attribute || 'change';
      return {
        field,
        field_label: getFieldLabel(field),
        previous: formatDisplayValue(change.old_value ?? change.previous_value ?? change.before),
        current: formatDisplayValue(change.new_value ?? change.current_value ?? change.after)
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
      const company = await CompanyRepository.findById(companyId);

      if (!company) {
        return res.status(404).json({
          success: false,
          message: 'company_not_found'
        });
      }

      const scopeWhere = await buildScopeWhere(req, companyId);
      const result = await AuditEventRepository.list(req.body, {
        where: {
          ...scopeWhere
        }
      });

      return res.status(200).json({
        success: true,
        events: result.events.map(mapEvent),
        pagination: result.pagination
      });
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
