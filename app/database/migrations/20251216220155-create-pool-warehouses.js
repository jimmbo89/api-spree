// migrations/YYYYMMDDHHMMSS-create-pool-warehouses.js
'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('pool_warehouses', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.BIGINT
      },
      pool_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { 
          model: 'pools', 
          key: 'id' 
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      warehouse_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { 
          model: 'warehouses', 
          key: 'id' 
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      is_primary: {
        type: Sequelize.BOOLEAN,
        defaultValue: false
      },
      position: {
        type: Sequelize.INTEGER,
        defaultValue: 0
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
    await queryInterface.addIndex('pool_warehouses', ['pool_id']);
    await queryInterface.addIndex('pool_warehouses', ['warehouse_id']);
    
    // Restricción: un almacén no puede estar en el mismo pool más de una vez
    await queryInterface.addConstraint('pool_warehouses', {
      fields: ['pool_id', 'warehouse_id'],
      type: 'unique',
      name: 'unique_pool_warehouse_combination'
    });

    // Restricción parcial para un solo principal por pool
    // Nota: MySQL no soporta índices parciales únicos directamente
    // Usaremos un trigger o validación en la aplicación
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('pool_warehouses');
  }
};