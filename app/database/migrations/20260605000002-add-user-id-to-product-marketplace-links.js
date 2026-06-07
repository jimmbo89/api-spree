'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      const tableDescription = await queryInterface.describeTable('product_marketplace_links', { transaction });

      if (!tableDescription.user_id) {
        await queryInterface.addColumn('product_marketplace_links', 'user_id', {
          type: Sequelize.BIGINT,
          allowNull: true,
          comment: 'ID del usuario que generó la publicación'
        }, { transaction });

        try {
          await queryInterface.addConstraint('product_marketplace_links', {
            fields: ['user_id'],
            type: 'foreign key',
            name: 'pml_user_fk',
            references: {
              table: 'users',
              field: 'id'
            },
            onUpdate: 'CASCADE',
            onDelete: 'SET NULL'
          }, { transaction });
        } catch (fkError) {
          console.warn('[Migration] FK user_id may already exist:', fkError.message);
        }
      }

      let indexes = await queryInterface.showIndex('product_marketplace_links', { transaction });
      const ensureIndex = async (fields, name) => {
        const exists = indexes.find((idx) => idx.name === name);
        if (!exists) {
          await queryInterface.addIndex('product_marketplace_links', fields, { name, transaction });
        }
      };

      await ensureIndex(['company_id'], 'pml_company_id_idx');
      await ensureIndex(['branch_id'], 'pml_branch_id_idx');
      await ensureIndex(['product_id'], 'pml_product_id_idx');
      await ensureIndex(['credential_id'], 'pml_credential_id_idx');
      await ensureIndex(['user_id'], 'pml_user_id_idx');

      await queryInterface.sequelize.query(`
        UPDATE product_marketplace_links pml
        INNER JOIN marketplace_credentials mc
          ON mc.id = pml.credential_id
        SET pml.user_id = mc.user_id
        WHERE pml.user_id IS NULL
          AND pml.credential_id IS NOT NULL
      `, { transaction });

      indexes = await queryInterface.showIndex('product_marketplace_links', { transaction });
      const oldIndex = indexes.find(idx => idx.name === 'pml_product_marketplace_context_unique');
      if (oldIndex) {
        await queryInterface.removeIndex('product_marketplace_links', 'pml_product_marketplace_context_unique', { transaction });
      }

      const newIndex = indexes.find(idx => idx.name === 'pml_product_marketplace_context_user_unique');
      if (!newIndex) {
        await queryInterface.addIndex(
          'product_marketplace_links',
          ['product_id', 'marketplace_id', 'company_id', 'branch_id', 'credential_id', 'user_id'],
          {
            unique: true,
            name: 'pml_product_marketplace_context_user_unique',
            transaction
          }
        );
      }

      await transaction.commit();
      console.log('[Migration] user_id agregado exitosamente a product_marketplace_links');
    } catch (error) {
      await transaction.rollback();
      console.error('[Migration] Error al agregar user_id:', error);
      throw error;
    }
  },

  async down(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      const tableDescription = await queryInterface.describeTable('product_marketplace_links', { transaction });

      if (tableDescription.user_id) {
        const indexes = await queryInterface.showIndex('product_marketplace_links', { transaction });
        const newIndex = indexes.find(idx => idx.name === 'pml_product_marketplace_context_user_unique');
        if (newIndex) {
          await queryInterface.removeIndex('product_marketplace_links', 'pml_product_marketplace_context_user_unique', { transaction });
        }

        try {
          await queryInterface.removeConstraint('product_marketplace_links', 'pml_user_fk', { transaction });
        } catch (fkError) {
          console.warn('[Migration] FK pml_user_fk does not exist:', fkError.message);
        }

        await queryInterface.removeColumn('product_marketplace_links', 'user_id', { transaction });

        const companyIndex = indexes.find(idx => idx.name === 'pml_company_id_idx');
        if (companyIndex) {
          await queryInterface.removeIndex('product_marketplace_links', 'pml_company_id_idx', { transaction });
        }

        const branchIndex = indexes.find(idx => idx.name === 'pml_branch_id_idx');
        if (branchIndex) {
          await queryInterface.removeIndex('product_marketplace_links', 'pml_branch_id_idx', { transaction });
        }

        const productIndex = indexes.find(idx => idx.name === 'pml_product_id_idx');
        if (productIndex) {
          await queryInterface.removeIndex('product_marketplace_links', 'pml_product_id_idx', { transaction });
        }

        const credentialIndex = indexes.find(idx => idx.name === 'pml_credential_id_idx');
        if (credentialIndex) {
          await queryInterface.removeIndex('product_marketplace_links', 'pml_credential_id_idx', { transaction });
        }

        const userIndex = indexes.find(idx => idx.name === 'pml_user_id_idx');
        if (userIndex) {
          await queryInterface.removeIndex('product_marketplace_links', 'pml_user_id_idx', { transaction });
        }

        await queryInterface.addIndex('product_marketplace_links', ['product_id', 'marketplace_id', 'company_id', 'branch_id'], {
          unique: true,
          name: 'pml_product_marketplace_context_unique',
          transaction
        });
      }

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      console.error('[Migration] Error al revertir user_id:', error);
      throw error;
    }
  }
};
