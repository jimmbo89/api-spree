// migrations/YYYYMMDDHHMMSS-create_inventory_movements_table.js
'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('inventory_movements', {
      id: {
        type: Sequelize.BIGINT,
        primaryKey: true,
        autoIncrement: true
      },
      warehouse_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: 'warehouses', key: 'id' },
        onDelete: 'SET NULL'
      },
      product_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: 'products', key: 'id' },
        onDelete: 'SET NULL'
      },
      variant_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: 'product_variants', key: 'id' },
        onDelete: 'SET NULL'
      },

      // 🔸 Denormalización para consultas eficientes
      company_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: 'companies', key: 'id' },
        onDelete: 'SET NULL'
      },
      branch_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: 'branches', key: 'id' },
        onDelete: 'SET NULL'
      },

      // 🔸 Tipos de movimiento (string flexible)
      // Ejemplos actuales:
      // - 'entry'               → Entrada individual o masiva
      // - 'exit'                → Salida individual o masiva
      // - 'transfer_entry'      → Entrada por transferencia
      // - 'transfer_exit'       → Salida por transferencia
      movement_type: {
        type: Sequelize.STRING,
        allowNull: true
      },

      quantity: {
        type: Sequelize.INTEGER,
        allowNull: true
      },
      stock_before: {
        type: Sequelize.INTEGER,
        allowNull: true
      },
      stock_after: {
        type: Sequelize.INTEGER,
        allowNull: true
      },
      unit_price: {
        type: Sequelize.DECIMAL(16, 2),
        allowNull: true
      },
      total_value: {
        type: Sequelize.DECIMAL(16, 2),
        allowNull: true
      },

      // 🔸 Referencia a la operación global
      reference_type: {
        type: Sequelize.STRING,
        allowNull: true // Ej: 'transfer', 'purchase_order', 'sale'
      },
      reference_id: {
        type: Sequelize.STRING,
        allowNull: true // UUID generado en backend
      },

      // 🔸 Solo para transferencias
      origin_warehouse_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: 'warehouses', key: 'id' },
        onDelete: 'SET NULL'
      },
      destination_warehouse_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: 'warehouses', key: 'id' },
        onDelete: 'SET NULL'
      },

      user_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onDelete: 'SET NULL'
      },
      reason: {
        type: Sequelize.TEXT,
        allowNull: true 
      },
      notes: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false
      }
    });

    // Índices para consultas frecuentes
    await queryInterface.addIndex('inventory_movements', ['warehouse_id'], { name: 'idx_inventory_warehouse' });
    await queryInterface.addIndex('inventory_movements', ['product_id'], { name: 'idx_inventory_product' });
    await queryInterface.addIndex('inventory_movements', ['variant_id'], { name: 'idx_inventory_variant' });
    await queryInterface.addIndex('inventory_movements', ['company_id'], { name: 'idx_inventory_company' });
    await queryInterface.addIndex('inventory_movements', ['branch_id'], { name: 'idx_inventory_branch' });
    await queryInterface.addIndex('inventory_movements', ['reference_id'], { name: 'idx_inventory_reference' });
    await queryInterface.addIndex('inventory_movements', ['movement_type'], { name: 'idx_inventory_movement_type' });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('inventory_movements');
  }
};