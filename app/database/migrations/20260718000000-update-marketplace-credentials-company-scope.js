'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // Asegurar que la columna company_id exista en entornos antiguos
      try {
        await queryInterface.addColumn(
          'marketplace_credentials',
          'company_id',
          {
            type: Sequelize.BIGINT,
            allowNull: true,
            references: { model: 'companies', key: 'id' },
            onUpdate: 'CASCADE',
            onDelete: 'CASCADE'
          },
          { transaction }
        );
      } catch (error) {
        // La columna ya existe en la mayoría de entornos; seguir adelante.
      }

      // Quitar índices antiguos basados en user_id
      for (const indexName of ['mc_marketplace_user_name_unique', 'mc_marketplace_user_unique']) {
        try {
          await queryInterface.removeIndex('marketplace_credentials', indexName, { transaction });
        } catch (error) {
          // Ignorar si el índice no existe en este entorno.
        }
      }

      // Crear índice nuevo por empresa
      try {
        await queryInterface.addIndex(
          'marketplace_credentials',
          ['marketplace_id', 'company_id', 'name'],
          {
            unique: true,
            name: 'mc_marketplace_company_name_unique',
            transaction
          }
        );
      } catch (error) {
        // Si ya existe, no detener la migración
      }

      // Índice simple por company_id para listados y filtros
      try {
        await queryInterface.addIndex(
          'marketplace_credentials',
          ['company_id'],
          {
            name: 'mc_company_idx',
            transaction
          }
        );
      } catch (error) {
        // Ignorar si ya existe
      }

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      for (const indexName of ['mc_marketplace_company_name_unique', 'mc_company_idx']) {
        try {
          await queryInterface.removeIndex('marketplace_credentials', indexName, { transaction });
        } catch (error) {
          // Ignorar si no existe
        }
      }

      try {
        await queryInterface.addIndex(
          'marketplace_credentials',
          ['marketplace_id', 'user_id', 'name'],
          {
            unique: true,
            name: 'mc_marketplace_user_name_unique',
            transaction
          }
        );
      } catch (error) {
        // Ignorar si ya existe
      }

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
};
