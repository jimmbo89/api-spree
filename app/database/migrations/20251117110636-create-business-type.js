'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('business_types', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.BIGINT
      },
      name: {
        type: Sequelize.STRING,
        allowNull: true,
        unique: true
      },
      status: {
        type: Sequelize.BOOLEAN,
        allowNull: true,
        defaultValue: true
      },
      description: {
        type: Sequelize.TEXT,
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
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('business_types');
  }
};