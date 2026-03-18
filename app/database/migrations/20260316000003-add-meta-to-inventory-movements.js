'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    // Agregar columna meta para almacenar información adicional de los movimientos
    // Esto permite guardar detalles del cálculo FIFO, lotes utilizados, etc.
    await queryInterface.addColumn('inventory_movements', 'meta', {
      type: Sequelize.JSON,
      allowNull: true,
      defaultValue: {},
      comment: 'Metadatos adicionales del movimiento (ej: cálculo FIFO, lotes usados)'
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('inventory_movements', 'meta');
  }
};
