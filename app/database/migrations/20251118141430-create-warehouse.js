'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('warehouses', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.BIGINT
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
      company_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: {
          model: 'companies',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      branch_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: {
          model: 'branches',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      name: {
        type: Sequelize.STRING,
        allowNull: true
      },
      type: {
        type: Sequelize.TINYINT,
        allowNull: true,
        defaultValue: 1
      },
      address: {
        type: Sequelize.STRING,
        allowNull: true
      },
      image: {
        type: Sequelize.STRING,
        allowNull: true,
        defaultValue: 'warehouses/default.jpg'
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
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('warehouses');
  }
};