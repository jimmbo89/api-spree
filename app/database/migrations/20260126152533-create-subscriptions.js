// migrations/XXXXXX-create-subscriptions.js
'use strict';
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('subscriptions', {
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
      plan_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: 'plans', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT'
      },
      status: {
        type: Sequelize.STRING,
        allowNull: false,
        defaultValue: 'active', // active, past_due, expired, canceled
        validate: {
          isIn: [['active', 'past_due', 'expired', 'canceled']]
        }
      },
      start_date: {
        type: Sequelize.DATEONLY,
        allowNull: false
      },
      end_date: {
        type: Sequelize.DATEONLY,
        allowNull: true // null = vigente hasta renovación
      },
      renewal_date: {
        type: Sequelize.DATEONLY,
        allowNull: false // próxima fecha de renovación
      },
      billing_cycle: {
        type: Sequelize.STRING,
        allowNull: false,
        defaultValue: 'monthly',
        validate: {
          isIn: [['monthly', 'annual']]
        }
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
        { fields: ['plan_id'] },
        { fields: ['status'] },
        { fields: ['renewal_date'] }
      ]
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('subscriptions');
  }
};