const { 
  MarketplaceOrder, 
  MarketplaceOrderItem, 
  WarehouseProductVariant, 
  WarehouseProduct,
  Warehouse,
  Product, 
  ProductPublishingTask,
  Marketplace,
  ProductMarketplaceLink,
  JobProduct,
  Job,
  InventoryMovement
} = require('../models');
const { Op, fn, col, literal } = require('sequelize');
const logger = require('../../config/logger');

const DashboardRepository = {
  /**
   * Obtiene estadísticas de ventas para un período
   * @param {number} companyId - ID de la empresa
   * @param {Date} fromDate - Fecha inicio del período
   * @param {Date} toDate - Fecha fin del período
   * @returns {Promise<{totalSales: number, totalOrders: number}>}
   */
  async getSalesStats(companyId, fromDate, toDate) {
    try {
      const result = await MarketplaceOrder.findOne({
        where: {
          company_id: companyId,
          order_status: 'paid',
          createdAt: {
            [Op.gte]: fromDate,
            [Op.lte]: toDate
          }
        },
        attributes: [
          [fn('SUM', col('total_amount')), 'totalSales'],
          [fn('COUNT', col('id')), 'totalOrders']
        ],
        raw: true
      });

      return {
        totalSales: parseFloat(result?.totalSales || 0),
        totalOrders: parseInt(result?.totalOrders || 0)
      };
    } catch (error) {
      logger.error('[DashboardRepository] Error en getSalesStats:', error.message);
      throw error;
    }
  },

  /**
   * Obtiene ventas agrupadas por día para el gráfico
   * @param {number} companyId - ID de la empresa
   * @param {Date} fromDate - Fecha inicio
   * @param {Date} toDate - Fecha fin
   * @returns {Promise<Array<{date: string, value: number}>>}
   */
  async getSalesByDay(companyId, fromDate, toDate) {
    try {
      const results = await MarketplaceOrder.findAll({
        where: {
          company_id: companyId,
          order_status: 'paid',
          createdAt: {
            [Op.gte]: fromDate,
            [Op.lte]: toDate
          }
        },
        attributes: [
          [fn('DATE', col('createdAt')), 'date'],
          [fn('SUM', col('total_amount')), 'value']
        ],
        group: [fn('DATE', col('createdAt'))],
        order: [[fn('DATE', col('createdAt')), 'ASC']],
        raw: true
      });

      return results.map(row => ({
        date: row.date, // Formato YYYY-MM-DD, se formateará en el controller
        value: parseFloat(row.value || 0)
      }));
    } catch (error) {
      logger.error('[DashboardRepository] Error en getSalesByDay:', error.message);
      throw error;
    }
  },

  /**
   * Cuenta productos con stock crítico (stock <= 0 o stock bajo threshold)
   * @param {number} companyId - ID de la empresa
   * @param {number} threshold - Umbral de stock crítico (default: 5)
   * @returns {Promise<number>}
   */
  async getCriticalStockCount(companyId, threshold = 5) {
    try {
      const count = await WarehouseProductVariant.count({
        include: [{
          model: WarehouseProduct,
          as: 'warehouseProduct',
          include: [{
            model: Product,
            as: 'product',
            where: {
              company_id: companyId
            },
            attributes: []
          }],
          attributes: []
        }],
        where: {
          stock: {
            [Op.lte]: threshold
          }
        },
        distinct: true
      });

      return count;
    } catch (error) {
      logger.error('[DashboardRepository] Error en getCriticalStockCount:', error.message);
      throw error;
    }
  },

  /**
   * Obtiene conteo de problemas de publicación (errores + pendientes)
   * @param {number} companyId - ID de la empresa
   * @param {Date} fromDate - Fecha inicio
   * @param {Date} toDate - Fecha fin
   * @returns {Promise<number>}
   */
  async getPublishingIssuesCount(companyId, fromDate, toDate) {
    try {
      const failed = await ProductPublishingTask.count({
        where: {
          company_id: companyId,
          status: {
            [Op.in]: ['failed', 'pending', 'processing']
          },
          createdAt: {
            [Op.gte]: fromDate,
            [Op.lte]: toDate
          }
        }
      });

      return failed;
    } catch (error) {
      logger.error('[DashboardRepository] Error en getPublishingIssuesCount:', error.message);
      throw error;
    }
  },

  /**
   * Obtiene los top productos más vendidos
   * @param {number} companyId - ID de la empresa
   * @param {Date} fromDate - Fecha inicio
   * @param {Date} toDate - Fecha fin
   * @param {number} limit - Límite de productos (default: 3)
   * @returns {Promise<Array<{id: number, name: string, value: number, image: string}>>}
   */
  async getTopProducts(companyId, fromDate, toDate, limit = 3) {
    try {
      const results = await MarketplaceOrderItem.findAll({
        include: [{
          model: Product,
          as: 'product',
          attributes: ['id', 'name', 'images']
        }, {
          model: MarketplaceOrder,
          as: 'order',
          attributes: [],
          where: {
            company_id: companyId,
            order_status: 'paid',
            createdAt: {
              [Op.gte]: fromDate,
              [Op.lte]: toDate
            }
          }
        }],
        attributes: [
          'product_id',
          [fn('SUM', col('quantity')), 'total_quantity']
        ],
        group: ['product_id', 'product.id', 'product.name', 'product.images'],
        order: [[fn('SUM', col('quantity')), 'DESC']],
        limit: limit,
        raw: true
      });

      return results.map(row => {
        // Parsear imagen principal
        let mainImage = null;
        try {
          const images = typeof row['product.images'] === 'string' 
            ? JSON.parse(row['product.images']) 
            : row['product.images'];
          mainImage = images && images.length > 0 ? images[0] : null;
        } catch (e) {
          mainImage = null;
        }

        return {
          id: row.product_id,
          name: row['product.name'],
          value: parseInt(row.total_quantity || 0),
          image: mainImage
        };
      });
    } catch (error) {
      logger.error('[DashboardRepository] Error en getTopProducts:', error.message);
      throw error;
    }
  },

  /**
   * Obtiene productos con problemas (stock bajo o errores de publicación)
   * @param {number} companyId - ID de la empresa
   * @param {number} limit - Límite (default: 3)
   * @returns {Promise<Array<{id: number, name: string, status: string, image: string, warehouses: Array<{id: number, name: string, stock: number}>}>>}
   */
  async getProblemProducts(companyId, limit = 3) {
    try {
      const problemProductsMap = {}; // Usar mapa para agrupar por producto

      // 1. Productos con stock bajo - buscar en todas las variantes de todos los almacenes
      const lowStockVariants = await WarehouseProductVariant.findAll({
        include: [
          {
            model: WarehouseProduct,
            as: 'warehouseProduct',
            include: [
              {
                model: Product,
                as: 'product',
                where: { company_id: companyId },
                attributes: ['id', 'name', 'images']
              },
              {
                model: Warehouse,
                as: 'warehouse',
                attributes: ['id', 'name']
              }
            ],
            attributes: ['id']
          }
        ],
        where: {
          stock: {
            [Op.lte]: 5
          }
        },
        attributes: ['stock'],
        raw: true
      });

      // Agrupar por producto y detallar warehouses
      lowStockVariants.forEach(variant => {
        const productId = variant['warehouseProduct.product.id'];
        const productName = variant['warehouseProduct.product.name'];
        const productImages = variant['warehouseProduct.product.images'];
        const warehouseId = variant['warehouseProduct.warehouse.id'];
        const warehouseName = variant['warehouseProduct.warehouse.name'];
        const stock = parseInt(variant.stock || 0);

        if (!problemProductsMap[productId]) {
          // Parsear imágenes (es un JSON array)
          let mainImage = null;
          try {
            const images = typeof productImages === 'string' 
              ? JSON.parse(productImages) 
              : productImages;
            mainImage = images && images.length > 0 ? images[0] : null;
          } catch (e) {
            mainImage = null;
          }

          problemProductsMap[productId] = {
            id: productId,
            name: productName,
            status: 'low_stock',
            image: mainImage,
            warehouses: []
          };
        }

        // Agregar warehouse con su stock
        problemProductsMap[productId].warehouses.push({
          id: warehouseId,
          name: warehouseName,
          stock: stock
        });
      });

      // 2. Productos con errores de publicación
      const errorProducts = await ProductPublishingTask.findAll({
        include: [
          {
            model: Product,
            as: 'product',
            where: { company_id: companyId },
            attributes: ['id', 'name', 'images']
          }
        ],
        where: {
          status: 'failed'
        },
        attributes: ['product_id'],
        limit: limit * 2,
        raw: true
      });

      errorProducts.forEach(task => {
        const productId = task['product.id'];
        const productName = task['product.name'];
        const productImages = task['product.images'];

        if (!problemProductsMap[productId]) {
          let mainImage = null;
          try {
            const images = typeof productImages === 'string' 
              ? JSON.parse(productImages) 
              : productImages;
            mainImage = images && images.length > 0 ? images[0] : null;
          } catch (e) {
            mainImage = null;
          }

          problemProductsMap[productId] = {
            id: productId,
            name: productName,
            status: 'error',
            image: mainImage,
            warehouses: []
          };
        }
      });

      // Convertir mapa a array
      const problemProducts = Object.values(problemProductsMap);

      // Calcular stock total y ordenar: primero por status (error primero), luego por stock total ascendente
      problemProducts.sort((a, b) => {
        if (a.status === 'error' && b.status !== 'error') return -1;
        if (a.status !== 'error' && b.status === 'error') return 1;
        
        // Si ambos son low_stock, ordenar por stock total (menor primero)
        const stockA = a.warehouses.reduce((sum, w) => sum + w.stock, 0);
        const stockB = b.warehouses.reduce((sum, w) => sum + w.stock, 0);
        return stockA - stockB;
      });

      return problemProducts.slice(0, limit);
    } catch (error) {
      logger.error('[DashboardRepository] Error en getProblemProducts:', error.message);
      throw error;
    }
  },

  /**
   * Obtiene el estado de todos los marketplaces de la empresa
   * @param {number} companyId - ID de la empresa
   * @returns {Promise<Array<{name: string, domain: string, status: string, summary: string, link: string}>>}
   */
  async getMarketplaces(companyId) {
    try {
      // 1. Obtener todos los marketplaces activos que tengan publicaciones de esta empresa
      const marketplaces = await Marketplace.findAll({
        include: [{
          model: ProductMarketplaceLink,
          as: 'productLinks',
          where: {
            company_id: companyId
          },
          attributes: ['status'],
          required: false
        }],
        where: {
          active: true
        },
        attributes: ['id', 'name', 'domain'],
        raw: false,
        distinct: true
      });

      // 2. Obtener conteo de JobProduct por marketplace (errores y pendientes)
      const jobProducts = await JobProduct.findAll({
        include: [{
          model: Job,
          as: 'job',
          where: {
            company_id: companyId
          },
          attributes: [],
          required: true
        }],
        attributes: ['marketplace_id', 'status'],
        raw: true
      });

      // Agrupar JobProduct por marketplace
      const jobProductsByMarketplace = {};
      jobProducts.forEach(jp => {
        const mpId = jp.marketplace_id;
        if (!jobProductsByMarketplace[mpId]) {
          jobProductsByMarketplace[mpId] = {
            success: 0,
            error: 0,
            pending: 0,
            processing: 0,
            retrying: 0
          };
        }
        jobProductsByMarketplace[mpId][jp.status] = (jobProductsByMarketplace[mpId][jp.status] || 0) + 1;
      });

      // 3. Construir respuesta por marketplace
      const result = marketplaces.map(marketplace => {
        const mpId = marketplace.id;
        const links = marketplace.productLinks || [];
        const jobStats = jobProductsByMarketplace[mpId] || {
          success: 0,
          error: 0,
          pending: 0,
          processing: 0,
          retrying: 0
        };

        // Calcular métricas reales
        const publishedCount = links.filter(l => l.status === 'published' || l.status === 'published_with_warnings').length;
        const errors = jobStats.error;
        const pending = jobStats.pending + jobStats.processing + jobStats.retrying;

        // Determinar estado según reglas del dashboard
        let status = 'healthy';
        let summary = '';

        if (errors > 0) {
          status = 'error';
          summary = `${errors} error${errors > 1 ? 'es' : ''} de publicación`;
        } else if (pending > 5) {
          status = 'warning';
          summary = `${pending} pendientes de sincronización`;
        } else if (publishedCount > 0) {
          status = 'healthy';
          summary = `${publishedCount} publicacione${publishedCount > 1 ? 's' : ''} activa${publishedCount > 1 ? 's' : ''}`;
        } else {
          status = 'healthy';
          summary = 'Sin publicaciones';
        }

        // Construir link para navegación (usar dominio para consistencia)
        const domainSlug = marketplace.domain
          ? marketplace.domain.replace(/\./g, '-').toLowerCase()
          : marketplace.name.toLowerCase().replace(/\s+/g, '-');

        return {
          name: marketplace.name,
          domain: marketplace.domain,
          status: status,
          summary: summary,
          link: `/procesos?marketplace=${domainSlug}`
        };
      });

      return result;
    } catch (error) {
      logger.error('[DashboardRepository] Error en getMarketplaces:', error.message);
      throw error;
    }
  },

  /**
   * Obtiene la actividad reciente de la empresa (publicaciones, errores, jobs, órdenes, stock)
   * @param {number} companyId - ID de la empresa
   * @param {number} limit - Límite de actividades (default: 5)
   * @returns {Promise<Array<{message: string, type: string, timestamp: string, link: string}>>}
   */
  async getRecentActivities(companyId, limit = 5) {
    try {
      const activities = [];
      const now = new Date();

      // 1. Obtener ProductPublishingTask recientes (publicaciones y errores)
      const publishingTasks = await ProductPublishingTask.findAll({
        where: {
          company_id: companyId,
          status: {
            [Op.in]: ['published', 'published_with_warnings', 'failed']
          }
        },
        include: [
          {
            model: Product,
            as: 'product',
            attributes: ['id', 'name']
          },
          {
            model: Marketplace,
            as: 'marketplace',
            attributes: ['id', 'name']
          }
        ],
        order: [['createdAt', 'DESC']],
        limit: limit * 2,
        raw: true
      });

      publishingTasks.forEach(task => {
        const productName = task['product.name'] || 'Producto';
        const marketplaceName = task['marketplace.name'] || 'Marketplace';
        const createdAt = new Date(task.createdAt);

        let message = '';
        let type = '';

        if (task.status === 'published') {
          message = `Producto "${productName}" publicado en ${marketplaceName}`;
          type = 'success';
        } else if (task.status === 'published_with_warnings') {
          message = `Producto "${productName}" publicado en ${marketplaceName} con advertencias`;
          type = 'warning';
        } else if (task.status === 'failed') {
          const errorMsg = task.error_message || 'Error desconocido';
          const shortError = errorMsg.length > 60 ? errorMsg.substring(0, 60) + '...' : errorMsg;
          message = `Error al publicar en ${marketplaceName} - ${shortError}`;
          type = 'error';
        }

        activities.push({
          message,
          type,
          timestamp: formatRelativeTime(createdAt),
          link: `/procesos/${task.id}`,
          createdAt
        });
      });

      // 2. Obtener Jobs recientes completados o con errores
      const recentJobs = await Job.findAll({
        where: {
          company_id: companyId,
          status: {
            [Op.in]: ['completed', 'completed_with_errors', 'failed']
          },
          job_type: {
            [Op.ne]: 'draft'
          }
        },
        order: [['createdAt', 'DESC']],
        limit: limit,
        raw: true
      });

      recentJobs.forEach(job => {
        const createdAt = new Date(job.createdAt);
        
        let message = '';
        let type = '';

        if (job.status === 'completed') {
          message = `Proceso de publicación completado - ${job.successful} productos publicados`;
          type = 'success';
        } else if (job.status === 'completed_with_errors') {
          message = `Proceso completado con errores - ${job.successful} publicados, ${job.errors_count} errores`;
          type = 'warning';
        } else if (job.status === 'failed') {
          message = `Proceso de publicación fallido`;
          type = 'error';
        }

        if (message) {
          activities.push({
            message,
            type,
            timestamp: formatRelativeTime(createdAt),
            link: `/procesos/${job.id}`,
            createdAt
          });
        }
      });

      // 3. Obtener órdenes nuevas de marketplaces
      const newOrders = await MarketplaceOrder.findAll({
        where: {
          company_id: companyId,
          order_status: 'paid',
          payment_status: 'paid'
        },
        attributes: ['id', 'marketplace', 'total_amount', 'buyer_name', 'createdAt'],
        order: [['createdAt', 'DESC']],
        limit: limit,
        raw: true
      });

      newOrders.forEach(order => {
        const createdAt = new Date(order.createdAt);
        const marketplaceName = order.marketplace || 'Marketplace';
        const total = parseFloat(order.total_amount || 0).toLocaleString('es-CL');
        const buyerName = order.buyer_name || 'Cliente';

        activities.push({
          message: `Nueva orden #${order.id} de ${marketplaceName} - $${total} (${buyerName})`,
          type: 'success',
          timestamp: formatRelativeTime(createdAt),
          link: `/ordenes/${order.id}`,
          createdAt
        });
      });

      // 4. Obtener movimientos de stock relevantes (ajustes y transferencias)
      const stockMovements = await InventoryMovement.findAll({
        where: {
          company_id: companyId,
          movement_type: {
            [Op.in]: ['adjustment', 'transfer', 'manual']
          },
          quantity: {
            [Op.gte]: 10 // Solo movimientos significativos (>= 10 unidades)
          }
        },
        include: [
          {
            model: Product,
            as: 'product',
            attributes: ['id', 'name']
          },
          {
            model: Warehouse,
            as: 'warehouse',
            attributes: ['id', 'name']
          },
          {
            model: Warehouse,
            as: 'originWarehouse',
            attributes: ['id', 'name'],
            required: false
          },
          {
            model: Warehouse,
            as: 'destinationWarehouse',
            attributes: ['id', 'name'],
            required: false
          }
        ],
        order: [['createdAt', 'DESC']],
        limit: limit,
        raw: true
      });

      stockMovements.forEach(movement => {
        const createdAt = new Date(movement.createdAt);
        const productName = movement['product.name'] || 'Producto';
        const quantity = parseInt(movement.quantity || 0);
        
        let message = '';
        let type = 'info';

        if (movement.movement_type === 'transfer') {
          const originName = movement['originWarehouse.name'] || 'Almacén origen';
          const destName = movement['destinationWarehouse.name'] || 'Almacén destino';
          message = `Transferencia de ${quantity} unidades de "${productName}": ${originName} → ${destName}`;
          type = 'info';
        } else if (movement.movement_type === 'adjustment' || movement.movement_type === 'manual') {
          const warehouseName = movement['warehouse.name'] || 'Almacén';
          const action = quantity > 0 ? 'Entrada' : 'Salida';
          message = `${action} de stock: ${Math.abs(quantity)} unidades de "${productName}" en ${warehouseName}`;
          type = quantity > 0 ? 'success' : 'warning';
        }

        if (message) {
          activities.push({
            message,
            type,
            timestamp: formatRelativeTime(createdAt),
            link: `/inventario/movimientos/${movement.id}`,
            createdAt
          });
        }
      });

      // 5. Ordenar todas las actividades por fecha (más reciente primero)
      activities.sort((a, b) => b.createdAt - a.createdAt);

      // 6. Retornar solo el límite solicitado, sin campo createdAt
      return activities.slice(0, limit).map(({ createdAt, ...activity }) => activity);
    } catch (error) {
      logger.error('[DashboardRepository] Error en getRecentActivities:', error.message);
      throw error;
    }
  }
};

/**
 * Formatea una fecha en tiempo relativo (ej: "Hace 5 min")
 * @param {Date} date - Fecha a formatear
 * @returns {string} Tiempo relativo
 */
function formatRelativeTime(date) {
  const now = new Date();
  const diffMs = now - date;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHours = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSec < 60) {
    return 'Hace menos de 1 min';
  } else if (diffMin < 60) {
    return `Hace ${diffMin} min`;
  } else if (diffHours < 24) {
    return `Hace ${diffHours} hora${diffHours > 1 ? 's' : ''}`;
  } else if (diffDays < 7) {
    return `Hace ${diffDays} día${diffDays > 1 ? 's' : ''}`;
  } else {
    // Si tiene más de 7 días, mostrar fecha corta
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    return `${day}/${month}`;
  }
}

module.exports = DashboardRepository;
