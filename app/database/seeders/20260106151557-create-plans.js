'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const plans = [
      // FREE
      {
        name: 'FREE',
        description: 'Plan gratuito con funcionalidades básicas',
        is_active: true,
        max_products: 20,
        max_branches: 0,
        max_stores: 1,
        max_integrations: 1,
        max_global_publications: 5,
        max_pools: 0,
        has_tenant_marketplace: false,
        has_custom_domain: false,
        has_multi_seller: false,
        has_headless_api: false,
        ia_level: 'manual',
        global_commission_rate: 5.00,
        sort_order: 1,
        createdAt: new Date(),
        updatedAt: new Date()
      },
      // PRO
      {
        name: 'PRO',
        description: 'Plan profesional con publicación ilimitada y IA automática',
        is_active: true,
        max_products: 200,
        max_branches: 1,
        max_stores: 2,
        max_integrations: 3,
        max_global_publications: -1, // ilimitado
        max_pools: 1,
        has_tenant_marketplace: true,
        has_custom_domain: false, // "Starter (subdominio)"
        has_multi_seller: false,
        has_headless_api: false,
        ia_level: 'auto',
        global_commission_rate: 3.00,
        sort_order: 2,
        createdAt: new Date(),
        updatedAt: new Date()
      },
      // BUSINESS
      {
        name: 'BUSINESS',
        description: 'Plan empresarial con white-label y IA avanzada',
        is_active: true,
        max_products: -1, // ilimitado
        max_branches: 3,
        max_stores: 5,
        max_integrations: -1, // "Todas"
        max_global_publications: -1,
        max_pools: -1,
        has_tenant_marketplace: true,
        has_custom_domain: true, // "White-label (dominio propio)"
        has_multi_seller: true,  // "multi-seller opc."
        has_headless_api: false,
        ia_level: 'advanced',
        global_commission_rate: 1.00,
        sort_order: 3,
        createdAt: new Date(),
        updatedAt: new Date()
      },
      // ENTERPRISE
      {
        name: 'ENTERPRISE',
        description: 'Plan enterprise con API, multi-dominio e IA avanzada',
        is_active: true,
        max_products: -1,
        max_branches: -1,
        max_stores: -1,
        max_integrations: -1, // "Todas + API"
        max_global_publications: -1,
        max_pools: -1,
        has_tenant_marketplace: true,
        has_custom_domain: true,
        has_multi_seller: true,
        has_headless_api: true, // "API/Headless + multi-dominio"
        ia_level: 'api',
        global_commission_rate: 0.50, // rango 0–1%, usamos 0.50 como ejemplo
        sort_order: 4,
        createdAt: new Date(),
        updatedAt: new Date()
      }
    ];

    await queryInterface.bulkInsert('plans', plans, {
      ignoreDuplicates: true
    });
  },

  async down(queryInterface, Sequelize) {
    // Eliminar solo los planes oficiales (no todos, por si hay personalizados)
    const officialPlans = ['FREE', 'PRO', 'BUSINESS', 'ENTERPRISE'];
    await queryInterface.bulkDelete('plans', { name: officialPlans }, {});
  }
};