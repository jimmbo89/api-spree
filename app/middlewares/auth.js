const jwt = require('jsonwebtoken');
const authConfig = require('../../config/auth');
const { runWithUser } = require('../../config/context');
const { User, UserToken } = require('../models');
const logger = require('../../config/logger');
const { UserTokenRepository, UserRepository } = require('../repositories');

module.exports = async (req, res, next) => {
  // Verificar si el token existe en los encabezados de la solicitud
  const token = req.headers.authorization?.split(" ")[1];

  if (!token) {
    return res.status(401).json({ msg: "Acceso no autorizado: token no proporcionado" });
  }

  try {
    // Verificar si el token está revocado o expirado
    const userToken = await UserTokenRepository.findByToken(token);
    if (!userToken) {
      return res.status(401).json({ succes: false, message: 'Acceso no autorizado: token inválido, revocado o expirado' });
    }

    // Verificar la validez del token JWT
    jwt.verify(token, authConfig.secret, async (err, decoded) => {
      if (err) {
        return res.status(401).json({ succes: false, message: "Token inválido o expirado" });
      }

      // Obtener el companyId del header (si existe)
      const companyId = req.headers['x-company-id'];
      const allowNoCompanyPaths = new Set([
        '/companies',
        '/login-companies',
        '/business-types',
        '/company-login',
        '/available-for-request',
        '/membership-requests',
        '/logout',
        '/joint-invitation-token'
      ]);

      // Almacenar el ID del usuario en el contexto
      runWithUser(decoded.user.id, async () => {
        let userWithContext = decoded.user;

        // ✅ Si el usuario tiene role_id (BackOffice), tiene acceso global sin necesidad de company
        if (decoded.user.role_id) {
          // Usuario BackOffice con rol global - acceso permitido sin company
          // Si se proporciona companyId, se usa para filtrar datos pero no es obligatorio
        } else if (companyId) {
          // Usuario normal SIN rol global - requiere companyId
          try {
            // Buscar el usuario con el contexto de la empresa específica
            const userWithCompanyContext = await UserRepository.findByEmailWithCompanyContext(
              decoded.user.email,
              companyId
            );

            if (!userWithCompanyContext) {
              return res.status(403).json({
                msg: "No tienes acceso a esta empresa."
              });
            }

            userWithContext = userWithCompanyContext;
          } catch (error) {
            if (error.message.includes('does not belong')) {
              return res.status(403).json({ success: false,
                message: "Acceso denegado a esta empresa."
              });
            }
            logger.error(`Error al establecer contexto de empresa: ${error.message}`);
            return res.status(500).json({ success: false,
              message: "Error al establecer el contexto de empresa."
            });
          }
        } else if (allowNoCompanyPaths.has(req.path)) {
          // Usuario normal sin companyId pero ruta permitida (flujo onboarding)
        } else {
          // Usuario normal sin companyId - error
          return res.status(403).json({
            success: false,
            msg: "Acceso requiere empresa. Usuario sin rol global debe proporcionar x-company-id."
          });
        }

        // Adjuntar el usuario (con o sin contexto de empresa) a la solicitud
        req.user = userWithContext;
        req.profile = userWithContext.profile;

        next();
      });
    });
  } catch (error) {
    logger.error(`Error en middleware de autenticación: ${error.message}`);
    return res.status(500).json({ msg: "Error en el servidor", error: error.message });
  }
};
