'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    // Agregar columna purchase_price para almacenar el precio de compra unitario en el momento del movimiento
    // Esto permite calcular correctamente la ganancia y el valor del inventario
    await queryInterface.addColumn('inventory_movements', 'purchase_price', {
      type: Sequelize.DECIMAL(16, 2),
      allowNull: true,
      comment: 'Precio de compra unitario en el momento del movimiento'
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('inventory_movements', 'purchase_price');
  }
};
