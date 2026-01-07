// app/utils/roleUtils.js

/**
 * Verifica si un usuario tiene uno de los roles permitidos EN UNA EMPRESA.
 * @param {Object} membership - Registro de user_companies con rol cargado
 * @param {string[]} allowedRoles - Lista de nombres de roles permitidos (ej: ['Admin', 'Editor'])
 * @returns {boolean}
 */
function hasRoleInCompany(membership, allowedRoles) {
  if (!membership || !membership.role) return false;
  return allowedRoles.includes(membership.role.name);
}

/**
 * Obtiene la primera membresía ACTIVA de un usuario (útil para contextos implícitos)
 * @param {Object} user - Instancia de User con memberships cargados
 * @returns {Object|null} - Membresía o null
 */
function getFirstActiveMembership(user) {
  if (!user?.memberships?.length) return null;
  return user.memberships.find(m => m.status === 1) || user.memberships[0];
}

module.exports = {
  hasRoleInCompany,
  getFirstActiveMembership
};