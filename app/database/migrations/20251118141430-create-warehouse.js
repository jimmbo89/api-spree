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
      code: {
        type: Sequelize.STRING(50),
        allowNull: true,
        unique: true
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
        allowNull: false
      },
      description: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      type: {
        type: Sequelize.STRING(20),
        allowNull: false,
        defaultValue: 'central'
      },
      address: {
        type: Sequelize.STRING,
        allowNull: true
      },
      city: {
        type: Sequelize.STRING(120),
        allowNull: true
      },
      region: {
        type: Sequelize.STRING(120),
        allowNull: true
      },
      country: {
        type: Sequelize.STRING(120),
        allowNull: true
      },
      latitude: {
        type: Sequelize.DECIMAL(10, 8),
        allowNull: true
      },
      longitude: {
        type: Sequelize.DECIMAL(11, 8),
        allowNull: true
      },
      capacity_max_units: {
        type: Sequelize.INTEGER,
        allowNull: true
      },
      allow_mermas: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true
      },
      rotation_policy: {
        type: Sequelize.STRING(10),
        allowNull: false,
        defaultValue: 'FIFO'
      },
      status: {
        type: Sequelize.STRING(20),
        allowNull: false,
        defaultValue: 'activo'
      },
      image: {
        type: Sequelize.STRING,
        allowNull: true,
        defaultValue: 'warehouses/default.jpg'
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

    // Agregar índice único para el código después de crear la tabla
    await queryInterface.addIndex('warehouses', ['code'], {
      unique: true,
      name: 'warehouses_code_unique'
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('warehouses');
  }
};