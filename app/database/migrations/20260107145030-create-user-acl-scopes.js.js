'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('user_acl_scopes', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.BIGINT,
        comment: 'ID autoincremental del alcance ACL de usuario'
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
      warehouse_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: 'warehouses', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
        comment: 'ID del almacén permitido (opcional)'
      },
      pool_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: 'pools', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
        comment: 'ID del pool permitido (opcional)'
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
    await queryInterface.addIndex('user_acl_scopes', ['user_id', 'company_id'], {
      name: 'user_acl_scopes_user_company_idx'
    });
    await queryInterface.addIndex('user_acl_scopes', ['warehouse_id'], {
      name: 'user_acl_scopes_warehouse_idx'
    });
    await queryInterface.addIndex('user_acl_scopes', ['pool_id'], {
      name: 'user_acl_scopes_pool_idx'
    });

    // Único por combinación válida
    await queryInterface.addIndex('user_acl_scopes', ['user_id', 'company_id', 'warehouse_id', 'pool_id'], {
      unique: true,
      name: 'user_acl_scopes_unique',
      where: {
        [Sequelize.Op.or]: [
          { warehouse_id: { [Sequelize.Op.ne]: null } },
          { pool_id: { [Sequelize.Op.ne]: null } }
        ]
      }
    });
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('user_acl_scopes');
  }
};