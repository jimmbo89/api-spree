'use strict';

/**
 * Migración para agregar el status 'completed_with_errors' al ENUM de jobs
 * Este status permite diferenciar jobs completados con errores de aquellos completados exitosamente
 */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      // 1. Cambiar el tipo de la columna a VARCHAR temporalmente
      await queryInterface.changeColumn(
        'jobs',
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
        'jobs',
        'status',
        {
          type: Sequelize.ENUM(
            'pending',
            'processing',
            'completed',
            'completed_with_errors',  // ✅ Nuevo status
            'failed',
            'cancelled'
          ),
          allowNull: false,
          defaultValue: 'pending'
        },
        { transaction }
      );

      console.log('✅ ENUM actualizado: se agregó "completed_with_errors"');
    });
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      // Revertir: actualizar cualquier registro con el nuevo status a 'completed'
      await queryInterface.bulkUpdate(
        'jobs',
        { status: 'completed' },
        { status: 'completed_with_errors' },
        { transaction }
      );

      // 1. Cambiar a VARCHAR temporalmente
      await queryInterface.changeColumn(
        'jobs',
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
        'jobs',
        'status',
        {
          type: Sequelize.ENUM(
            'pending',
            'processing',
            'completed',
            'failed',
            'cancelled'
          ),
          allowNull: false,
          defaultValue: 'pending'
        },
        { transaction }
      );

      console.log('⏮️ ENUM revertido: se eliminó "completed_with_errors"');
    });
  }
};
