'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // Primero: asegurar que todos los usuarios con role_id tengan al menos una membresía
    // (esto debe hacerse en un script previo si hay datos históricos)
    
    // Eliminar la columna
    await queryInterface.removeColumn('users', 'role_id');
  },

  down: async (queryInterface, Sequelize) => {
    // Revertir: volver a añadir role_id (nullable)
    await queryInterface.addColumn('users', 'role_id', {
      type: Sequelize.BIGINT,
      allowNull: true,
      references: {
        model: 'roles',
        key: 'id'
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      comment: 'ID del rol asignado al usuario (DEPRECATED)'
    });
  }
};