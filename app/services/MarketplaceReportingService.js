const {
  MarketplaceOrderRepository,
  MarketplaceOrderItemRepository,
  MarketplaceOrderFeeRepository
} = require('../repositories');
const { sequelize } = require('../models');
const logger = require('../../config/logger');

const MarketplaceReportingService = {
  /**
   * Obtiene reporte de ventas
   * @param {Object} filters - Filtros de búsqueda
   * @returns {Promise<Object>} Reporte de ventas
   */
  async getSalesReport(filters = {}) {
    try {
      const {
        from,
        to,
        marketplace,
        status,
        company_id,
        user_id,
        product_id,
        limit = 50,
        offset = 0
      } = filters;

      // Obtener órdenes con filtros
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

      // Calcular totales
      const stats = await this.getSalesStats({
        from,
        to,
        marketplace,
        company_id,
        user_id
      });

      return {
        summary: {
          totalOrders: ordersResult.count,
          totalRevenue: stats.total_revenue || 0,
          totalSubtotal: stats.total_subtotal || 0,
          totalShipping: stats.total_shipping || 0,
          totalTax: stats.total_tax || 0
        },
        orders: ordersResult.rows.map(order => ({
          id: order.id,
          marketplace: order.marketplace,
          orderRef: order.marketplace_order_id,
          date: order.createdAt,
          customer: order.buyer_name || order.buyer_id || 'N/A',
          status: order.order_status,
          paymentStatus: order.payment_status,
          itemsCount: order.items?.length || 0,
          subtotal: parseFloat(order.subtotal || 0),
          shipping: parseFloat(order.shipping_total || 0),
          tax: parseFloat(order.tax_total || 0),
          total: parseFloat(order.total_amount || 0),
          invoiceNumber: order.invoice_number,
          invoiceType: order.invoice_type
        }))
      };
    } catch (error) {
      logger.error('[MarketplaceReportingService] Error en getSalesReport:', error.message);
      throw error;
    }
  },

  /**
   * Obtiene estadísticas de ventas
   * @param {Object} filters - Filtros de búsqueda
   * @returns {Promise<Object>} Estadísticas
   */
  async getSalesStats(filters = {}) {
    try {
      const {
        from,
        to,
        marketplace,
        company_id,
        user_id
      } = filters;

      const where = [];
      const params = [];

      if (marketplace) {
        where.push('marketplace = :marketplace');
        params.push({ marketplace });
      }
      if (company_id) {
        where.push('company_id = :company_id');
        params.push({ company_id });
      }
      if (user_id) {
        where.push('user_id = :user_id');
        params.push({ user_id });
      }
      if (from) {
        where.push('"createdAt" >= :from');
        params.push({ from: new Date(from) });
      }
      if (to) {
        where.push('"createdAt" <= :to');
        params.push({ to: new Date(to) });
      }

      const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

      const [result] = await sequelize.query(`
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
        replacements: Object.assign({}, ...params)
      });

      return {
        total_orders: parseInt(result.total_orders || 0),
        total_revenue: parseFloat(result.total_revenue || 0),
        total_subtotal: parseFloat(result.total_subtotal || 0),
        total_shipping: parseFloat(result.total_shipping || 0),
        total_tax: parseFloat(result.total_tax || 0)
      };
    } catch (error) {
      logger.error('[MarketplaceReportingService] Error en getSalesStats:', error.message);
      throw error;
    }
  },

  /**
   * Obtiene reporte de comisiones
   * @param {Object} filters - Filtros de búsqueda
   * @returns {Promise<Object>} Reporte de comisiones
   */
  async getCommissionReport(filters = {}) {
    try {
      const {
        from,
        to,
        marketplace,
        status,
        company_id,
        fee_type = 'commission',
        limit = 50,
        offset = 0
      } = filters;

      // Obtener fees con filtros
      const feesResult = await MarketplaceOrderFeeRepository.findAndCountAll({
        filters: {
          from,
          to,
          company_id,
          fee_type,
          status
        },
        pagination: { limit, offset }
      });

      // Calcular totales por estado
      const stats = await this.getCommissionStats({
        from,
        to,
        marketplace,
        company_id,
        fee_type
      });

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
          marketplace: fee.order?.marketplace,
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
      logger.error('[MarketplaceReportingService] Error en getCommissionReport:', error.message);
      throw error;
    }
  },

  /**
   * Obtiene estadísticas de comisiones
   * @param {Object} filters - Filtros de búsqueda
   * @returns {Promise<Object>} Estadísticas
   */
  async getCommissionStats(filters = {}) {
    try {
      const {
        from,
        to,
        marketplace,
        company_id,
        fee_type = 'commission'
      } = filters;

      const where = ['fee_type = :fee_type'];
      const params = { fee_type };

      if (company_id) {
        where.push('company_id = :company_id');
        params.company_id = company_id;
      }
      if (from) {
        where.push('"createdAt" >= :from');
        params.from = new Date(from);
      }
      if (to) {
        where.push('"createdAt" <= :to');
        params.to = new Date(to);
      }

      const whereClause = where.join(' AND ');

      // Total general
      const [totalResult] = await sequelize.query(`
        SELECT
          COALESCE(SUM(amount), 0) as total_amount
        FROM marketplace_order_fees
        WHERE ${whereClause}
      `, {
        type: sequelize.QueryTypes.SELECT,
        replacements: params
      });

      // Por estado
      const [byStatusResult] = await sequelize.query(`
        SELECT
          status,
          COALESCE(SUM(amount), 0) as total_amount,
          COUNT(*) as count
        FROM marketplace_order_fees
        WHERE ${whereClause}
        GROUP BY status
      `, {
        type: sequelize.QueryTypes.SELECT,
        replacements: params
      });

      const byStatus = {};
      byStatusResult.forEach(row => {
        byStatus[row.status] = {
          total_amount: parseFloat(row.total_amount || 0),
          count: parseInt(row.count || 0)
        };
      });

      return {
        total_amount: parseFloat(totalResult.total_amount || 0),
        by_status: byStatus
      };
    } catch (error) {
      logger.error('[MarketplaceReportingService] Error en getCommissionStats:', error.message);
      throw error;
    }
  },

  /**
   * Obtiene reporte de ganancias
   * @param {Object} filters - Filtros de búsqueda
   * @param {String} groupBy - Agrupamiento (day, week, month, product, marketplace)
   * @returns {Promise<Object>} Reporte de ganancias
   */
  async getProfitReport(filters = {}, groupBy = 'marketplace') {
    try {
      const {
        from,
        to,
        marketplace,
        company_id,
        user_id
      } = filters;

      // Obtener estadísticas generales
      const stats = await this.getProfitStats({
        from,
        to,
        marketplace,
        company_id,
        user_id
      });

      // Obtener desglose por marketplace
      const byMarketplace = await this.getProfitByMarketplace({
        from,
        to,
        company_id
      });

      // Obtener desglose por producto
      const byProduct = await this.getProfitByProduct({
        from,
        to,
        marketplace,
        company_id,
        limit: 20
      });

      return {
        summary: {
          totalRevenue: stats.total_revenue || 0,
          totalCost: stats.total_cost || 0,
          totalFees: stats.total_fees || 0,
          grossProfit: stats.gross_profit || 0,
          marginPercentage: stats.margin_percentage || 0
        },
        byMarketplace,
        byProduct,
        topProducts: byProduct.slice(0, 10)
      };
    } catch (error) {
      logger.error('[MarketplaceReportingService] Error en getProfitReport:', error.message);
      throw error;
    }
  },

  /**
   * Obtiene estadísticas de ganancias
   * @param {Object} filters - Filtros de búsqueda
   * @returns {Promise<Object>} Estadísticas
   */
  async getProfitStats(filters = {}) {
    try {
      const {
        from,
        to,
        marketplace,
        company_id,
        user_id
      } = filters;

      const where = [];
      const params = [];

      if (marketplace) {
        where.push('o.marketplace = :marketplace');
        params.push({ marketplace });
      }
      if (company_id) {
        where.push('o.company_id = :company_id');
        params.push({ company_id });
      }
      if (user_id) {
        where.push('o.user_id = :user_id');
        params.push({ user_id });
      }
      if (from) {
        where.push('o."createdAt" >= :from');
        params.push({ from: new Date(from) });
      }
      if (to) {
        where.push('o."createdAt" <= :to');
        params.push({ to: new Date(to) });
      }

      const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

      const [result] = await sequelize.query(`
        SELECT
          COALESCE(SUM(o.total_amount), 0) as total_revenue,
          COALESCE(SUM(oi.total_cost), 0) as total_cost,
          COALESCE(SUM(f.amount), 0) as total_fees,
          COALESCE(SUM(o.total_amount), 0) - COALESCE(SUM(oi.total_cost), 0) - COALESCE(SUM(f.amount), 0) as gross_profit
        FROM marketplace_orders o
        LEFT JOIN marketplace_order_items oi ON o.id = oi.order_id
        LEFT JOIN marketplace_order_fees f ON o.id = f.order_id
        ${whereClause}
        AND o.order_status = 'paid'
      `, {
        type: sequelize.QueryTypes.SELECT,
        replacements: Object.assign({}, ...params)
      });

      const totalRevenue = parseFloat(result.total_revenue || 0);
      const totalCost = parseFloat(result.total_cost || 0);
      const totalFees = parseFloat(result.total_fees || 0);
      const grossProfit = parseFloat(result.gross_profit || 0);
      const marginPercentage = totalRevenue > 0 ? (grossProfit / totalRevenue) * 100 : 0;

      return {
        total_revenue: totalRevenue,
        total_cost: totalCost,
        total_fees: totalFees,
        gross_profit: grossProfit,
        margin_percentage: Math.round(marginPercentage * 100) / 100
      };
    } catch (error) {
      logger.error('[MarketplaceReportingService] Error en getProfitStats:', error.message);
      throw error;
    }
  },

  /**
   * Obtiene ganancias por marketplace
   * @param {Object} filters - Filtros de búsqueda
   * @returns {Promise<Array>} Ganancias por marketplace
   */
  async getProfitByMarketplace(filters = {}) {
    try {
      const {
        from,
        to,
        company_id
      } = filters;

      const where = [];
      const params = [];

      if (company_id) {
        where.push('o.company_id = :company_id');
        params.push({ company_id });
      }
      if (from) {
        where.push('o."createdAt" >= :from');
        params.push({ from: new Date(from) });
      }
      if (to) {
        where.push('o."createdAt" <= :to');
        params.push({ to: new Date(to) });
      }

      const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

      const results = await sequelize.query(`
        SELECT
          o.marketplace,
          COALESCE(SUM(o.total_amount), 0) as revenue,
          COALESCE(SUM(oi.total_cost), 0) as cost,
          COALESCE(SUM(f.amount), 0) as fees,
          COALESCE(SUM(o.total_amount), 0) - COALESCE(SUM(oi.total_cost), 0) - COALESCE(SUM(f.amount), 0) as profit
        FROM marketplace_orders o
        LEFT JOIN marketplace_order_items oi ON o.id = oi.order_id
        LEFT JOIN marketplace_order_fees f ON o.id = f.order_id
        ${whereClause}
        AND o.order_status = 'paid'
        GROUP BY o.marketplace
      `, {
        type: sequelize.QueryTypes.SELECT,
        replacements: Object.assign({}, ...params)
      });

      return results.map(row => ({
        marketplace: row.marketplace,
        revenue: parseFloat(row.revenue || 0),
        cost: parseFloat(row.cost || 0),
        fees: parseFloat(row.fees || 0),
        profit: parseFloat(row.profit || 0),
        margin: row.revenue > 0 ? Math.round((parseFloat(row.profit || 0) / parseFloat(row.revenue || 0)) * 100 * 100) / 100 : 0
      }));
    } catch (error) {
      logger.error('[MarketplaceReportingService] Error en getProfitByMarketplace:', error.message);
      throw error;
    }
  },

  /**
   * Obtiene ganancias por producto
   * @param {Object} filters - Filtros de búsqueda
   * @returns {Promise<Array>} Ganancias por producto
   */
  async getProfitByProduct(filters = {}) {
    try {
      const {
        from,
        to,
        marketplace,
        company_id,
        limit = 20
      } = filters;

      const where = [];
      const params = { limit };

      if (marketplace) {
        where.push('o.marketplace = :marketplace');
        params.marketplace = marketplace;
      }
      if (company_id) {
        where.push('o.company_id = :company_id');
        params.company_id = company_id;
      }
      if (from) {
        where.push('o."createdAt" >= :from');
        params.from = new Date(from);
      }
      if (to) {
        where.push('o."createdAt" <= :to');
        params.to = new Date(to);
      }

      const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

      const results = await sequelize.query(`
        SELECT
          p.id as product_id,
          p.name as product_name,
          p.sku as product_sku,
          SUM(oi.quantity) as qty_sold,
          COALESCE(SUM(oi.total_price), 0) as revenue,
          COALESCE(SUM(oi.total_cost), 0) as cost,
          COALESCE(SUM(f.amount), 0) as fees,
          COALESCE(SUM(oi.total_price), 0) - COALESCE(SUM(oi.total_cost), 0) - COALESCE(SUM(f.amount), 0) as profit
        FROM marketplace_orders o
        JOIN marketplace_order_items oi ON o.id = oi.order_id
        LEFT JOIN products p ON oi.product_id = p.id
        LEFT JOIN marketplace_order_fees f ON oi.id = f.order_item_id
        ${whereClause}
        AND o.order_status = 'paid'
        GROUP BY p.id, p.name, p.sku
        ORDER BY profit DESC
        LIMIT :limit
      `, {
        type: sequelize.QueryTypes.SELECT,
        replacements: params
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
        margin: row.revenue > 0 ? Math.round((parseFloat(row.profit || 0) / parseFloat(row.revenue || 0)) * 100 * 100) / 100 : 0
      }));
    } catch (error) {
      logger.error('[MarketplaceReportingService] Error en getProfitByProduct:', error.message);
      throw error;
    }
  }
};

module.exports = MarketplaceReportingService;
