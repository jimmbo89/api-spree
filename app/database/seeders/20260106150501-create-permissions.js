'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const permissions = [
      // PRODUCT SERVICE
      { name: 'product.view', description: 'Ver productos', service: 'Product', resource: 'product', action: 'view', is_conditional: false, is_active: false },
      { name: 'product.category.view', description: 'Ver categorías de productos', service: 'Product', resource: 'category', action: 'view', is_conditional: false, is_active: false },
      { name: 'product.attribute.view', description: 'Ver atributos de productos', service: 'Product', resource: 'attribute', action: 'view', is_conditional: false, is_active: false },
      { name: 'product.attribute.create', description: 'Crear atributos de productos', service: 'Product', resource: 'attribute', action: 'create', is_conditional: false, is_active: true },

      // INVENTORY SERVICE
      { name: 'movement.view', description: 'Ver movimientos de inventario', service: 'Inventory', resource: 'movement', action: 'view', is_conditional: false, is_active: false },
      { name: 'inventory.kardex.view', description: 'Ver kardex', service: 'Inventory', resource: 'kardex', action: 'view', is_conditional: false, is_active: false },
      { name: 'branch.view', description: 'Ver sucursales', service: 'Inventory', resource: 'branch', action: 'view', is_conditional: false, is_active: false },
      { name: 'pool.view', description: 'Ver warehouse pools', service: 'Inventory', resource: 'pool', action: 'view', is_conditional: false, is_active: false },
      { name: 'store.view', description: 'Ver almacenes', service: 'Inventory', resource: 'store', action: 'view', is_conditional: false, is_active: false },

      // PUBLISHING SERVICE
      { name: 'publishing.publish', description: 'Publicar productos en canales', service: 'Publishing', resource: 'publication', action: 'publish', is_conditional: true, is_active: false },
      { name: 'publishing.jobs.view', description: 'Ver procesos de publicaciones', service: 'Publishing', resource: 'draft', action: 'view', is_conditional: false, is_active: false },

      // MARKETPLACE SERVICE
      { name: 'marketplace.view', description: 'Ver marketplaces configurados', service: 'Marketplace', resource: 'marketplace', action: 'view', is_conditional: false, is_active: false },
      { name: 'marketplacecredential.view', description: 'Visualizar Credenciales de los marketplaces', service: 'Marketplace', resource: 'marketplace_credential', action: 'view', is_conditional: false, is_active: false },

      // COMPANY SERVICE
      { name: 'company.view', description: 'Ver configuración de la empresa', service: 'Company', resource: 'company', action: 'view', is_conditional: false, is_active: false },
      { name: 'company.type.view', description: 'Ver tipos de empresas', service: 'Company', resource: 'type', action: 'view', is_conditional: false, is_active: false },

      // IAM SERVICE
      { name: 'role.view', description: 'Ver roles', service: 'IAM', resource: 'role', action: 'view', is_conditional: false, is_active: false },
      { name: 'permission.view', description: 'Ver permisos del sistema', service: 'IAM', resource: 'permission', action: 'view', is_conditional: false, is_active: false },
      { name: 'permission.create', description: 'Crear permisos del sistema', service: 'IAM', resource: 'permission', action: 'create', is_conditional: false, is_active: true },
      { name: 'permission.edit', description: 'Editar permisos del sistema', service: 'IAM', resource: 'permission', action: 'edit', is_conditional: false, is_active: true },
      { name: 'permission.delete', description: 'Eliminar permisos del sistema', service: 'IAM', resource: 'permission', action: 'delete', is_conditional: false, is_active: true },
      { name: 'user.view', description: 'Ver usuarios', service: 'IAM', resource: 'user', action: 'view', is_conditional: false, is_active: false },
      { name: 'audit.view', description: 'Ver logs de auditoría', service: 'IAM', resource: 'audit', action: 'view', is_conditional: false, is_active: false },

      // PLAN SERVICE
      { name: 'plan.view', description: 'Ver plan actual', service: 'Plan', resource: 'plan', action: 'view', is_conditional: false, is_active: false },
      { name: 'plan.upgrade', description: 'Solicitar upgrade de plan', service: 'Plan', resource: 'plan', action: 'upgrade', is_conditional: false, is_active: false },

      // REPORTING SERVICE
      { name: 'report.sales.view', description: 'Ver Reportes de ventas', service: 'Reporting', resource: 'sales', action: 'view', is_conditional: false, is_active: false },
      { name: 'report.profit.view', description: 'Ver reportes de ganancias', service: 'Reporting', resource: 'profit', action: 'view', is_conditional: false, is_active: false },
      { name: 'report.commission.view', description: 'Ver reportes de comisiones', service: 'Reporting', resource: 'commission', action: 'view', is_conditional: false, is_active: false }
    ];

    // Insertar permisos (ignorar duplicados)
    await queryInterface.bulkInsert('permissions', permissions.map(p => ({
      ...p,
      createdAt: new Date(),
      updatedAt: new Date()
    })), {
      ignoreDuplicates: true
    });
  },

  async down(queryInterface, Sequelize) {
    // Eliminar solo los permisos que insertamos
    const permissionNames = [
      'product.view', 'product.category.view', 'product.attribute.view', 'product.attribute.create',
      'movement.view', 'inventory.kardex.view', 'branch.view', 'pool.view', 'store.view',
      'publishing.publish', 'publishing.jobs.view',
      'marketplace.view', 'marketplacecredential.view',
      'company.view', 'company.type.view',
      'role.view', 'permission.view', 'permission.create', 'permission.edit', 'permission.delete',
      'user.view', 'audit.view',
      'plan.view', 'plan.upgrade',
      'report.sales.view', 'report.profit.view', 'report.commission.view'
    ];
    await queryInterface.bulkDelete('permissions', { name: permissionNames }, {});
  }
};
