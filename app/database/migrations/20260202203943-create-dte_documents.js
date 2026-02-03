// migrations/20260203130000-create-dte-documents.js
'use strict';
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('dte_documents', {
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
      document_type: {
        type: Sequelize.STRING,
        allowNull: true,
        comment: '33=Factura, 39=Boleta, 61=Nota de Crédito'
      },
      folio: {
        type: Sequelize.INTEGER,
        allowNull: true
      },
      rut_emisor: {
        type: Sequelize.STRING,
        allowNull: true
      },
      rut_receptor: {
        type: Sequelize.STRING,
        allowNull: true
      },
      razon_social_receptor: {
        type: Sequelize.STRING,
        allowNull: true
      },
      giro_receptor: {
        type: Sequelize.STRING,
        allowNull: true
      },
      direccion_receptor: {
        type: Sequelize.STRING,
        allowNull: true
      },
      comuna_receptor: {
        type: Sequelize.STRING,
        allowNull: true
      },
      ciudad_receptor: {
        type: Sequelize.STRING,
        allowNull: true
      },
      monto_neto: {
        type: Sequelize.DECIMAL(16, 2),
        allowNull: true
      },
      monto_iva: {
        type: Sequelize.DECIMAL(16, 2),
        allowNull: true
      },
      monto_total: {
        type: Sequelize.DECIMAL(16, 2),
        allowNull: true
      },
      fecha_emision: {
        type: Sequelize.DATEONLY,
        allowNull: true
      },
      sii_status: {
        type: Sequelize.STRING,
        allowNull: true,
        defaultValue: 'pendiente',
        comment: 'pendiente, enviado, aceptado, rechazado'
      },
      track_id: {
        type: Sequelize.STRING,
        allowNull: true
      },
      sii_response: {
        type: Sequelize.TEXT('long'),
        allowNull: true
      },
      sii_error_code: {
        type: Sequelize.STRING,
        allowNull: true
      },
      sii_error_message: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      xml_dte: {
        type: Sequelize.TEXT('long'),
        allowNull: true
      },
      xml_envio: {
        type: Sequelize.TEXT('long'),
        allowNull: true
      },
      referenced_document_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: 'dte_documents', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      detalles: {
        type: Sequelize.JSON,
        allowNull: true
      },
      order_id: {
        type: Sequelize.BIGINT,
        allowNull: true
      },
      order_type: {
        type: Sequelize.STRING,
        allowNull: true,
        comment: 'marketplace, spree, manual'
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
        { fields: ['document_type', 'folio'] },
        { fields: ['company_id', 'document_type', 'folio'], unique: true },
        { fields: ['rut_emisor'] },
        { fields: ['rut_receptor'] },
        { fields: ['fecha_emision'] },
        { fields: ['sii_status'] },
        { fields: ['track_id'] },
        { fields: ['referenced_document_id'] }
      ]
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('dte_documents');
  }
};