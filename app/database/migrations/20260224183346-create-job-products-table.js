// migrations/xxxx-create-job-products-table.js
'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('job_products', {
      id: {
        type: Sequelize.BIGINT,
        primaryKey: true,
        autoIncrement: true,  // ← Esto genera AUTO_INCREMENT en MySQL
        allowNull: false
      },
      job_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: 'jobs', key: 'id' },
        onDelete: 'CASCADE',
        index: true
      },
      product_id: { type: Sequelize.BIGINT, allowNull: false },
      credential_id: { type: Sequelize.BIGINT }, // Para tracking por credencial
      marketplace_id: { type: Sequelize.BIGINT, allowNull: false },
      
      // Estado individual del producto
      status: {
        type: Sequelize.STRING(100), //ENUM('pending', 'processing', 'success', 'error', 'retrying')
        allowNull: false,
        defaultValue: 'pending'
      },
      
      // Resultado
      external_id: { type: Sequelize.STRING }, // ID en MercadoLibre
      external_url: { type: Sequelize.STRING },
      error_message: { type: Sequelize.TEXT },
      error_details: { type: Sequelize.JSON }, // { code, response, etc. }
      
      // Intentos
      attempt_count: { type: Sequelize.INTEGER, defaultValue: 0 },
      last_attempt_at: { type: Sequelize.DATE },
      
      // Payload original (para reintentar sin volver a consultar)
      product_payload: { type: Sequelize.JSON },
      marketplace_payload: { type: Sequelize.JSON },
      
      createdAt: {  // ⚠️ Solo createdAt (inmutable según reqs)
        allowNull: false,
        type: Sequelize.DATE
      },
      updatedAt: {  // ⚠️ Solo createdAt (inmutable según reqs)
        allowNull: false,
        type: Sequelize.DATE
      }
    });

    // Índice compuesto para consultas por job + estado
    await queryInterface.addIndex('job_products', ['job_id', 'status']);
    await queryInterface.addIndex('job_products', ['product_id', 'marketplace_id', 'credential_id']);
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('job_products');
  }
};