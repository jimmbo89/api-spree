'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      const operations = await queryInterface.describeTable('marketplace_import_operations', { transaction }).catch(() => null);
      if (!operations) {
        await queryInterface.createTable('marketplace_import_operations', {
          id: { type: Sequelize.UUID, allowNull: false, primaryKey: true },
          preview_operation_id: { type: Sequelize.UUID, allowNull: false },
          company_id: { type: Sequelize.BIGINT, allowNull: false },
          user_id: { type: Sequelize.BIGINT, allowNull: false },
          credential_id: { type: Sequelize.BIGINT, allowNull: false },
          marketplace_id: { type: Sequelize.BIGINT, allowNull: false },
          status: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'queued' },
          phase: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'queued' },
          total: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
          processed: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
          success_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
          error_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
          skipped_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
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

        await queryInterface.addConstraint('marketplace_import_operations', {
          fields: ['preview_operation_id'],
          type: 'foreign key',
          name: 'mio_preview_operation_fk',
          references: { table: 'marketplace_preview_operations', field: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
          transaction
        });
        await queryInterface.addIndex('marketplace_import_operations', ['status', 'createdAt'], {
          name: 'mio_status_created_idx', transaction
        });
        await queryInterface.addIndex('marketplace_import_operations', ['company_id', 'createdAt'], {
          name: 'mio_company_created_idx', transaction
        });
        await queryInterface.addIndex('marketplace_import_operations', ['expires_at'], {
          name: 'mio_expires_idx', transaction
        });
      }

      if (operations && !operations.skipped_count) {
        await queryInterface.addColumn('marketplace_import_operations', 'skipped_count', {
          type: Sequelize.INTEGER, allowNull: false, defaultValue: 0
        }, { transaction });
      }

      const items = await queryInterface.describeTable('marketplace_import_items', { transaction }).catch(() => null);
      if (!items) {
        await queryInterface.createTable('marketplace_import_items', {
          id: { type: Sequelize.BIGINT, allowNull: false, primaryKey: true, autoIncrement: true },
          operation_id: { type: Sequelize.UUID, allowNull: false },
          preview_item_id: { type: Sequelize.BIGINT, allowNull: false },
          action: { type: Sequelize.STRING(16), allowNull: false },
          payload: { type: Sequelize.JSON, allowNull: false },
          status: { type: Sequelize.STRING(32), allowNull: false, defaultValue: 'queued' },
          product_id: { type: Sequelize.BIGINT, allowNull: true },
          link_id: { type: Sequelize.BIGINT, allowNull: true },
          result: { type: Sequelize.JSON, allowNull: true },
          error: { type: Sequelize.JSON, allowNull: true },
          started_at: { type: Sequelize.DATE, allowNull: true },
          completed_at: { type: Sequelize.DATE, allowNull: true },
          createdAt: { type: Sequelize.DATE, allowNull: false },
          updatedAt: { type: Sequelize.DATE, allowNull: false }
        }, { transaction });

        await queryInterface.addConstraint('marketplace_import_items', {
          fields: ['operation_id'],
          type: 'foreign key',
          name: 'mii_operation_fk',
          references: { table: 'marketplace_import_operations', field: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
          transaction
        });
        await queryInterface.addConstraint('marketplace_import_items', {
          fields: ['preview_item_id'],
          type: 'foreign key',
          name: 'mii_preview_item_fk',
          references: { table: 'marketplace_preview_items', field: 'id' },
          onUpdate: 'CASCADE',
          onDelete: 'RESTRICT',
          transaction
        });
        await queryInterface.addIndex('marketplace_import_items', ['operation_id', 'preview_item_id'], {
          unique: true, name: 'mii_operation_preview_unique', transaction
        });
        await queryInterface.addIndex('marketplace_import_items', ['operation_id', 'id'], {
          name: 'mii_operation_id_cursor_idx', transaction
        });
        await queryInterface.addIndex('marketplace_import_items', ['operation_id', 'status'], {
          name: 'mii_operation_status_idx', transaction
        });
      }

      const linkDescription = await queryInterface.describeTable('product_marketplace_links', { transaction }).catch(() => null);
      if (linkDescription && !linkDescription.external_variant_id) {
        await queryInterface.addColumn('product_marketplace_links', 'external_variant_id', {
          type: Sequelize.STRING(150), allowNull: true, comment: 'ID de variante de la publicación externa'
        }, { transaction });
      }
      if (linkDescription) {
        const indexes = await queryInterface.showIndex('product_marketplace_links', { transaction });
        const oldUnique = indexes.find(index => [
          'pml_product_marketplace_context_unique',
          'pml_product_marketplace_context_user_unique'
        ].includes(index.name));
        if (oldUnique) await queryInterface.removeIndex('product_marketplace_links', oldUnique.name, { transaction });
        const variantUnique = indexes.find(index => index.name === 'pml_product_marketplace_external_unique');
        if (!variantUnique) {
          await queryInterface.addIndex('product_marketplace_links', [
            'product_id', 'marketplace_id', 'company_id', 'branch_id', 'credential_id', 'user_id',
            'external_id', 'external_variant_id'
          ], { unique: true, name: 'pml_product_marketplace_external_unique', transaction });
        }
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
      await queryInterface.dropTable('marketplace_import_items', { transaction }).catch(() => null);
      await queryInterface.dropTable('marketplace_import_operations', { transaction }).catch(() => null);
      const linkDescription = await queryInterface.describeTable('product_marketplace_links', { transaction }).catch(() => null);
      if (linkDescription?.external_variant_id) {
        await queryInterface.removeIndex('product_marketplace_links', 'pml_product_marketplace_external_unique', { transaction }).catch(() => null);
        const indexFields = linkDescription.user_id
          ? ['product_id', 'marketplace_id', 'company_id', 'branch_id', 'credential_id', 'user_id']
          : ['product_id', 'marketplace_id', 'company_id', 'branch_id'];
        const indexName = linkDescription.user_id
          ? 'pml_product_marketplace_context_user_unique'
          : 'pml_product_marketplace_context_unique';
        await queryInterface.addIndex('product_marketplace_links', indexFields, {
          unique: true, name: indexName, transaction
        }).catch(() => null);
        await queryInterface.removeColumn('product_marketplace_links', 'external_variant_id', { transaction });
      }
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
};
