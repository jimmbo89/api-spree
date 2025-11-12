// policies/rolePolicy.js
const { User } = require('../models');

/**
 * Middleware de autorización por roles.
 * @param {string | string[]} allowedRoles - Rol o lista de roles permitidos (ej: 'admin' o ['admin', 'seller'])
 */
function requireRoles(allowedRoles) {
  // Aseguramos que allowedRoles sea un array
  const rolesArray = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];

  return (req, res, next) => {
    const user = req.user;

    if (!user) {
      return res.status(403).json({ message: 'User no disponible. Autenticación requerida.' });
    }

    // Extraemos el rol del perfil (puede ser un string)
    const userRoles = user.role; // Esto es un string, ej: 'admin'

    // Usamos el método genérico `hasRole` del modelo User
    if (User.hasRole(userRoles, rolesArray)) {
      return next();
    }

    return res.status(403).json({
      message: 'Acceso denegado: no tienes los permisos necesarios.',
      requiredRoles: rolesArray,
      yourRole: userRoles
    });
  };
}

module.exports = { requireRoles };