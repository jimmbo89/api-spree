'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Agregar el campo variants como JSON
    await queryInterface.addColumn('warehouse_products', 'variants', {
      type: Sequelize.JSON,
      allowNull: true,
      defaultValue: [],
      comment: 'Array de variantes del producto en este almacén'
    });
  },

  async down(queryInterface, Sequelize) {
    // Remover el campo variants
    await queryInterface.removeColumn('warehouse_products', 'variants');
  }
};