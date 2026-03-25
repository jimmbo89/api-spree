// app/middlewares/requireRoles.js

const { UserCompanyRepository } = require('../repositories');
const { hasRoleInCompany } = require('../util/roleUtils'); // ✅ Corrige ruta si es "utils"

function requireRoles(allowedRoles) {
  const rolesArray = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];

  return async (req, res, next) => {
    const user = req.user;

    if (!user || !user.id) {
      return res.status(403).json({
        success: false,
        message: 'Autenticación requerida.'
      });
    }

    // ✅ Si el usuario tiene role_id (BackOffice), tiene acceso global - saltar validación de company
    if (user.role_id) {
      // Usuario BackOffice con rol global - acceso permitido sin company_id
      // Los permisos vienen del rol global, no de memberships
      return next();
    }

    // 🔍 Para usuarios normales: Determinar companyId: explícito o implícito (del token)
    let companyId = req.companyId || user.company_id;

    if (!companyId) {
      return res.status(400).json({
        success: false,
        message: 'No se pudo determinar el contexto de la empresa. Asegúrate de que el token incluya company_id o que la solicitud defina companyId.'
      });
    }

    try {
      const membership = await UserCompanyRepository.findByUserIdAndCompanyId(user.id, companyId);

      if (!membership || ![1, 0].includes(membership.status)) {
        return res.status(403).json({
          success: false,
          message: 'No perteneces a esta empresa.'
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
        success: false,
        message: 'Acceso denegado: rol no autorizado en esta empresa.',
        requiredRoles: rolesArray,
        yourRole: membership.role?.name || null
      });

    } catch (error) {
      return res.status(500).json({
        success: false,
        message: 'Error al verificar permisos.',
        error: error.message
      });
    }
  };
}

module.exports = { requireRoles };