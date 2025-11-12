'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('user_tokens', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.BIGINT
      },
      user_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: {
          model: 'users', // Asegúrate de que 'Users' sea el nombre correcto de tu tabla de usuarios
          key: 'id'
        },
        onDelete: 'CASCADE'
      },
      token: {
        type: Sequelize.TEXT,
        allowNull: false
      },
      expires_at: {
        type: Sequelize.DATE,  // Usa Sequelize.DATE en lugar de Sequelize.DATETIME
        allowNull: true // Puede ser nulo si el token no expira
      },
      revoked: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
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
    await queryInterface.dropTable('user_tokens');
  }
};