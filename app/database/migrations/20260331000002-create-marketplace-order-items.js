'use strict';

/**
 * Migración para crear la tabla marketplace_order_items
 * Almacena los items de cada orden de marketplace
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('marketplace_order_items', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.BIGINT
      },
      order_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: {
          model: 'marketplace_orders',
          key: 'id'
        },
        comment: 'Referencia a la orden padre'
      },
      
      // Identificación del item
      marketplace_item_id: {
        type: Sequelize.STRING(100),
        allowNull: true,
        comment: 'ID del item en el marketplace'
      },
      listing_id: {
        type: Sequelize.STRING(100),
        allowNull: true,
        comment: 'External ID del listing (product_marketplace_links)'
      },
      sku: {
        type: Sequelize.STRING(100),
        allowNull: true,
        comment: 'SKU del producto'
      },
      
      // Vínculo con productos locales
      product_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: {
          model: 'products',
          key: 'id'
        },
        comment: 'Producto local asociado'
      },
      variant_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: {
          model: 'product_variants',
          key: 'id'
        },
        comment: 'Variante local asociada'
      },
      
      // Relaciones con entidades locales (para filtrado rápido y seguridad)
      company_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: {
          model: 'companies',
          key: 'id'
        },
        comment: 'Empresa propietaria del item'
      },
      branch_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: {
          model: 'branches',
          key: 'id'
        },
        comment: 'Sucursal asociada al item'
      },
      user_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: {
          model: 'users',
          key: 'id'
        },
        comment: 'Usuario que publicó el producto'
      },
      
      // Cantidad y precios
      quantity: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 1,
        comment: 'Cantidad del item'
      },
      unit_price: {
        type: Sequelize.DECIMAL(12, 2),
        allowNull: false,
        comment: 'Precio unitario del item'
      },
      total_price: {
        type: Sequelize.DECIMAL(12, 2),
        allowNull: false,
        comment: 'Precio total (quantity * unit_price)'
      },
      
      // Descuentos e impuestos
      discount_amount: {
        type: Sequelize.DECIMAL(12, 2),
        allowNull: true,
        defaultValue: 0,
        comment: 'Descuento aplicado al item'
      },
      tax_amount: {
        type: Sequelize.DECIMAL(12, 2),
        allowNull: true,
        defaultValue: 0,
        comment: 'Impuestos aplicados al item'
      },
      
      // Costos
      cost_price: {
        type: Sequelize.DECIMAL(12, 2),
        allowNull: true,
        comment: 'Costo unitario del producto (para cálculo de ganancias)'
      },
      total_cost: {
        type: Sequelize.DECIMAL(12, 2),
        allowNull: true,
        comment: 'Costo total (quantity * cost_price)'
      },
      
      // Vínculo con movimiento de inventario
      inventory_movement_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: {
          model: 'inventory_movements',
          key: 'id'
        },
        comment: 'Movimiento de inventario asociado a este item'
      },
      
      // Metadatos
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE
      }
    }, {
      indexes: [
        {
          fields: ['order_id'],
          name: 'idx_order_items_order_id'
        },
        {
          fields: ['product_id'],
          name: 'idx_order_items_product_id'
        },
        {
          fields: ['variant_id'],
          name: 'idx_order_items_variant_id'
        },
        {
          fields: ['inventory_movement_id'],
          name: 'idx_order_items_movement_id'
        },
        {
          fields: ['listing_id'],
          name: 'idx_order_items_listing_id'
        },
        {
          fields: ['company_id'],
          name: 'idx_order_items_company_id'
        },
        {
          fields: ['branch_id'],
          name: 'idx_order_items_branch_id'
        },
        {
          fields: ['user_id'],
          name: 'idx_order_items_user_id'
        }
      ]
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('marketplace_order_items');
  }
};
