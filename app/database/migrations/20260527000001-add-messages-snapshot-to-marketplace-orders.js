'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('marketplace_orders', 'messages_snapshot', {
      type: Sequelize.JSON,
      allowNull: true,
      comment: 'Snapshot de mensajes asociados a la orden para mostrar en UI'
    });

    await queryInterface.addColumn('marketplace_orders', 'notes_snapshot', {
      type: Sequelize.JSON,
      allowNull: true,
      comment: 'Notas internas de la orden agregadas por el usuario'
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('marketplace_orders', 'notes_snapshot');
    await queryInterface.removeColumn('marketplace_orders', 'messages_snapshot');
  }
};
