'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      const operationsDescription = await queryInterface.describeTable(
        'marketplace_preview_operations',
        { transaction }
      ).catch(() => null);

      if (!operationsDescription) {
        await queryInterface.createTable('marketplace_preview_operations', {
          id: { type: Sequelize.UUID, allowNull: false, primaryKey: true },
          company_id: { type: Sequelize.BIGINT, allowNull: false },
          user_id: { type: Sequelize.BIGINT, allowNull: false },
          credential_id: { type: Sequelize.BIGINT, allowNull: false },
          marketplace_id: { type: Sequelize.BIGINT, allowNull: false },
          status: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'queued' },
          phase: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'queued' },
          total: { type: Sequelize.INTEGER, allowNull: true },
          processed: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
          success_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
          error_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
          options: { type: Sequelize.JSON, allowNull: true },
          checkpoint: { type: Sequelize.JSON, allowNull: true },
          cancel_requested: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
          worker_id: { type: Sequelize.STRING(100), allowNull: true },
          lease_until: { type: Sequelize.DATE, allowNull: true },
          expires_at: { type: Sequelize.DATE, allowNull: false },
          started_at: { type: Sequelize.DATE, allowNull: true },
          completed_at: { type: Sequelize.DATE, allowNull: true },
          last_error: { type: Sequelize.JSON, allowNull: true },
          createdAt: { type: Sequelize.DATE, allowNull: false },
          updatedAt: { type: Sequelize.DATE, allowNull: false }
        }, { transaction });

        await queryInterface.addIndex(
          'marketplace_preview_operations',
          ['status', 'createdAt'],
          { name: 'mpo_status_created_idx', transaction }
        );
        await queryInterface.addIndex(
          'marketplace_preview_operations',
          ['company_id', 'createdAt'],
          { name: 'mpo_company_created_idx', transaction }
        );
        await queryInterface.addIndex(
          'marketplace_preview_operations',
          ['expires_at'],
          { name: 'mpo_expires_idx', transaction }
        );
      }

      const itemsDescription = await queryInterface.describeTable(
        'marketplace_preview_items',
        { transaction }
      ).catch(() => null);

      if (!itemsDescription) {
        await queryInterface.createTable('marketplace_preview_items', {
          id: { type: Sequelize.BIGINT, allowNull: false, primaryKey: true, autoIncrement: true },
          operation_id: { type: Sequelize.UUID, allowNull: false },
          sequence: { type: Sequelize.INTEGER, allowNull: false },
          external_id: { type: Sequelize.STRING(150), allowNull: false },
          external_variant_id: { type: Sequelize.STRING(150), allowNull: true },
          sku: { type: Sequelize.STRING(255), allowNull: true },
          status: { type: Sequelize.STRING(32), allowNull: false },
          data: { type: Sequelize.JSON, allowNull: false },
          source_payload: { type: Sequelize.JSON, allowNull: true },
          error: { type: Sequelize.JSON, allowNull: true },
          fetched_at: { type: Sequelize.DATE, allowNull: false },
          createdAt: { type: Sequelize.DATE, allowNull: false },
          updatedAt: { type: Sequelize.DATE, allowNull: false }
        }, { transaction });

        await queryInterface.addConstraint('marketplace_preview_items', {
          fields: ['operation_id'],
          type: 'foreign key',
          name: 'mpi_operation_fk',
          references: {
            table: 'marketplace_preview_operations',
            field: 'id'
          },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
          transaction
        });

        await queryInterface.addIndex(
          'marketplace_preview_items',
          ['operation_id', 'sequence'],
          { name: 'mpi_operation_sequence_unique', unique: true, transaction }
        );
        await queryInterface.addIndex(
          'marketplace_preview_items',
          ['operation_id', 'sku'],
          { name: 'mpi_operation_sku_idx', transaction }
        );
        await queryInterface.addIndex(
          'marketplace_preview_items',
          ['operation_id', 'external_id'],
          { name: 'mpi_operation_external_idx', transaction }
        );
        await queryInterface.addIndex(
          'marketplace_preview_items',
          ['operation_id', 'id'],
          { name: 'mpi_operation_id_cursor_idx', transaction }
        );
      }

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      await queryInterface.dropTable('marketplace_preview_items', { transaction }).catch(() => null);
      await queryInterface.dropTable('marketplace_preview_operations', { transaction }).catch(() => null);
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
};
