'use strict';

/**
 * Completa cargos de orden que ya estaban disponibles en marketplace_orders
 * antes de que el reporte comenzara a tratarlos como fees independientes.
 *
 * No elimina ni reemplaza comisiones existentes. Solo crea el cargo directo
 * de la orden si todavía no existe, por lo que puede ejecutarse una sola vez
 * sin duplicar registros al reintentar la migración.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      INSERT INTO marketplace_order_fees
        (order_id, order_item_id, fee_type, amount, percentage, status,
         company_id, description, raw_data, createdAt, updatedAt)
      SELECT
        o.id,
        NULL,
        'shipping_fee',
        shipping.amount,
        NULL,
        CASE
          WHEN LOWER(COALESCE(o.order_status, '')) IN ('refunded', 'returned')
            OR LOWER(COALESCE(o.payment_status, '')) IN ('refunded', 'reimbursed', 'charged_back')
            OR (
              COALESCE(o.total_amount, 0) > 0
              AND COALESCE(o.refunded_amount, 0) >= o.total_amount
            ) THEN 'refunded'
          WHEN LOWER(COALESCE(o.order_status, '')) IN ('cancelled', 'canceled')
            OR LOWER(COALESCE(o.payment_status, '')) IN ('cancelled', 'canceled') THEN 'cancelled'
          ELSE 'charged'
        END,
        o.company_id,
        CONCAT('Costo de envío vendedor ', COALESCE(o.marketplace, 'marketplace'), ' - Orden ', o.marketplace_order_id),
        JSON_OBJECT(
          'backfilled', TRUE,
          'source', 'marketplace_orders.shipping_total',
          'shipment_id', o.shipment_id
        ),
        NOW(),
        NOW()
      FROM marketplace_orders o
      JOIN (
        SELECT
          id,
          COALESCE(
            NULLIF(shipping_total, 0),
            CAST(JSON_UNQUOTE(JSON_EXTRACT(raw_payload, '$.shipping_financials.seller_cost')) AS DECIMAL(12, 2)),
            0
          ) AS amount
        FROM marketplace_orders
      ) shipping ON shipping.id = o.id
      WHERE shipping.amount > 0
        AND NOT EXISTS (
          SELECT 1
          FROM marketplace_order_fees existing_fee
          WHERE existing_fee.order_id = o.id
            AND existing_fee.order_item_id IS NULL
            AND existing_fee.fee_type = 'shipping_fee'
        )
    `);

    // Mercado Libre entrega descuentos financiados por el marketplace en el
    // snapshot histórico. Se conserva como bonificación negativa dentro de
    // "other" para que reduzca el total de cargos sin confundirse con la
    // comisión o el envío.
    await queryInterface.sequelize.query(`
      INSERT INTO marketplace_order_fees
        (order_id, order_item_id, fee_type, amount, percentage, status,
         company_id, description, raw_data, createdAt, updatedAt)
      SELECT
        o.id,
        NULL,
        'other',
        -ABS(CAST(JSON_UNQUOTE(JSON_EXTRACT(raw_payload, '$.discount_financials.marketplace_amount')) AS DECIMAL(12, 2))),
        NULL,
        CASE
          WHEN LOWER(COALESCE(o.order_status, '')) IN ('refunded', 'returned')
            OR LOWER(COALESCE(o.payment_status, '')) IN ('refunded', 'reimbursed', 'charged_back')
            OR (
              COALESCE(o.total_amount, 0) > 0
              AND COALESCE(o.refunded_amount, 0) >= o.total_amount
            ) THEN 'refunded'
          WHEN LOWER(COALESCE(o.order_status, '')) IN ('cancelled', 'canceled')
            OR LOWER(COALESCE(o.payment_status, '')) IN ('cancelled', 'canceled') THEN 'cancelled'
          ELSE 'charged'
        END,
        o.company_id,
        CONCAT('Bonificación marketplace ', COALESCE(o.marketplace, 'marketplace'), ' - Orden ', o.marketplace_order_id),
        JSON_OBJECT(
          'backfilled', TRUE,
          'source', 'raw_payload.discount_financials.marketplace_amount'
        ),
        NOW(),
        NOW()
      FROM marketplace_orders o
      WHERE CAST(JSON_UNQUOTE(JSON_EXTRACT(raw_payload, '$.discount_financials.marketplace_amount')) AS DECIMAL(12, 2)) > 0
        AND NOT EXISTS (
          SELECT 1
          FROM marketplace_order_fees existing_fee
          WHERE existing_fee.order_id = o.id
            AND existing_fee.order_item_id IS NULL
            AND existing_fee.fee_type = 'other'
            AND JSON_UNQUOTE(JSON_EXTRACT(existing_fee.raw_data, '$.source')) = 'raw_payload.discount_financials.marketplace_amount'
        )
    `);
  },

  async down() {
    // No se eliminan cargos históricos automáticamente: forman parte de la
    // trazabilidad financiera y pueden coexistir con cargos nuevos.
  }
};
