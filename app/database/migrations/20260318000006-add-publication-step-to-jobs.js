'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // 1. Agregar columna publication_step
      await queryInterface.addColumn('jobs', 'publication_step', {
        type: Sequelize.INTEGER,
        defaultValue: 0,
        allowNull: true,
        comment: 'Paso del flujo de publicación donde se guardó el borrador (0=Pool, 1=Productos, 2=Marketplaces, 3=Resumen, 4=Progreso, 5=Resultado)',
        validate: {
          min: 0,
          max: 5
        }
      }, { transaction });

      // 2. Agregar índices para mejorar performance
      await queryInterface.addIndex('jobs', ['job_type', 'status', 'company_id'], {
        name: 'idx_jobs_type_status_company',
        using: 'BTREE',
        unique: false
      }, { transaction });

      await queryInterface.addIndex('jobs', ['batch_id'], {
        name: 'idx_jobs_batch_id',
        using: 'BTREE',
        unique: false
      }, { transaction });

      await queryInterface.addIndex('jobs', ['user_id', 'company_id', 'job_type', 'createdAt'], {
        name: 'idx_jobs_user_drafts',
        using: 'BTREE',
        unique: false
      }, { transaction });

      await transaction.commit();

      console.log('✅ Migración completada: publication_step agregado a jobs + índices creados');
    } catch (error) {
      await transaction.rollback();
      console.error('❌ Error en migración:', error);
      throw error;
    }
  },

  down: async (queryInterface, Sequelize) => {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // Eliminar índices (sintaxis correcta para Sequelize CLI)
      await queryInterface.removeIndex('jobs', ['job_type', 'status', 'company_id'], { transaction });
      await queryInterface.removeIndex('jobs', ['batch_id'], { transaction });
      await queryInterface.removeIndex('jobs', ['user_id', 'company_id', 'job_type', 'createdAt'], { transaction });

      // Eliminar columna
      await queryInterface.removeColumn('jobs', 'publication_step', { transaction });

      await transaction.commit();

      console.log('✅ Rollback completado: publication_step y índices eliminados');
    } catch (error) {
      await transaction.rollback();
      console.error('❌ Error en rollback:', error);
      throw error;
    }
  }
};
