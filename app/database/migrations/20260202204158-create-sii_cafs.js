// migrations/20260203130001-create-sii-cafs.js
'use strict';
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('sii_cafs', {
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
      certificate_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: 'sii_certificates', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      document_type: {
        type: Sequelize.STRING,
        allowNull: true,
        comment: '33, 39, 61'
      },
      folio_start: {
        type: Sequelize.INTEGER,
        allowNull: true
      },
      folio_end: {
        type: Sequelize.INTEGER,
        allowNull: true
      },
      folio_next: {
        type: Sequelize.INTEGER,
        allowNull: true
      },
      issue_date: {
        type: Sequelize.DATEONLY,
        allowNull: true
      },
      expiration_date: {
        type: Sequelize.DATEONLY,
        allowNull: true
      },
      caf_xml: {
        type: Sequelize.TEXT('long'),
        allowNull: true
      },
      private_key: {
        type: Sequelize.TEXT('long'),
        allowNull: true
      },
      is_active: {
        type: Sequelize.BOOLEAN,
        allowNull: true,
        defaultValue: true
      },
      is_exhausted: {
        type: Sequelize.BOOLEAN,
        allowNull: true,
        defaultValue: false
      },
      used_count: {
        type: Sequelize.INTEGER,
        allowNull: true,
        defaultValue: 0
      },
      remaining_count: {
        type: Sequelize.INTEGER,
        allowNull: true,
        defaultValue: 0
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
        { fields: ['certificate_id'] },
        { fields: ['document_type'] },
        { fields: ['company_id', 'document_type', 'is_active'] },
        { fields: ['is_active'] },
        { fields: ['expiration_date'] }
      ]
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('sii_cafs');
  }
};