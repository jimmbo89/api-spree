// src/utils/auditUtils.js

/**
 * Compara dos objetos y devuelve los campos que cambiaron
 * @param {Object} original - Objeto original (ej: empresa antes de update)
 * @param {Object} updated - Objeto actualizado
 * @param {string[]} fieldsToAudit - Lista de campos a auditar (ej: ['name', 'rut', 'status'])
 * @returns {Array} - Lista de cambios: { field, old_value, new_value }
 */
const detectChanges = (original, updated, fieldsToAudit) => {
  const changes = [];

  for (const field of fieldsToAudit) {
    const oldValue = original[field];
    const newValue = updated[field];

    // Normalizar valores nulos/vacios para comparación justa
    const normalizedOld = oldValue === null || oldValue === undefined ? null : oldValue;
    const normalizedNew = newValue === null || newValue === undefined ? null : newValue;

    if (JSON.stringify(normalizedOld) !== JSON.stringify(normalizedNew)) {
      changes.push({
        field,
        old_value: normalizedOld,
        new_value: normalizedNew
      });
    }
  }

  return changes;
};

module.exports = { detectChanges };