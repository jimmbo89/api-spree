'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('product_field_mappings', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.BIGINT
      },
      marketplace_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: {
          model: 'marketplaces',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      internal_field: {
        type: Sequelize.STRING,
        allowNull: false
      },
      external_field: {
        type: Sequelize.STRING,
        allowNull: false
      },
      required: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false
      },
      data_type: {
        type: Sequelize.STRING,
        allowNull: true
      },
      direction: {
        type: Sequelize.STRING,
        allowNull: false,
        defaultValue: 'export'
      },
      default_value: {
        type: Sequelize.STRING,
        allowNull: true
      },
      validation_rules: {
        type: Sequelize.JSON,
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

    await queryInterface.addIndex('product_field_mappings', ['marketplace_id', 'internal_field'], {
      unique: true,
      name: 'pfm_marketplace_internal_unique'
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('product_field_mappings');
  }
};