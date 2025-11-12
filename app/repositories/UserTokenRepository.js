// app/repositories/UserTokenRepository.js
const { Op } = require('sequelize');
const { UserToken, User } = require('../models'); // Asegúrate de que el modelo se llame UserToken
const logger = require('../../config/logger');

const UserTokenRepository = {
  // Crear un nuevo token
  async create(tokenData) {
    try {
      const { user_id, token, expires_at, revoked = false } = tokenData;

      const userToken = await UserToken.create({
        user_id,
        token,
        expires_at,
        revoked,
      });
      return userToken;
    } catch (error) {
      logger.error('Error al crear token de usuario:', error);
      throw new Error(`Error al crear token de usuario: ${error.message}`);
    }
  },

  // Buscar un token por su valor (útil para autenticación)
  async findByToken(tokenValue) {
    try {
      const userToken = await UserToken.findOne({
        where: {
          token: tokenValue,
          revoked: false, // Solo tokens no revocados
          [Op.or]: [
            { expires_at: null }, // Tokens sin expiración
            { expires_at: { [Op.gt]: new Date() } }, // Tokens no expirados
          ],
        },
      });

      return userToken;
    } catch (error) {
      logger.error('Error al buscar token por valor:', error);
      throw new Error(`Error al buscar token por valor: ${error.message}`);
    }
  },

  // Obtener todos los tokens de un usuario (útil para listar o revocar)
  async findByUserId(userId) {
    try {
      const tokens = await UserToken.findAll({
        where: { user_id: userId },
        order: [['createdAt', 'DESC']],
      });
      return tokens;
    } catch (error) {
      logger.error(`Error al obtener tokens del usuario ID: ${userId}:`, error);
      throw new Error(`Error al obtener tokens del usuario ID: ${error.message}`);
    }
  },

  // Revocar un token específico (por ID)
  async revokeById(tokenId) {
    try {
      const userToken = await UserToken.findByPk(tokenId);
      if (!userToken) {
        logger.info(`Intento de revocar token inexistente ID: ${tokenId}`);
        return { success: false, error: 'Token no encontrado' };
      }

      await userToken.update({ revoked: true });
      return { success: true, message: 'Token revocado' };
    } catch (error) {
      logger.error(`Error al revocar token ID: ${tokenId}:`, error);
      throw new Error(`Error al revocar token ID: ${tokenId}: ${error.message}`);
    }
  },

  // Revocar un token por su valor (string)
async revokeByToken(tokenValue) {
  try {
    const [updatedCount] = await UserToken.update(
      { revoked: true },
      {
        where: {
          token: tokenValue,
          revoked: false, // Solo revocar si aún no está revocado
        },
      }
    );

    if (updatedCount === 0) {
      logger.info(`Intento de revocar token inexistente o ya revocado: ${tokenValue.substring(0, 20)}...`);
      return { success: false, error: 'Token no encontrado o ya revocado' };
    }

    return { success: true, count: updatedCount };
  } catch (error) {
    logger.error('Error al revocar token por valor:', error);
    throw new Error(`Error al revocar token: ${error.message}`);
  }
},

  // Revocar todos los tokens de un usuario (útil al cerrar sesión en todos los dispositivos)
  async revokeAllByUserId(userId) {
    try {
      const [updatedCount] = await UserToken.update(
        { revoked: true },
        {
          where: {
            user_id: userId,
            revoked: false,
          },
        }
      );

      return updatedCount;
    } catch (error) {
      logger.error(`Error al revocar todos los tokens del usuario ID: ${userId}:`, error);
      throw new Error(`Error al revocar todos los tokens del usuario ID: ${userId}: ${error.message}`);
    }
  },

  // Eliminar tokens expirados (útil para limpieza periódica)
  async deleteExpiredTokens() {
    try {
      const deletedCount = await UserToken.destroy({
        where: {
          expires_at: { [Op.lt]: new Date() },
          revoked: true, // Opcional: solo los ya revocados
        },
      });

      return deletedCount;
    } catch (error) {
      logger.error('Error al eliminar tokens expirados:', error);
      throw new Error(`Error al eliminar tokens expirados: ${error.message}`);
    }
  },
};

module.exports = UserTokenRepository;