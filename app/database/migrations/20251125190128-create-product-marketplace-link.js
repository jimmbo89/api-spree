'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('product_marketplace_links', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.BIGINT
      },
      product_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: 'products', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
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
      status: {
        type: Sequelize.STRING,
        allowNull: false,
        defaultValue: 'unpublished'
      },
      external_id: {
        type: Sequelize.STRING,
        allowNull: true
      },
      external_url: {
        type: Sequelize.STRING,
        allowNull: true
      },
      last_synced_at: {
        type: Sequelize.DATE,
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

    await queryInterface.addIndex('product_marketplace_links', ['product_id', 'marketplace_id', 'company_id', 'branch_id'], {
      unique: true,
      name: 'pml_product_marketplace_context_unique'
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('product_marketplace_links');
  }
};