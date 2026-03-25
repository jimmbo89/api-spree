'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // 1. Agregar columna role_id (NULL por defecto, solo BackOffice tendrá rol)
      await queryInterface.addColumn('users', 'role_id', {
        type: Sequelize.BIGINT,
        allowNull: true,
        defaultValue: null,
        comment: 'Rol global del usuario (NULL = usuario normal, BackOffice = rol asignado)',
        references: {
          model: 'roles',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      }, { transaction });

      // 2. Crear índice para búsquedas rápidas
      await queryInterface.addIndex('users', {
        name: 'users_role_id_idx',
        fields: ['role_id'],
        unique: false
      }, { transaction });

      await transaction.commit();

      console.log('✅ Migración completada: role_id agregado a users');
    } catch (error) {
      await transaction.rollback();
      console.error('❌ Error en migración:', error);
      throw error;
    }
  },

  async down(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // 1. Eliminar índice
      await queryInterface.removeIndex('users', 'users_role_id_idx', { transaction });

      // 2. Eliminar columna
      await queryInterface.removeColumn('users', 'role_id', { transaction });

      await transaction.commit();

      console.log('✅ Migración revertida: role_id eliminado de users');
    } catch (error) {
      await transaction.rollback();
      console.error('❌ Error al revertir migración:', error);
      throw error;
    }
  }
};
