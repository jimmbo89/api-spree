// app/middlewares/requireRoles.js

const { UserCompanyRepository } = require('../repositories');
const { hasRoleInCompany } = require('../util/roleUtils'); // ✅ Corrige ruta si es "utils"

function requireRoles(allowedRoles) {
  const rolesArray = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];

  return async (req, res, next) => {
    const user = req.user;

    if (!user || !user.id) {
      return res.status(403).json({ message: 'Autenticación requerida.' });
    }

    // 🔍 Determinar companyId: explícito o implícito (del token)
    let companyId = req.companyId || user.company_id;

    if (!companyId) {
      return res.status(400).json({
        message: 'No se pudo determinar el contexto de la empresa. Asegúrate de que el token incluya company_id o que la solicitud defina companyId.'
      });
    }

    try {
      const membership = await UserCompanyRepository.findByUserIdAndCompanyId(user.id, companyId);

      if (!membership || ![1, 0].includes(membership.status)) {
        return res.status(403).json({
          message: 'No perteneces a esta empresa o tu membresía no es válida.'
        });
      }

      // Cargar rol si no viene
      if (!membership.role) {
        await membership.reload({ include: [{ association: 'role' }] });
      }

      if (hasRoleInCompany(membership, rolesArray)) {
        req.membership = membership;
        req.companyId = companyId; // Normalizar
        return next();
      }

      return res.status(403).json({
        message: 'Acceso denegado: rol no autorizado en esta empresa.',
        requiredRoles: rolesArray,
        yourRole: membership.role?.name || null
      });

    } catch (error) {
      return res.status(500).json({
        message: 'Error al verificar permisos.',
        error: error.message
      });
    }
  };
}

module.exports = { requireRoles };