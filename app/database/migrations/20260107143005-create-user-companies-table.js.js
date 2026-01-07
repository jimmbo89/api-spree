'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('user_companies', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.BIGINT,
        comment: 'ID autoincremental de la membresía usuario-empresa'
      },
      user_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
        comment: 'ID del usuario'
      },
      company_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: 'companies', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
        comment: 'ID de la empresa'
      },
      role_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: 'roles', key: 'id' },
        onDelete: 'RESTRICT', // No eliminar rol si hay membresías
        onUpdate: 'CASCADE',
        comment: 'Rol asignado al usuario en esta empresa'
      },
      status: {
        type: Sequelize.TINYINT,
        allowNull: false,
        defaultValue: -1, // -1 = invitación pendiente, 1 = activo, 0 = inactivo
        comment: 'Estado: -1=invitación pendiente, 0=inactivo, 1=activo'
      },
      joined_at: {
        type: Sequelize.DATE,
        allowNull: true,
        comment: 'Fecha en que aceptó la invitación o fue creado'
      },
      invited_by: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
        comment: 'Usuario que envió la invitación'
      },
      invitation_token: {
        type: Sequelize.STRING(255),
        allowNull: true,
        comment: 'Token único para aceptar invitación'
      },
      expires_at: {
        type: Sequelize.DATE,
        allowNull: true,
        comment: 'Fecha de expiración de la invitación'
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

    // Índices
    await queryInterface.addIndex('user_companies', ['user_id', 'company_id'], {
      unique: true,
      name: 'user_companies_user_company_unique'
    });
    await queryInterface.addIndex('user_companies', ['company_id', 'status'], {
      name: 'user_companies_company_status_idx'
    });
    await queryInterface.addIndex('user_companies', ['invitation_token'], {
      unique: true,
      name: 'user_companies_invitation_token_unique',
      where: { invitation_token: { [Sequelize.Op.ne]: null } } // solo para tokens no nulos
    });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('user_companies');
  }
};