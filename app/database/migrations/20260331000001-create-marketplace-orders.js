'use strict';

/**
 * Migración para crear la tabla marketplace_orders
 * Almacena las órdenes de venta de todos los marketplaces
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('marketplace_orders', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.BIGINT
      },
      marketplace: {
        type: Sequelize.STRING(50),
        allowNull: false,
        comment: 'mercadolibre, falabella, etc.'
      },
      marketplace_order_id: {
        type: Sequelize.STRING(100),
        allowNull: false,
        comment: 'ID de la orden en el marketplace'
      },
      marketplace_credential_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: {
          model: 'marketplace_credentials',
          key: 'id'
        },
        comment: 'Credencial usada para esta orden'
      },
      
      // Relaciones con entidades locales (para filtrado rápido y seguridad)
      company_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: {
          model: 'companies',
          key: 'id'
        },
        comment: 'Empresa propietaria de la orden'
      },
      branch_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: {
          model: 'branches',
          key: 'id'
        },
        comment: 'Sucursal asociada a la orden'
      },
      user_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: {
          model: 'users',
          key: 'id'
        },
        comment: 'Usuario que publicó el producto/gestionó la orden'
      },
      
      // Estados
      order_status: {
        type: Sequelize.STRING(50),
        allowNull: true,
        comment: 'paid, cancelled, returned, pending, etc.'
      },
      payment_status: {
        type: Sequelize.STRING(50),
        allowNull: true,
        comment: 'paid, pending, cancelled, refunded'
      },
      
      // Totales de la orden
      subtotal: {
        type: Sequelize.DECIMAL(12, 2),
        allowNull: true,
        comment: 'Subtotal sin impuestos ni envíos'
      },
      shipping_total: {
        type: Sequelize.DECIMAL(12, 2),
        allowNull: true,
        defaultValue: 0,
        comment: 'Total de envíos'
      },
      discount_total: {
        type: Sequelize.DECIMAL(12, 2),
        allowNull: true,
        defaultValue: 0,
        comment: 'Total de descuentos'
      },
      tax_total: {
        type: Sequelize.DECIMAL(12, 2),
        allowNull: true,
        defaultValue: 0,
        comment: 'Total de impuestos'
      },
      total_amount: {
        type: Sequelize.DECIMAL(12, 2),
        allowNull: true,
        comment: 'Monto total de la orden'
      },
      currency: {
        type: Sequelize.STRING(10),
        allowNull: true,
        defaultValue: 'CLP',
        comment: 'Moneda de la orden'
      },
      
      // Cliente
      buyer_id: {
        type: Sequelize.STRING(100),
        allowNull: true,
        comment: 'ID del comprador en el marketplace'
      },
      buyer_name: {
        type: Sequelize.STRING(255),
        allowNull: true,
        comment: 'Nombre del comprador'
      },
      buyer_email: {
        type: Sequelize.STRING(255),
        allowNull: true,
        comment: 'Email del comprador'
      },
      buyer_document: {
        type: Sequelize.STRING(50),
        allowNull: true,
        comment: 'Documento tributario del comprador (RUT, etc.)'
      },
      
      // Pagos
      payment_method: {
        type: Sequelize.STRING(50),
        allowNull: true,
        comment: 'credit_card, debit_card, bank_transfer, etc.'
      },
      payment_date: {
        type: Sequelize.DATE,
        allowNull: true,
        comment: 'Fecha de pago'
      },
      
      // Envío
      shipping_address: {
        type: Sequelize.TEXT,
        allowNull: true,
        comment: 'Dirección completa de envío'
      },
      shipping_city: {
        type: Sequelize.STRING(100),
        allowNull: true,
        comment: 'Ciudad de envío'
      },
      shipping_region: {
        type: Sequelize.STRING(100),
        allowNull: true,
        comment: 'Región/Estado de envío'
      },
      
      // Documento tributario
      invoice_type: {
        type: Sequelize.STRING(50),
        allowNull: true,
        comment: 'boleta, factura, ticket'
      },
      invoice_number: {
        type: Sequelize.STRING(100),
        allowNull: true,
        comment: 'Número de documento tributario'
      },
      invoice_date: {
        type: Sequelize.DATE,
        allowNull: true,
        comment: 'Fecha de emisión del documento'
      },
      
      // Raw payload para auditoría
      raw_payload: {
        type: Sequelize.JSON,
        allowNull: true,
        comment: 'Payload completo de la orden para auditoría'
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
          unique: true,
          fields: ['marketplace', 'marketplace_order_id'],
          name: 'uniq_marketplace_order'
        },
        {
          fields: ['order_status'],
          name: 'idx_order_status'
        },
        {
          fields: ['payment_status'],
          name: 'idx_payment_status'
        },
        {
          fields: ['createdAt'],
          name: 'idx_order_created_at'
        },
        {
          fields: ['marketplace_credential_id'],
          name: 'idx_credential_id'
        },
        {
          fields: ['company_id'],
          name: 'idx_company_id'
        },
        {
          fields: ['branch_id'],
          name: 'idx_branch_id'
        },
        {
          fields: ['user_id'],
          name: 'idx_user_id'
        }
      ]
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('marketplace_orders');
  }
};
