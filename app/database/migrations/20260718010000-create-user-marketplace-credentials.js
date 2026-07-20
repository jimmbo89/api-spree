'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      await queryInterface.createTable('user_marketplace_credentials', {
        id: {
          type: Sequelize.BIGINT,
          autoIncrement: true,
          primaryKey: true,
          allowNull: false
        },
        user_id: {
          type: Sequelize.BIGINT,
          allowNull: false,
          references: {
            model: 'users',
            key: 'id'
          },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE'
        },
        company_id: {
          type: Sequelize.BIGINT,
          allowNull: false,
          references: {
            model: 'companies',
            key: 'id'
          },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE'
        },
        marketplace_credential_id: {
          type: Sequelize.BIGINT,
          allowNull: false,
          references: {
            model: 'marketplace_credentials',
            key: 'id'
          },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE'
        },
        status: {
          type: Sequelize.TINYINT,
          allowNull: false,
          defaultValue: 1,
          comment: '0 = inactivo, 1 = activo'
        },
        createdAt: {
          allowNull: false,
          type: Sequelize.DATE
        },
        updatedAt: {
          allowNull: false,
          type: Sequelize.DATE
        }
      }, { transaction });

      await queryInterface.addIndex('user_marketplace_credentials', ['user_id'], {
        name: 'umc_user_idx',
        transaction
      });

      await queryInterface.addIndex('user_marketplace_credentials', ['company_id'], {
        name: 'umc_company_idx',
        transaction
      });

      await queryInterface.addIndex('user_marketplace_credentials', ['marketplace_credential_id'], {
        name: 'umc_marketplace_credential_idx',
        transaction
      });

      await queryInterface.addIndex('user_marketplace_credentials', ['status'], {
        name: 'umc_status_idx',
        transaction
      });

      await queryInterface.addIndex(
        'user_marketplace_credentials',
        ['user_id', 'company_id', 'marketplace_credential_id'],
        {
          unique: true,
          name: 'umc_user_company_credential_unique',
          transaction
        }
      );

      await queryInterface.sequelize.query(`
        INSERT INTO user_marketplace_credentials
          (user_id, company_id, marketplace_credential_id, status, createdAt, updatedAt)
        SELECT
          mc.user_id,
          mc.company_id,
          mc.id,
          1,
          NOW(),
          NOW()
        FROM marketplace_credentials mc
        WHERE mc.user_id IS NOT NULL
          AND mc.company_id IS NOT NULL
        ON DUPLICATE KEY UPDATE
          status = VALUES(status),
          updatedAt = VALUES(updatedAt)
      `, { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      await queryInterface.dropTable('user_marketplace_credentials', { transaction });
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
};
