'use strict';
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('feature_flags', {
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
      flag_key: {
        type: Sequelize.STRING(50),
        allowNull: true
      },
      is_enabled: {
        type: Sequelize.BOOLEAN,
        allowNull: true,
        defaultValue: false
      },
      source: {
        type: Sequelize.STRING(255), //.ENUM('plan', 'backoffice', 'manual'),
        allowNull: false,
        defaultValue: 'plan'
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
        { fields: ['flag_key'] },
        { fields: ['company_id', 'flag_key'], unique: true }
      ]
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('feature_flags');
  }
};