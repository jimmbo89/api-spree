'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('marketplaces', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.BIGINT
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
      name: {
        type: Sequelize.STRING,
        allowNull: false
      },
      description: {
        type: Sequelize.STRING,
        allowNull: true
      },
      type: {
        type: Sequelize.TINYINT,
        allowNull: true,
        comment: '0 = internal, 1 = external'
      },
      domain: {
        type: Sequelize.STRING,
        allowNull: true
      },
      config: {
        type: Sequelize.JSON,
        allowNull: true
      },
      active: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true
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

    await queryInterface.addIndex('marketplaces', ['company_id', 'name'], {
      unique: true,
      name: 'marketplaces_company_name_unique'
    });
    await queryInterface.addIndex('marketplaces', ['company_id'], {
      name: 'marketplaces_company_idx'
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('marketplaces');
  }
};