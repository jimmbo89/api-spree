'use strict';

/**
 * Migración para crear la tabla marketplace_order_fees
 * Almacena las comisiones y cargos de cada orden
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('marketplace_order_fees', {
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
      order_item_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: {
          model: 'marketplace_order_items',
          key: 'id'
        },
        comment: 'Referencia al item (si el fee es por item)'
      },
      
      // Tipo de fee
      fee_type: {
        type: Sequelize.STRING(50),
        allowNull: false,
        comment: 'commission, shipping_fee, tax, fixed_fee, other'
      },
      
      // Montos
      amount: {
        type: Sequelize.DECIMAL(12, 2),
        allowNull: false,
        comment: 'Monto del fee'
      },
      percentage: {
        type: Sequelize.DECIMAL(5, 2),
        allowNull: true,
        comment: 'Porcentaje aplicado (si corresponde)'
      },
      
      // Estado
      status: {
        type: Sequelize.STRING(50),
        allowNull: true,
        defaultValue: 'pending',
        comment: 'pending, charged, paid, cancelled'
      },
      payout_date: {
        type: Sequelize.DATE,
        allowNull: true,
        comment: 'Fecha de pago del fee (cuando se cobra)'
      },
      payout_reference: {
        type: Sequelize.STRING(100),
        allowNull: true,
        comment: 'Referencia del payout (ID de liquidación)'
      },
      
      // Metadatos
      description: {
        type: Sequelize.TEXT,
        allowNull: true,
        comment: 'Descripción del fee'
      },
      raw_data: {
        type: Sequelize.JSON,
        allowNull: true,
        comment: 'Datos raw del fee para auditoría'
      },
      
      // Relaciones con entidades locales
      company_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: {
          model: 'companies',
          key: 'id'
        },
        comment: 'Empresa propietaria del fee'
      },
      
      // Metadatos de sistema
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
          name: 'idx_order_fees_order_id'
        },
        {
          fields: ['order_item_id'],
          name: 'idx_order_fees_item_id'
        },
        {
          fields: ['fee_type'],
          name: 'idx_order_fees_type'
        },
        {
          fields: ['status'],
          name: 'idx_order_fees_status'
        },
        {
          fields: ['company_id'],
          name: 'idx_order_fees_company_id'
        },
        {
          fields: ['payout_date'],
          name: 'idx_order_fees_payout_date'
        }
      ]
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('marketplace_order_fees');
  }
};
