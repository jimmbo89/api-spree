'use strict';
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('product_attributes', {
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
      attribute_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: 'attributes', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      value: {
        type: Sequelize.TEXT,
        allowNull: false
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

    await queryInterface.addIndex('product_attributes', ['product_id']);
    await queryInterface.addIndex('product_attributes', ['attribute_id']);
    // Opcional: índice único si un atributo no se repite por producto
    await queryInterface.addIndex('product_attributes', ['product_id', 'attribute_id'], { unique: true });
  },
  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('product_attributes');
  }
};