'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // Actualizar borradores existentes para establecer publication_step = 3 (Resumen completado)
      // Asumimos que si es draft, ya completó al menos el resumen
      const [result] = await queryInterface.sequelize.query(`
        UPDATE jobs 
        SET publication_step = 3 
        WHERE job_type = 'draft' 
          AND status = 'pending'
          AND publication_step IS NULL
      `, { transaction });

      await transaction.commit();

      console.log(`✅ Migración de datos completada: ${result} borradores actualizados a publication_step = 3`);
    } catch (error) {
      await transaction.rollback();
      console.error('❌ Error en migración de datos:', error);
      throw error;
    }
  },

  down: async (queryInterface, Sequelize) => {
    // No hay rollback para esta migración de datos
    console.log('ℹ️  No hay rollback para migración de datos (datos históricos)');
  }
};
