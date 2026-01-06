'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const permissions = [
      // PRODUCT SERVICE
      { name: 'product.create', description: 'Crear productos', service: 'Product', resource: 'product', action: 'create', is_conditional: false },
      { name: 'product.edit', description: 'Editar productos', service: 'Product', resource: 'product', action: 'edit', is_conditional: false },
      { name: 'product.delete', description: 'Archivar/eliminar productos', service: 'Product', resource: 'product', action: 'delete', is_conditional: false },
      { name: 'product.view', description: 'Ver productos', service: 'Product', resource: 'product', action: 'view', is_conditional: false },
      { name: 'product.clone', description: 'Clonar productos', service: 'Product', resource: 'product', action: 'clone', is_conditional: false },
      { name: 'product.ia.manual', description: 'Usar IA manual en productos', service: 'Product', resource: 'product', action: 'ia_manual', is_conditional: true }, // FREE+
      { name: 'product.ia.auto', description: 'Usar IA automática en productos', service: 'Product', resource: 'product', action: 'ia_auto', is_conditional: true }, // PRO+

      // INVENTORY SERVICE
      { name: 'inventory.branch.create', description: 'Crear sucursales', service: 'Inventory', resource: 'branch', action: 'create', is_conditional: true }, // según plan
      { name: 'inventory.store.create', description: 'Crear almacenes', service: 'Inventory', resource: 'store', action: 'create', is_conditional: true }, // según plan
      { name: 'inventory.stock.assign', description: 'Asignar stock a almacén', service: 'Inventory', resource: 'stock', action: 'assign', is_conditional: true }, // ACL por almacén
      { name: 'inventory.movement.view', description: 'Ver movimientos de inventario', service: 'Inventory', resource: 'movement', action: 'view', is_conditional: false },
      { name: 'inventory.kardex.view', description: 'Ver kardex', service: 'Inventory', resource: 'kardex', action: 'view', is_conditional: false },
      { name: 'inventory.pool.create', description: 'Crear warehouse pools', service: 'Inventory', resource: 'pool', action: 'create', is_conditional: true }, // PRO+

      // PUBLISHING SERVICE
      { name: 'publishing.publish', description: 'Publicar productos en canales', service: 'Publishing', resource: 'publication', action: 'publish', is_conditional: true }, // ACL + plan
      { name: 'publishing.pool.select', description: 'Seleccionar pool/almacén para publicación', service: 'Publishing', resource: 'publication', action: 'select_pool', is_conditional: true }, // ACL
      { name: 'publishing.preview', description: 'Previsualizar publicación', service: 'Publishing', resource: 'publication', action: 'preview', is_conditional: false },
      { name: 'publishing.logs.view', description: 'Ver logs de publicación', service: 'Publishing', resource: 'log', action: 'view', is_conditional: false },
      { name: 'publishing.retry', description: 'Reintentar publicaciones fallidas', service: 'Publishing', resource: 'publication', action: 'retry', is_conditional: false },

      // MARKETPLACES EXTERNOS
      { name: 'marketplace.external.connect', description: 'Conectar marketplaces externos (ML, Falabella, etc.)', service: 'Marketplace', resource: 'external', action: 'connect', is_conditional: false },
      { name: 'marketplace.external.status.view', description: 'Ver estado de integraciones', service: 'Marketplace', resource: 'external', action: 'view_status', is_conditional: false },
      { name: 'marketplace.external.webhook.view', description: 'Ver webhooks de marketplaces', service: 'Marketplace', resource: 'external', action: 'view_webhook', is_conditional: false },
      { name: 'marketplace.external.token.renew', description: 'Renovar tokens de marketplace', service: 'Marketplace', resource: 'external', action: 'renew_token', is_conditional: false },

      // MARKETPLACE DEL TENANT (PRO+)
      { name: 'marketplace.tenant.branding', description: 'Configurar branding del Marketplace del Tenant', service: 'Marketplace', resource: 'tenant', action: 'branding', is_conditional: true }, // PRO+
      { name: 'marketplace.tenant.domain', description: 'Configurar dominio propio', service: 'Marketplace', resource: 'tenant', action: 'domain', is_conditional: true }, // PRO+
      { name: 'marketplace.tenant.commission.set', description: 'Establecer comisiones internas', service: 'Marketplace', resource: 'tenant', action: 'set_commission', is_conditional: false }, // Solo Admin
      { name: 'marketplace.tenant.seller.invite', description: 'Invitar sellers al Marketplace del Tenant', service: 'Marketplace', resource: 'tenant', action: 'invite_seller', is_conditional: false },

      // MARKETPLACE GLOBAL
      { name: 'marketplace.global.publish', description: 'Publicar en Marketplace Global SPREE', service: 'Marketplace', resource: 'global', action: 'publish', is_conditional: true }, // FREE limitado
      { name: 'marketplace.global.profile.view', description: 'Ver perfil de seller global', service: 'Marketplace', resource: 'global', action: 'view_profile', is_conditional: false },
      { name: 'marketplace.global.order.view', description: 'Ver órdenes del Marketplace Global', service: 'Marketplace', resource: 'global', action: 'view_order', is_conditional: false },
      { name: 'marketplace.global.moderate', description: 'Moderar Marketplace Global', service: 'Marketplace', resource: 'global', action: 'moderate', is_conditional: false }, // Solo Backoffice

      // SYNC ENGINE
      { name: 'sync.view', description: 'Ver estado de sincronizaciones', service: 'Sync', resource: 'sync', action: 'view', is_conditional: false },
      { name: 'sync.force', description: 'Forzar sincronización manual', service: 'Sync', resource: 'sync', action: 'force', is_conditional: false },

      // ORDERS & BILLING
      { name: 'order.external.view', description: 'Ver órdenes de marketplaces externos', service: 'Order', resource: 'order', action: 'view_external', is_conditional: false },
      { name: 'order.tenant.view', description: 'Ver órdenes del Tenant Marketplace', service: 'Order', resource: 'order', action: 'view_tenant', is_conditional: false },
      { name: 'order.global.view', description: 'Ver órdenes del Marketplace Global', service: 'Order', resource: 'order', action: 'view_global', is_conditional: false },
      { name: 'billing.dte.view', description: 'Ver documentos tributarios (DTE)', service: 'Billing', resource: 'dte', action: 'view', is_conditional: false },
      { name: 'billing.nc.view', description: 'Ver notas de crédito', service: 'Billing', resource: 'nc', action: 'view', is_conditional: false },

      // PLANS & SUBSCRIPTIONS
      { name: 'plan.view', description: 'Ver plan actual', service: 'Plan', resource: 'plan', action: 'view', is_conditional: false },
      { name: 'plan.upgrade', description: 'Solicitar upgrade de plan', service: 'Plan', resource: 'plan', action: 'upgrade', is_conditional: false }, // Solo Admin

      // IAM (Roles & Permisos)
      { name: 'iam.user.create', description: 'Crear usuarios', service: 'IAM', resource: 'user', action: 'create', is_conditional: false }, // Solo Admin
      { name: 'iam.role.assign', description: 'Asignar roles a usuarios', service: 'IAM', resource: 'role', action: 'assign', is_conditional: false }, // Solo Admin
      { name: 'iam.acl.branch.set', description: 'Definir ACL por sucursal', service: 'IAM', resource: 'acl', action: 'set_branch', is_conditional: true }, // Admin permite a Seller Manager
      { name: 'iam.audit.view', description: 'Ver logs de auditoría', service: 'IAM', resource: 'audit', action: 'view', is_conditional: false },

      // REPORTING
      { name: 'report.kpi.view', description: 'Ver KPIs', service: 'Reporting', resource: 'kpi', action: 'view', is_conditional: false },
      { name: 'report.export', description: 'Exportar reportes', service: 'Reporting', resource: 'report', action: 'export', is_conditional: true }, // según plan
      { name: 'report.commission.view', description: 'Ver reportes de comisiones', service: 'Reporting', resource: 'commission', action: 'view', is_conditional: false }
    ];

    // Insertar permisos (ignorar duplicados)
    await queryInterface.bulkInsert('permissions', permissions, {
      ignoreDuplicates: true,
      updateOnDuplicate: ['name'] // Opcional: si usas MySQL 8+ con ON DUPLICATE KEY UPDATE
    });
  },

  async down(queryInterface, Sequelize) {
    // Opción 1: eliminar todos los permisos (solo si es seguro en tu entorno)
    // await queryInterface.bulkDelete('permissions', null, {});

    // Opción 2: eliminar solo los que insertamos (más seguro en producción)
    const permissionNames = [
      'product.create', 'product.edit', 'product.delete', 'product.view', 'product.clone',
      'product.ia.manual', 'product.ia.auto',
      'inventory.branch.create', 'inventory.store.create', 'inventory.stock.assign',
      'inventory.movement.view', 'inventory.kardex.view', 'inventory.pool.create',
      'publishing.publish', 'publishing.pool.select', 'publishing.preview',
      'publishing.logs.view', 'publishing.retry',
      'marketplace.external.connect', 'marketplace.external.status.view',
      'marketplace.external.webhook.view', 'marketplace.external.token.renew',
      'marketplace.tenant.branding', 'marketplace.tenant.domain',
      'marketplace.tenant.commission.set', 'marketplace.tenant.seller.invite',
      'marketplace.global.publish', 'marketplace.global.profile.view',
      'marketplace.global.order.view', 'marketplace.global.moderate',
      'sync.view', 'sync.force',
      'order.external.view', 'order.tenant.view', 'order.global.view',
      'billing.dte.view', 'billing.nc.view',
      'plan.view', 'plan.upgrade',
      'iam.user.create', 'iam.role.assign', 'iam.acl.branch.set', 'iam.audit.view',
      'report.kpi.view', 'report.export', 'report.commission.view'
    ];
    await queryInterface.bulkDelete('permissions', { name: permissionNames }, {});
  }
};