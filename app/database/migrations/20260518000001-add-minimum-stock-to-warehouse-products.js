'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('warehouse_products', 'minimum_stock', {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 5
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('warehouse_products', 'minimum_stock');
  }
};
