// migrations/xxxx-create-jobs-table.js
'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('jobs', {
      id: {
         type: Sequelize.BIGINT,
          primaryKey: true,
          autoIncrement: true,  // ← Esto genera AUTO_INCREMENT en MySQL
          allowNull: false
      },
      user_id: { type: Sequelize.INTEGER, allowNull: false },
      company_id: { type: Sequelize.INTEGER, allowNull: false },
      batch_id: { type: Sequelize.UUID, allowNull: false, index: true },
      
      // Tipo y configuración
      job_type: { 
        type: Sequelize.ENUM('publish', 'draft', 'sync'),
        allowNull: false 
      },
      mode: { type: Sequelize.STRING }, // 'quick', 'advanced'
      draft_name: { type: Sequelize.STRING },
      
      // Métricas de progreso (denormalizadas para lectura rápida)
      total_products: { type: Sequelize.INTEGER, defaultValue: 0 },
      processed: { type: Sequelize.INTEGER, defaultValue: 0 },
      successful: { type: Sequelize.INTEGER, defaultValue: 0 },
      errors_count: { type: Sequelize.INTEGER, defaultValue: 0 },
      percentage: { type: Sequelize.INTEGER, defaultValue: 0 },
      
      // Estado del job
      status: { 
        type: Sequelize.ENUM('pending', 'processing', 'completed', 'failed', 'cancelled'),
        defaultValue: 'pending',
        index: true
      },
      
      // Payload de configuración (no los productos, eso va en job_products)
      config: { type: Sequelize.JSON }, // { marketplaces, pool, economic_config, etc. }
      
      // Metadata de ejecución
      started_at: { type: Sequelize.DATE },
      completed_at: { type: Sequelize.DATE },
      error_summary: { type: Sequelize.JSON }, // { message, timestamp }      
      notified_users: { type: Sequelize.JSON },
      
      createdAt: {  // ⚠️ Solo createdAt (inmutable según reqs)
        allowNull: false,
        type: Sequelize.DATE
      },
      updatedAt: {  // ⚠️ Solo createdAt (inmutable según reqs)
        allowNull: false,
        type: Sequelize.DATE
      }
    });

    // Índices para consultas frecuentes
    await queryInterface.addIndex('jobs', ['user_id', 'company_id']);
    await queryInterface.addIndex('jobs', ['status', 'createdAt']);
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('jobs');
  }
};