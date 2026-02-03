'use strict';
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('sii_configurations', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.BIGINT
      },
      company_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        unique: true,
        references: { model: 'companies', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      rut: {
        type: Sequelize.STRING(12),
        allowNull: true
      },
      legal_name: {
        type: Sequelize.STRING(255),
        allowNull: true
      },
      sii_environment: {
        type: Sequelize.STRING(255), //.ENUM('production', 'certification'),
        allowNull: true,
        defaultValue: 'certification'
      },
      contributor_type: {
        type: Sequelize.STRING(50),
        allowNull: true
      },
      is_connected: {
        type: Sequelize.BOOLEAN,
        allowNull: true,
        defaultValue: false
      },
      connected_at: {
        type: Sequelize.DATE,
        allowNull: true
      },
      disconnected_at: {
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
        { fields: ['rut'] }
      ]
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('sii_configurations');
  }
};