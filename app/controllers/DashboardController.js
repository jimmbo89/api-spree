const DashboardRepository = require('../repositories/DashboardRepository');
const logger = require('../../config/logger');

const DashboardController = {
  /**
   * Endpoint POST /api/dashboard
   * Retorna estadísticas completas del dashboard
   */
  async getDashboard(req, res) {
    try {
      // Obtener companyId del header o body
      const companyId = req.headers['x-company-id'] || req.body.company_id;
      
      if (!companyId) {
        return res.status(400).json({
          success: false,
          message: 'Company-ID es requerido (enviar en header X-Company-ID o en body como company_id)'
        });
      }

      // Períodos para comparación
      const now = new Date();
      const currentPeriodStart = new Date(now);
      currentPeriodStart.setDate(now.getDate() - 7);
      
      const previousPeriodStart = new Date(currentPeriodStart);
      previousPeriodStart.setDate(previousPeriodStart.getDate() - 7);

      // === 1. KPIs ===
      const kpis = await calculateKPIs(companyId, currentPeriodStart, previousPeriodStart, now);

      // === 2. Ventas por día (gráfico) ===
      const sales = await calculateSalesChart(companyId, currentPeriodStart, now);

      // === 3. Alertas ===
      const alerts = await calculateAlerts(companyId);

      // === 4. Marketplaces ===
      const marketplaces = await calculateMarketplaces(companyId, req.user?.id);

      // === 5. Productos ===
      const products = await calculateProducts(companyId, currentPeriodStart, now);

      // === 6. Actividad reciente ===
      const activities = await calculateActivities(companyId);

      return res.status(200).json({
        success: true,
        data: {
          kpis,
          sales,
          alerts,
          marketplaces,
          products,
          activities
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
async function calculateKPIs(companyId, currentPeriodStart, previousPeriodStart, now) {
  // Período actual
  const currentSales = await DashboardRepository.getSalesStats(companyId, currentPeriodStart, now);
  const currentIssues = await DashboardRepository.getPublishingIssuesCount(companyId, currentPeriodStart, now);
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
  
  // Formatear fechas a "DD/MM"
  return salesByDay.map(sale => {
    const date = new Date(sale.date);
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    return {
      date: `${day}/${month}`,
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
  // Contar productos con stock bajo (stock <= 5) para referencia
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

module.exports = DashboardController;
