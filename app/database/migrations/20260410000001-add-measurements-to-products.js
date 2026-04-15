'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    // Agregar columna product_measurements para almacenar las medidas del producto
    await queryInterface.addColumn('products', 'product_measurements', {
      type: Sequelize.JSON,
      allowNull: true,
      defaultValue: {},
      comment: 'Medidas del producto: { weight: { value, unit }, dimensions: { length, width, height, depth } }'
    });

    // Agregar columna packaging_measurements para almacenar las medidas del empaque/caja
    await queryInterface.addColumn('products', 'packaging_measurements', {
      type: Sequelize.JSON,
      allowNull: true,
      defaultValue: {},
      comment: 'Medidas de la caja: { weight: { value, unit }, dimensions: { length, width, height, depth }, material, fragile }'
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('products', 'packaging_measurements');
    await queryInterface.removeColumn('products', 'product_measurements');
  }
};
