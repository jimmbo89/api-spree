/**
 * Parsea una fecha en formato YYYY-MM-DD sin conversión de timezone
 * @param {string|null} dateStr - Fecha en formato YYYY-MM-DD
 * @returns {string|null} La misma fecha sin modificar, o null si no es válida
 */
function parseDateSafe(dateStr) {
  if (!dateStr) return null;
  
  // Si ya viene en formato YYYY-MM-DD, retornar tal cual (evita new Date() que usa UTC)
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return dateStr;
  }
  
  // Fallback para otros formatos: intentar parsear con precaución
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().split('T')[0];
  } catch {
    return null;
  }
}

/**
 * Obtiene rango de fechas para el mes actual o fechas específicas
 * @param {Date|string|null} start_date - Fecha de inicio (opcional)
 * @param {Date|string|null} end_date - Fecha de fin (opcional)
 * @returns {Object} Objeto con start_date y end_date formateadas YYYY-MM-DD
 */
function getDateRange(start_date = null, end_date = null) {
  const now = new Date();
  
  // Si no se proporcionan fechas, usar mes actual
  if (!start_date && !end_date) {
    const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    
    return {
      start_date: firstDay.toISOString().split('T')[0],
      end_date: lastDay.toISOString().split('T')[0]
    };
  }
  
  // Si solo se proporciona start_date, usarlo como inicio y mes actual como fin
  if (start_date && !end_date) {
    const startDate = parseDateSafe(start_date);
    const endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];
    
    return {
      start_date: startDate,
      end_date: endDate
    };
  }
  
  // Si solo se proporciona end_date, usar mes actual como inicio y la fecha proporcionada como fin
  if (!start_date && end_date) {
    const firstDay = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
    const endDate = parseDateSafe(end_date);
    
    return {
      start_date: firstDay,
      end_date: endDate
    };
  }
  
  // Si se proporcionan ambas fechas → usar parse seguro para evitar timezone shifts
  return {
    start_date: parseDateSafe(start_date),
    end_date: parseDateSafe(end_date)
  };
}

/**
 * Obtiene el rango de fechas del mes actual
 * @returns {Object} Objeto con start_date y end_date del mes actual en formato YYYY-MM-DD
 */
function getCurrentMonthRange() {
  const now = new Date();
  const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  
  return {
    start_date: firstDay.toISOString().split('T')[0],
    end_date: lastDay.toISOString().split('T')[0]
  };
}

/**
 * Formatea una fecha a 'YYYY-MM-DD HH:mm:ss' usando UTC para evitar problemas de timezone
 * @param {Date|string|null} date - Fecha a formatear
 * @returns {string|null} Fecha formateada o null si no hay fecha
 */
function formatDateTimeUTC(date) {
  if (!date) return null;
  
  // Si es string, convertir a Date
  const dateObj = typeof date === 'string' ? new Date(date) : date;
  
  // Validar que sea una fecha válida
  if (isNaN(dateObj.getTime())) return null;
  
  // Usar métodos UTC para evitar desplazamientos por timezone del servidor
  const year = dateObj.getUTCFullYear();
  const month = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
  const day = String(dateObj.getUTCDate()).padStart(2, '0');
  const hours = String(dateObj.getUTCHours()).padStart(2, '0');
  const minutes = String(dateObj.getUTCMinutes()).padStart(2, '0');
  const seconds = String(dateObj.getUTCSeconds()).padStart(2, '0');
  
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

module.exports = { getDateRange, getCurrentMonthRange, formatDateTimeUTC, parseDateSafe };