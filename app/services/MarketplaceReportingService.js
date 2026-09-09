const {
  MarketplaceOrderRepository,
  MarketplaceOrderFeeRepository,
  MarketplaceCredentialRepository
} = require('../repositories');

const { sequelize, MarketplaceOrder } = require('../models');
const { Op } = require('sequelize');
const { getDateOnlyBounds, formatLocalSqlDateTime } = require('../utils/dateRange');
const logger = require('../../config/logger');
const MarketplaceFinancialService = require('./MarketplaceFinancialService');

/**
 * Construye rango de fechas SIN timezone issues
 */
function buildDateRange(from, to, alias = null) {
  const conditions = [];
  const replacements = {};
  const field = alias ? `${alias}.createdAt` : 'createdAt';
  const { start, endExclusive } = getDateOnlyBounds(from, to);

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

function getMarketplaceMetaFromCredential(credential) {
  const marketplace = credential?.marketplace || {};

  return {
    marketplace_name: credential?.name || null,
    marketplace_domain: marketplace.domain?.trim() || credential?.domain?.trim() || null
  };
}

function buildMarketplaceLookup(credentials = []) {
  return credentials.reduce((acc, credential) => {
    if (credential?.id == null) return acc;
    acc[String(credential.id)] = getMarketplaceMetaFromCredential(credential);
    return acc;
  }, {});
}

function getMarketplaceMetaFromLookup(marketplaceId, lookup = {}) {
  return lookup[String(marketplaceId)] || {
    marketplace_name: null,
    marketplace_domain: null
  };
}

function parseJsonMaybe(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;

  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value !== null && value !== undefined && String(value).trim() !== '') {
      return value;
    }
  }
  return null;
}

function buildBuyerSummary(order) {
  const snapshot = order?.customerSnapshot || {};
  const rawPayload = parseJsonMaybe(order?.raw_payload) || {};
  const rawBuyer = rawPayload?.order?.buyer || {};
  const billingInfo = rawPayload?.billing_info?.buyer?.billing_info || {};
  const legalName = [snapshot.first_name, snapshot.last_name].filter(Boolean).join(' ').trim();
  const billingName = [billingInfo.name, billingInfo.last_name].filter(Boolean).join(' ').trim();

  return {
    id: firstNonEmpty(snapshot.marketplace_customer_id, order?.buyer_id, rawBuyer.id),
    nickname: firstNonEmpty(order?.buyer_name, rawBuyer.nickname, snapshot.full_name),
    name: firstNonEmpty(snapshot.legal_name, legalName, billingName, rawBuyer.nickname, order?.buyer_name),
    first_name: firstNonEmpty(snapshot.first_name, rawBuyer.first_name, billingInfo.name),
    last_name: firstNonEmpty(snapshot.last_name, rawBuyer.last_name, billingInfo.last_name),
    email: firstNonEmpty(snapshot.email, order?.buyer_email, rawBuyer.email),
    document_type: firstNonEmpty(snapshot.document_type, billingInfo.identification?.type),
    document_number: firstNonEmpty(snapshot.document_number, order?.buyer_document, billingInfo.identification?.number),
    phone: firstNonEmpty(snapshot.phone, snapshot.phone_secondary),
    customer_type: snapshot.customer_type || null
  };
}

function buildSellerSummary(order) {
  const credential = order?.credential || {};
  const rawPayload = parseJsonMaybe(order?.raw_payload) || {};
  const rawSeller = rawPayload?.order?.seller || {};
  const sellerCredentialData = parseJsonMaybe(credential.additional_data) || {};

  return {
    id: firstNonEmpty(credential.seller_id, sellerCredentialData.ml_user_id, rawSeller.id),
    name: firstNonEmpty(credential.name, sellerCredentialData.nickname, sellerCredentialData.seller_name),
    email: firstNonEmpty(credential.seller_email, sellerCredentialData.email),
    credential_id: order?.marketplace_credential_id || credential.id || null,
    credential_name: credential.name || null
  };
}

function buildStockDisplay(order) {
  const items = Array.isArray(order?.items) ? order.items : [];
  const stockDeductedInSpree = items.length > 0 && items.every((item) => (
    item?.product_id != null && item?.inventory_movement_id != null
  ));

  return {
    descuentaStockEnSpree: stockDeductedInSpree,
    mensajeStock: stockDeductedInSpree
      ? null
      : 'Esta venta no descuenta stock en Spree'
  };
}

function getSaleDisplayStatus(order) {
  const payment = String(order?.payment_status || '').toLowerCase();
  const shipping = String(order?.shipping_status || '').toLowerCase();
  const orderStatus = String(order?.order_status || '').toLowerCase();
  if (payment === 'refunded') return 'Reembolsada';
  if (shipping === 'returned' || orderStatus === 'returned') return 'Devuelta';
  if (shipping === 'cancelled' || orderStatus === 'cancelled') return 'Cancelada';
  if (shipping === 'delivered') return 'Entregada';
  if (['shipped', 'in_transit'].includes(shipping)) return 'Enviada';
  if (['ready_to_ship', 'ready_for_ship'].includes(shipping)) return 'Lista para enviar';
  if (payment === 'paid') return 'En preparación';
  return 'Pagada';
}

function normalizeChargeFeeType(feeType) {
  const normalized = String(feeType ?? 'all').trim().toLowerCase();
  return normalized || 'all';
}

const FINANCIAL_FEE_LABELS = Object.freeze({
  commission: 'Comisión',
  shipping_fee: 'Envío vendedor',
  other: 'Otros cargos',
  other_charge: 'Otros cargos',
  other_charges: 'Otros cargos',
  payment_fee: 'Cargo de pago',
  transaction_fee: 'Cargo de transacción',
  tax: 'Impuesto',
  refund: 'Reembolso',
  discount: 'Descuento'
});

function getFinancialFeeLabel(feeType) {
  const normalized = String(feeType ?? '').trim().toLowerCase();
  return FINANCIAL_FEE_LABELS[normalized] || 'Otros cargos';
}

function toMoney(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount)
    ? Math.round((amount + Number.EPSILON) * 100) / 100
    : 0;
}

function toPercentage(value) {
  return toMoney(value);
}

function isActiveFinancialFee(fee) {
  return ![
    'cancelled',
    'canceled',
    'refunded',
    'reimbursed',
    'charged_back'
  ].includes(String(fee?.status || '').toLowerCase());
}

function buildChargeQuery(filters = {}) {
  const {
    from,
    to,
    marketplace,
    company_id,
    status,
    fee_type
  } = filters;

  const normalizedFeeType = normalizeChargeFeeType(fee_type);
  const replacements = {};
  const orderConditions = [];

  if (from || to) {
    const dateFilter = buildDateRange(from, to, 'o');
    orderConditions.push(...dateFilter.conditions.map((condition) => (
      condition.replaceAll('o.createdAt', 'COALESCE(o.sale_date, o.createdAt)')
    )));
    Object.assign(replacements, dateFilter.replacements);
  }

  if (marketplace && marketplace !== 'all') {
    orderConditions.push('o.marketplace_credential_id = :marketplace');
    replacements.marketplace = marketplace;
  }

  if (company_id) {
    orderConditions.push('o.company_id = :company_id');
    replacements.company_id = company_id;
  }

  let feeTypeCondition = '1 = 1';
  if (normalizedFeeType === 'other') {
    feeTypeCondition = "f.fee_type NOT IN ('commission', 'shipping_fee')";
  } else if (normalizedFeeType !== 'all') {
    feeTypeCondition = 'f.fee_type = :fee_type';
    replacements.fee_type = normalizedFeeType;
  }

  const includeShipping = normalizedFeeType === 'all' || normalizedFeeType === 'shipping_fee';
  const orderWhere = orderConditions.length > 0
    ? `WHERE ${orderConditions.join(' AND ')}`
    : '';
  const chargeStatusWhere = status && status !== 'all'
    ? 'AND charge_status = :status'
    : '';

  if (status && status !== 'all') {
    replacements.status = status;
  }

  const shippingAmountExpression = includeShipping
    ? `CASE
        WHEN o.shipment_id IS NULL OR o.id = (
          SELECT MIN(shipment_order.id)
          FROM marketplace_orders shipment_order
          WHERE shipment_order.shipment_id = o.shipment_id
        ) THEN CASE
          WHEN COALESCE(fa.shipping_fee_count, 0) > 0
            THEN COALESCE(fa.stored_shipping_amount, 0)
          ELSE COALESCE(
            NULLIF(o.shipping_total, 0),
            JSON_UNQUOTE(JSON_EXTRACT(o.raw_payload, '$.shipping_financials.seller_cost')),
            0
          )
        END
        ELSE 0
      END`
    : '0';

  const cte = `
WITH fee_agg AS (
  SELECT
    f.order_id,
    COUNT(*) AS fee_count,
    SUM(CASE WHEN f.fee_type = 'commission' THEN f.amount ELSE 0 END) AS commission_amount,
    SUM(CASE WHEN f.fee_type = 'shipping_fee' THEN f.amount ELSE 0 END) AS stored_shipping_amount,
    SUM(CASE WHEN f.fee_type NOT IN ('commission', 'shipping_fee') THEN f.amount ELSE 0 END) AS other_amount,
    SUM(CASE WHEN f.fee_type = 'shipping_fee' THEN 1 ELSE 0 END) AS shipping_fee_count,
    MAX(CASE WHEN LOWER(COALESCE(f.status, '')) IN ('refunded', 'reimbursed', 'charged_back') THEN 1 ELSE 0 END) AS has_refunded_fee,
    MAX(CASE WHEN LOWER(COALESCE(f.status, '')) IN ('cancelled', 'canceled') THEN 1 ELSE 0 END) AS has_cancelled_fee,
    MAX(CASE WHEN LOWER(COALESCE(f.status, '')) = 'pending' THEN 1 ELSE 0 END) AS has_pending_fee,
    MAX(CASE WHEN LOWER(COALESCE(f.status, '')) = 'paid' THEN 1 ELSE 0 END) AS has_paid_fee,
    MAX(CASE WHEN LOWER(COALESCE(f.status, '')) = 'charged' THEN 1 ELSE 0 END) AS has_charged_fee
  FROM marketplace_order_fees f
  WHERE ${feeTypeCondition}
  GROUP BY f.order_id
),
charge_rows AS (
  SELECT
    o.id AS order_id,
    o.marketplace_order_id AS order_ref,
    o.marketplace_credential_id,
    COALESCE(o.sale_date, o.createdAt) AS sale_date,
    o.order_status,
    o.payment_status,
    o.total_amount AS sale_total,
    o.refunded_amount,
    o.currency,
    COALESCE(fa.fee_count, 0) AS fee_count,
    COALESCE(fa.commission_amount, 0) AS commission_amount,
    ${shippingAmountExpression} AS shipping_amount,
    COALESCE(fa.other_amount, 0) AS other_amount,
    CASE
      WHEN COALESCE(fa.has_refunded_fee, 0) = 1
        OR LOWER(COALESCE(o.order_status, '')) IN ('refunded', 'returned')
        OR LOWER(COALESCE(o.payment_status, '')) IN ('refunded', 'reimbursed', 'charged_back')
        OR (
          COALESCE(o.total_amount, 0) > 0
          AND COALESCE(o.refunded_amount, 0) >= o.total_amount
        ) THEN 'refunded'
      WHEN COALESCE(fa.has_cancelled_fee, 0) = 1
        OR LOWER(COALESCE(o.order_status, '')) IN ('cancelled', 'canceled')
        OR LOWER(COALESCE(o.payment_status, '')) IN ('cancelled', 'canceled') THEN 'cancelled'
      WHEN COALESCE(fa.has_pending_fee, 0) = 1 THEN 'pending'
      WHEN COALESCE(fa.has_paid_fee, 0) = 1 THEN 'paid'
      WHEN COALESCE(fa.has_charged_fee, 0) = 1 THEN 'charged'
      ELSE 'charged'
    END AS charge_status,
    CASE
      WHEN (
        COALESCE(fa.has_refunded_fee, 0) = 1
        OR LOWER(COALESCE(o.order_status, '')) IN ('refunded', 'returned')
        OR LOWER(COALESCE(o.payment_status, '')) IN ('refunded', 'reimbursed', 'charged_back')
        OR (
          COALESCE(o.total_amount, 0) > 0
          AND COALESCE(o.refunded_amount, 0) >= o.total_amount
        )
        OR COALESCE(fa.has_cancelled_fee, 0) = 1
        OR LOWER(COALESCE(o.order_status, '')) IN ('cancelled', 'canceled')
        OR LOWER(COALESCE(o.payment_status, '')) IN ('cancelled', 'canceled')
      ) THEN 0
      ELSE 1
    END AS is_definitive
  FROM marketplace_orders o
  LEFT JOIN fee_agg fa ON fa.order_id = o.id
  ${orderWhere}
)
`;

  const chargeWhere = `WHERE (
    ABS(commission_amount) > 0
    OR ABS(shipping_amount) > 0
    OR ABS(other_amount) > 0
  ) ${chargeStatusWhere}`;

  return {
    cte,
    chargeWhere,
    replacements,
    normalizedFeeType
  };
}

async function getChargeRows(filters = {}, pagination = {}) {
  const { cte, chargeWhere, replacements } = buildChargeQuery(filters);
  const limit = Number.isInteger(Number(pagination.limit)) && Number(pagination.limit) >= 0
    ? Number(pagination.limit)
    : 50;
  const offset = Number.isInteger(Number(pagination.offset)) && Number(pagination.offset) >= 0
    ? Number(pagination.offset)
    : 0;

  const rows = await sequelize.query(`
    ${cte}
    SELECT
      order_id,
      order_ref,
      marketplace_credential_id,
      sale_date,
      order_status,
      payment_status,
      sale_total,
      refunded_amount,
      currency,
      fee_count,
      commission_amount,
      shipping_amount,
      other_amount,
      commission_amount + shipping_amount + other_amount AS total_charges,
      CASE
        WHEN COALESCE(sale_total, 0) > 0
          THEN ((commission_amount + shipping_amount + other_amount) / sale_total) * 100
        ELSE 0
      END AS charges_percentage,
      charge_status,
      CASE WHEN charge_status IN ('cancelled', 'refunded') THEN 0 ELSE 1 END AS is_definitive
    FROM charge_rows
    ${chargeWhere}
    ORDER BY sale_date DESC, order_id DESC
    LIMIT :limit OFFSET :offset
  `, {
    type: sequelize.QueryTypes.SELECT,
    replacements: { ...replacements, limit, offset }
  });

  return rows;
}

async function getChargeSummary(filters = {}) {
  const { cte, chargeWhere, replacements } = buildChargeQuery(filters);
  const [totals] = await sequelize.query(`
    ${cte}
    SELECT
      COUNT(*) AS total_sales,
      COALESCE(SUM(fee_count), 0) AS total_fee_records,
      COALESCE(SUM(commission_amount), 0) AS commissions,
      COALESCE(SUM(shipping_amount), 0) AS shipping,
      COALESCE(SUM(other_amount), 0) AS other_charges,
      COALESCE(SUM(commission_amount + shipping_amount + other_amount), 0) AS total_charges,
      COALESCE(SUM(CASE WHEN is_definitive = 1 THEN commission_amount ELSE 0 END), 0) AS definitive_commissions,
      COALESCE(SUM(CASE WHEN is_definitive = 1 THEN shipping_amount ELSE 0 END), 0) AS definitive_shipping,
      COALESCE(SUM(CASE WHEN is_definitive = 1 THEN other_amount ELSE 0 END), 0) AS definitive_other_charges,
      COALESCE(SUM(CASE WHEN is_definitive = 1 THEN commission_amount + shipping_amount + other_amount ELSE 0 END), 0) AS definitive_total_charges
    FROM charge_rows
    ${chargeWhere}
  `, {
    type: sequelize.QueryTypes.SELECT,
    replacements
  });

  const byStatusRows = await sequelize.query(`
    ${cte}
    SELECT
      charge_status,
      COUNT(*) AS sale_count,
      COALESCE(SUM(commission_amount), 0) AS commissions,
      COALESCE(SUM(shipping_amount), 0) AS shipping,
      COALESCE(SUM(other_amount), 0) AS other_charges,
      COALESCE(SUM(commission_amount + shipping_amount + other_amount), 0) AS total_charges
    FROM charge_rows
    ${chargeWhere}
    GROUP BY charge_status
  `, {
    type: sequelize.QueryTypes.SELECT,
    replacements
  });

  const byStatus = {};
  byStatusRows.forEach((row) => {
    byStatus[row.charge_status] = {
      count: Number(row.sale_count || 0),
      commissions: toMoney(row.commissions),
      shipping: toMoney(row.shipping),
      otherCharges: toMoney(row.other_charges),
      totalCharges: toMoney(row.total_charges)
    };
  });

  return {
    totalSales: Number(totals?.total_sales || 0),
    totalFees: Number(totals?.total_fee_records || 0),
    commissions: toMoney(totals?.commissions),
    shipping: toMoney(totals?.shipping),
    otherCharges: toMoney(totals?.other_charges),
    totalCharges: toMoney(totals?.total_charges),
    definitive: {
      commissions: toMoney(totals?.definitive_commissions),
      shipping: toMoney(totals?.definitive_shipping),
      otherCharges: toMoney(totals?.definitive_other_charges),
      totalCharges: toMoney(totals?.definitive_total_charges)
    },
    byStatus
  };
}

const MarketplaceReportingService = {

  // ========================
  // SALES
  // ========================
  async getSalesReport(filters = {}) {
    try {
      const {
        from, to, marketplace, status,
        company_id, user_id,
        limit, offset
      } = filters;

      const ordersResult = await MarketplaceOrderRepository.findAndCountAll({
        filters: {
          from,
          to,
          marketplace,
          order_status: status,
          company_id,
          user_id
        },
        pagination: { limit, offset }
      });

      const summary = await MarketplaceOrderRepository.getSalesSummary({
        filters: {
          from,
          to,
          marketplace,
          company_id,
          user_id
        }
      });

      const financialSummary = await MarketplaceFinancialService.getFinancialSummary({
        from,
        to,
        marketplace,
        company_id,
        user_id,
        status
      });
      const orderIds = ordersResult.rows.map((order) => order.id).filter(Boolean);
      const financialRows = orderIds.length > 0
        ? await MarketplaceFinancialService.getOrderFinancialRows({
            from,
            to,
            marketplace,
            company_id,
            user_id,
            status,
            orderIds
          })
        : [];
      const financialByOrder = new Map(
        financialRows.map((row) => [String(row.orderId), row])
      );

      return {
        summary: {
          ...summary,
          totalRevenue: financialSummary.totalRevenue,
          totalShipping: financialSummary.totalShipping,
          totalProductCost: financialSummary.totalProductCost,
          totalCommissions: financialSummary.totalCommissions,
          totalOtherCharges: financialSummary.totalOtherCharges,
          estimatedProfit: financialSummary.estimatedProfit,
          marginPercentage: financialSummary.marginPercentage
        },
        orders: ordersResult.rows.map(order => {
          const buyer = buildBuyerSummary(order);
          const seller = buildSellerSummary(order);
          const stockDisplay = buildStockDisplay(order);
          const financial = financialByOrder.get(String(order.id));

          return {
          id: order.id,
          marketplace: order.marketplace_credential_id,
          ...getMarketplaceMetaFromCredential(order.credential),
          orderRef: order.marketplace_order_id,
           date: order.sale_date || order.createdAt,
          customer: buyer.name || buyer.nickname || buyer.id || 'N/A',
          buyer,
          seller,
           status: order.order_status,
           displayStatus: getSaleDisplayStatus(order),
           paymentStatus: order.payment_status,
           shippingStatus: order.shipping_status,
           shippingSubstatus: order.shipping_substatus,
           shippedAt: order.shipped_at,
           deliveredAt: order.delivered_at,
           cancelledAt: order.cancelled_at,
           returnedAt: order.returned_at,
           managedBySpree: Boolean(order.managed_by_spree),
           managementLabel: order.managed_by_spree
             ? 'Gestionada por Spree'
             : `Venta externa de ${getMarketplaceMetaFromCredential(order.credential).marketplace_name || 'Mercado Libre'}`,
           items: (order.items || []).map((item) => ({
             id: item.id,
             listingId: item.listing_id,
             marketplaceItemId: item.marketplace_item_id,
             sku: item.sku,
             title: item.title || item.product?.name || item.variant?.name || item.listing_id,
             userProductId: item.user_product_id,
             attributes: item.marketplace_attributes,
             quantity: item.quantity,
             unitPrice: parseFloat(item.unit_price || 0),
             totalPrice: parseFloat(item.total_price || 0),
             productId: item.product_id,
             variantId: item.variant_id,
             managedBySpree: Boolean(item.managed_by_spree)
           })),
          itemsCount: order.items?.length || 0,
          subtotal: parseFloat(order.subtotal || 0),
           shipping: financial?.shipping ?? parseFloat(order.shipping_total || 0),
           shippingSellerCost: financial?.shipping ?? parseFloat(order.shipping_total || 0),
           tax: parseFloat(order.tax_total || 0),
           total: parseFloat(order.total_amount || 0),
           netRevenue: financial?.revenue ?? parseFloat(order.total_amount || 0),
           commission: financial?.commission ?? 0,
           otherCharges: financial?.otherCharges ?? 0,
           productCost: financial?.productCost ?? 0,
           estimatedProfit: financial?.estimatedProfit ?? 0,
           margin: financial?.margin ?? 0,
           financial: financial
             ? {
                 revenue: financial.revenue,
                 commission: financial.commission,
                 shipping: financial.shipping,
                 otherCharges: financial.otherCharges,
                 productCost: financial.productCost,
                 estimatedProfit: financial.estimatedProfit,
                 margin: financial.margin,
                 refundedAmount: financial.refundedAmount
               }
             : null,
           invoiceNumber: order.invoice_number,
          invoiceType: order.invoice_type,
          ...stockDisplay,
          notes_snapshot: normalizeNotesSnapshot(order.notes_snapshot)
          };
        })
      };

    } catch (error) {
      logger.error(`[MarketplaceReportingService] Error en getSalesReport: ${error.message}`);
      throw error;
    }
  },

  async getSalesStats(filters = {}) {
    try {
      const summary = await MarketplaceFinancialService.getFinancialSummary(filters);
      const legacySummary = await MarketplaceOrderRepository.getSalesStats({ filters });

      return {
        total_orders: summary.totalOrders,
        total_revenue: summary.totalRevenue,
        total_subtotal: parseFloat(legacySummary?.total_subtotal || 0),
        total_shipping: summary.totalShipping,
        total_tax: parseFloat(legacySummary?.total_tax || 0),
        total_product_cost: summary.totalProductCost,
        total_commissions: summary.totalCommissions,
        total_other_charges: summary.totalOtherCharges,
        estimated_profit: summary.estimatedProfit,
        margin_percentage: summary.marginPercentage
      };

    } catch (error) {
      logger.error('[MarketplaceReportingService] Error en getSalesStats: ' + error.message);
      throw error;
    }
  },

  // ========================
  // COMMISSIONS
  // ========================
  async getCommissionReport(filters = {}) {
    try {
      const {
        from,
        to,
        marketplace,
        company_id,
        status,
        fee_type = 'all',
        limit,
        offset
      } = filters;
      const normalizedFeeType = normalizeChargeFeeType(fee_type);
      const normalizedStatus = status && status !== 'all' ? status : undefined;
      const chargeFilters = {
        from,
        to,
        marketplace,
        company_id,
        status: normalizedStatus,
        fee_type: normalizedFeeType
      };

      const feesResult = await MarketplaceOrderFeeRepository.findAndCountAll({
        filters: {
          from,
          to,
          marketplace,
          company_id,
          status: normalizedStatus,
          fee_type: normalizedFeeType === 'all' ? undefined : normalizedFeeType
        },
        pagination: { limit, offset }
      });

      const [chargeRows, chargeSummary] = await Promise.all([
        getChargeRows(chargeFilters, { limit, offset }),
        getChargeSummary(chargeFilters)
      ]);

      const marketplaceIds = [...new Set(
        chargeRows.map(row => row.marketplace_credential_id).filter(Boolean)
      )];
      const credentials = marketplaceIds.length
        ? await MarketplaceCredentialRepository.findByIds(marketplaceIds)
        : [];
      const marketplaceLookup = buildMarketplaceLookup(credentials);

      return {
        summary: {
          // Campos anteriores conservados para compatibilidad.
          totalFees: chargeSummary.totalFees,
          totalAmount: chargeSummary.totalCharges,
          byStatus: chargeSummary.byStatus,
          // Totales del nuevo reporte de cargos, calculados sobre todo el
          // conjunto filtrado y no solo sobre la página visible.
          totalSales: chargeSummary.totalSales,
          totalCharges: chargeSummary.totalCharges,
          commissions: chargeSummary.commissions,
          shipping: chargeSummary.shipping,
          otherCharges: chargeSummary.otherCharges,
          definitive: chargeSummary.definitive
        },
        // Vista nueva: una fila consolidada por venta.
        charges: chargeRows.map(row => ({
          id: row.order_id,
          orderId: row.order_id,
          orderRef: row.order_ref,
          marketplace: row.marketplace_credential_id,
          ...getMarketplaceMetaFromLookup(row.marketplace_credential_id, marketplaceLookup),
          saleDate: row.sale_date,
          saleTotal: toMoney(row.sale_total),
          commission: toMoney(row.commission_amount),
          shipping: toMoney(row.shipping_amount),
          otherCharges: toMoney(row.other_amount),
          totalCharges: toMoney(row.total_charges),
          percentage: toPercentage(row.charges_percentage),
          status: row.charge_status,
          isDefinitive: Boolean(row.is_definitive),
          orderStatus: row.order_status,
          paymentStatus: row.payment_status,
          refundedAmount: toMoney(row.refunded_amount),
          currency: row.currency,
          feeCount: Number(row.fee_count || 0)
        })),
        // Vista existente conservada para consumidores que todavía trabajan
        // con el detalle individual de cada fee.
        fees: feesResult.rows.map(fee => ({
          id: fee.id,
          orderId: fee.order_id,
          orderRef: fee.order?.marketplace_order_id,
          marketplace: fee.order?.marketplace_credential_id,
          ...getMarketplaceMetaFromCredential(fee.order?.credential),
          feeType: getFinancialFeeLabel(fee.fee_type),
          saleDate: fee.order?.sale_date || fee.order?.createdAt,
          orderStatus: fee.order?.order_status,
          paymentStatus: fee.order?.payment_status,
          saleTotal: parseFloat(fee.order?.total_amount || 0),
          refundedAmount: parseFloat(fee.order?.refunded_amount || 0),
          currency: fee.order?.currency,
          sku: fee.orderItem?.sku,
          productId: fee.orderItem?.product_id,
          variantId: fee.orderItem?.variant_id,
          quantity: fee.orderItem?.quantity,
          unitPrice: parseFloat(fee.orderItem?.unit_price || 0),
          itemTotal: parseFloat(fee.orderItem?.total_price || 0),
          title: fee.orderItem?.title || null,
          amount: parseFloat(fee.amount || 0),
          percentage: parseFloat(fee.percentage || 0),
          status: fee.status,
          payoutDate: fee.payout_date,
          payoutReference: fee.payout_reference,
          description: fee.description,
          createdAt: fee.createdAt
        }))
      };

    } catch (error) {
      logger.error('[MarketplaceReportingService] Error en getCommissionReport: ' + error.message);
      throw error;
    }
  },

  async getCommissionStats(filters = {}) {
    try {
      const summary = await getChargeSummary({
        ...filters,
        fee_type: normalizeChargeFeeType(filters.fee_type)
      });

      return {
        // Campos existentes conservados.
        total_amount: summary.totalCharges,
        by_status: summary.byStatus,
        // Totales separados para el resumen de Cargos Marketplace.
        total_sales: summary.totalSales,
        total_fees: summary.totalFees,
        total_charges: summary.totalCharges,
        commissions: summary.commissions,
        shipping: summary.shipping,
        other_charges: summary.otherCharges,
        definitive: summary.definitive
      };

    } catch (error) {
      logger.error('[MarketplaceReportingService] Error en getCommissionStats: ' + error.message);
      throw error;
    }
  },

  // ========================
  // PROFITS (OPTIMIZADO)
  // ========================
  async getProfitReport(filters = {}, groupBy = 'marketplace') {
    try {
      const stats = await this.getProfitStats(filters);
      const byMarketplace = await this.getProfitByMarketplace(filters);
      const byProduct = await this.getProfitByProduct(filters);
      const details = await this.getProfitDetails(filters, {
        limit: filters.detail_limit ?? filters.limit,
        offset: filters.detail_offset ?? filters.offset
      });
      const marketplaceIds = [...new Set(byMarketplace.map(row => row.marketplace).filter(Boolean))];
      const credentials = marketplaceIds.length
        ? await MarketplaceCredentialRepository.findByIds(marketplaceIds)
        : [];
      const marketplaceLookup = buildMarketplaceLookup(credentials);

      return {
        summary: {
          totalRevenue: stats.total_revenue || 0,
          totalCost: stats.total_cost || 0,
          totalProductCost: stats.total_product_cost || 0,
          totalShipping: stats.total_shipping || 0,
          totalCommissions: stats.total_commissions || 0,
          totalFees: stats.total_fees || 0,
          totalOtherCharges: stats.total_other_charges || 0,
          grossProfit: stats.gross_profit || 0,
          marginPercentage: stats.margin_percentage || 0
        },
        byMarketplace: byMarketplace.map(row => ({
          ...row,
          ...getMarketplaceMetaFromLookup(row.marketplace, marketplaceLookup)
        })),
        byProduct,
        topProducts: byProduct.slice(0, 10),
        details
      };

    } catch (error) {
      logger.error('[MarketplaceReportingService] Error en getProfitReport: ' + error.message);
      throw error;
    }
  },

  async getProfitStats(filters = {}) {
    try {
      const summary = await MarketplaceFinancialService.getFinancialSummary(filters);

      return {
        total_revenue: summary.totalRevenue,
        total_cost: summary.totalProductCost,
        total_product_cost: summary.totalProductCost,
        total_fees: summary.totalCommissions,
        total_commissions: summary.totalCommissions,
        total_shipping: summary.totalShipping,
        total_other_charges: summary.totalOtherCharges,
        gross_profit: summary.estimatedProfit,
        margin_percentage: summary.marginPercentage
      };

    } catch (error) {
      logger.error('[MarketplaceReportingService] Error en getProfitStats: ' + error.message);
      throw error;
    }
  },

  async getProfitByMarketplace(filters = {}) {
    try {
      return await MarketplaceFinancialService.getMarketplaceSummary(filters);

    } catch (error) {
      logger.error('[MarketplaceReportingService] Error en getProfitByMarketplace: ' + error.message);
      throw error;
    }
  },

  async getProfitDetails(filters = {}, pagination = {}) {
    try {
      const financialRows = await MarketplaceFinancialService.getOrderFinancialRows(
        filters,
        pagination
      );
      if (financialRows.length === 0) return [];

      const orders = await MarketplaceOrder.findAll({
        where: {
          id: {
            [Op.in]: financialRows.map((row) => row.orderId)
          }
        },
        include: [
          {
            association: 'credential',
            include: [{ association: 'marketplace' }]
          },
          {
            association: 'items',
            include: [
              { association: 'product' },
              { association: 'variant' },
              { association: 'fees' }
            ]
          },
          { association: 'fees' }
        ]
      });

      const ordersById = new Map(orders.map((order) => [String(order.id), order]));

      return financialRows.map((financial) => {
        const order = ordersById.get(String(financial.orderId));
        const marketplaceMeta = getMarketplaceMetaFromCredential(order?.credential);
        const orderFees = (order?.fees || []).map((fee) => ({
          id: fee.id,
          type: getFinancialFeeLabel(fee.fee_type),
          amount: toMoney(fee.amount),
          status: fee.status,
          description: fee.description,
          orderItemId: fee.order_item_id,
          percentage: toPercentage(fee.percentage)
        }));
        const items = (order?.items || []).map((item) => {
          const activeFees = (item.fees || []).filter(isActiveFinancialFee);
          const commission = activeFees
            .filter((fee) => fee.fee_type === 'commission')
            .reduce((sum, fee) => sum + Number(fee.amount || 0), 0);
          const otherCharges = activeFees
            .filter((fee) => !['commission', 'shipping_fee'].includes(fee.fee_type))
            .reduce((sum, fee) => sum + Number(fee.amount || 0), 0);
          const revenue = Number(item.total_price || 0);
          const productCost = Number(item.total_cost || 0);

          return {
            id: item.id,
            listingId: item.listing_id,
            marketplaceItemId: item.marketplace_item_id,
            sku: item.sku,
            title: item.title || item.product?.name || item.variant?.name || item.listing_id,
            quantity: Number(item.quantity || 0),
            unitPrice: toMoney(item.unit_price),
            totalPrice: toMoney(revenue),
            productId: item.product_id,
            variantId: item.variant_id,
            managedBySpree: Boolean(item.managed_by_spree),
            productCost: toMoney(productCost),
            commission: toMoney(commission),
            otherCharges: toMoney(otherCharges),
            estimatedProfit: toMoney(revenue - productCost - commission - otherCharges),
            fees: activeFees.map((fee) => ({
              id: fee.id,
              type: getFinancialFeeLabel(fee.fee_type),
              amount: toMoney(fee.amount),
              status: fee.status,
              description: fee.description
            }))
          };
        });

        return {
          id: financial.orderId,
          orderId: financial.orderId,
          date: financial.date,
          marketplace: marketplaceMeta.marketplace_name || financial.marketplace,
          marketplaceId: financial.marketplaceCredentialId,
          marketplaceDomain: marketplaceMeta.marketplace_domain,
          order: financial.orderRef,
          orderRef: financial.orderRef,
          revenue: financial.revenue,
          netRevenue: financial.revenue,
          grossRevenue: financial.grossRevenue,
          refundedAmount: financial.refundedAmount,
          commission: financial.commission,
          shipping: financial.shipping,
          otherCharges: financial.otherCharges,
          productCost: financial.productCost,
          estimatedProfit: financial.estimatedProfit,
          margin: financial.margin,
          currency: financial.currency,
          items,
          fees: orderFees
        };
      });
    } catch (error) {
      logger.error('[MarketplaceReportingService] Error en getProfitDetails: ' + error.message);
      throw error;
    }
  },

  async getProfitByProduct(filters = {}) {
    try {
      return await MarketplaceFinancialService.getProductSummary(filters, {
        limit: filters.limit ?? 20
      });

    } catch (error) {
      logger.error('[MarketplaceReportingService] Error en getProfitByProduct: ' + error.message);
      throw error;
    }
  }

};

function normalizeNotesSnapshot(notesSnapshot) {
  if (Array.isArray(notesSnapshot)) {
    return notesSnapshot
      .map((note, index) => {
        if (typeof note === 'string') {
          return {
            note_id: `legacy-note-${index}`,
            text: note,
            created_at: null,
            created_by_user_id: null,
            created_by_user_name: null,
            raw_payload: { text: note }
          };
        }

        if (!note || typeof note !== 'object') return null;
        const text = typeof note.text === 'string' ? note.text : '';
        if (!text) return null;

        return {
          note_id: note.note_id || `legacy-note-${index}`,
          text,
          created_at: note.created_at || null,
          created_by_user_id: note.created_by_user_id ?? null,
          created_by_user_name: note.created_by_user_name ?? null,
          raw_payload: note.raw_payload || note
        };
      })
      .filter(Boolean);
  }

  if (notesSnapshot && typeof notesSnapshot === 'object') {
    return [{
      note_id: notesSnapshot.note_id || 'legacy-note-0',
      text: notesSnapshot.text || '',
      created_at: notesSnapshot.created_at || null,
      created_by_user_id: notesSnapshot.created_by_user_id ?? null,
      created_by_user_name: notesSnapshot.created_by_user_name ?? null,
      raw_payload: notesSnapshot.raw_payload || notesSnapshot
    }].filter((note) => note.text);
  }

  return [];
}

module.exports = MarketplaceReportingService;
MarketplaceReportingService._buildStockDisplay = buildStockDisplay;
MarketplaceReportingService._getFinancialFeeLabel = getFinancialFeeLabel;
