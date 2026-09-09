const { sequelize } = require('../models');
const { getDateOnlyBounds, formatLocalSqlDateTime } = require('../utils/dateRange');

const ACTIVE_FEE_CONDITION = `LOWER(COALESCE(f.status, '')) NOT IN (
  'cancelled', 'canceled', 'refunded', 'reimbursed', 'charged_back'
)`;

function toMoney(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount)
    ? Math.round((amount + Number.EPSILON) * 100) / 100
    : 0;
}

function refundedAmountExpression(alias = 'o') {
  return `COALESCE(NULLIF(${alias}.refunded_amount, 0), (
    SELECT COALESCE(SUM(CAST(JSON_UNQUOTE(JSON_EXTRACT(payment.value, '$.transaction_amount_refunded')) AS DECIMAL(12,2))), 0)
    FROM JSON_TABLE(
      JSON_EXTRACT(${alias}.raw_payload, '$.order.payments'),
      '$[*]' COLUMNS (value JSON PATH '$')
    ) payment
  ), 0)`;
}

function netRevenueExpression(alias = 'o') {
  return `GREATEST(COALESCE(${alias}.total_amount, 0) - (${refundedAmountExpression(alias)}), 0)`;
}

function buildDateConditions(from, to, alias = 'o') {
  const conditions = [];
  const replacements = {};
  const { start, endExclusive } = getDateOnlyBounds(from, to);
  const field = `COALESCE(${alias}.sale_date, ${alias}.createdAt)`;

  if (start) {
    conditions.push(`${field} >= :from`);
    replacements.from = formatLocalSqlDateTime(start);
  }

  if (endExclusive) {
    conditions.push(`${field} < :to`);
    replacements.to = formatLocalSqlDateTime(endExclusive);
  }

  return { conditions, replacements };
}

function buildValidOrderCondition(alias = 'o') {
  return `(
    LOWER(COALESCE(${alias}.order_status, '')) NOT IN ('cancelled', 'returned', 'refunded')
    AND LOWER(COALESCE(${alias}.payment_status, '')) NOT IN ('cancelled', 'refunded', 'charged_back')
    AND NOT (
      COALESCE(${alias}.total_amount, 0) > 0
      AND (${refundedAmountExpression(alias)}) >= ${alias}.total_amount
    )
    AND (
      LOWER(COALESCE(${alias}.order_status, '')) IN ('paid', 'shipped', 'delivered')
      OR LOWER(COALESCE(${alias}.payment_status, '')) IN ('paid', 'approved', 'authorized')
    )
  )`;
}

function buildOrderConditions(filters = {}, options = {}) {
  const {
    from,
    to,
    marketplace,
    company_id,
    user_id,
    status,
    orderIds
  } = filters;
  const {
    validOnly = true
  } = options;
  const conditions = [];
  const replacements = {};

  const dateFilter = buildDateConditions(from, to);
  conditions.push(...dateFilter.conditions);
  Object.assign(replacements, dateFilter.replacements);

  if (marketplace && marketplace !== 'all') {
    conditions.push('o.marketplace_credential_id = :marketplace');
    replacements.marketplace = marketplace;
  }

  if (company_id) {
    conditions.push('o.company_id = :company_id');
    replacements.company_id = company_id;
  }

  if (user_id) {
    conditions.push('o.user_id = :user_id');
    replacements.user_id = user_id;
  }

  if (status && status !== 'all') {
    conditions.push('o.order_status = :order_status');
    replacements.order_status = status;
  }

  if (Array.isArray(orderIds)) {
    if (orderIds.length === 0) {
      conditions.push('1 = 0');
    } else {
      conditions.push('o.id IN (:order_ids)');
      replacements.order_ids = orderIds;
    }
  }

  if (validOnly) {
    conditions.push(buildValidOrderCondition('o'));
  }

  return {
    whereClause: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    replacements
  };
}

function buildNormalizedFinancialCtes() {
  const netRevenue = netRevenueExpression('o');
  const shippingAmount = `CASE
    WHEN o.shipment_id IS NULL OR o.id = (
      SELECT MIN(shipment_order.id)
      FROM marketplace_orders shipment_order
      WHERE shipment_order.shipment_id = o.shipment_id
    ) THEN CASE
      WHEN COALESCE(fa.active_shipping_fee_count, 0) > 0
        THEN COALESCE(fa.shipping_amount, 0)
      ELSE COALESCE(
        NULLIF(o.shipping_total, 0),
        CAST(JSON_UNQUOTE(JSON_EXTRACT(o.raw_payload, '$.shipping_financials.seller_cost')) AS DECIMAL(12, 2)),
        0
      )
    END
    ELSE 0
  END`;

  return `
WITH item_agg AS (
  SELECT
    order_id,
    COALESCE(SUM(COALESCE(total_cost, 0)), 0) AS product_cost,
    COALESCE(SUM(total_price), 0) AS item_revenue
  FROM marketplace_order_items
  GROUP BY order_id
),
item_fee_agg AS (
  SELECT
    f.order_item_id,
    COALESCE(SUM(CASE
      WHEN f.fee_type = 'commission' AND ${ACTIVE_FEE_CONDITION}
      THEN f.amount ELSE 0 END), 0) AS commission_amount,
    SUM(CASE
      WHEN f.fee_type = 'commission' AND ${ACTIVE_FEE_CONDITION}
      THEN 1 ELSE 0 END) AS commission_count,
    COALESCE(SUM(CASE
      WHEN f.fee_type NOT IN ('commission', 'shipping_fee') AND ${ACTIVE_FEE_CONDITION}
      THEN f.amount ELSE 0 END), 0) AS other_charges
  FROM marketplace_order_fees f
  WHERE f.order_item_id IS NOT NULL
  GROUP BY f.order_item_id
),
fee_agg AS (
  SELECT
    f.order_id,
    COALESCE(SUM(CASE
      WHEN f.fee_type = 'commission'
        AND f.order_item_id IS NOT NULL
        AND ${ACTIVE_FEE_CONDITION}
      THEN f.amount ELSE 0 END), 0) AS item_commission_amount,
    COALESCE(SUM(CASE
      WHEN f.fee_type = 'commission'
        AND f.order_item_id IS NULL
        AND ${ACTIVE_FEE_CONDITION}
      THEN f.amount ELSE 0 END), 0) AS order_commission_amount,
    SUM(CASE
      WHEN f.fee_type = 'commission'
        AND f.order_item_id IS NOT NULL
        AND ${ACTIVE_FEE_CONDITION}
      THEN 1 ELSE 0 END) AS active_item_commission_count,
    COALESCE(SUM(CASE
      WHEN f.fee_type = 'shipping_fee'
        AND ${ACTIVE_FEE_CONDITION}
      THEN f.amount ELSE 0 END), 0) AS shipping_amount,
    SUM(CASE
      WHEN f.fee_type = 'shipping_fee'
        AND ${ACTIVE_FEE_CONDITION}
      THEN 1 ELSE 0 END) AS active_shipping_fee_count,
    COALESCE(SUM(CASE
      WHEN f.fee_type NOT IN ('commission', 'shipping_fee')
        AND f.order_item_id IS NOT NULL
        AND ${ACTIVE_FEE_CONDITION}
      THEN f.amount ELSE 0 END), 0) AS item_other_charges,
    COALESCE(SUM(CASE
      WHEN f.fee_type NOT IN ('commission', 'shipping_fee')
        AND f.order_item_id IS NULL
        AND ${ACTIVE_FEE_CONDITION}
      THEN f.amount ELSE 0 END), 0) AS order_other_charges
  FROM marketplace_order_fees f
  GROUP BY f.order_id
),
order_financials AS (
  SELECT
    o.id AS order_id,
    o.marketplace,
    o.marketplace_credential_id,
    o.marketplace_order_id AS order_ref,
    COALESCE(o.sale_date, o.createdAt) AS sale_date,
    o.currency,
    o.total_amount AS gross_revenue,
    ${netRevenue} AS net_revenue,
    ${refundedAmountExpression('o')} AS refunded_amount,
    COALESCE(ia.product_cost, 0) AS product_cost,
    CASE
      WHEN COALESCE(fa.active_item_commission_count, 0) > 0
        THEN COALESCE(fa.item_commission_amount, 0)
      ELSE COALESCE(fa.order_commission_amount, 0)
    END AS commission,
    CASE
      WHEN COALESCE(fa.active_item_commission_count, 0) > 0 THEN 1
      ELSE 0
    END AS commission_uses_items,
    ${shippingAmount} AS shipping,
    COALESCE(fa.item_other_charges, 0) + COALESCE(fa.order_other_charges, 0) AS other_charges,
    COALESCE(fa.item_other_charges, 0) AS item_other_charges,
    COALESCE(fa.order_other_charges, 0) AS order_other_charges,
    COALESCE(ia.item_revenue, 0) AS item_revenue,
    o.company_id,
    o.user_id
  FROM marketplace_orders o
  LEFT JOIN item_agg ia ON ia.order_id = o.id
  LEFT JOIN fee_agg fa ON fa.order_id = o.id
  {{WHERE_CLAUSE}}
)
`;
}

function buildQuery(filters = {}, options = {}) {
  const { whereClause, replacements } = buildOrderConditions(filters, options);
  // Use a replacement function because the SQL contains JSON paths such as
  // `'$'`; String.replace treats `$'` specially when the replacement is a string.
  const ctes = buildNormalizedFinancialCtes().replace('{{WHERE_CLAUSE}}', () => whereClause);
  return { ctes, replacements };
}

function normalizeRow(row) {
  const revenue = Number(row.net_revenue || 0);
  const commission = Number(row.commission || 0);
  const shipping = Number(row.shipping || 0);
  const otherCharges = Number(row.other_charges || 0);
  const productCost = Number(row.product_cost || 0);
  const estimatedProfit = revenue - commission - shipping - otherCharges - productCost;

  return {
    orderId: row.order_id,
    marketplace: row.marketplace,
    marketplaceCredentialId: row.marketplace_credential_id,
    orderRef: row.order_ref,
    date: row.sale_date,
    currency: row.currency,
    grossRevenue: toMoney(row.gross_revenue),
    revenue: toMoney(revenue),
    refundedAmount: toMoney(row.refunded_amount),
    commission: toMoney(commission),
    shipping: toMoney(shipping),
    otherCharges: toMoney(otherCharges),
    productCost: toMoney(productCost),
    estimatedProfit: toMoney(estimatedProfit),
    margin: revenue > 0 ? toMoney((estimatedProfit / revenue) * 100) : 0
  };
}

async function getOrderFinancialRows(filters = {}, pagination = {}, options = {}) {
  const { ctes, replacements } = buildQuery(filters, options);
  const limit = Number.isInteger(Number(pagination.limit)) && Number(pagination.limit) >= 0
    ? Number(pagination.limit)
    : null;
  const offset = Number.isInteger(Number(pagination.offset)) && Number(pagination.offset) >= 0
    ? Number(pagination.offset)
    : 0;
  const paginationClause = limit === null ? '' : 'LIMIT :limit OFFSET :offset';

  const rows = await sequelize.query(`
    ${ctes}
    SELECT
      order_id,
      marketplace,
      marketplace_credential_id,
      order_ref,
      sale_date,
      currency,
      gross_revenue,
      net_revenue,
      refunded_amount,
      product_cost,
      commission,
      shipping,
      other_charges,
      item_revenue,
      net_revenue - commission - shipping - other_charges - product_cost AS estimated_profit,
      CASE
        WHEN net_revenue > 0
          THEN ((net_revenue - commission - shipping - other_charges - product_cost) / net_revenue) * 100
        ELSE 0
      END AS margin_percentage
    FROM order_financials
    ORDER BY sale_date DESC, order_id DESC
    ${paginationClause}
  `, {
    type: sequelize.QueryTypes.SELECT,
    replacements: limit === null
      ? replacements
      : { ...replacements, limit, offset }
  });

  return rows.map(normalizeRow);
}

async function getFinancialSummary(filters = {}, options = {}) {
  const { ctes, replacements } = buildQuery(filters, options);
  const [row] = await sequelize.query(`
    ${ctes}
    SELECT
      COUNT(*) AS total_orders,
      COALESCE(SUM(gross_revenue), 0) AS gross_revenue,
      COALESCE(SUM(net_revenue), 0) AS total_revenue,
      COALESCE(SUM(product_cost), 0) AS total_product_cost,
      COALESCE(SUM(commission), 0) AS total_commissions,
      COALESCE(SUM(shipping), 0) AS total_shipping,
      COALESCE(SUM(other_charges), 0) AS total_other_charges,
      COALESCE(SUM(net_revenue - commission - shipping - other_charges - product_cost), 0) AS estimated_profit
    FROM order_financials
  `, {
    type: sequelize.QueryTypes.SELECT,
    replacements
  });

  const totalRevenue = Number(row?.total_revenue || 0);
  const estimatedProfit = Number(row?.estimated_profit || 0);

  return {
    totalOrders: Number(row?.total_orders || 0),
    grossRevenue: toMoney(row?.gross_revenue),
    totalRevenue: toMoney(totalRevenue),
    totalProductCost: toMoney(row?.total_product_cost),
    totalCommissions: toMoney(row?.total_commissions),
    totalShipping: toMoney(row?.total_shipping),
    totalOtherCharges: toMoney(row?.total_other_charges),
    estimatedProfit: toMoney(estimatedProfit),
    marginPercentage: totalRevenue > 0 ? toMoney((estimatedProfit / totalRevenue) * 100) : 0
  };
}

async function getMarketplaceSummary(filters = {}, options = {}) {
  const { ctes, replacements } = buildQuery(filters, options);
  const rows = await sequelize.query(`
    ${ctes}
    SELECT
      marketplace_credential_id AS marketplace,
      COALESCE(SUM(net_revenue), 0) AS revenue,
      COALESCE(SUM(product_cost), 0) AS product_cost,
      COALESCE(SUM(commission), 0) AS commissions,
      COALESCE(SUM(shipping), 0) AS shipping,
      COALESCE(SUM(other_charges), 0) AS other_charges,
      COALESCE(SUM(net_revenue - commission - shipping - other_charges - product_cost), 0) AS profit
    FROM order_financials
    GROUP BY marketplace_credential_id
    ORDER BY profit DESC, marketplace_credential_id
  `, {
    type: sequelize.QueryTypes.SELECT,
    replacements
  });

  return rows.map((row) => {
    const revenue = Number(row.revenue || 0);
    const profit = Number(row.profit || 0);
    const commissions = toMoney(row.commissions);

    return {
      marketplace: row.marketplace,
      revenue: toMoney(revenue),
      cost: toMoney(row.product_cost),
      productCost: toMoney(row.product_cost),
      shippingCost: toMoney(row.shipping),
      commissions,
      fees: commissions,
      otherCharges: toMoney(row.other_charges),
      profit: toMoney(profit),
      margin: revenue > 0 ? toMoney((profit / revenue) * 100) : 0
    };
  });
}

async function getProductSummary(filters = {}, options = {}) {
  const { ctes, replacements } = buildQuery(filters, options);
  const rows = await sequelize.query(`
    ${ctes}
    SELECT
      p.id AS product_id,
      COALESCE(p.name, oi.title, oi.sku, oi.listing_id) AS product_name,
      COALESCE(p.sku, oi.sku) AS product_sku,
      oi.listing_id,
      SUM(oi.quantity) AS qty_sold,
      COALESCE(SUM(
        CASE WHEN COALESCE(ofn.gross_revenue, 0) > 0
          THEN oi.total_price * ofn.net_revenue / ofn.gross_revenue
          ELSE 0
        END
      ), 0) AS revenue,
      COALESCE(SUM(COALESCE(oi.total_cost, 0)), 0) AS product_cost,
      COALESCE(SUM(
        CASE
          WHEN COALESCE(ifa.commission_count, 0) > 0
            THEN COALESCE(ifa.commission_amount, 0)
          WHEN COALESCE(ofn.commission_uses_items, 0) = 0
            AND COALESCE(ofn.item_revenue, 0) > 0
            THEN ofn.commission * oi.total_price / ofn.item_revenue
          ELSE 0
        END
      ), 0) AS commissions,
      COALESCE(SUM(
        CASE WHEN COALESCE(ofn.item_revenue, 0) > 0
          THEN ofn.shipping * oi.total_price / ofn.item_revenue
          ELSE 0
        END
      ), 0) AS shipping,
      COALESCE(SUM(
        COALESCE(ifa.other_charges, 0)
        + CASE WHEN COALESCE(ofn.item_revenue, 0) > 0
          THEN ofn.order_other_charges * oi.total_price / ofn.item_revenue
          ELSE 0
        END
      ), 0) AS other_charges,
      COALESCE(SUM(
        CASE WHEN COALESCE(ofn.gross_revenue, 0) > 0
          THEN oi.total_price * ofn.net_revenue / ofn.gross_revenue
          ELSE 0
        END
      ), 0)
        - COALESCE(SUM(COALESCE(oi.total_cost, 0)), 0)
        - COALESCE(SUM(
          CASE
            WHEN COALESCE(ifa.commission_count, 0) > 0
              THEN COALESCE(ifa.commission_amount, 0)
            WHEN COALESCE(ofn.commission_uses_items, 0) = 0
              AND COALESCE(ofn.item_revenue, 0) > 0
              THEN ofn.commission * oi.total_price / ofn.item_revenue
            ELSE 0
          END
        ), 0)
        - COALESCE(SUM(
          CASE WHEN COALESCE(ofn.item_revenue, 0) > 0
            THEN ofn.shipping * oi.total_price / ofn.item_revenue
            ELSE 0
          END
        ), 0)
        - COALESCE(SUM(
          COALESCE(ifa.other_charges, 0)
          + CASE WHEN COALESCE(ofn.item_revenue, 0) > 0
            THEN ofn.order_other_charges * oi.total_price / ofn.item_revenue
            ELSE 0
          END
        ), 0) AS profit
    FROM order_financials ofn
    JOIN marketplace_order_items oi ON oi.order_id = ofn.order_id
    LEFT JOIN item_fee_agg ifa ON ifa.order_item_id = oi.id
    LEFT JOIN products p ON oi.product_id = p.id
    GROUP BY p.id, p.name, p.sku, oi.title, oi.sku, oi.listing_id
    ORDER BY profit DESC
    LIMIT :limit
  `, {
    type: sequelize.QueryTypes.SELECT,
    replacements: {
      ...replacements,
      limit: Number.isInteger(Number(options.limit)) && Number(options.limit) >= 0
        ? Number(options.limit)
        : 20
    }
  });

  return rows.map((row) => {
    const revenue = Number(row.revenue || 0);
    const profit = Number(row.profit || 0);
    const commissions = toMoney(row.commissions);

    return {
      product_id: row.product_id,
      product_name: row.product_name,
      product_sku: row.product_sku,
      listing_id: row.listing_id,
      qty_sold: Number(row.qty_sold || 0),
      revenue: toMoney(revenue),
      cost: toMoney(row.product_cost),
      productCost: toMoney(row.product_cost),
      commissions,
      fees: commissions,
      shippingCost: toMoney(row.shipping),
      otherCharges: toMoney(row.other_charges),
      profit: toMoney(profit),
      margin: revenue > 0 ? toMoney((profit / revenue) * 100) : 0
    };
  });
}

module.exports = {
  getOrderFinancialRows,
  getFinancialSummary,
  getMarketplaceSummary,
  getProductSummary,
  buildNormalizedFinancialCtes,
  buildOrderConditions,
  buildValidOrderCondition,
  netRevenueExpression,
  refundedAmountExpression,
  toMoney,
  normalizeRow
};
