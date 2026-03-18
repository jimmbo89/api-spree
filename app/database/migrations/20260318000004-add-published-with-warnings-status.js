'use strict';

/**
 * Migración para agregar el status 'published_with_warnings' al ENUM de product_publishing_tasks
 * Este status permite diferenciar publicaciones exitosas con advertencias del marketplace
 * de aquellas que fallaron completamente.
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      // 1. Cambiar el tipo de la columna a VARCHAR temporalmente
      await queryInterface.changeColumn(
        'product_publishing_tasks',
        'status',
        {
          type: Sequelize.STRING(50),
          allowNull: false,
          defaultValue: 'pending'
        },
        { transaction }
      );

      // 2. Volver a cambiar a ENUM con el nuevo valor incluido
      await queryInterface.changeColumn(
        'product_publishing_tasks',
        'status',
        {
          type: Sequelize.ENUM(
            'draft',
            'pending',
            'processing',
            'published',
            'published_with_warnings',
            'failed',
            'cancelled'
          ),
          allowNull: false,
          defaultValue: 'pending'
        },
        { transaction }
      );

      console.log('✅ ENUM actualizado: se agregó "published_with_warnings"');
    });
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      // Revertir: actualizar cualquier registro con el nuevo status a 'published'
      await queryInterface.bulkUpdate(
        'product_publishing_tasks',
        { status: 'published' },
        { status: 'published_with_warnings' },
        { transaction }
      );

      // 1. Cambiar a VARCHAR temporalmente
      await queryInterface.changeColumn(
        'product_publishing_tasks',
        'status',
        {
          type: Sequelize.STRING(50),
          allowNull: false,
          defaultValue: 'pending'
        },
        { transaction }
      );

      // 2. Volver a ENUM sin el nuevo valor
      await queryInterface.changeColumn(
        'product_publishing_tasks',
        'status',
        {
          type: Sequelize.ENUM(
            'draft',
            'pending',
            'processing',
            'published',
            'failed',
            'cancelled'
          ),
          allowNull: false,
          defaultValue: 'pending'
        },
        { transaction }
      );

      console.log('⏮️ ENUM revertido: se eliminó "published_with_warnings"');
    });
  }
};
