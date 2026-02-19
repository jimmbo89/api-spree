'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // Agregar columna credential_id
      await queryInterface.addColumn('product_publishing_tasks', 'credential_id', {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: {
          model: 'marketplace_credentials',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
        comment: 'ID de la credencial específica usada para esta publicación'
      }, { transaction });

      // Agregar índice para consultas frecuentes
      await queryInterface.addIndex('product_publishing_tasks', ['credential_id'], {
        name: 'ppt_credential_idx',
        transaction
      });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // Eliminar índice primero
      await queryInterface.removeIndex('product_publishing_tasks', 'ppt_credential_idx', { transaction });

      // Eliminar columna
      await queryInterface.removeColumn('product_publishing_tasks', 'credential_id', { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
};