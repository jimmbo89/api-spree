'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const rolesData = [
      { name: 'Admin', description: 'Propietario del tenant. Acceso total.', status: true, visible_to_companies: 1 },
      { name: 'Seller Manager', description: 'Responsable operativo del ecommerce interno.', status: true, visible_to_companies: 0 },
      { name: 'Publicador', description: 'Enfocado en operaciÃ³n diaria bÃ¡sica.', status: true, visible_to_companies: 1 },
      { name: 'Viewer', description: 'Solo lectura.', status: true, visible_to_companies: 1 },
      { name: 'Backoffice', description: 'Acceso global de soporte (Klint + Deed).', status: true, visible_to_companies: 0 }
    ];

    // Insertar/actualizar roles
    for (const role of rolesData) {
      await queryInterface.sequelize.query(
        `INSERT INTO roles (name, description, status, visible_to_companies, createdAt, updatedAt)
         VALUES (:name, :description, :status, :visible_to_companies, NOW(), NOW())
         ON DUPLICATE KEY UPDATE
           description = VALUES(description),
           status = VALUES(status),
           visible_to_companies = VALUES(visible_to_companies),
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

    // Definir permisos por rol segÃºn la matriz IAM
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
      'product.view', 'product.category.view', 'product.attribute.view', 'product.attribute.create',

      // INVENTARIO
      'movement.view', 'inventory.kardex.view', 'branch.view', 'pool.view', 'store.view',

      // PUBLICACIÃ“N
      'publishing.publish', 'publishing.jobs.view',

      // MARKETPLACES
      'marketplace.view', 'marketplacecredential.view',

      // EMPRESA
      'company.view', 'company.type.view',

      // PLANES
      'plan.view', 'plan.upgrade',

      // REPORTING
      'report.sales.view', 'report.profit.view', 'report.commission.view',

      // IAM (limitado)
      'user.view', 'role.view', 'permission.view', 'audit.view'
    ];
    sellerManagerPerms.forEach(p => addPermission('Seller Manager', p));

    // --- PUBLICADOR ---
    const publicadorPerms = [
      // PRODUCTOS
      'product.view', 'product.category.view', 'product.attribute.view',

      // INVENTARIO (solo ver)
      'movement.view', 'inventory.kardex.view',

      // PUBLICACIÃ“N
      'publishing.jobs.view',

      // Ã“RDENES (si existen)

      // REPORTING
      'report.sales.view'
    ];
    publicadorPerms.forEach(p => addPermission('Publicador', p));

    // --- VIEWER ---
    const viewerPerms = [
      // PRODUCTOS
      'product.view', 'product.category.view', 'product.attribute.view',

      // INVENTARIO
      'movement.view', 'inventory.kardex.view', 'branch.view', 'pool.view', 'store.view',

      // PUBLICACIÃ“N
      'publishing.jobs.view',

      // MARKETPLACES
      'marketplace.view', 'marketplacecredential.view',

      // EMPRESA
      'company.view', 'company.type.view',

      // PLANES
      'plan.view',

      // REPORTING
      'report.sales.view', 'report.profit.view', 'report.commission.view'
    ];
    viewerPerms.forEach(p => addPermission('Viewer', p));

    // --- BACKOFFICE ---
    const backofficePerms = [
      // PRODUCTOS
      'product.view', 'product.category.view', 'product.attribute.view',

      // INVENTARIO
      'movement.view', 'inventory.kardex.view', 'branch.view', 'pool.view', 'store.view',

      // PUBLICACIÃ“N
      'publishing.publish', 'publishing.jobs.view',

      // MARKETPLACES
      'marketplace.view', 'marketplacecredential.view',

      // EMPRESA
      'company.view', 'company.type.view',

      // PLANES
      'plan.view', 'plan.upgrade',

      // REPORTING
      'report.sales.view', 'report.profit.view', 'report.commission.view',

      // IAM
      'user.view', 'role.view', 'permission.view', 'audit.view'
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
    const officialRoles = ['Admin', 'Seller Manager', 'Publicador', 'Viewer', 'Backoffice'];
    await queryInterface.bulkDelete('roles', { name: officialRoles }, {});
  }
};
