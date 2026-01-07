'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // Añadir la columna plan_id
    await queryInterface.addColumn('companies', 'plan_id', {
      type: Sequelize.BIGINT,
      allowNull: true, // o false si todos deben tener un plan desde el inicio
      references: {
        model: 'plans',
        key: 'id'
      },
      onDelete: 'SET NULL', // si se elimina el plan, se pone NULL (o RESTRICT si prefieres)
      onUpdate: 'CASCADE',
      comment: 'ID del plan asociado a la empresa'
    });

    // Opcional: índice para mejorar rendimiento en joins y búsquedas
    await queryInterface.addIndex('companies', ['plan_id'], {
      name: 'companies_plan_id_idx'
    });
  },

  down: async (queryInterface) => {
    // Eliminar el índice primero
    await queryInterface.removeIndex('companies', 'companies_plan_id_idx');
    // Luego eliminar la columna
    await queryInterface.removeColumn('companies', 'plan_id');
  }
};