// migrations/20251127120000-create-marketplace-credentials.js
'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('marketplace_credentials', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.BIGINT
      },
      marketplace_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: 'marketplaces', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      company_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: 'companies', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      branch_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: 'branches', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      // 🔑 Nuevos campos OAuth
      client_id: {
        type: Sequelize.STRING,
        allowNull: true
      },
      client_secret: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      redirect_uri: {
        type: Sequelize.STRING,
        allowNull: true
      },
      access_token: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      refresh_token: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      expires_at: {
        type: Sequelize.DATE,
        allowNull: true
      },
      scopes: {
        type: Sequelize.STRING,
        allowNull: true
      },
      active: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true
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

    // Índice único: contexto de credencial
    await queryInterface.addIndex('marketplace_credentials', ['marketplace_id', 'company_id', 'branch_id'], {
      unique: true,
      name: 'mc_marketplace_company_branch_unique'
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('marketplace_credentials');
  }
};