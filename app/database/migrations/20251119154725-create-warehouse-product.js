'use strict';
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('warehouse_products', {
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
      warehouse_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: 'warehouses', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      active: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true
      },
      code: {
        type: Sequelize.STRING,
        allowNull: true
      },
      company_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: 'companies', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      branch_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: 'branches', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      user_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
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

    await queryInterface.addIndex('warehouse_products', ['product_id', 'warehouse_id'], {
      unique: true,
      name: 'warehouse_products_product_warehouse_unique'
    });
    await queryInterface.addIndex('warehouse_products', ['warehouse_id']);
    await queryInterface.addIndex('warehouse_products', ['company_id']);
  },
  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('warehouse_products');
  }
};