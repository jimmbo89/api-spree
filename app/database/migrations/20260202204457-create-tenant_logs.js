// migrations/20260203140000-create-tenant-logs.js
'use strict';
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('tenant_logs', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.BIGINT
      },
      company_id: {  // 🔑 Obligatorio para aislamiento
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: 'companies', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      user_id: {  // Usuario del tenant (no del sistema global)
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      module: {  // 'sii', 'configuracion', 'documentos', 'notificaciones'
        type: Sequelize.STRING,
        allowNull: true
      },
      event_type: {  // 'create', 'update', 'delete', 'error', 'success'
        type: Sequelize.STRING,
        allowNull: true
      },
      action: {
        type: Sequelize.STRING,
        allowNull: true
      },
      description: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      meta: {  // Reemplaza metadata + detalles específicos
        type: Sequelize.JSON,
        allowNull: true
      },
      ip_address: {
        type: Sequelize.STRING,
        allowNull: true
      },
      user_agent: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      result: {  // 'success', 'error', 'warning'
        type: Sequelize.STRING,
        allowNull: true,
        defaultValue: 'success'
      },
      error_message: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      createdAt: {  // ⚠️ Solo createdAt (inmutable según reqs)
        allowNull: false,
        type: Sequelize.DATE
      },
      updatedAt: {  // ⚠️ Solo createdAt (inmutable según reqs)
        allowNull: false,
        type: Sequelize.DATE
      }
    }, {
      indexes: [
        { fields: ['company_id'] },
        { fields: ['company_id', 'createdAt'] },  // Óptimo para queries por tenant
        { fields: ['company_id', 'module'] },
        { fields: ['company_id', 'result'] },
        { fields: ['createdAt'] }  // Para purga global si aplica
      ]
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('tenant_logs');
  }
};