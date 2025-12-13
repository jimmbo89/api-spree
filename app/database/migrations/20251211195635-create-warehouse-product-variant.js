'use strict';
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('warehouse_product_variants', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.BIGINT
      },
      warehouse_product_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: 'warehouse_products', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      variant_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: 'product_variants', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      active: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true
      },
      published: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false
      },
      local_sku: {
        type: Sequelize.STRING,
        allowNull: true
      },
      price: {
        type: Sequelize.DECIMAL(16, 2),
        allowNull: false
      },
      promotional_price: {
        type: Sequelize.DECIMAL(16, 2),
        allowNull: true
      },
      stock: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0
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

    await queryInterface.addIndex('warehouse_product_variants', ['warehouse_product_id', 'variant_id'], {
      unique: true,
      name: 'warehouse_product_variants_unique'
    });
    await queryInterface.addIndex('warehouse_product_variants', ['variant_id']);
    await queryInterface.addIndex('warehouse_product_variants', ['warehouse_product_id', 'published']);
  },
  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('warehouse_product_variants');
  }
};