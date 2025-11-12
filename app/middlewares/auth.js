const jwt = require('jsonwebtoken');
const authConfig = require('../../config/auth');
const { runWithUser } = require('../../config/context');
const { User, UserToken } = require('../models');
const logger = require('../../config/logger');
const { UserTokenRepository } = require('../repositories');

module.exports = async (req, res, next) => {
    // Verificar si el token existe en los encabezados de la solicitud
    const token = req.headers.authorization?.split(" ")[1];

    if (!token) {
        return res.status(401).json({ msg: "Acceso no autorizado: token no proporcionado" });
    }

    try {
        const userToken = await UserTokenRepository.findByToken(token);
        if (!userToken) {
        return res.status(401).json({ msg: 'Acceso no autorizado: token inválido, revocado o expirado' });
        }
        // Verificar la validez del token usando jwt.verify
        jwt.verify(token, authConfig.secret, async (err, decoded) => {
            if (err) {
                return res.status(500).json({ msg: "Error al verificar el token", err });
            }

            // Almacenar el ID del usuario en el contexto
            runWithUser(decoded.user.id, async () => {
                req.user = decoded.user; // Puedes mantenerlo si necesitas acceder a otros datos del usuario
                req.profile = decoded.user.profile;
                next();
            });

        });
    } catch (error) {
        logger.error(`Error al verificar el token: ${error.message}`);
        return res.status(500).json({ msg: "Error en el servidor", error });
    }
};
