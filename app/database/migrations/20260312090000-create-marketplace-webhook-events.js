'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('marketplace_webhook_events', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.BIGINT
      },
      marketplace: {
        type: Sequelize.STRING(50),
        allowNull: false
      },
      topic: {
        type: Sequelize.STRING(50),
        allowNull: false
      },
      resource: {
        type: Sequelize.STRING(255),
        allowNull: false
      },
      external_id: {
        type: Sequelize.STRING(100),
        allowNull: true
      },
      marketplace_user_id: {
        type: Sequelize.STRING(100),
        allowNull: true
      },
      status: {
        type: Sequelize.STRING(30),
        allowNull: false,
        defaultValue: 'received'
      },
      payload: {
        type: Sequelize.JSON,
        allowNull: true
      },
      error_message: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      processed_at: {
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
        { unique: true, fields: ['marketplace', 'topic', 'resource'] },
        { fields: ['external_id'] },
        { fields: ['marketplace_user_id'] },
        { fields: ['createdAt'] }
      ]
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('marketplace_webhook_events');
  }
};
