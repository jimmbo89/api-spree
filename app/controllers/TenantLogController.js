// controllers/tenantLogController.js
const logger = require("../../config/logger");
const { TenantLogRepository } = require("../repositories");
const { getLogsSchema } = require("../schemas/tenantLogSchema");
const { CompanyRepository } = require("../repositories");

const TenantLogController = {
  /**
   * Listar logs del tenant con filtros y paginación
   * GET /api/tenant-logs
   */
  async index(req, res) {
    try {
      // ✅ Los parámetros vienen de req.query para GET requests
      const { error, value } = getLogsSchema.validate(req.query);
      
      if (error) {
        return res.status(400).json({ 
          success: false, 
          message: error.details[0].message 
        });
      }

      const { 
        company_id, 
        module, 
        event_type, 
        result, 
        page, 
        limit, 
        date_from, 
        date_to 
      } = value;
      
      // Validar que la compañía exista
      const company = await CompanyRepository.findById(company_id);
      if (!company) {
        return res.status(404).json({ 
          success: false, 
          message: "Compañía no encontrada" 
        });
      }

      // Obtener logs con filtros
      const resultData = await TenantLogRepository.findByCompanyId(company_id, {
        module,
        event_type,
        result,
        date_from,
        date_to,
        page,
        limit
      });

      return res.status(200).json({
        success: true,
         logs: resultData.logs.map(log => ({
          id: log.id,
          module: log.module,
          event_type: log.event_type,
          action: log.action,
          description: log.description,
          result: log.result,
          user_id: log.user_id,
          ip_address: log.ip_address,
          created_at: log.createdAt
        })),
        pagination: resultData.pagination,
        filters: {
          module: module || 'todos',
          event_type: event_type || 'todos',
          result: result || 'todos',
          date_range: date_from || date_to 
            ? `${date_from || 'inicio'} - ${date_to || 'ahora'}`
            : 'todo el período'
        }
      });
    } catch (err) {
      logger.error("TenantLogController->index: " + err.message);
      return res.status(500).json({ 
        success: false, 
        message: "Error al listar logs del tenant.",
        details: process.env.NODE_ENV === 'development' ? err.message : undefined
      });
    }
  },

  /**
   * Obtener un log específico por ID
   * GET /api/tenant-logs/:id
   */
  async show(req, res) {
    try {
      const { id } = req.params;  // ✅ ID viene de params
      const { company_id } = req.query;  // ✅ company_id de query
      
      if (!company_id) {
        return res.status(400).json({ 
          success: false, 
          message: "company_id es requerido" 
        });
      }

      // Validar compañía
      const company = await CompanyRepository.findById(company_id);
      if (!company) {
        return res.status(404).json({ 
          success: false, 
          message: "Compañía no encontrada" 
        });
      }

      // Obtener log
      const log = await TenantLogRepository.findById(id);
      
      if (!log) {
        return res.status(404).json({ 
          success: false, 
          message: "Log no encontrado" 
        });
      }

      // Validar que el log pertenezca al tenant
      if (log.company_id !== parseInt(company_id)) {
        return res.status(403).json({ 
          success: false, 
          message: "Acceso denegado al log" 
        });
      }

      return res.status(200).json({ 
        success: true, 
         log: {
          id: log.id,
          company_id: log.company_id,
          user_id: log.user_id,
          module: log.module,
          event_type: log.event_type,
          action: log.action,
          description: log.description,
          meta: log.meta,
          ip_address: log.ip_address,
          user_agent: log.user_agent,
          result: log.result,
          error_message: log.error_message,
          created_at: log.createdAt
        }
      });
    } catch (err) {
      logger.error("TenantLogController->show: " + err.message);
      return res.status(500).json({ 
        success: false, 
        message: "Error al obtener log del tenant.",
        details: process.env.NODE_ENV === 'development' ? err.message : undefined
      });
    }
  },

  /**
   * Obtener estadísticas de logs por módulo
   * GET /api/tenant-logs/stats
   */
  async stats(req, res) {
    try {
      const { company_id } = req.query;
      
      if (!company_id) {
        return res.status(400).json({ 
          success: false, 
          message: "company_id es requerido" 
        });
      }

      const company = await CompanyRepository.findById(company_id);
      if (!company) {
        return res.status(404).json({ 
          success: false, 
          message: "Compañía no encontrada" 
        });
      }

      const stats = await TenantLogRepository.getStatsByModule(company_id);

      return res.status(200).json({
        success: true,
         stats: stats
      });
    } catch (err) {
      logger.error("TenantLogController->stats: " + err.message);
      return res.status(500).json({ 
        success: false, 
        message: "Error al obtener estadísticas de logs.",
        details: process.env.NODE_ENV === 'development' ? err.message : undefined
      });
    }
  },

  /**
   * Obtener últimos logs exitosos
   * GET /api/tenant-logs/recent/success
   */
  async recentSuccess(req, res) {
    try {
      const { company_id, limit = 10 } = req.query;
      
      if (!company_id) {
        return res.status(400).json({ 
          success: false, 
          message: "company_id es requerido" 
        });
      }

      const company = await CompanyRepository.findById(company_id);
      if (!company) {
        return res.status(404).json({ 
          success: false, 
          message: "Compañía no encontrada" 
        });
      }

      const logs = await TenantLogRepository.getRecentSuccess(company_id, limit);

      return res.status(200).json({
        success: true,
         logs: logs.map(log => ({
          id: log.id,
          action: log.action,
          description: log.description,
          created_at: log.createdAt
        }))
      });
    } catch (err) {
      logger.error("TenantLogController->recentSuccess: " + err.message);
      return res.status(500).json({ 
        success: false, 
        message: "Error al obtener logs recientes exitosos.",
        details: process.env.NODE_ENV === 'development' ? err.message : undefined
      });
    }
  },

  /**
   * Obtener logs con errores recientes
   * GET /api/tenant-logs/recent/errors
   */
  async recentErrors(req, res) {
    try {
      const { company_id, limit = 10 } = req.query;
      
      if (!company_id) {
        return res.status(400).json({ 
          success: false, 
          message: "company_id es requerido" 
        });
      }

      const company = await CompanyRepository.findById(company_id);
      if (!company) {
        return res.status(404).json({ 
          success: false, 
          message: "Compañía no encontrada" 
        });
      }

      const logs = await TenantLogRepository.getRecentErrors(company_id, limit);

      return res.status(200).json({
        success: true,
         logs: logs.map(log => ({
          id: log.id,
          action: log.action,
          error_message: log.error_message,
          created_at: log.createdAt
        }))
      });
    } catch (err) {
      logger.error("TenantLogController->recentErrors: " + err.message);
      return res.status(500).json({ 
        success: false, 
        message: "Error al obtener logs con errores recientes.",
        details: process.env.NODE_ENV === 'development' ? err.message : undefined
      });
    }
  }
};

module.exports = TenantLogController;