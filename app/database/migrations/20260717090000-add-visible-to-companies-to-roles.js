'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('roles', 'visible_to_companies', {
      type: Sequelize.TINYINT,
      allowNull: false,
      defaultValue: 1,
      comment: '0 = no visible para empresas, 1 = visible para empresas'
    });

    await queryInterface.sequelize.query(`
      UPDATE roles
      SET visible_to_companies = 0
      WHERE LOWER(name) IN ('backoffice', 'seller manager')
    `);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('roles', 'visible_to_companies');
  }
};
