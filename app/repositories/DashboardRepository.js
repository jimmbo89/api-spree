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
  User,
  InventoryMovement,
  MarketplaceCredential
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
    const lowStockVariants = await WarehouseProductVariant.findAll({
      include: [{
        model: WarehouseProduct,
        as: 'warehouseProduct',
        required: true,
        attributes: ['id', 'product_id', 'minimum_stock'],
        include: [{
          model: Product,
          as: 'product',
          where: {
            company_id: companyId,
            id: { [Op.ne]: null }
          },
          attributes: ['id'],
          required: true
        }]
      }],
      attributes: ['stock'],
      raw: true
    });

    const uniqueProductIds = new Set();
    lowStockVariants.forEach(variant => {
      const productId = variant['warehouseProduct.product.id'];
      const minimumStock = parseInt(variant['warehouseProduct.minimum_stock'], 10);
      const stock = parseInt(variant.stock || 0, 10);
      const effectiveMinimumStock = Number.isNaN(minimumStock) ? threshold : minimumStock;
      if (productId && stock <= effectiveMinimumStock) {
        uniqueProductIds.add(productId);
      }
    });

    return uniqueProductIds.size;
  } catch (error) {
    logger.error('[DashboardRepository] Error en getCriticalStockCount:', error.message);
    throw error;
  }
},

  /**
 * Cuenta productos SIN stock (stock = 0)
 * @param {number} companyId - ID de la empresa
 * @returns {Promise<number>}
 */
async getOutOfStockCount(companyId) {
  try {
    const outOfStockVariants = await WarehouseProductVariant.findAll({
      include: [{
        model: WarehouseProduct,
        as: 'warehouseProduct',
        required: true,
        attributes: ['id', 'product_id'],
        include: [{
          model: Product,
          as: 'product',
          where: {
            company_id: companyId,
            id: { [Op.ne]: null }
          },
          attributes: ['id'],
          required: true
        }],
        attributes: []
      }],
      where: {
        stock: {
          [Op.eq]: 0
        }
      },
      attributes: [],
      raw: true
    });

    const uniqueProductIds = new Set();
    outOfStockVariants.forEach(variant => {
      const productId = variant['warehouseProduct.product.id'];
      if (productId) {
        uniqueProductIds.add(productId);
      }
    });

    return uniqueProductIds.size;
  } catch (error) {
    logger.error('[DashboardRepository] Error en getOutOfStockCount:', error.message);
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
    const problemProductsMap = {};

    // 1. Productos con stock bajo - consulta corregida con validaciones
    const lowStockVariants = await WarehouseProductVariant.findAll({
      include: [
        {
          model: WarehouseProduct,
          as: 'warehouseProduct',
          required: true,
          attributes: ['id', 'product_id', 'minimum_stock'],
          include: [
            {
              model: Product,
              as: 'product',
              where: { 
                company_id: companyId,
                id: { [Op.ne]: null }
              },
              attributes: ['id', 'name', 'images'],
              required: true
            },
            {
              model: Warehouse,
              as: 'warehouse',
              attributes: ['id', 'name']
            }
          ]
        }
      ],
      attributes: ['stock', 'warehouse_product_id'],
      raw: true
    });

    // Agrupar por producto con validación estricta
    lowStockVariants.forEach(variant => {
      const productId = variant['warehouseProduct.product.id'];
      const minimumStock = parseInt(variant['warehouseProduct.minimum_stock'], 10);
      const effectiveMinimumStock = Number.isNaN(minimumStock) ? 5 : minimumStock;
      const stock = parseInt(variant.stock || 0);

      if (stock > effectiveMinimumStock) {
        return;
      }
      
      // Validación crítica: saltar variantes sin producto asociado válido
      if (!productId || !variant['warehouseProduct.product.name']) {
        logger.warn(`[DashboardRepository] Variante con producto inválido omitida: warehouse_product_id=${variant['warehouseProduct.id']}, product_id=${variant['warehouseProduct.product_id']}`);
        return;
      }

      const productName = variant['warehouseProduct.product.name'];
      const productImages = variant['warehouseProduct.product.images'];
      const warehouseId = variant['warehouseProduct.warehouse.id'];
      const warehouseName = variant['warehouseProduct.warehouse.name'];

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
          status: 'low_stock',
          image: mainImage,
          warehouses: []
        };
      }

      problemProductsMap[productId].warehouses.push({
        id: warehouseId,
        name: warehouseName,
        stock: stock,
        minimum_stock: effectiveMinimumStock
      });
    });
    // Convertir mapa a array
    const problemProducts = Object.values(problemProductsMap);

    // Calcular stock total y ordenar por stock total ascendente
    problemProducts.sort((a, b) => {
      
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
   * Obtiene el estado de los marketplaces conectados por el usuario (o de la empresa si no se pasa userId)
   * @param {number} companyId - ID de la empresa
   * @param {number} [userId] - ID del usuario (opcional: si se pasa, filtra solo sus credenciales)
   * @returns {Promise<Array<{name: string, domain: string, status: string, summary: string, link: string}>>}
   */
  async getMarketplaces(companyId, userId = null) {
    try {
      // Construir where dinamico para credenciales
      const credentialWhere = { active: true };
      if (userId) {
        credentialWhere.user_id = userId; // Filtrar solo credenciales de este usuario
      }

      // Decidir si es INNER o LEFT JOIN segun si filtramos por usuario
      const credentialsRequired = !!userId; // true = solo marketplaces con credenciales del usuario

      // 1. Obtener marketplaces con sus links y credenciales
      const marketplaces = await Marketplace.findAll({
        include: [{
          model: ProductMarketplaceLink,
          as: 'productLinks',
          where: { company_id: companyId },
          attributes: ['status'],
          required: false
        }, {
          model: MarketplaceCredential,
          as: 'credentials',
          where: credentialWhere,
          required: credentialsRequired,
          attributes: ['id', 'active', 'access_token', 'refresh_token', 'expires_at', 'seller_email', 'api_key', 'user_id']
        }],
        where: { active: true },
        attributes: ['id', 'name', 'domain'],
        raw: false,
        distinct: true
      });

      // 2. Obtener conteo de JobProduct por marketplace (errores y pendientes)
      const jobProducts = await JobProduct.findAll({
        include: [{
          model: Job,
          as: 'job',
          where: { company_id: companyId },
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
            success: 0, error: 0, pending: 0, processing: 0, retrying: 0
          };
        }
        jobProductsByMarketplace[mpId][jp.status] = (jobProductsByMarketplace[mpId][jp.status] || 0) + 1;
      });

      // 3. Construir respuesta por marketplace
      const result = marketplaces.map(marketplace => {
        const mpId = marketplace.id;
        const links = marketplace.productLinks || [];
        const jobStats = jobProductsByMarketplace[mpId] || {
          success: 0, error: 0, pending: 0, processing: 0, retrying: 0
        };
        const publishedCount = links.filter(l =>
          l.status === 'published' || l.status === 'published_with_warnings'
        ).length;
        const errors = jobStats.error;
        const pending = jobStats.pending + jobStats.processing + jobStats.retrying;
        const connectionStatus = checkConnectionStatus(marketplace);

        let status = 'warning';
        if (connectionStatus.state === 'connected') status = 'healthy';
        if (connectionStatus.state === 'error') status = 'error';
        
        let summary = '';
        if (errors > 0) {
          summary = `${errors} error${errors > 1 ? 'es' : ''} de publicacion`;
        } else if (pending > 5) {
          summary = `${pending} pendientes de sincronizacion`;
        } else if (publishedCount > 0) {
          summary = `${publishedCount} publicacione${publishedCount > 1 ? 's' : ''} activa${publishedCount > 1 ? 's' : ''}`;
        } else {
          summary = connectionStatus.reason === 'Conectado' ? 'Sin publicaciones' : connectionStatus.reason;
        }

        const domainSlug = marketplace.domain
          ? marketplace.domain.replace(/\./g, '-').toLowerCase()
          : marketplace.name.toLowerCase().replace(/\s+/g, '-');

        return {
          name: marketplace.name,
          domain: marketplace.domain,
          status: status,
          summary: summary,
          link: `/marketplace-credentials?marketplace=${domainSlug}`,
          connectionStatus: connectionStatus.isConnected
        };
      });

      return result;
    } catch (error) {
      logger.error('[DashboardRepository] Error en getMarketplaces:', error.message);
      throw error;
    }
  },
  /**
   * Obtiene procesos finalizados con problemas para dashboard
   * @param {number} companyId - ID de la empresa
   * @param {number} limit - Limite (default: 5)
   * @returns {Promise<Array<Object>>}
   */
  async getProblemProcesses(companyId, limit = 5) {
    try {
      const jobs = await Job.findAll({
        where: {
          company_id: companyId,
          job_type: 'publish',
          status: {
            [Op.in]: ['completed_with_errors', 'failed']
          }
        },
        attributes: [
          'id',
          'batch_id',
          'status',
          'total_products',
          'successful',
          'errors_count',
          'percentage',
          'draft_name',
          'completed_at',
          'createdAt'
        ],
        include: [{
          model: User,
          as: 'user',
          attributes: ['id', 'name'],
          required: false
        }],
        order: [['completed_at', 'DESC'], ['createdAt', 'DESC']],
        limit: limit,
        raw: false
      });

      const jobIds = jobs.map(job => job.id);
      const channelsByJob = {};
      if (jobIds.length > 0) {
        const channelRows = await JobProduct.findAll({
          where: {
            job_id: { [Op.in]: jobIds }
          },
          attributes: [
            'job_id',
            [fn('COUNT', fn('DISTINCT', col('credential_id'))), 'channelsCount']
          ],
          group: ['job_id'],
          raw: true
        });

        channelRows.forEach(row => {
          channelsByJob[row.job_id] = parseInt(row.channelsCount || 0);
        });
      }

      return jobs.map(jobModel => {
        const job = jobModel.get({ plain: true });
        const date = new Date(job.completed_at || job.createdAt);
        return {
          id: job.id,
          batch_id: job.batch_id,
          display_id: `J-${String(job.id).padStart(5, '0')}`,
          name: formatProcessDateTime(date),
          status: job.status,
          createdAt: job.completed_at || job.createdAt,
          user_name: job.user?.name || 'N/A',
          channelsCount: channelsByJob[job.id] || 0,
          productsTotal: parseInt(job.total_products || 0),
          publishedCount: parseInt(job.successful || 0),
          errorCount: parseInt(job.errors_count || 0),
          percentage: parseInt(job.percentage || 0),
          draft_name: job.draft_name || null,
          link: `/procesos/${job.id}`
        };
      });
    } catch (error) {
      logger.error('[DashboardRepository] Error en getProblemProcesses:', error.message);
      throw error;
    }
  },
  /**
   * Obtiene la actividad reciente de la empresa (publicaciones, errores, jobs, ordenes, stock)
   * @param {number} companyId - ID de la empresa
   * @param {number} limit - Limite de actividades (default: 5)
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
 * Verifica el estado de la conexión con un marketplace
 * @param {Object} marketplace - Objeto Marketplace con credenciales incluidas
 * @returns {Object} - { isConnected: boolean, reason: string }
 */
function checkConnectionStatus(marketplace) {
  const now = new Date();
  const credentials = marketplace.credentials || [];
  const domain = (marketplace.domain || '').toLowerCase();
  const isMercadoLibre = domain.includes('mercadolibre');
  const isFalabella = domain.includes('falabella');

  // Si no hay credenciales activas
  if (credentials.length === 0) {
    return {
      state: 'disconnected',
      isConnected: false,
      reason: 'No conectado'
    };
  }

  const hasValue = (value) => value !== null && value !== undefined && String(value).trim() !== '';
  let hasInvalidEssentialData = false;

  for (const credential of credentials) {
    if (isMercadoLibre) {
      const hasTokens = hasValue(credential.access_token) && hasValue(credential.refresh_token);
      const hasExpiry = !!credential.expires_at;

      if (!hasTokens || !hasExpiry) {
        hasInvalidEssentialData = true;
        continue;
      }

      const expiresAt = new Date(credential.expires_at);
      if (expiresAt >= now) {
        return {
          state: 'connected',
          isConnected: true,
          reason: 'Conectado'
        };
      }

      continue;
    }

    if (isFalabella) {
      if (!hasValue(credential.api_key)) {
        hasInvalidEssentialData = true;
        continue;
      }

      return {
        state: 'connected',
        isConnected: true,
        reason: 'Conectado'
      };
    }

    // Fallback para otros marketplaces
    if (hasValue(credential.access_token) || hasValue(credential.refresh_token) || hasValue(credential.api_key)) {
      return {
        state: 'connected',
        isConnected: true,
        reason: 'Conectado'
      };
    }
  }

  if (hasInvalidEssentialData) {
    return {
      state: 'error',
      isConnected: false,
      reason: 'Error de configuracion'
    };
  }

  return {
    state: 'disconnected',
    isConnected: false,
    reason: 'No conectado'
  };
}

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

/**
 * Formatea fecha/hora para nombre de proceso (YYYY-MM-DD HH:mm)
 * @param {Date} date
 * @returns {string}
 */
function formatProcessDateTime(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

module.exports = DashboardRepository;
