// migrations/20260203150000-add-falabella-fields-to-marketplace-credentials.js
'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Agregar columna seller_email
    await queryInterface.addColumn('marketplace_credentials', 'seller_email', {
      type: Sequelize.STRING(255),
      allowNull: true,
      comment: 'Correo electrónico del usuario de Seller Center (UserID para Falabella)'
    });

    // Agregar columna seller_id
    await queryInterface.addColumn('marketplace_credentials', 'seller_id', {
      type: Sequelize.STRING(50),
      allowNull: true,
      comment: 'ID del vendedor (para header User-Agent en Falabella)'
    });

    // Agregar columna api_key
    await queryInterface.addColumn('marketplace_credentials', 'api_key', {
      type: Sequelize.TEXT,
      allowNull: true,
      comment: 'API Key para marketplaces sin OAuth (Falabella)'
    });

    // Agregar columna adicional_data (opcional, para datos específicos por marketplace)
    await queryInterface.addColumn('marketplace_credentials', 'additional_data', {
      type: Sequelize.JSON,
      allowNull: true,
      comment: 'Datos adicionales específicos por marketplace'
    });

    // Agregar índice para seller_email (opcional, para búsquedas rápidas)
    await queryInterface.addIndex('marketplace_credentials', ['seller_email'], {
      name: 'mc_seller_email_idx'
    });
  },

  async down(queryInterface, Sequelize) {
    // Eliminar índice
    await queryInterface.removeIndex('marketplace_credentials', 'mc_seller_email_idx');

    // Eliminar columnas en orden inverso
    await queryInterface.removeColumn('marketplace_credentials', 'additional_data');
    await queryInterface.removeColumn('marketplace_credentials', 'api_key');
    await queryInterface.removeColumn('marketplace_credentials', 'seller_id');
    await queryInterface.removeColumn('marketplace_credentials', 'seller_email');
  }
};