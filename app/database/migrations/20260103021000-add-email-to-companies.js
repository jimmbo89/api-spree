'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('companies', 'email', {
      type: Sequelize.STRING,
      allowNull: true,
      validate: {
        isEmail: {
          msg: 'El campo email debe ser una dirección de correo válida'
        }
      }
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('companies', 'email');
  }
};