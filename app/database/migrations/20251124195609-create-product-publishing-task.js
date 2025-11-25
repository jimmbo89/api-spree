'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('product_publishing_tasks', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.BIGINT
      },
      product_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: {
          model: 'products',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      marketplace_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: {
          model: 'marketplaces',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      warehouse_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: {
          model: 'warehouses',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      user_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: {
          model: 'users',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      date: {
        type: Sequelize.DATEONLY,
        allowNull: false,
        defaultValue: Sequelize.NOW // se guarda como YYYY-MM-DD
      },
      status: {
        type: Sequelize.STRING,
        allowNull: false,
        defaultValue: 'pending'
      },
      error_message: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      payload: {
        type: Sequelize.JSON,
        allowNull: false
      },
      external_id: {
        type: Sequelize.STRING,
        allowNull: true
      },
      external_url: {
        type: Sequelize.STRING,
        allowNull: true
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE
      }
    });

    await queryInterface.addIndex('product_publishing_tasks', ['date'], {
      name: 'ppt_date_idx'
    });
    await queryInterface.addIndex('product_publishing_tasks', ['marketplace_id'], {
      name: 'ppt_marketplace_idx'
    });
    await queryInterface.addIndex('product_publishing_tasks', ['product_id'], {
      name: 'ppt_product_idx'
    });
    await queryInterface.addIndex('product_publishing_tasks', ['user_id'], {
      name: 'ppt_user_idx'
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('product_publishing_tasks');
  }
};