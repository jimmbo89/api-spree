'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('permissions', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.BIGINT
      },
      name: {
        type: Sequelize.STRING(100),
        allowNull: false,
        unique: true
      },
      description: {
        type: Sequelize.STRING(255),
        allowNull: true
      },
      service: {
        type: Sequelize.STRING(50),
        allowNull: true,
        comment: 'Microservicio o módulo (Product, Inventory, Publishing, etc.)'
      },
      resource: {
        type: Sequelize.STRING(50),
        allowNull: true,
        comment: 'Recurso sobre el que se aplica (product, branch, publication, etc.)'
      },
      action: {
        type: Sequelize.STRING(30),
        allowNull: true,
        comment: 'Acción realizada (create, view, edit, delete, publish, etc.)'
      },
      is_conditional: {
        type: Sequelize.BOOLEAN,
        allowNull: true,
        defaultValue: false
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
    await queryInterface.dropTable('permissions');
  }
};