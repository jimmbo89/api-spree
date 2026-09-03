const DashboardRepository = require('../repositories/DashboardRepository');
const { UserRepository } = require('../repositories');
const { getCalendarWindow, formatDateOnly } = require('../utils/dateRange');
const logger = require('../../config/logger');

const DASHBOARD_RANGE_DAYS = {
  '7d': 7,
  '30d': 30
};

function getCurrentMonthWindow(referenceDate = new Date()) {
  const start = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), 1);
  const endExclusive = new Date(referenceDate.getFullYear(), referenceDate.getMonth() + 1, 1);

  return { start, endExclusive };
}

function getPreviousMonthWindow(currentMonthStart) {
  const start = new Date(
    currentMonthStart.getFullYear(),
    currentMonthStart.getMonth() - 1,
    1
  );

  return { start, endExclusive: new Date(currentMonthStart) };
}

const DashboardController = {
  /**
   * Endpoint POST /api/dashboard
   * Retorna estadísticas completas del dashboard
   */
  async getDashboard(req, res) {
    try {
      const rawCompanyId = req.headers['x-company-id'] || req.body.company_id || null;
      const companyId = rawCompanyId ? Number(rawCompanyId) : null;
      const range = req.body?.range || 'month';
      const rangeDays = DASHBOARD_RANGE_DAYS[range];
      const isGlobalUser = await UserRepository.hasGlobalRole(req.user?.id);

      if (!rangeDays && range !== 'month') {
        return res.status(400).json({
          success: false,
          message: 'range debe ser month, 7d o 30d'
        });
      }

      if (!companyId && !isGlobalUser) {
        return res.status(400).json({
          success: false,
          message: 'Company-ID es requerido (enviar en header X-Company-ID o en body como company_id)'
        });
      }

      if (isGlobalUser && !companyId) {
        return res.status(200).json({
          success: true,
          data: {
            kpis: {
              sales: { value: 0, delta: 0, trend: 'up' },
              orders: { value: 0, delta: 0, trend: 'up' },
              issues: { value: 0, delta: 0, trend: 'up' },
              criticalStock: { value: 0, delta: 0, trend: 'up' }
            },
            sales: [],
            alerts: [],
            marketplaces: [],
            products: {
              topProducts: [],
              problemProducts: []
            },
            processes: []
          }
        });
      }

      // Períodos para comparación
      const currentPeriod = range === 'month'
        ? getCurrentMonthWindow()
        : getCalendarWindow(rangeDays);
      const previousPeriod = range === 'month'
        ? getPreviousMonthWindow(currentPeriod.start)
        : (() => {
          const previousReferenceDate = new Date(currentPeriod.start);
          previousReferenceDate.setDate(previousReferenceDate.getDate() - 1);
          return getCalendarWindow(rangeDays, previousReferenceDate);
        })();

      // === 1. KPIs ===
      const kpis = await calculateKPIs(
        companyId,
        currentPeriod.start,
        previousPeriod.start,
        currentPeriod.endExclusive
      );

      // === 2. Ventas por día (gráfico) ===
      const sales = await calculateSalesChart(companyId, currentPeriod.start, currentPeriod.endExclusive);

      // === 3. Alertas ===
      const alerts = await calculateAlerts(companyId);

      // === 4. Marketplaces ===
      const marketplacesUserId = companyId ? req.user?.id : null;
      const marketplaces = await calculateMarketplaces(companyId, marketplacesUserId);

      // === 5. Productos ===
      const products = await calculateProducts(companyId, currentPeriod.start, currentPeriod.endExclusive);

      // === 6. Actividad reciente ===
      // const activities = await calculateActivities(companyId);

      // === 7. Procesos con problemas ===
      const processes = await calculateProblemProcesses(companyId);

      return res.status(200).json({
        success: true,
        data: {
          kpis,
          sales,
          alerts,
          marketplaces,
          products,
          // activities,
          processes
        }
      });

    } catch (error) {
      logger.error('[DashboardController] Error:', error.message);
      return res.status(500).json({
        success: false,
        message: 'Error al obtener estadísticas del dashboard',
        error: error.message
      });
    }
  }
};

/**
 * Calcula los KPIs con delta y trend
 */
async function calculateKPIs(companyId, currentPeriodStart, previousPeriodStart, currentPeriodEndExclusive) {
  // Período actual
  const currentSales = await DashboardRepository.getSalesStats(companyId, currentPeriodStart, currentPeriodEndExclusive);
  const currentIssues = await DashboardRepository.getPublishingIssuesCount(companyId, currentPeriodStart, currentPeriodEndExclusive);
  const currentCriticalStock = await DashboardRepository.getCriticalStockCount(companyId);

  // Período anterior
  const previousSales = await DashboardRepository.getSalesStats(companyId, previousPeriodStart, currentPeriodStart);
  const previousIssues = await DashboardRepository.getPublishingIssuesCount(companyId, previousPeriodStart, currentPeriodStart);
  const previousCriticalStock = await DashboardRepository.getCriticalStockCount(companyId); // Stock es snapshot actual

  return {
    sales: calculateKPI(currentSales.totalSales, previousSales.totalSales),
    orders: calculateKPI(currentSales.totalOrders, previousSales.totalOrders),
    issues: calculateKPI(currentIssues, previousIssues),
    criticalStock: calculateKPI(currentCriticalStock, previousCriticalStock)
  };
}

/**
 * Calcula un KPI individual con delta y trend
 */
function calculateKPI(current, previous) {
  const value = current || 0;
  const delta = previous !== 0 ? ((value - previous) / previous) * 100 : 0;
  const trend = delta >= 0 ? 'up' : 'down';

  return {
    value: Math.round(value * 100) / 100, // Redondear a 2 decimales
    delta: Math.round(delta * 10) / 10, // Redondear a 1 decimal
    trend
  };
}

/**
 * Calcula las ventas por día para el gráfico
 */
async function calculateSalesChart(companyId, fromDate, toDate) {
  const salesByDay = await DashboardRepository.getSalesByDay(companyId, fromDate, toDate);
  
  // DATE(createdAt) llega como fecha SQL, no como instante UTC.
  return salesByDay.map(sale => {
    return {
      date: formatDateOnly(sale.date),
      value: Math.round(sale.value * 100) / 100
    };
  });
}

/**
 * Calcula las alertas del sistema
 */
async function calculateAlerts(companyId) {
  // Contar productos SIN stock (stock = 0) para la alerta de "sin stock"
  const outOfStockCount = await DashboardRepository.getOutOfStockCount(companyId);
  // Contar productos con stock bajo segun minimum_stock configurado
  const lowStockCount = await DashboardRepository.getCriticalStockCount(companyId);
  
  const publishingErrors = await DashboardRepository.getPublishingIssuesCount(companyId,
    new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    new Date()
  );

  const alerts = [];

  if (outOfStockCount > 0) {
    alerts.push({
      type: 'error',
      label: 'Productos sin stock',
      count: outOfStockCount,
      link: '/products?stock=out'
    });
  } else if (lowStockCount > 0) {
    // Si no hay productos sin stock pero sí con stock bajo, mostrar advertencia
    alerts.push({
      type: 'warning',
      label: 'Productos con stock bajo',
      count: lowStockCount,
      link: '/products?stock=low'
    });
  }

  if (publishingErrors > 0) {
    alerts.push({
      type: 'error',
      label: 'Errores de publicación',
      count: publishingErrors,
      link: '/procesos?status=error'
    });
  }

  // Aquí se pueden agregar más tipos de alertas en el futuro
  // Por ejemplo: pending sync, etc.

  return alerts;
}

/**
 * Calcula el estado de los marketplaces
 */
async function calculateMarketplaces(companyId, userId) {
  return await DashboardRepository.getMarketplaces(companyId, userId);
}

/**
 * Calcula información de productos (top y problemáticos)
 */
async function calculateProducts(companyId, fromDate, toDate) {
  const topProducts = await DashboardRepository.getTopProducts(companyId, fromDate, toDate, 3);
  const problemProducts = await DashboardRepository.getProblemProducts(companyId, 3);

  return {
    topProducts,
    problemProducts
  };
}

/**
 * Calcula la actividad reciente
 */
async function calculateActivities(companyId) {
  return await DashboardRepository.getRecentActivities(companyId, 5);
}

/**
 * Calcula procesos finalizados con problemas
 */
async function calculateProblemProcesses(companyId) {
  return await DashboardRepository.getProblemProcesses(companyId, 5);
}

module.exports = DashboardController;
