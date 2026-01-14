'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('plans', 'monthly_price', {
      type: Sequelize.DECIMAL(16, 2),
      allowNull: true,
      comment: 'Precio mensual del plan'
    });

    await queryInterface.addColumn('plans', 'annual_price', {
      type: Sequelize.DECIMAL(16, 2),
      allowNull: true,
      comment: 'Precio anual del plan'
    });

    await queryInterface.addColumn('plans', 'monthly_discount', {
      type: Sequelize.DECIMAL(16, 2),
      allowNull: true,
      comment: 'Descuento mensual en porcentaje (ej: 10.00 = 10%)'
    });

    await queryInterface.addColumn('plans', 'annual_discount', {
      type: Sequelize.DECIMAL(16, 2),
      allowNull: true,
      comment: 'Descuento anual en porcentaje (ej: 20.00 = 20%)'
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('plans', 'annual_discount');
    await queryInterface.removeColumn('plans', 'monthly_discount');
    await queryInterface.removeColumn('plans', 'annual_price');
    await queryInterface.removeColumn('plans', 'monthly_price');
  }
};