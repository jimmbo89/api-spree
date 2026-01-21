// migrations/20260120140000-add-oauth-fields-to-marketplaces.js
'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    // Agregar columnas de configuración global (OAuth app-level)
    await queryInterface.addColumn('marketplaces', 'client_id', {
      type: Sequelize.STRING,
      allowNull: true
    });

    await queryInterface.addColumn('marketplaces', 'client_secret', {
      type: Sequelize.TEXT,
      allowNull: true
    });

    await queryInterface.addColumn('marketplaces', 'redirect_uri', {
      type: Sequelize.STRING,
      allowNull: true
    });

    await queryInterface.addColumn('marketplaces', 'scopes', {
      type: Sequelize.TEXT,
      allowNull: true
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('marketplaces', 'client_id');
    await queryInterface.removeColumn('marketplaces', 'client_secret');
    await queryInterface.removeColumn('marketplaces', 'redirect_uri');
    await queryInterface.removeColumn('marketplaces', 'scopes');
  }
};