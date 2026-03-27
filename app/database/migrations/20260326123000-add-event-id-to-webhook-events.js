'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // 1. Verificar si la columna ya existe
      const tableDescription = await queryInterface.describeTable('marketplace_webhook_events', { transaction });
      
      if (!tableDescription.event_id) {
        // Solo agregar si no existe
        await queryInterface.addColumn(
          'marketplace_webhook_events',
          'event_id',
          {
            type: Sequelize.STRING(255),
            allowNull: true
          },
          { transaction }
        );

        // Actualizar registros existentes
        await queryInterface.sequelize.query(
          "UPDATE marketplace_webhook_events SET event_id = resource WHERE event_id IS NULL",
          { transaction }
        );
      }

      // 2. Verificar y eliminar índice antiguo si existe
      const indexes = await queryInterface.showIndex('marketplace_webhook_events', { transaction });
      const oldIndex = indexes.find(idx => idx.name === 'marketplace_webhook_events_marketplace_topic_resource');
      
      if (oldIndex) {
        await queryInterface.removeIndex(
          'marketplace_webhook_events',
          'marketplace_webhook_events_marketplace_topic_resource',
          { transaction }
        );
      }

      // 3. Agregar nuevo índice único (si no existe)
      const uniqueEventIndex = indexes.find(idx => idx.name === 'marketplace_webhook_events_unique_event');
      
      if (!uniqueEventIndex) {
        await queryInterface.addIndex(
          'marketplace_webhook_events',
          ['marketplace', 'topic', 'event_id'],
          {
            unique: true,
            name: 'marketplace_webhook_events_unique_event',
            transaction
          }
        );
      }

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // 1. Eliminar el índice único de event_id (si existe)
      const indexes = await queryInterface.showIndex('marketplace_webhook_events', { transaction });
      const uniqueEventIndex = indexes.find(idx => idx.name === 'marketplace_webhook_events_unique_event');
      
      if (uniqueEventIndex) {
        await queryInterface.removeIndex(
          'marketplace_webhook_events',
          'marketplace_webhook_events_unique_event',
          { transaction }
        );
      }

      // 2. Restaurar índice original por marketplace, topic, resource
      await queryInterface.addIndex(
        'marketplace_webhook_events',
        ['marketplace', 'topic', 'resource'],
        {
          unique: true,
          name: 'marketplace_webhook_events_marketplace_topic_resource',
          transaction
        }
      );

      // 3. Eliminar columna event_id
      await queryInterface.removeColumn('marketplace_webhook_events', 'event_id', { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
};
