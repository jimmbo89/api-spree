'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('audit_events', {
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
        onDelete: 'CASCADE',
        comment: 'Empresa propietaria del evento de auditoria'
      },
      occurred_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW,
        comment: 'Fecha real en que ocurrio el evento'
      },
      module: {
        type: Sequelize.STRING(80),
        allowNull: false,
        comment: 'Modulo funcional: product, warehouse, published_product, order, etc.'
      },
      action: {
        type: Sequelize.STRING(120),
        allowNull: false,
        comment: 'Accion normalizada realizada sobre el recurso'
      },
      result: {
        type: Sequelize.STRING(30),
        allowNull: false,
        defaultValue: 'success',
        comment: 'success, error, warning, pending'
      },
      actor_type: {
        type: Sequelize.STRING(40),
        allowNull: false,
        comment: 'user, system, marketplace, automatic_process, external_integration'
      },
      actor_id: {
        type: Sequelize.STRING(100),
        allowNull: true,
        comment: 'Identificador del actor cuando exista'
      },
      actor_name: {
        type: Sequelize.STRING(255),
        allowNull: true,
        comment: 'Nombre legible del actor al momento del evento'
      },
      resource_type: {
        type: Sequelize.STRING(80),
        allowNull: false,
        comment: 'Tipo del recurso afectado'
      },
      resource_id: {
        type: Sequelize.STRING(100),
        allowNull: false,
        comment: 'Identificador del recurso afectado'
      },
      resource_label: {
        type: Sequelize.STRING(255),
        allowNull: true,
        comment: 'Etiqueta legible del recurso: SKU, nombre, numero de orden, etc.'
      },
      related_resource_type: {
        type: Sequelize.STRING(80),
        allowNull: true,
        comment: 'Tipo de recurso relacionado'
      },
      related_resource_id: {
        type: Sequelize.STRING(100),
        allowNull: true,
        comment: 'Identificador del recurso relacionado'
      },
      marketplace_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: 'marketplaces', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      marketplace_credential_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: 'marketplace_credentials', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      pool_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: 'pools', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      warehouse_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: 'warehouses', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      branch_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: 'branches', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      job_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: 'jobs', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
        comment: 'Proceso/job asociado al evento'
      },
      origin_job_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: 'jobs', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
        comment: 'Proceso que origino este proceso o reproceso'
      },
      parent_event_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: 'audit_events', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
        comment: 'Evento padre cuando este evento deriva de otro'
      },
      previous_value: {
        type: Sequelize.JSON,
        allowNull: true,
        comment: 'Valor anterior cuando la accion modifica informacion'
      },
      new_value: {
        type: Sequelize.JSON,
        allowNull: true,
        comment: 'Valor nuevo cuando la accion modifica informacion'
      },
      changes: {
        type: Sequelize.JSON,
        allowNull: true,
        comment: 'Lista de cambios: field, old_value, new_value'
      },
      description: {
        type: Sequelize.TEXT,
        allowNull: true,
        comment: 'Descripcion legible para mostrar en historiales'
      },
      metadata: {
        type: Sequelize.JSON,
        allowNull: true,
        comment: 'Datos adicionales: payloads, feed ids, errores, snapshots'
      },
      correlation_id: {
        type: Sequelize.STRING(100),
        allowNull: true,
        comment: 'Identificador para agrupar eventos de una misma operacion'
      },
      dedupe_key: {
        type: Sequelize.STRING(190),
        allowNull: true,
        unique: true,
        comment: 'Clave opcional para evitar eventos equivalentes duplicados'
      },
      ip_address: {
        type: Sequelize.STRING(45),
        allowNull: true
      },
      user_agent: {
        type: Sequelize.TEXT,
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
        { fields: ['company_id', 'occurred_at'], name: 'idx_audit_company_occurred' },
        { fields: ['company_id', 'module', 'occurred_at'], name: 'idx_audit_company_module' },
        { fields: ['company_id', 'resource_type', 'resource_id'], name: 'idx_audit_resource' },
        { fields: ['company_id', 'actor_type', 'actor_id'], name: 'idx_audit_actor' },
        { fields: ['company_id', 'marketplace_id'], name: 'idx_audit_marketplace' },
        { fields: ['company_id', 'marketplace_credential_id'], name: 'idx_audit_credential' },
        { fields: ['company_id', 'pool_id'], name: 'idx_audit_pool' },
        { fields: ['company_id', 'warehouse_id'], name: 'idx_audit_warehouse' },
        { fields: ['company_id', 'job_id'], name: 'idx_audit_job' },
        { fields: ['company_id', 'origin_job_id'], name: 'idx_audit_origin_job' },
        { fields: ['correlation_id'], name: 'idx_audit_correlation' },
        { fields: ['parent_event_id'], name: 'idx_audit_parent_event' }
      ]
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('audit_events');
  }
};
