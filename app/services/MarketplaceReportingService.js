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

const MarketplaceReportingService = {

  // ========================
  // SALES
  // ========================
  async getSalesReport(filters = {}) {
    try {
      const {
        from, to, marketplace, status,
        company_id, user_id,
        limit = 50, offset = 0
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

      const stats = await this.getSalesStats(filters);

      return {
        summary: {
          totalOrders: ordersResult.count,
          totalRevenue: stats.total_revenue || 0,
          totalSubtotal: stats.total_subtotal || 0,
          totalShipping: stats.total_shipping || 0,
          totalTax: stats.total_tax || 0
        },
        orders: ordersResult.rows.map(order => {
          const buyer = buildBuyerSummary(order);
          const seller = buildSellerSummary(order);

          return {
          id: order.id,
          marketplace: order.marketplace_credential_id,
          ...getMarketplaceMetaFromCredential(order.credential),
          orderRef: order.marketplace_order_id,
          date: order.createdAt,
          customer: buyer.name || buyer.nickname || buyer.id || 'N/A',
          buyer,
          seller,
          status: order.order_status,
          paymentStatus: order.payment_status,
          itemsCount: order.items?.length || 0,
          subtotal: parseFloat(order.subtotal || 0),
          shipping: parseFloat(order.shipping_total || 0),
          tax: parseFloat(order.tax_total || 0),
          total: parseFloat(order.total_amount || 0),
          invoiceNumber: order.invoice_number,
          invoiceType: order.invoice_type,
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

      const conditions = [];
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
        from, to, company_id,
        fee_type = 'commission',
        limit = 50, offset = 0
      } = filters;

      const feesResult = await MarketplaceOrderFeeRepository.findAndCountAll({
        filters: { from, to, company_id, fee_type },
        pagination: { limit, offset }
      });

      const stats = await this.getCommissionStats(filters);

      return {
        summary: {
          totalFees: feesResult.count,
          totalAmount: stats.total_amount || 0,
          byStatus: stats.by_status || {}
        },
        fees: feesResult.rows.map(fee => ({
          id: fee.id,
          orderId: fee.order_id,
          orderRef: fee.order?.marketplace_order_id,
          marketplace: fee.order?.marketplace_credential_id,
          ...getMarketplaceMetaFromCredential(fee.order?.credential),
          feeType: fee.fee_type,
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
      const { from, to, company_id, fee_type = 'commission' } = filters;

      const conditions = ['fee_type = :fee_type'];
      const replacements = { fee_type };

      const dateFilter = buildDateRange(from, to);
      conditions.push(...dateFilter.conditions);
      Object.assign(replacements, dateFilter.replacements);

      if (company_id) {
        conditions.push(`company_id = :company_id`);
        replacements.company_id = company_id;
      }

      const whereClause = `WHERE ${conditions.join(' AND ')}`;

      const totalResult = await sequelize.query(`
        SELECT COALESCE(SUM(amount), 0) as total_amount
        FROM marketplace_order_fees
        ${whereClause}
      `, {
        type: sequelize.QueryTypes.SELECT,
        replacements
      });

      const byStatusResult = await sequelize.query(`
        SELECT status, SUM(amount) as total_amount, COUNT(*) as count
        FROM marketplace_order_fees
        ${whereClause}
        GROUP BY status
      `, {
        type: sequelize.QueryTypes.SELECT,
        replacements
      });

      const byStatus = {};
      byStatusResult.forEach(row => {
        byStatus[row.status] = {
          total_amount: parseFloat(row.total_amount || 0),
          count: parseInt(row.count || 0)
        };
      });

      return {
        total_amount: parseFloat(totalResult?.[0]?.total_amount || 0),
        by_status: byStatus
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

      conditions.push("o.order_status = 'paid'");

      const whereClause = `WHERE ${conditions.join(' AND ')}`;

      const result = await sequelize.query(`
        SELECT
          COALESCE(SUM(o.total_amount), 0) as total_revenue,
          COALESCE(SUM(oi.total_cost), 0) as total_cost,
          COALESCE(SUM(f.total_fees), 0) as total_fees,
          COALESCE(SUM(o.total_amount), 0)
            - COALESCE(SUM(oi.total_cost), 0)
            - COALESCE(SUM(f.total_fees), 0) as gross_profit
        FROM marketplace_orders o
        LEFT JOIN (
          SELECT order_id, SUM(total_cost) as total_cost
          FROM marketplace_order_items
          GROUP BY order_id
        ) oi ON o.id = oi.order_id
        LEFT JOIN (
          SELECT order_id, SUM(amount) as total_fees
          FROM marketplace_order_fees
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
      const grossProfit = parseFloat(row.gross_profit || 0);

      const marginPercentage =
        totalRevenue > 0 ? (grossProfit / totalRevenue) * 100 : 0;

      return {
        total_revenue: totalRevenue,
        total_cost: totalCost,
        total_fees: totalFees,
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
      const { from, to, company_id } = filters;

      const conditions = [];
      const replacements = {};

      const dateFilter = buildDateRange(from, to, 'o');
      conditions.push(...dateFilter.conditions);
      Object.assign(replacements, dateFilter.replacements);

      if (company_id) {
        conditions.push('o.company_id = :company_id');
        replacements.company_id = company_id;
      }

      conditions.push("o.order_status = 'paid'");

      const whereClause = `WHERE ${conditions.join(' AND ')}`;

      const results = await sequelize.query(`
        SELECT
          o.marketplace_credential_id as marketplace,
          COALESCE(SUM(o.total_amount), 0) as revenue,
          COALESCE(SUM(oi.total_cost), 0) as cost,
          COALESCE(SUM(f.total_fees), 0) as fees,
          COALESCE(SUM(o.total_amount), 0)
            - COALESCE(SUM(oi.total_cost), 0)
            - COALESCE(SUM(f.total_fees), 0) as profit
        FROM marketplace_orders o
        LEFT JOIN (
          SELECT order_id, SUM(total_cost) as total_cost
          FROM marketplace_order_items
          GROUP BY order_id
        ) oi ON o.id = oi.order_id
        LEFT JOIN (
          SELECT order_id, SUM(amount) as total_fees
          FROM marketplace_order_fees
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
        fees: parseFloat(row.fees || 0),
        profit: parseFloat(row.profit || 0),
        margin: row.revenue > 0
          ? Math.round((row.profit / row.revenue) * 100 * 100) / 100
          : 0
      }));

    } catch (error) {
      logger.error('[MarketplaceReportingService] Error en getProfitByMarketplace: ' + error.message);
      throw error;
    }
  },

  async getProfitByProduct(filters = {}) {
    try {
      const { from, to, marketplace, company_id, limit = 20 } = filters;

      const conditions = [];
      const replacements = {};

      const dateFilter = buildDateRange(from, to, 'o');
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

      conditions.push("o.order_status = 'paid'");

      const whereClause = `WHERE ${conditions.join(' AND ')}`;

      const results = await sequelize.query(`
        SELECT
          p.id as product_id,
          p.name as product_name,
          p.sku as product_sku,
          SUM(oi.quantity) as qty_sold,
          COALESCE(SUM(oi.total_price), 0) as revenue,
          COALESCE(SUM(oi.total_cost), 0) as cost,
          COALESCE(SUM(f.amount), 0) as fees,
          COALESCE(SUM(oi.total_price), 0)
            - COALESCE(SUM(oi.total_cost), 0)
            - COALESCE(SUM(f.amount), 0) as profit
        FROM marketplace_orders o
        JOIN marketplace_order_items oi ON o.id = oi.order_id
        LEFT JOIN products p ON oi.product_id = p.id
        LEFT JOIN marketplace_order_fees f ON oi.id = f.order_item_id
        ${whereClause}
        GROUP BY p.id, p.name, p.sku
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
