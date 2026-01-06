'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const rolesData = [
      { name: 'Admin', description: 'Propietario del tenant. Acceso total.', status: true },
      { name: 'Seller Manager', description: 'Responsable operativo del ecommerce interno.', status: true },
      { name: 'Editor', description: 'Enfocado en operación diaria básica.', status: true },
      { name: 'Viewer', description: 'Solo lectura.', status: true },
      { name: 'Backoffice', description: 'Acceso global de soporte (Klint + Deed).', status: true }
    ];

    // Insertar/actualizar roles
    for (const role of rolesData) {
      await queryInterface.sequelize.query(
        `INSERT INTO roles (name, description, status, createdAt, updatedAt)
         VALUES (:name, :description, :status, NOW(), NOW())
         ON DUPLICATE KEY UPDATE
           description = VALUES(description),
           status = VALUES(status),
           updatedAt = NOW()`,
        { replacements: role }
      );
    }

    // Obtener IDs de roles y permisos
    const [roles, permissions] = await Promise.all([
      queryInterface.sequelize.query(
        'SELECT id, name FROM roles',
        { type: Sequelize.QueryTypes.SELECT }
      ),
      queryInterface.sequelize.query(
        'SELECT id, name FROM permissions',
        { type: Sequelize.QueryTypes.SELECT }
      )
    ]);

    const roleMap = {};
    roles.forEach(r => roleMap[r.name] = r.id);

    const permissionMap = {};
    permissions.forEach(p => permissionMap[p.name] = p.id);

    // Definir permisos por rol según la matriz IAM
    const rolePermissions = [];

    const addPermission = (roleName, permissionName) => {
      if (roleMap[roleName] && permissionMap[permissionName]) {
        rolePermissions.push({
          role_id: roleMap[roleName],
          permission_id: permissionMap[permissionName],
          status: 1,
          createdAt: new Date(),
          updatedAt: new Date()
        });
      }
    };

    // --- ADMIN ---
    const adminPerms = Object.keys(permissionMap);
    adminPerms.forEach(p => addPermission('Admin', p));

    // --- SELLER MANAGER ---
    const sellerManagerPerms = [
      // PRODUCTOS
      'product.create', 'product.edit', 'product.delete', 'product.view', 'product.clone',
      'product.ia.manual', 'product.ia.auto',

      // INVENTARIO
      'inventory.branch.create', 'inventory.store.create', 'inventory.stock.assign',
      'inventory.movement.view', 'inventory.kardex.view', 'inventory.pool.create',

      // PUBLICACIÓN
      'publishing.publish', 'publishing.pool.select', 'publishing.preview',
      'publishing.logs.view', 'publishing.retry',

      // MARKETPLACES EXTERNOS
      'marketplace.external.connect', 'marketplace.external.status.view',
      'marketplace.external.webhook.view', 'marketplace.external.token.renew',

      // MARKETPLACE DEL TENANT
      'marketplace.tenant.branding', 'marketplace.tenant.seller.invite',

      // SYNC ENGINE
      'sync.view', 'sync.force',

      // ÓRDENES & BILLING
      'order.external.view', 'order.tenant.view', 'order.global.view',
      'billing.dte.view', 'billing.nc.view',

      // REPORTING
      'report.kpi.view', 'report.export', 'report.commission.view',

      // IAM (limitado)
      'iam.acl.branch.set', 'iam.audit.view'
    ];
    sellerManagerPerms.forEach(p => addPermission('Seller Manager', p));

    // --- EDITOR ---
    const editorPerms = [
      // PRODUCTOS
      'product.create', 'product.edit', 'product.view', 'product.clone',
      'product.ia.manual',

      // INVENTARIO (solo ver stock asignado)
      'inventory.movement.view', 'inventory.kardex.view',

      // PUBLICACIÓN (si ACL lo permite)
      'publishing.preview', 'publishing.logs.view',

      // ÓRDENES
      'order.external.view', 'order.tenant.view', 'order.global.view',

      // REPORTING
      'report.kpi.view'
    ];
    editorPerms.forEach(p => addPermission('Editor', p));

    // --- VIEWER ---
    const viewerPerms = [
      // PRODUCTOS
      'product.view',

      // INVENTARIO
      'inventory.movement.view', 'inventory.kardex.view',

      // PUBLICACIÓN
      'publishing.preview', 'publishing.logs.view',

      // MARKETPLACES
      'marketplace.external.status.view',
      'marketplace.global.profile.view', 'marketplace.global.order.view',

      // ÓRDENES
      'order.external.view', 'order.tenant.view', 'order.global.view',

      // REPORTING
      'report.kpi.view'
    ];
    viewerPerms.forEach(p => addPermission('Viewer', p));

    // --- BACKOFFICE ---
    const backofficePerms = [
      // PRODUCTOS (solo ver global)
      'product.view',

      // INVENTARIO (solo ver)
      'inventory.movement.view', 'inventory.kardex.view',

      // PUBLICACIÓN
      'publishing.publish', 'publishing.preview', 'publishing.logs.view', 'publishing.retry',

      // MARKETPLACES
      'marketplace.external.connect', 'marketplace.external.status.view',
      'marketplace.external.webhook.view',
      'marketplace.global.publish', 'marketplace.global.profile.view',
      'marketplace.global.order.view', 'marketplace.global.moderate',

      // SYNC ENGINE
      'sync.view', 'sync.force',

      // ÓRDENES & BILLING
      'order.external.view', 'order.tenant.view', 'order.global.view',
      'billing.dte.view', 'billing.nc.view',

      // REPORTING
      'report.kpi.view', 'report.export', 'report.commission.view',

      // IAM
      'iam.audit.view'
    ];
    backofficePerms.forEach(p => addPermission('Backoffice', p));

    // Insertar asignaciones (evitar duplicados)
    if (rolePermissions.length > 0) {
      await queryInterface.bulkInsert('role_permissions', rolePermissions, {
        ignoreDuplicates: true
      });
    }
  },

  async down(queryInterface, Sequelize) {
    // Eliminar todas las asignaciones de role_permissions
    await queryInterface.bulkDelete('role_permissions', null, {});

    // Eliminar roles oficiales (opcional, normalmente no se hace en down)
    const officialRoles = ['Admin', 'Seller Manager', 'Editor', 'Viewer', 'Backoffice'];
    await queryInterface.bulkDelete('roles', { name: officialRoles }, {});
  }
};