const logger = require('../../config/logger');
const MarketplaceOrderSyncService = require('../services/MarketplaceOrderSyncService');
const { MarketplaceOrderRepository } = require('../repositories');
const { MarketplaceOrderMessageService, MercadoLibreError } = require('../services/MarketplaceOrderMessageService');
const SalesAuditService = require('../services/SalesAuditService');

const MarketplaceOrderController = {
  async refresh(req, res) {
    try {
      logger.info(`${req.user?.user || 'Unknown'} - Solicita refresh de orden marketplace`);
      logger.info(`Datos recibidos:\n ${JSON.stringify(req.body)}`);

      const { id } = req.body || {};

      const report = await MarketplaceOrderSyncService.refreshById(id);
      const refreshedOrder = await MarketplaceOrderRepository.findById(id);
      // Se mantiene temporalmente comentado para no registrar cada consulta de una orden.
      // if (refreshedOrder) {
      //   await SalesAuditService.recordFromRequest(req, refreshedOrder, 'sales.refreshed', {
      //     new_value: SalesAuditService.buildOrderSnapshot(refreshedOrder),
      //     description: 'El usuario solicitó la sincronización manual de la venta',
      //     metadata: {
      //       refresh_source: report?.source || null,
      //       fallback_error: report?.error || null
      //     }
      //   });
      // }

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

      const previousNotes = normalizeNotesForResponse(existingOrder.notes_snapshot);
      const normalizedNotes = normalizeNotesPayload(notes, req.user);
      if (hasSubmittedNoteContent(notes) && normalizedNotes.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'MESSAGE_TEXT_INVALID',
          message: 'Las notas enviadas no son válidas.'
        });
      }

      logger.info(`[MarketplaceOrderController] Notas normalizadas para orden ${id}: ${normalizedNotes.length}`);
      await MarketplaceOrderRepository.updateById(id, {
        notes_snapshot: normalizedNotes
      });

      const order = await MarketplaceOrderRepository.findById(id);
      const previousNoteIds = new Set(previousNotes.map((note) => String(note.note_id || '')));
      const addedNotes = normalizeNotesForResponse(normalizedNotes)
        .filter((note) => note.note_id && !previousNoteIds.has(String(note.note_id)));

      if (addedNotes.length > 0) {
        const auditNotes = addedNotes.map((note) => ({
          texto: note.text,
          creado_por: note.created_by_user_name || 'Usuario',
          fecha: note.created_at
        }));
        await SalesAuditService.recordFromRequest(req, order || existingOrder, 'sales.note_added', {
          new_value: {
            notes_count: addedNotes.length,
            notas: auditNotes
          },
          description: `${addedNotes.length} nota(s) interna(s) agregada(s) a la venta`,
          metadata: {
            cantidad_de_notas: addedNotes.length,
            notas: auditNotes
          }
        });
      }

      return res.json({
        success: true,
        data: {
          order: serializeOrderForNotesResponse(order),
          notes_snapshot: normalizeNotesForResponse(normalizedNotes),
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
      const result = await MarketplaceOrderMessageService.sendByOrderId(id, text, req.user);
      const order = await MarketplaceOrderRepository.findById(id);
      if (order) {
        const messageText = typeof text === 'string' ? text.trim() : '';
        await SalesAuditService.recordFromRequest(req, order, 'sales.message_sent', {
          new_value: {
            texto: messageText,
            longitud_del_mensaje: messageText.length
          },
          description: 'Mensaje enviado al comprador desde Spree',
          metadata: {
            destinatario: order.buyer_name || 'Comprador',
            canal: order.marketplace || null,
            origen: result?.source || 'Spree'
          }
        });
      }

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

function normalizeNotesPayload(notes, user = null) {
  const parsedNotes = parseJsonMaybe(notes);
  const list = normalizeNotesList(parsedNotes);
  if (!Array.isArray(list)) return [];
  const now = new Date().toISOString();

  return list
    .map((note, index) => {
      if (typeof note === 'string') {
        const text = note.trim();
        if (!text) return null;

        return {
          note_id: `note-${Date.now()}-${index}`,
          text,
          created_at: now,
          created_by_user_id: user?.id || null,
          created_by_user_name: user?.name || user?.email || user?.user || null,
          raw_payload: { text }
        };
      }

      if (!note || typeof note !== 'object') return null;

      const text = typeof note.text === 'string' ? note.text.trim() : '';
      if (!text) return null;

      return {
        note_id: note.note_id || `note-${Date.now()}-${index}`,
        text,
        created_at: note.created_at || now,
        created_by_user_id: note.created_by_user_id ?? user?.id ?? null,
        created_by_user_name: note.created_by_user_name ?? user?.name ?? user?.email ?? user?.user ?? null,
        raw_payload: note.raw_payload || note
      };
    })
    .filter(Boolean);
}

function normalizeNotesList(notes) {
  if (Array.isArray(notes)) return notes;
  if (!notes || typeof notes !== 'object') return [];

  if (typeof notes.text === 'string') return [notes];

  const numericKeys = Object.keys(notes)
    .filter((key) => /^\d+$/.test(key))
    .sort((a, b) => Number(a) - Number(b));

  if (numericKeys.length > 0) {
    return numericKeys.map((key) => notes[key]);
  }

  return [];
}

function hasSubmittedNoteContent(notes) {
  const parsedNotes = parseJsonMaybe(notes);
  const list = normalizeNotesList(parsedNotes);

  return list.some((note) => {
    if (typeof note === 'string') return note.trim().length > 0;
    if (!note || typeof note !== 'object') return false;
    return typeof note.text === 'string' && note.text.trim().length > 0;
  });
}

function serializeOrderForNotesResponse(orderRecord) {
  if (!orderRecord) return null;

  const order = typeof orderRecord.get === 'function'
    ? orderRecord.get({ plain: true })
    : { ...orderRecord };

  order.notes_snapshot = normalizeNotesForResponse(order.notes_snapshot);
  return order;
}

function normalizeNotesForResponse(notesSnapshot) {
  const notes = parseJsonMaybe(notesSnapshot);
  const list = Array.isArray(notes) ? notes : [];

  return list
    .map((note) => {
      const text = typeof note?.text === 'string' ? note.text.trim() : '';
      if (!text) return null;

      return {
        note_id: note?.note_id || null,
        text,
        created_at: note?.created_at || null,
        created_by_user_id: note?.created_by_user_id ?? null,
        created_by_user_name: note?.created_by_user_name ?? null
      };
    })
    .filter(Boolean);
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

module.exports = MarketplaceOrderController;

