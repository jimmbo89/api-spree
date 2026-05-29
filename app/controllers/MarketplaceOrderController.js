const logger = require('../../config/logger');
const MarketplaceOrderSyncService = require('../services/MarketplaceOrderSyncService');
const { MarketplaceOrderRepository } = require('../repositories');
const { MarketplaceOrderMessageService, MercadoLibreError } = require('../services/MarketplaceOrderMessageService');

const MarketplaceOrderController = {
  async refresh(req, res) {
    try {
      logger.info(`${req.user?.user || 'Unknown'} - Solicita refresh de orden marketplace`);
      logger.info(`Datos recibidos:\n ${JSON.stringify(req.body)}`);

      const { id } = req.body || {};

      const report = await MarketplaceOrderSyncService.refreshById(id);

      logger.info(`${req.user?.user || 'Unknown'} - Refresh de orden marketplace exitoso`);
      return res.json({
        success: true,
        data: report
      });
    } catch (error) {
      logger.error('[MarketplaceOrderController] Error en refresh: ' + error.message);

      const statusCode =
        error.message === 'order_not_found' ? 404 :
        error.message === 'unsupported_marketplace' ? 400 :
        error.message === 'credential_not_found' ? 404 :
        error.message === 'order_fetch_failed' ? 502 :
        500;

      const message =
        error.message === 'order_not_found'
          ? 'La orden solicitada no existe.'
          : error.message === 'unsupported_marketplace'
            ? 'La orden no pertenece a un marketplace soportado.'
            : error.message === 'credential_not_found'
              ? 'No se encontrÃ³ la credencial necesaria para refrescar esta orden.'
              : error.message === 'order_fetch_failed'
                ? 'No se pudo actualizar la orden desde el marketplace.'
                : error.message;

      return res.status(statusCode).json({
        success: false,
        error: error.message,
        message
      });
    }
  },

  async updateNotes(req, res) {
    try {
      logger.info(`${req.user?.user || 'Unknown'} - Actualiza notas de orden marketplace`);
      logger.info(`Datos recibidos:\n ${JSON.stringify(req.body)}`);

      const { id, notes } = req.body || {};
      const existingOrder = await MarketplaceOrderRepository.findById(id);
      if (!existingOrder) {
        return res.status(404).json({
          success: false,
          error: 'order_not_found',
          message: 'La orden solicitada no existe.'
        });
      }

      const normalizedNotes = normalizeNotesPayload(notes);
      await MarketplaceOrderRepository.updateById(id, {
        notes_snapshot: normalizedNotes
      });

      const order = await MarketplaceOrderRepository.findById(id);

      return res.json({
        success: true,
        data: {
          order: order ? order.get({ plain: true }) : null,
          refreshed_at: new Date().toISOString()
        }
      });
    } catch (error) {
      logger.error('[MarketplaceOrderController] Error en updateNotes: ' + error.message);
      const statusCode =
        error.message === 'order_not_found' ? 404 :
        error.message === 'MESSAGE_TEXT_INVALID' ? 400 :
        500;
      const message =
        error.message === 'order_not_found'
          ? 'La orden solicitada no existe.'
          : error.message === 'MESSAGE_TEXT_INVALID'
            ? 'Las notas enviadas no son vÃ¡lidas.'
          : error.message;
      return res.status(statusCode).json({
        success: false,
        error: error.message,
        message
      });
    }
  },

  async sendMessage(req, res) {
    try {
      logger.info(`${req.user?.user || 'Unknown'} - EnvÃ­a mensaje a orden marketplace`);
      logger.info(`Datos recibidos:\n ${JSON.stringify(req.body)}`);

      const { id, text } = req.body || {};
      const result = await MarketplaceOrderMessageService.sendByOrderId(id, text);

      return res.json({
        success: true,
        data: result
      });
    } catch (error) {
      logger.error('[MarketplaceOrderController] Error en sendMessage: ' + error.message);

      if (error instanceof MercadoLibreError) {
        const statusCode = error.status === 0 ? 502 : error.status;
        return res.status(statusCode).json({
          success: false,
          error: error.message,
          status: error.status
        });
      }

      const statusCode =
        error.message === 'order_not_found' ? 404 :
        error.message === 'unsupported_marketplace' ? 400 :
        error.message === 'credential_not_found' ? 404 :
        error.message === 'MESSAGE_TEXT_INVALID' ? 400 :
        500;

      const message =
        error.message === 'order_not_found'
          ? 'La orden solicitada no existe.'
          : error.message === 'unsupported_marketplace'
            ? 'La orden no pertenece a un marketplace soportado.'
            : error.message === 'message_not_supported'
              ? 'Falabella no permite mensajería post-venta desde el front.'
              : error.message === 'credential_not_found'
                ? 'No se encontró la credencial necesaria para enviar el mensaje.'
                : error.message === 'MESSAGE_TEXT_INVALID'
                  ? 'El texto del mensaje no es válido.'
                  : error.message;

      return res.status(statusCode).json({
        success: false,
        error: error.message,
        message
      });
    }
  }
};

function normalizeNotesPayload(notes) {
  if (!Array.isArray(notes)) return [];

  return notes
    .map((note, index) => {
      if (typeof note === 'string') {
        return {
          note_id: `note-${Date.now()}-${index}`,
          text: note,
          created_at: new Date().toISOString(),
          created_by_user_id: null,
          created_by_user_name: null,
          raw_payload: { text: note }
        };
      }

      if (!note || typeof note !== 'object') return null;

      const text = typeof note.text === 'string' ? note.text.trim() : '';
      if (!text) return null;

      return {
        note_id: note.note_id || `note-${Date.now()}-${index}`,
        text,
        created_at: note.created_at || new Date().toISOString(),
        created_by_user_id: note.created_by_user_id ?? null,
        created_by_user_name: note.created_by_user_name ?? null,
        raw_payload: note.raw_payload || note
      };
    })
    .filter(Boolean);
}

module.exports = MarketplaceOrderController;

