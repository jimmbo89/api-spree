'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('users', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.BIGINT
      },
      role_id: {
        type: Sequelize.BIGINT,
        allowNull: true, // o false si siempre debe tener rol
        references: {
          model: 'roles', // nombre de la tabla
          key: 'id'
        },
        onDelete: 'SET NULL', // o 'RESTRICT' si no quieres permitir eliminación de roles en uso
        onUpdate: 'CASCADE'
      },
      name: {
        type: Sequelize.STRING,
        allowNull: false
      },
      email: {
        type: Sequelize.STRING,
        allowNull: true,
        unique: true
      },
      email_verified_at: {
        type: Sequelize.DATE,
        allowNull: true
      },
      password: {
        type: Sequelize.STRING,
        allowNull: true
      },
      remember_token: {
        type: Sequelize.STRING,
        allowNull: true
      },
      external_id: {
        type: Sequelize.STRING,
        allowNull: true
      },
      external_auth: {
        type: Sequelize.STRING,
        allowNull: true
      },
      status: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true
      },
       image: {
        type: Sequelize.STRING,
        allowNull: true
      },
      registration_date: {
        type: Sequelize.DATE, // o Sequelize.DATE
        allowNull: true,
      },
      user: {
        type: Sequelize.STRING,
        allowNull: true
      },
         reset_expire: {
        type: DataTypes.BIGINT,
        allowNull: true
      },
      reset_token: {
        type: DataTypes.STRING,
        allowNull: true
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE,
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE,
      }
    });

     // Opcional: Crear índice para búsquedas por external_id + external_auth
    await queryInterface.addIndex('users', ['external_id', 'external_auth'], {
      name: 'users_external_auth_idx',
      unique: false
    });

    // Opcional: Crear índice para reset_token (búsquedas más rápidas)
    await queryInterface.addIndex('users', ['reset_token'], {
      name: 'users_reset_token_idx',
      unique: false
    });
  },

  async down(queryInterface, Sequelize) {
     await queryInterface.removeIndex('users', 'users_external_auth_idx');
    await queryInterface.removeIndex('users', 'users_reset_token_idx');
    await queryInterface.dropTable('users');
  }
};