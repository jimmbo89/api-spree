// app/controllers/InventoryMovementController.js
const logger = require("../../config/logger");
const { InventoryMovementRepository, LogRepository, CompanyRepository, UserRepository, BranchRepository } = require("../repositories");

const InventoryMovementController = {
  async getMovements(req, res) {
    const requesterName = req.user?.name || 'Anonymous';
    const requesterId = req.user?.id || null;

    logger.info(`${requesterName} - Solicita movimientos de inventario`);
    logger.info("Datos recibidos:", JSON.stringify(req.body));

    const ip = req.ip || 'unknown';
    const userAgent = req.get('User-Agent') || null;

    try {
      // Extraer parámetros de req.body
      const {
        warehouse_id,
        product_id,
        variant_id,
        company_id,
        branch_id,
        reference_id,
        start_date,
        end_date
      } = req.body;

      // Preparar filtros (solo los que vienen)
      const filters = {};
      if (warehouse_id != null) filters.warehouse_id = warehouse_id;
      if (product_id != null) filters.product_id = product_id;
      if (variant_id != null) filters.variant_id = variant_id;
      if (company_id != null) filters.company_id = company_id;
      if (branch_id != null) filters.branch_id = branch_id;
      if (reference_id != null) filters.reference_id = reference_id;
      if (start_date) filters.startDate = start_date;
      if (end_date) filters.endDate = end_date;

      // Ejecutar consulta
      const movements = await InventoryMovementRepository.findWithFilters(filters);

      // 📝 Registrar auditoría de la consulta
      await LogRepository.create({
        user_id: requesterId,
        action: 'inventory.movement.view',
        description: `Consulta movimientos de inventario`,
        ip_address: ip,
        user_agent: userAgent,
        status: 'success',
        extra: JSON.stringify({
          filters: {
            warehouse_id,
            product_id,
            variant_id,
            company_id,
            branch_id,
            reference_id,
            start_date,
            end_date
          },
          results: movements.length
        })
      });

      return res.status(200).json({
        success: true,
        count: movements.length,
        movements: movements
      });

    } catch (error) {
      logger.error(`InventoryMovementController->getMovements: ${error.message}`, { stack: error.stack });

      // Intentar registrar error en log
      try {
        await LogRepository.create({
          user_id: requesterId,
          action: 'inventory.movement.view',
          description: `Error al consultar movimientos: ${error.message}`,
          ip_address: ip,
          user_agent: userAgent,
          status: 'error'
        });
      } catch (logError) {
        logger.error("No se pudo registrar el error en logs:", logError);
      }

      return res.status(500).json({
        success: false,
        error: "ServerError",
        details: error.message
      });
    }
  },

  async list(req, res) {
  logger.info(`${req.user?.name || 'Unknown'} - Lista inventario consolidado`);
  const { company_id, user_id, branch_id } = req.body;

    if (company_id) {
      const company = await CompanyRepository.findById(company_id);
      if (!company) return res.status(400).json({ msg: "companyNotFound" });
    }
    if (user_id) {
      const user = await UserRepository.findById(user_id);
      if (!user) return res.status(400).json({ msg: "userNotFound" });
    }
    if (branch_id) {
      const branch = await BranchRepository.findById(branch_id);
      if (!branch) return res.status(400).json({ msg: "branchNotFound" });
    }

  try {
    const inventory = await InventoryMovementRepository.getConsolidatedInventory({
      companyId: company_id,
      userId: user_id,
      branchId: branch_id
    });

    res.status(200).json({
      inventory: inventory.length ? inventory : [],
      message: inventory.length ? "Inventario encontrado" : "NoInventoryFound"
    });
  } catch (error) {
    logger.error("InventoryController->list: " + error.message);
    res.status(500).json({ error: "ServerError", details: error.message });
  }
}
};

module.exports = InventoryMovementController;