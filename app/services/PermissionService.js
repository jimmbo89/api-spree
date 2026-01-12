// app/services/PermissionService.js

const { UserCompanyRepository, RolePermissionRepository, CompanyRepository, PlanRepository } = require('../repositories');
const logger = require('../../config/logger');

/**
 * Verifica si un usuario tiene un permiso específico en una empresa.
 * 
 * @param {number} user_id - ID del usuario
 * @param {number} company_id - ID de la empresa
 * @param {string} permissionName - Nombre del permiso (ej: 'product.create', 'iam.create_user')
 * @returns {Promise<boolean>} - true si tiene permiso, false si no
 */
async function userCan(user_id, company_id, permissionName) {
  try {
    // 1. Validar membresía activa en la empresa
    const membership = await UserCompanyRepository.findByUserIdAndCompanyId(user_id, company_id);
    if (!membership || ![1].includes(membership.status)) {
      return false; // No pertenece o membresía inactiva
    }

    // 2. Obtener todos los permisos activos del rol
    const rolePermissions = await RolePermissionRepository.getPermissionsByRoleId(membership.role_id, 1);
    const permission = rolePermissions.find(rp => rp.permission.name === permissionName);

    if (!permission) {
      return false; // Permiso no asignado al rol
    }

    // 3. Si el permiso NO es condicional, está permitido
    if (!permission.permission.is_conditional) {
      return true;
    }

    // 4. Si es condicional, validar según el plan de la empresa
    const company = await CompanyRepository.findById(company_id);
    if (!company || !company.plan_id) {
      return false; // Empresa sin plan → asumir sin permiso
    }

    const plan = await PlanRepository.findById(company.plan_id);
    if (!plan || !plan.is_active) {
      return false;
    }

    // 🔑 Lógica específica por permiso condicional
    // Puedes extender este switch con más reglas
    switch (permissionName) {
      case 'publish.global':
        // Solo planes PRO o superiores
        return !['FREE'].includes(plan.name);

      case 'pool.create':
        // No disponible en FREE
        return !['FREE'].includes(plan.name);

      case 'ia.auto':
        // Requiere plan BUSINESS o superior
        return ['BUSINESS', 'ENTERPRISE'].includes(plan.name);

      case 'iam.create_user':
        // Solo Admin (ya validado por rol, pero redundancia segura)
        // Nota: este permiso NO debería ser condicional, pero por si acaso
        return true;

      default:
        // Si es condicional pero no está definido, denegar por seguridad
        logger.warn(`Permiso condicional no manejado: ${permissionName}`);
        return false;
    }

  } catch (error) {
    logger.error(`Error en PermissionService.userCan(${user_id}, ${company_id}, ${permissionName}):`, error.message);
    return false; // En caso de error, denegar acceso (fail-safe)
  }
}

/**
 * Versión optimizada para middleware: resuelve permisos y guarda contexto en req
 */
async function resolveUserPermissions(req, res, next) {
  const { user } = req;
  const companyId = req.companyId || user?.company_id;

  if (!user || !companyId) {
    return res.status(403).json({ message: 'Contexto de usuario o empresa no disponible' });
  }

  try {
    const membership = await UserCompanyRepository.findByUserIdAndCompanyId(user.id, companyId);
    if (!membership || membership.status !== 1) {
      return res.status(403).json({ message: 'Membresía no válida en esta empresa' });
    }

    req.membership = membership;
    req.userRole = membership.role?.name || 'invited';
    next();
  } catch (error) {
    logger.error('Error al resolver permisos de usuario:', error.message);
    return res.status(500).json({ message: 'Error al verificar permisos' });
  }
}

module.exports = {
  userCan,
  resolveUserPermissions
};