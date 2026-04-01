'use strict';

/**
 * Migración para crear la tabla marketplace_order_events
 * Almacena el historial de cambios de estado de cada orden
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('marketplace_order_events', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.BIGINT
      },
      order_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: {
          model: 'marketplace_orders',
          key: 'id'
        },
        comment: 'Referencia a la orden'
      },
      webhook_event_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: {
          model: 'marketplace_webhook_events',
          key: 'id'
        },
        comment: 'Evento webhook que originó este cambio (si aplica)'
      },
      
      // Tipo de evento
      event_type: {
        type: Sequelize.STRING(50),
        allowNull: false,
        comment: 'created, paid, cancelled, returned, shipped, refunded'
      },
      
      // Estado antes/después
      previous_status: {
        type: Sequelize.STRING(50),
        allowNull: true,
        comment: 'Estado anterior al evento'
      },
      new_status: {
        type: Sequelize.STRING(50),
        allowNull: true,
        comment: 'Nuevo estado después del evento'
      },
      
      // Raw payload
      raw_payload: {
        type: Sequelize.JSON,
        allowNull: true,
        comment: 'Payload completo del evento para auditoría'
      },
      
      // Metadatos adicionales
      notes: {
        type: Sequelize.TEXT,
        allowNull: true,
        comment: 'Notas adicionales del evento'
      },
      
      // Relaciones con entidades locales
      company_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: {
          model: 'companies',
          key: 'id'
        },
        comment: 'Empresa propietaria del evento'
      },
      
      // Metadatos de sistema
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
        {
          fields: ['order_id'],
          name: 'idx_order_events_order_id'
        },
        {
          fields: ['event_type'],
          name: 'idx_order_events_type'
        },
        {
          fields: ['webhook_event_id'],
          name: 'idx_order_events_webhook_id'
        },
        {
          fields: ['company_id'],
          name: 'idx_order_events_company_id'
        },
        {
          fields: ['createdAt'],
          name: 'idx_order_events_created_at'
        }
      ]
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('marketplace_order_events');
  }
};
