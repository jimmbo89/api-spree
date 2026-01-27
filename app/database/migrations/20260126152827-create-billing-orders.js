// migrations/XXXXXX-create-billing-orders.js
'use strict';
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('billing_orders', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.BIGINT
      },
      company_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: 'companies', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      current_plan_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: 'plans', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT'
      },
      target_plan_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: 'plans', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT'
      },
      billing_cycle: {
        type: Sequelize.STRING,
        allowNull: false,
        validate: {
          isIn: [['monthly', 'annual']]
        }
      },
      type: {
        type: Sequelize.STRING,
        allowNull: false,
        validate: {
          isIn: [['upgrade', 'downgrade', 'renewal', 'reactivation', 'past_due_payment']]
        }
      },
      status: {
        type: Sequelize.STRING,
        allowNull: false,
        defaultValue: 'pending_payment',
        validate: {
          isIn: [['pending_payment', 'paid', 'rejected', 'canceled']]
        }
      },
      total_amount: {
        type: Sequelize.DECIMAL(16,2),
        allowNull: false
      },
      currency: {
        type: Sequelize.STRING,
        allowNull: false,
        defaultValue: 'USD'
      },
      payment_method: {
        type: Sequelize.STRING,
        allowNull: false,
        validate: {
          isIn: [['payment_link', 'transfer_proof', 'invoice_sii']]
        }
      },
      payment_link_url: {
        type: Sequelize.STRING,
        allowNull: true
      },
      proof_url: {
        type: Sequelize.STRING,
        allowNull: true // comprobante de transferencia
      },
      invoice_request: {
        type: Sequelize.JSON,
        allowNull: true // datos de facturación si aplica
      },
      effective_date: {
        type: Sequelize.DATEONLY,
        allowNull: true // para downgrades programados
      },
      paid_at: {
        type: Sequelize.DATE,
        allowNull: true
      },
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
        { fields: ['company_id'] },
        { fields: ['status'] },
        { fields: ['type'] },
        { fields: ['payment_method'] }
      ]
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('billing_orders');
  }
};