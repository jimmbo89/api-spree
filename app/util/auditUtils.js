// src/utils/auditUtils.js

function parseJsonLikeString(value) {
  if (typeof value !== 'string') return value;

  const trimmed = value.trim();
  if (!trimmed) return value;

  const looksLikeJson =
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'));

  if (!looksLikeJson) return value;

  try {
    return JSON.parse(trimmed);
  } catch (error) {
    return value;
  }
}

function normalizeAuditValue(value, field = '') {
  if (value === null || value === undefined || value === '') return null;

  const parsed = parseJsonLikeString(value);

  if (Array.isArray(parsed)) {
    return parsed.map((item) => normalizeAuditValue(item));
  }

  if (parsed && typeof parsed === 'object') {
    return Object.keys(parsed)
      .sort()
      .reduce((normalized, key) => {
        normalized[key] = normalizeAuditValue(parsed[key], key);
        return normalized;
      }, {});
  }

  if (/_id$/.test(field) && typeof parsed === 'string' && /^\d+$/.test(parsed)) {
    return Number(parsed);
  }

  return parsed;
}

const detectChanges = (original, updated, fieldsToAudit) => {
  const changes = [];

  for (const field of fieldsToAudit) {
    const normalizedOld = normalizeAuditValue(original[field], field);
    const normalizedNew = normalizeAuditValue(updated[field], field);

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

module.exports = { detectChanges, normalizeAuditValue };
