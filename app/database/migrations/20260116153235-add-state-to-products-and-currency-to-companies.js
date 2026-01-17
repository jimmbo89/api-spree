'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('products', 'state', {
      type: Sequelize.TINYINT,
      allowNull: true,
      defaultValue: 1
    });

    await queryInterface.addColumn('companies', 'currency', {
      type: Sequelize.STRING,
      allowNull: true
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('products', 'state');
    await queryInterface.removeColumn('companies', 'currency');
  }
};