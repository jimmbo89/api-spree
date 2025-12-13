// migrations/XXXXXXXXXXXXXX-add-external-auth-fields-to-users.js
'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('users', 'reset_expire', {
      type: Sequelize.BIGINT,
      allowNull: true,
      comment: 'Timestamp de expiración para el token de restablecimiento de contraseña'
    });

    await queryInterface.addColumn('users', 'reset_token', {
      type: Sequelize.STRING,
      allowNull: true,
      comment: 'Token para restablecimiento de contraseña'
    });

    // Opcional: Crear índice para búsquedas por external_id + external_auth
    await queryInterface.addIndex('users', ['external_id', 'external_auth'], {
      name: 'users_external_auth_idx',
      unique: false
    });

    // Opcional: Crear índice para reset_token (búsquedas más rápidas)
    await queryInterface.addIndex('users', ['reset_token'], {
      name: 'users_reset_token_idx',
      unique: false
    });
  },

  async down(queryInterface, Sequelize) {
    // Eliminar índices primero
    await queryInterface.removeIndex('users', 'users_external_auth_idx');
    await queryInterface.removeIndex('users', 'users_reset_token_idx');

    // Eliminar columnas en orden inverso
    await queryInterface.removeColumn('users', 'reset_token');
    await queryInterface.removeColumn('users', 'reset_expire');
  }
};