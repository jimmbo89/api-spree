'use strict';

async function hasIndex(queryInterface, tableName, indexName, transaction) {
  const indexes = await queryInterface.showIndex(tableName, { transaction });
  return indexes.some((index) => index.name === indexName);
}

async function hasUniqueIndexForFields(queryInterface, tableName, fields, transaction) {
  const indexes = await queryInterface.showIndex(tableName, { transaction });
  return indexes.some((index) => (
    index.unique === true &&
    Array.isArray(index.fields) &&
    index.fields.length === fields.length &&
    index.fields.every((field, indexPosition) => field.attribute === fields[indexPosition])
  ));
}

async function cleanDuplicates(queryInterface, tableName, fields, pk = 'id', transaction) {
  const joinConditions = fields.map((f) => `t1.\`${f}\` = t2.\`${f}\``).join(' AND ');

  await queryInterface.sequelize.query('SET FOREIGN_KEY_CHECKS = 0', { transaction });

  try {
    await queryInterface.sequelize.query(`
      DELETE t1 FROM \`${tableName}\` t1
      INNER JOIN \`${tableName}\` t2
      WHERE
        t1.\`${pk}\` > t2.\`${pk}\` AND
        ${joinConditions}
    `, { transaction });
  } finally {
    await queryInterface.sequelize.query('SET FOREIGN_KEY_CHECKS = 1', { transaction });
  }
}

async function assertNoDuplicates(queryInterface, tableName, fields, transaction) {
  const columns = fields.map((field) => `\`${field}\``).join(', ');
  const rows = await queryInterface.sequelize.query(`
    SELECT ${columns}, COUNT(*) AS duplicate_count
    FROM \`${tableName}\`
    GROUP BY ${columns}
    HAVING COUNT(*) > 1
    LIMIT 10
  `, {
    type: queryInterface.sequelize.QueryTypes.SELECT,
    transaction
  });

  if (rows.length) {
    throw new Error(
      `No se puede crear índice único ${tableName}(${fields.join(', ')}). ` +
      `Existen duplicados que requieren consolidación controlada: ${JSON.stringify(rows)}`
    );
  }
}

module.exports = {
  async up(queryInterface) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      await cleanDuplicates(
        queryInterface,
        'marketplace_orders',
        ['marketplace', 'marketplace_order_id'],
        'id',
        transaction
      );

      await assertNoDuplicates(
        queryInterface,
        'marketplace_orders',
        ['marketplace', 'marketplace_order_id'],
        transaction
      );

      if (!await hasUniqueIndexForFields(
        queryInterface,
        'marketplace_orders',
        ['marketplace', 'marketplace_order_id'],
        transaction
      )) {
        await queryInterface.addIndex(
          'marketplace_orders',
          ['marketplace', 'marketplace_order_id'],
          { name: 'marketplace_orders_unique_identity_idempotency', unique: true, transaction }
        );
      }

      if (!await hasUniqueIndexForFields(
        queryInterface,
        'marketplace_webhook_events',
        ['marketplace', 'topic', 'event_id'],
        transaction
      )) {
        await queryInterface.addIndex(
          'marketplace_webhook_events',
          ['marketplace', 'topic', 'event_id'],
          { name: 'marketplace_webhook_events_unique_event_idempotency', unique: true, transaction }
        );
      }

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  async down(queryInterface) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      if (await hasIndex(queryInterface, 'marketplace_webhook_events', 'marketplace_webhook_events_unique_event_idempotency', transaction)) {
        await queryInterface.removeIndex('marketplace_webhook_events', 'marketplace_webhook_events_unique_event_idempotency', { transaction });
      }
      if (await hasIndex(queryInterface, 'marketplace_orders', 'marketplace_orders_unique_identity_idempotency', transaction)) {
        await queryInterface.removeIndex('marketplace_orders', 'marketplace_orders_unique_identity_idempotency', { transaction });
      }
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
};