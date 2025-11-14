const logger = require("../../config/logger");
const { LogRepository } = require("../repositories");

const LogController = {
async getLogs(req, res) {
  const requesterName = req.user?.name || 'Anonymous';
  const requesterId = req.user?.id || null;

  logger.info(`${requesterName} - Solicita logs`);
  logger.info("Datos recibidos:", req.body);

   const ip = req.ip || 'unknown';
    const userAgent = req.get('User-Agent') || null;

  try {
    // Extraer y validar parámetros de consulta (query string)
    let { start_date, end_date, user_id } = req.body;

    // Llamar al repositorio
    const logs = await LogRepository.getLogsByDateRange({
      start_date,
      end_date,
      user_id
    });

    // 📝 Registrar que alguien consultó los logs (opcional, pero útil para auditoría)
    await LogRepository.create({
      user_id: requesterId,
      action: 'log.view',
      description: `Consulta el registro de logs`,
      ip_address: ip || 'unknown',
      user_agent: userAgent,
      status: 'success'
    });

    return res.status(200).json({
      success: true,
      count: logs.length,
      logs: logs
    });

  } catch (error) {
    logger.error(`LogController->getLogs: ${error.message}`, error);

    // Registrar error en logs (solo si no causa recursión)
    try {
      await LogRepository.create({
        user_id: req.user?.id || null,
        action: 'log.view',
        description: `Error al consultar logs: ${error.message}`,
        ip_address: ip,
        user_agent: userAgent,
        status: 'error'
      });
    } catch (e) {
      // Ignorar error en log de error
      logger.error("No se pudo registrar el error en logs:", e);
    }

    return res.status(500).json({ error: "ServerError", details: error.message });
  }
}
};

module.exports = LogController;