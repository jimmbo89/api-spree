'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('plans', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.BIGINT
      },
      name: {
        type: Sequelize.STRING,
        allowNull: false,
        unique: true
      },
      description: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      is_active: {
        type: Sequelize.BOOLEAN,
        allowNull: true,
        defaultValue: true
      },
      max_products: {
        type: Sequelize.INTEGER,
        allowNull: true
      },
      max_branches: {
        type: Sequelize.INTEGER,
        allowNull: true
      },
      max_stores: {
        type: Sequelize.INTEGER,
        allowNull: true
      },
      max_integrations: {
        type: Sequelize.INTEGER,
        allowNull: true
      },
      max_global_publications: {
        type: Sequelize.INTEGER,
        allowNull: true
      },
      max_pools: {
        type: Sequelize.INTEGER,
        allowNull: true
      },
      has_tenant_marketplace: {
        type: Sequelize.BOOLEAN,
        allowNull: true,
        defaultValue: false
      },
      has_custom_domain: {
        type: Sequelize.BOOLEAN,
        allowNull: true,
        defaultValue: false
      },
      has_multi_seller: {
        type: Sequelize.BOOLEAN,
        allowNull: true,
        defaultValue: false
      },
      has_headless_api: {
        type: Sequelize.BOOLEAN,
        allowNull: true,
        defaultValue: false
      },
      ia_level: {
        type: Sequelize.STRING,
        allowNull: true
      },
      global_commission_rate: {
        type: Sequelize.DECIMAL(10,2),
        allowNull: true
      },
      sort_order: {
        type: Sequelize.INTEGER,
        allowNull: true
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE
      }
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('plans');
  }
};