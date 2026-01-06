'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('role_permissions', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.BIGINT,
        comment: 'ID autoincremental de la relación rol-permiso'
      },
      role_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: 'roles', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
        comment: 'ID del rol'
      },
      permission_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: 'permissions', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
        comment: 'ID del permiso'
      },
      status: {
        type: Sequelize.TINYINT,
        allowNull: false,
        defaultValue: 1,
        comment: 'Estado: 1=activo, 2=inactivo, 3=archivado'
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

    await queryInterface.addIndex('role_permissions', ['role_id', 'permission_id'], {
      unique: true,
      name: 'role_permissions_unique'
    });
    await queryInterface.addIndex('role_permissions', ['status'], {
      name: 'role_permissions_status_idx'
    });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('role_permissions');
  }
};