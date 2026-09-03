'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('marketplace_orders', 'refunded_amount', {
      type: Sequelize.DECIMAL(12, 2),
      allowNull: false,
      defaultValue: 0
    });
    await queryInterface.addIndex('marketplace_orders', ['refunded_amount'], {
      name: 'idx_marketplace_orders_refunded_amount'
    });
    await queryInterface.sequelize.query(`
      UPDATE marketplace_orders
      SET refunded_amount = COALESCE((
        SELECT SUM(CAST(JSON_UNQUOTE(JSON_EXTRACT(payment.value, '$.transaction_amount_refunded')) AS DECIMAL(12,2)))
        FROM JSON_TABLE(
          JSON_EXTRACT(marketplace_orders.raw_payload, '$.order.payments'),
          '$[*]' COLUMNS (value JSON PATH '$')
        ) payment
      ), 0)
      WHERE raw_payload IS NOT NULL
    `);
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('marketplace_orders', 'idx_marketplace_orders_refunded_amount');
    await queryInterface.removeColumn('marketplace_orders', 'refunded_amount');
  }
};
