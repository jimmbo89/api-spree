'use strict';

module.exports = {
  async up(queryInterface) {
    const orders = await queryInterface.sequelize.query(
      `SELECT id, company_id, raw_payload, order_status, payment_status
       FROM marketplace_orders WHERE raw_payload IS NOT NULL`,
      { type: queryInterface.sequelize.QueryTypes.SELECT }
    );

    for (const order of orders) {
      const raw = typeof order.raw_payload === 'string' ? JSON.parse(order.raw_payload) : order.raw_payload;
      const items = Array.isArray(raw?.order?.order_items) ? raw.order.order_items : [];
      for (const rawItem of items) {
        const saleFee = Number(rawItem?.sale_fee || 0);
        if (!Number.isFinite(saleFee) || saleFee <= 0) continue;

        const listingId = rawItem?.item?.id || rawItem?.item_id || rawItem?.id || null;
        const marketplaceItemId = rawItem?.id ? String(rawItem.id) : null;
        const itemRows = await queryInterface.sequelize.query(
          `SELECT id, total_price, company_id FROM marketplace_order_items
           WHERE order_id = :orderId AND marketplace_item_id <=> :marketplaceItemId
             AND listing_id <=> :listingId LIMIT 1`,
          { replacements: { orderId: order.id, marketplaceItemId, listingId }, type: queryInterface.sequelize.QueryTypes.SELECT }
        );
        const item = itemRows[0];
        if (!item) continue;

        const existingFees = await queryInterface.sequelize.query(
          `SELECT id FROM marketplace_order_fees
           WHERE order_item_id = :orderItemId AND fee_type = 'commission' LIMIT 1`,
          { replacements: { orderItemId: item.id }, type: queryInterface.sequelize.QueryTypes.SELECT }
        );
        if (existingFees.length) continue;

        const totalPrice = Number(item.total_price || rawItem.unit_price || 0);
        const cancelled = ['cancelled', 'refunded', 'charged_back'].includes(
          String(order.order_status || order.payment_status || '').toLowerCase()
        );
        await queryInterface.sequelize.query(
          `INSERT INTO marketplace_order_fees
           (order_id, order_item_id, fee_type, amount, percentage, status, company_id, description, raw_data, createdAt, updatedAt)
           VALUES (:orderId, :orderItemId, 'commission', :amount, :percentage, :status, :companyId, :description, :rawData, NOW(), NOW())`,
          {
            replacements: {
              orderId: order.id,
              orderItemId: item.id,
              amount: saleFee,
              percentage: totalPrice > 0 ? (saleFee / totalPrice) * 100 : 0,
              status: cancelled ? 'cancelled' : 'charged',
              companyId: item.company_id || order.company_id || null,
              description: `Comisión ML - Item ${listingId || item.id}`,
              rawData: JSON.stringify({ sale_fee: saleFee, backfilled: true })
            }
          }
        );
      }
    }
  },

  async down() {
    // Los fees históricos no se eliminan automáticamente para preservar auditoría.
  }
};
