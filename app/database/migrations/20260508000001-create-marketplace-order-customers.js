'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('marketplace_order_customers', {
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
        onDelete: 'CASCADE',
        comment: 'Orden local asociada'
      },
      marketplace: {
        type: Sequelize.STRING(50),
        allowNull: false,
        comment: 'Origen marketplace del snapshot'
      },
      marketplace_customer_id: {
        type: Sequelize.STRING(100),
        allowNull: true
      },
      first_name: {
        type: Sequelize.STRING(120),
        allowNull: true
      },
      last_name: {
        type: Sequelize.STRING(120),
        allowNull: true
      },
      full_name: {
        type: Sequelize.STRING(255),
        allowNull: true
      },
      email: {
        type: Sequelize.STRING(255),
        allowNull: true
      },
      phone: {
        type: Sequelize.STRING(100),
        allowNull: true
      },
      phone_secondary: {
        type: Sequelize.STRING(100),
        allowNull: true
      },
      document_type: {
        type: Sequelize.STRING(50),
        allowNull: true
      },
      document_number: {
        type: Sequelize.STRING(100),
        allowNull: true
      },
      document_verifier: {
        type: Sequelize.STRING(20),
        allowNull: true
      },
      customer_type: {
        type: Sequelize.STRING(50),
        allowNull: true
      },
      legal_name: {
        type: Sequelize.STRING(255),
        allowNull: true
      },
      receiver_name: {
        type: Sequelize.STRING(255),
        allowNull: true
      },
      invoice_required: {
        type: Sequelize.BOOLEAN,
        allowNull: true
      },
      billing_address_line: {
        type: Sequelize.STRING(255),
        allowNull: true
      },
      billing_address_line_2: {
        type: Sequelize.STRING(255),
        allowNull: true
      },
      billing_city: {
        type: Sequelize.STRING(120),
        allowNull: true
      },
      billing_municipality: {
        type: Sequelize.STRING(120),
        allowNull: true
      },
      billing_state: {
        type: Sequelize.STRING(120),
        allowNull: true
      },
      billing_state_code: {
        type: Sequelize.STRING(50),
        allowNull: true
      },
      billing_zip_code: {
        type: Sequelize.STRING(50),
        allowNull: true
      },
      billing_country_code: {
        type: Sequelize.STRING(10),
        allowNull: true
      },
      billing_comment: {
        type: Sequelize.STRING(255),
        allowNull: true
      },
      shipping_address_line: {
        type: Sequelize.STRING(255),
        allowNull: true
      },
      shipping_address_line_2: {
        type: Sequelize.STRING(255),
        allowNull: true
      },
      shipping_city: {
        type: Sequelize.STRING(120),
        allowNull: true
      },
      shipping_municipality: {
        type: Sequelize.STRING(120),
        allowNull: true
      },
      shipping_state: {
        type: Sequelize.STRING(120),
        allowNull: true
      },
      shipping_state_code: {
        type: Sequelize.STRING(50),
        allowNull: true
      },
      shipping_zip_code: {
        type: Sequelize.STRING(50),
        allowNull: true
      },
      shipping_country_code: {
        type: Sequelize.STRING(10),
        allowNull: true
      },
      shipping_comment: {
        type: Sequelize.STRING(255),
        allowNull: true
      },
      shipping_reference: {
        type: Sequelize.STRING(255),
        allowNull: true
      },
      data_completeness: {
        type: Sequelize.STRING(20),
        allowNull: true,
        defaultValue: 'partial'
      },
      source_updated_at: {
        type: Sequelize.DATE,
        allowNull: true
      },
      raw_order_payload: {
        type: Sequelize.JSON,
        allowNull: true
      },
      raw_billing_payload: {
        type: Sequelize.JSON,
        allowNull: true
      },
      raw_shipping_payload: {
        type: Sequelize.JSON,
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
    });

    await queryInterface.addIndex('marketplace_order_customers', ['order_id'], {
      unique: true,
      name: 'uniq_marketplace_order_customer_order_id'
    });
    await queryInterface.addIndex('marketplace_order_customers', ['marketplace_customer_id'], {
      name: 'idx_marketplace_order_customer_marketplace_customer_id'
    });
    await queryInterface.addIndex('marketplace_order_customers', ['document_number'], {
      name: 'idx_marketplace_order_customer_document_number'
    });
    await queryInterface.addIndex('marketplace_order_customers', ['email'], {
      name: 'idx_marketplace_order_customer_email'
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('marketplace_order_customers');
  }
};
