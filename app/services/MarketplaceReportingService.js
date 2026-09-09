const {
  MarketplaceOrderRepository,
  MarketplaceOrderFeeRepository,
  MarketplaceCredentialRepository
} = require('../repositories');

const { sequelize } = require('../models');
const { getDateOnlyBounds, formatLocalSqlDateTime } = require('../utils/dateRange');
const logger = require('../../config/logger');

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

function toMoney(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount)
    ? Math.round((amount + Number.EPSILON) * 100) / 100
    : 0;
}

function toPercentage(value) {
  return toMoney(value);
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

      return {
        summary,
        orders: ordersResult.rows.map(order => {
          const buyer = buildBuyerSummary(order);
          const seller = buildSellerSummary(order);
          const stockDisplay = buildStockDisplay(order);

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
          shipping: parseFloat(order.shipping_total || 0),
          tax: parseFloat(order.tax_total || 0),
          total: parseFloat(order.total_amount || 0),
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
      const { from, to, marketplace, company_id, user_id } = filters;

      const conditions = ["order_status = 'paid'"];
      const replacements = {};

      const dateFilter = buildDateRange(from, to);
      conditions.push(...dateFilter.conditions);
      Object.assign(replacements, dateFilter.replacements);

      if (marketplace && marketplace !== 'all') {
        conditions.push(`marketplace_credential_id = :marketplace`);
        replacements.marketplace = marketplace;
      }

      if (company_id) {
        conditions.push(`company_id = :company_id`);
        replacements.company_id = company_id;
      }

      if (user_id) {
        conditions.push(`user_id = :user_id`);
        replacements.user_id = user_id;
      }

      const whereClause = conditions.length
        ? `WHERE ${conditions.join(' AND ')}`
        : '';

      const result = await sequelize.query(`
        SELECT
          COUNT(*) as total_orders,
          COALESCE(SUM(total_amount), 0) as total_revenue,
          COALESCE(SUM(subtotal), 0) as total_subtotal,
          COALESCE(SUM(shipping_total), 0) as total_shipping,
          COALESCE(SUM(tax_total), 0) as total_tax
        FROM marketplace_orders
        ${whereClause}
      `, {
        type: sequelize.QueryTypes.SELECT,
        replacements
      });

      const row = result?.[0] || {};

      return {
        total_orders: parseInt(row.total_orders || 0),
        total_revenue: parseFloat(row.total_revenue || 0),
        total_subtotal: parseFloat(row.total_subtotal || 0),
        total_shipping: parseFloat(row.total_shipping || 0),
        total_tax: parseFloat(row.total_tax || 0)
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
          feeType: fee.fee_type,
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
      const marketplaceIds = [...new Set(byMarketplace.map(row => row.marketplace).filter(Boolean))];
      const credentials = marketplaceIds.length
        ? await MarketplaceCredentialRepository.findByIds(marketplaceIds)
        : [];
      const marketplaceLookup = buildMarketplaceLookup(credentials);

      return {
        summary: {
          totalRevenue: stats.total_revenue || 0,
          totalCost: stats.total_cost || 0,
          totalFees: stats.total_fees || 0,
          grossProfit: stats.gross_profit || 0,
          marginPercentage: stats.margin_percentage || 0
        },
        byMarketplace: byMarketplace.map(row => ({
          ...row,
          ...getMarketplaceMetaFromLookup(row.marketplace, marketplaceLookup)
        })),
        byProduct,
        topProducts: byProduct.slice(0, 10)
      };

    } catch (error) {
      logger.error('[MarketplaceReportingService] Error en getProfitReport: ' + error.message);
      throw error;
    }
  },

  async getProfitStats(filters = {}) {
    try {
      const { from, to, marketplace, company_id, user_id } = filters;

      const conditions = [];
      const replacements = {};

      const dateFilter = buildDateRange(from, to, 'o');
      conditions.push(...dateFilter.conditions.map((condition) => (
        condition.replaceAll('o.createdAt', 'COALESCE(o.sale_date, o.createdAt)')
      )));
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

      conditions.push(buildValidProfitOrderCondition('o'));

      const whereClause = `WHERE ${conditions.join(' AND ')}`;

      const result = await sequelize.query(`
        SELECT
          COALESCE(SUM(${netRevenueExpression('o')}), 0) as total_revenue,
          COALESCE(SUM(oi.total_cost), 0) as total_cost,
          COALESCE(SUM(f.total_fees), 0) as total_fees,
          COALESCE(SUM(${shippingCostExpression('o')}), 0) as total_shipping,
          COALESCE(SUM(${netRevenueExpression('o')}), 0)
            - COALESCE(SUM(oi.total_cost), 0)
            - COALESCE(SUM(f.total_fees), 0)
            - COALESCE(SUM(${shippingCostExpression('o')}), 0) as gross_profit
        FROM marketplace_orders o
        LEFT JOIN (
          SELECT order_id, SUM(total_cost) as total_cost
          FROM marketplace_order_items
          GROUP BY order_id
        ) oi ON o.id = oi.order_id
        LEFT JOIN (
          SELECT f.order_id, SUM(f.amount) as total_fees
          FROM marketplace_order_fees f
          WHERE f.fee_type = 'commission'
            AND LOWER(COALESCE(f.status, '')) NOT IN ('cancelled', 'refunded')
            AND (
              f.order_item_id IS NOT NULL
              OR NOT EXISTS (
                SELECT 1
                FROM marketplace_order_fees item_fee
                WHERE item_fee.order_id = f.order_id
                  AND item_fee.order_item_id IS NOT NULL
                  AND item_fee.fee_type = 'commission'
                  AND LOWER(COALESCE(item_fee.status, '')) NOT IN ('cancelled', 'refunded')
              )
            )
          GROUP BY order_id
        ) f ON o.id = f.order_id
        ${whereClause}
      `, {
        type: sequelize.QueryTypes.SELECT,
        replacements
      });

      const row = result?.[0] || {};

      const totalRevenue = parseFloat(row.total_revenue || 0);
      const totalCost = parseFloat(row.total_cost || 0);
      const totalFees = parseFloat(row.total_fees || 0);
      const totalShipping = parseFloat(row.total_shipping || 0);
      const grossProfit = parseFloat(row.gross_profit || 0);

      const marginPercentage =
        totalRevenue > 0 ? (grossProfit / totalRevenue) * 100 : 0;

      return {
        total_revenue: totalRevenue,
        total_cost: totalCost,
        total_fees: totalFees,
        total_shipping: totalShipping,
        gross_profit: grossProfit,
        margin_percentage: Math.round(marginPercentage * 100) / 100
      };

    } catch (error) {
      logger.error('[MarketplaceReportingService] Error en getProfitStats: ' + error.message);
      throw error;
    }
  },

  async getProfitByMarketplace(filters = {}) {
    try {
      const { from, to, marketplace, company_id, user_id } = filters;

      const conditions = [];
      const replacements = {};

      const dateFilter = buildDateRange(from, to, 'o');
      conditions.push(...dateFilter.conditions.map((condition) => (
        condition.replaceAll('o.createdAt', 'COALESCE(o.sale_date, o.createdAt)')
      )));
      Object.assign(replacements, dateFilter.replacements);

      if (company_id) {
        conditions.push('o.company_id = :company_id');
        replacements.company_id = company_id;
      }
      if (user_id) {
        conditions.push('o.user_id = :user_id');
        replacements.user_id = user_id;
      }
      if (marketplace && marketplace !== 'all') {
        conditions.push('o.marketplace_credential_id = :marketplace');
        replacements.marketplace = marketplace;
      }

      conditions.push(buildValidProfitOrderCondition('o'));

      const whereClause = `WHERE ${conditions.join(' AND ')}`;

      const results = await sequelize.query(`
        SELECT
          o.marketplace_credential_id as marketplace,
          COALESCE(SUM(${netRevenueExpression('o')}), 0) as revenue,
          COALESCE(SUM(oi.total_cost), 0) as cost,
          COALESCE(SUM(f.total_fees), 0) as fees,
          COALESCE(SUM(${shippingCostExpression('o')}), 0) as shipping,
          COALESCE(SUM(${netRevenueExpression('o')}), 0)
            - COALESCE(SUM(oi.total_cost), 0)
            - COALESCE(SUM(f.total_fees), 0)
            - COALESCE(SUM(${shippingCostExpression('o')}), 0) as profit
        FROM marketplace_orders o
        LEFT JOIN (
          SELECT order_id, SUM(total_cost) as total_cost
          FROM marketplace_order_items
          GROUP BY order_id
        ) oi ON o.id = oi.order_id
        LEFT JOIN (
          SELECT f.order_id, SUM(f.amount) as total_fees
          FROM marketplace_order_fees f
          WHERE f.fee_type = 'commission'
            AND LOWER(COALESCE(f.status, '')) NOT IN ('cancelled', 'refunded')
            AND (
              f.order_item_id IS NOT NULL
              OR NOT EXISTS (
                SELECT 1
                FROM marketplace_order_fees item_fee
                WHERE item_fee.order_id = f.order_id
                  AND item_fee.order_item_id IS NOT NULL
                  AND item_fee.fee_type = 'commission'
                  AND LOWER(COALESCE(item_fee.status, '')) NOT IN ('cancelled', 'refunded')
              )
            )
          GROUP BY order_id
        ) f ON o.id = f.order_id
        ${whereClause}
        GROUP BY o.marketplace_credential_id
      `, {
        type: sequelize.QueryTypes.SELECT,
        replacements
      });

      return results.map(row => ({
        marketplace: row.marketplace,
        revenue: parseFloat(row.revenue || 0),
        cost: parseFloat(row.cost || 0),
        productCost: parseFloat(row.cost || 0),
        shippingCost: parseFloat(row.shipping || 0),
        fees: parseFloat(row.fees || 0),
        profit: parseFloat(row.profit || 0),
        margin: Number(row.revenue || 0) > 0
          ? Math.round((Number(row.profit || 0) / Number(row.revenue)) * 100 * 100) / 100
          : 0
      }));

    } catch (error) {
      logger.error('[MarketplaceReportingService] Error en getProfitByMarketplace: ' + error.message);
      throw error;
    }
  },

  async getProfitByProduct(filters = {}) {
    try {
      const { from, to, marketplace, company_id, user_id, limit = 20 } = filters;

      const conditions = [];
      const replacements = {};

      const dateFilter = buildDateRange(from, to, 'o');
      conditions.push(...dateFilter.conditions.map((condition) => (
        condition.replaceAll('o.createdAt', 'COALESCE(o.sale_date, o.createdAt)')
      )));
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

      conditions.push(buildValidProfitOrderCondition('o'));

      const whereClause = `WHERE ${conditions.join(' AND ')}`;

      const results = await sequelize.query(`
        SELECT
          p.id as product_id,
          COALESCE(p.name, oi.title, oi.sku, oi.listing_id) as product_name,
          COALESCE(p.sku, oi.sku) as product_sku,
          oi.listing_id as listing_id,
          SUM(oi.quantity) as qty_sold,
          COALESCE(SUM(oi.total_price - (oi.total_price * COALESCE(${refundAllocationExpression('o')}, 0))), 0) as revenue,
          COALESCE(SUM(oi.total_cost), 0) as cost,
          COALESCE(SUM(
            COALESCE(fi.item_fees, 0)
            + CASE
                WHEN COALESCE(ot.order_item_revenue, 0) > 0
                THEN COALESCE(fo.order_fees, 0) * oi.total_price / ot.order_item_revenue
                ELSE 0
              END
          ), 0) as fees,
          COALESCE(SUM(oi.total_price - (oi.total_price * COALESCE(${refundAllocationExpression('o')}, 0))), 0)
            - COALESCE(SUM(oi.total_cost), 0)
            - COALESCE(SUM(
                COALESCE(fi.item_fees, 0)
                + CASE
                    WHEN COALESCE(ot.order_item_revenue, 0) > 0
                    THEN COALESCE(fo.order_fees, 0) * oi.total_price / ot.order_item_revenue
                    ELSE 0
                  END
              ), 0) as profit
        FROM marketplace_orders o
        JOIN marketplace_order_items oi ON o.id = oi.order_id
        LEFT JOIN products p ON oi.product_id = p.id
        LEFT JOIN (
          SELECT f.order_item_id, SUM(f.amount) AS item_fees
          FROM marketplace_order_fees f
          WHERE f.fee_type = 'commission'
            AND f.order_item_id IS NOT NULL
            AND LOWER(COALESCE(f.status, '')) NOT IN ('cancelled', 'refunded')
          GROUP BY f.order_item_id
        ) fi ON oi.id = fi.order_item_id
        LEFT JOIN (
          SELECT f.order_id, SUM(f.amount) AS order_fees
          FROM marketplace_order_fees f
          WHERE f.fee_type = 'commission'
            AND f.order_item_id IS NULL
            AND LOWER(COALESCE(f.status, '')) NOT IN ('cancelled', 'refunded')
            AND NOT EXISTS (
              SELECT 1
              FROM marketplace_order_fees item_fee
              WHERE item_fee.order_id = f.order_id
                AND item_fee.order_item_id IS NOT NULL
                AND item_fee.fee_type = 'commission'
                AND LOWER(COALESCE(item_fee.status, '')) NOT IN ('cancelled', 'refunded')
            )
          GROUP BY f.order_id
        ) fo ON o.id = fo.order_id
        LEFT JOIN (
          SELECT order_id, SUM(total_price) AS order_item_revenue
          FROM marketplace_order_items
          GROUP BY order_id
        ) ot ON o.id = ot.order_id
        ${whereClause}
        GROUP BY p.id, p.name, p.sku, oi.title, oi.sku, oi.listing_id
        ORDER BY profit DESC
        LIMIT :limit
      `, {
        type: sequelize.QueryTypes.SELECT,
        replacements: { ...replacements, limit }
      });

      return results.map(row => ({
        product_id: row.product_id,
        product_name: row.product_name,
        product_sku: row.product_sku,
        listing_id: row.listing_id,
        qty_sold: parseInt(row.qty_sold || 0),
        revenue: parseFloat(row.revenue || 0),
        cost: parseFloat(row.cost || 0),
        fees: parseFloat(row.fees || 0),
        profit: parseFloat(row.profit || 0),
        margin: row.revenue > 0
          ? Math.round((row.profit / row.revenue) * 100 * 100) / 100
          : 0
      }));

    } catch (error) {
      logger.error('[MarketplaceReportingService] Error en getProfitByProduct: ' + error.message);
      throw error;
    }
  }

};

function refundedAmountExpression(alias = 'o') {
  return `COALESCE(${alias}.refunded_amount, (
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

function shippingCostExpression(alias = 'o') {
  const sellerCost = `COALESCE(${alias}.shipping_total, JSON_UNQUOTE(JSON_EXTRACT(${alias}.raw_payload, '$.shipping_financials.seller_cost')), 0)`;
  return `CASE
    WHEN ${alias}.shipment_id IS NULL THEN ${sellerCost}
    WHEN ${alias}.id = (
      SELECT MIN(shipment_order.id)
      FROM marketplace_orders shipment_order
      WHERE shipment_order.shipment_id = ${alias}.shipment_id
    ) THEN ${sellerCost}
    ELSE 0
  END`;
}

function refundAllocationExpression(alias = 'o') {
  return `CASE
    WHEN COALESCE(${alias}.total_amount, 0) > 0
    THEN LEAST(1, (${refundedAmountExpression(alias)}) / ${alias}.total_amount)
    ELSE 0
  END`;
}

function buildValidProfitOrderCondition(alias = 'o') {
  return `(
    LOWER(COALESCE(${alias}.order_status, '')) NOT IN ('cancelled', 'returned', 'refunded')
    AND LOWER(COALESCE(${alias}.payment_status, '')) NOT IN ('cancelled', 'refunded', 'charged_back')
    AND (
      LOWER(COALESCE(${alias}.order_status, '')) IN ('paid', 'shipped', 'delivered')
      OR LOWER(COALESCE(${alias}.payment_status, '')) IN ('paid', 'approved', 'authorized')
    )
  )`;
}

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
