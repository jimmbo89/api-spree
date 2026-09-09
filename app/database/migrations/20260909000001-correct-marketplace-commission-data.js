'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE marketplace_order_fees f
      INNER JOIN marketplace_orders o ON o.id = f.order_id
      SET f.status = 'refunded'
      WHERE f.fee_type = 'commission'
        AND f.status = 'cancelled'
        AND (
          LOWER(COALESCE(o.order_status, '')) IN ('refunded')
          OR LOWER(COALESCE(o.payment_status, '')) IN ('refunded', 'charged_back')
          OR (
            COALESCE(o.total_amount, 0) > 0
            AND COALESCE(o.refunded_amount, 0) >= o.total_amount
          )
        )
    `);

    await queryInterface.sequelize.query(`
      UPDATE marketplace_order_fees f
      INNER JOIN marketplace_order_items oi ON oi.id = f.order_item_id
      SET f.percentage = ROUND((f.amount / oi.total_price) * 100, 2)
      WHERE f.fee_type = 'commission'
        AND f.order_item_id IS NOT NULL
        AND COALESCE(oi.total_price, 0) > 0
    `);
  },

  async down() {
    // No se revierten estados ni porcentajes para no sobrescribir correcciones
    // posteriores ni perder la trazabilidad financiera histórica.
  }
};
