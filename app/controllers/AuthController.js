const bcrypt = require('bcrypt');
const jwt = require("jsonwebtoken");
const authConfig = require("../../config/auth");
const { sequelize } = require("../models")
const logger = require("../../config/logger");
const { UserRepository, UserTokenRepository, RoleRepository, LogRepository } = require("../repositories");

const AuthController = {

    async signUp(req, res) {
    logger.info("Registrando Usuario.");
    logger.info("Datos recibidos al registrarse:");
    logger.info(JSON.stringify(req.body));

    const t = await sequelize.transaction();
    try {
        // 1. Buscar rol por nombre (si se envía)
        let role_id = null;
        if (req.body.role_id) {
        const role = await RoleRepository.findById(req.body.role_id);
        if (!role) {
            await t.rollback();
            return res.status(400).json({ msg: "Rol no válido" });
        }
        }else {
         const invitedRole = await RoleRepository.findByName('Invited');
            if (invitedRole) {
            role_id = invitedRole.id;
            }
        }

        const hashedPassword = bcrypt.hashSync(req.body.password, parseInt(authConfig.rounds));
        const extractedUser = req.body.user || req.body.email.split("@")[0];

        const userData = {
        name: req.body.name,
        email: req.body.email,
        password: hashedPassword,
        status: false,        // ✅ nuevo usuario activo
        role_id: role_id,     // ✅ asignar desde tabla roles
        image: 'users/default.jpg',         // o procesa avatar si lo subes
        email_verified_at: null,
        remember_token: null,
        registration_date: null,
        user: extractedUser
        };

        const user = await UserRepository.create(userData);

        const roleName = user.role?.name || 'Invited';

        const userNew = {
        id: user.id,
        email: user.email,
        name: user.name,
        user: user.user,
        role: roleName,
        role_id: user.role_id
        };

        const token = jwt.sign({ user: userNew }, authConfig.secret, { expiresIn: authConfig.expires });
        const decoded = jwt.decode(token);
        const expiresAt = new Date(decoded.exp * 1000);

        await UserTokenRepository.create({
        user_id: user.id,
        token,
        expires_at: expiresAt,
        }, t);

        await t.commit();

        return res.status(201).json({
        id: userNew.id,
        name: userNew.name,
        email: userNew.email,
        user: userNew.user,
        token,
        role: userNew.role,
        role_id: userNew.role_id,
        });

    } catch (error) {
        await t.rollback();
        const errorMsg = error.details ? error.details.map(d => d.message).join(", ") : error.message;
        logger.error("Error al registrar usuario: " + errorMsg);
        return res.status(500).json({ error: "ServerError", details: errorMsg });
    }
    },

    async signIn(req, res) {
    logger.info("Entrando a loguearse");
    logger.info("Datos recibidos al loguearse:");
    logger.info(JSON.stringify(req.body));

    try {
        const user = await UserRepository.findByEmailOrName(req.body.email);
         // Obtener IP y User-Agent
        const ip = req.ip || req.connection.remoteAddress || 'unknown';
        const userAgent = req.get('User-Agent') || null;
        if (!user) {
           await LogRepository.create({
            action: 'auth.login',
            description: `Intento de login: usuario no encontrado (${req.body.email})`,
            ip_address: ip,
            user_agent: userAgent,
            status: 'error'
          });
        return res.status(204).json({ msg: "Usuario no encontrado" });
        }

        // ✅ Verificar que el usuario esté activo
        if (user.status !== true) {
          await LogRepository.create({
          user_id: user.id,
          action: 'auth.login',
          description: `Intento de login: usuario inactivo (${user.email})`,
          ip_address: ip,
          user_agent: userAgent,
          status: 'error'
        });
        return res.status(403).json({ msg: "Usuario inactivo" });
        }

        if (!user.password || user.password === "") {
          await LogRepository.create({
            user_id: user.id,
            action: 'auth.login',
            description: `Intento de login: credenciales inválidas (sin contraseña)`,
            ip_address: ip,
            user_agent: userAgent,
            status: 'error'
          });
        return res.status(400).json({ msg: "Credenciales inválidas" });
        }

        const isMatch = await bcrypt.compare(req.body.password, user.password);
        if (!isMatch) {
          await LogRepository.create({
            user_id: user.id,
            action: 'auth.login',
            description: `Intento de login: contraseña incorrecta (${user.email})`,
            ip_address: ip,
            user_agent: userAgent,
            status: 'error'
          });
        return res.status(400).json({ msg: "Credenciales inválidas" });
        }
        // ✅ Rol desde la relación con tabla roles
        const roleName = user.role?.name || 'invited'; // fallback seguro

        const userNew = {
        id: user.id,
        email: user.email,
        name: user.name,
        user: user.user,
        role: roleName,
        role_id: user.role_id
        };

        const token = jwt.sign({ user: userNew }, authConfig.secret, {
        expiresIn: authConfig.expires,
        });

        const decoded = jwt.decode(token);
        const expiresAt = new Date(decoded.exp * 1000);

        await UserTokenRepository.create({
        user_id: user.id,
        token,
        expires_at: expiresAt,
        });

        await LogRepository.create({
          user_id: user.id,
          action: 'auth.login',
          description: `Login exitoso (${user.email})`,
          ip_address: ip,
          user_agent: userAgent,
          status: 'success'
        });

        return res.status(200).json({
        id: userNew.id,
        name: userNew.name,
        user: userNew.user,
        email: userNew.email,
        token,
        role: userNew.role,
        role_id: userNew.role_id,
        });

    } catch (error) {
        const errorMsg = error.details ? error.details.map(d => d.message).join(", ") : error.message;
        logger.error("Error al loguear usuario: " + errorMsg);
        return res.status(500).json({ error: "ServerError", details: errorMsg });
    }
    },
    async logout(req, res) {
    logger.info(`${req.user.name} - Cierra sessión`);
     const ip = req.ip || 'unknown';
      const userAgent = req.get('User-Agent') || null;
      const userId = req.user?.id || null;

    try {
      const token = req.headers["authorization"]?.split(" ")[1]; // Obtener el token del encabezado Authorization

      if (!token) {
        return res.status(400).json({ msg: "No token proporcionado" });
      }

      const result = await UserTokenRepository.revokeByToken(token);
        if (!result.success) {
          await LogRepository.create({
            user_id: userId,
            action: 'auth.logout',
            description: `Logout fallido: ${result.error}`,
            ip_address: ip,
            user_agent: userAgent,
            status: 'error'
          });
        return res.status(400).json({ msg: result.error });
        }

        await LogRepository.create({
          user_id: userId,
          action: 'auth.logout',
          description: `Logout exitoso (${req.user?.email || 'desconocido'})`,
          ip_address: ip,
          user_agent: userAgent,
          status: 'success'
        });
      // Responder al cliente
      res.status(200).json({ msg: "Logout exitoso" });
    } catch (err) {
      logger.error("Error al hacer logout: " + err.message);
      res.status(500).json({ error: "Error en el servidor" });
    }
  },

  async destroy(req, res) {
    const requesterId = req.user?.id || null;
    const requesterName = req.user?.name || 'Anonymous';
    const userIdToDelete = req.params.id || req.body.id;

    logger.info(`${requesterName} - Intenta eliminar usuario con ID: ${userIdToDelete}`);
    logger.info("Datos recibidos (params):");
    logger.info(JSON.stringify({ params: req.params, query: req.query, body: req.body }));

    const ip = req.ip || 'unknown';
    const userAgent = req.get('User-Agent') || null;

    try {

      // 2. Buscar al usuario a eliminar (con su rol cargado)
      const userToDelete = await UserRepository.findById(userIdToDelete, {
        include: [{ association: 'role' }]
      });

      if (!userToDelete) {
        await LogRepository.create({
        user_id: requesterId,
        action: 'user.delete',
        description: `Intentó eliminar usuario inexistente (ID: ${userIdToDelete})`,
        ip_address: ip,
        user_agent: userAgent,
        status: 'error'
      });
        return res.status(404).json({ msg: "Usuario no encontrado" });
      }

      // 3. Evitar que un usuario se elimine a sí mismo (opcional, pero recomendado)
      if (req.user?.id && req.user.id.toString() === userIdToDelete.toString()) {
        await LogRepository.create({
        user_id: requesterId,
        action: 'user.delete',
        description: `(Intentó eliminarse a sí mismo)`,
        ip_address: ip,
        user_agent: userAgent,
        status: 'error'
      });
        return res.status(400).json({ msg: "No puedes eliminarte a ti mismo" });
      }

      // 4. Ejecutar la eliminación segura (incluye la validación del último Admin)
      const result = await UserRepository.delete(userToDelete);

      if (result.success) {
      // 📝 Log: eliminación exitosa
      await LogRepository.create({
        user_id: requesterId, // el usuario que fue eliminado
        action: 'user.delete',
        description: `Elimina al usuario (${userToDelete.name} con rol: ${userToDelete.role?.name || 'sin rol'})`,
        ip_address: ip,
        user_agent: userAgent,
        status: 'success'
      });
    } else {
      // 📝 Log: eliminación fallida (ej: último admin)
      await LogRepository.create({
        user_id: requesterId,
        action: 'user.delete',
        description: `Error al eliminar a (${userToDelete.name} con rol: ${userToDelete.role?.name || 'sin rol'}: ${result.message})`,
        ip_address: ip,
        user_agent: userAgent,
        status: 'error'
      });
    }
      return res.status(200).json({
        success: result.success,
        message: result.message
      });

    } catch (error) {
      // Manejo de errores específicos (como el del último admin)
      if (error.message.includes('último usuario administrador')) {
        logger.warn(`Intento fallido de eliminar último admin por ${requesterName}`);
        return res.status(403).json({ 
          msg: "Prohibido: no se puede eliminar el último administrador del sistema" 
        });
      }

      // Error genérico
      logger.error(`UserController->destroy: ${error.message}`, error);
      return res.status(500).json({ error: "ServerError", details: error.message });
    }
  },
  async index(req, res) {
    const requesterName = req.user?.name || 'Anonymous';
    logger.info(`${requesterName} - Solicita lista de usuarios (plana)`);

    try {
      const users = await UserRepository.findAll();

      return res.status(200).json({
        success: true,
        count: users.length,
        users: users // ya están en formato plano
      });
    } catch (error) {
      logger.error(`UserController->index: ${error.message}`);
      return res.status(500).json({ error: "ServerError", details: error.message });
    }
  },

  async update(req, res) {
      const requesterId = req.user?.id || null;
      const requesterName = req.user?.name || 'Anonymous';
      const ip = req.ip || 'unknown';
      const userAgent = req.get('User-Agent') || null;
    logger.info(`${requesterName} - Editando un usuario`);

    try {
      const userId = req.body.id;

      // Buscar usuario con su rol
      const user = await UserRepository.findById(userId, {
        include: [{ association: 'role' }]
      });

      if (!user) {
        return res.status(204).json({ msg: 'UserNotFound' });
      }

    // 👇 Lógica especial: si status es 1 o true, establecer registration_date a ahora
      const updateData = { ...req.body };

      // 👉 Capturar valores actuales para comparar cambios
      const originalStatus = user.status;
      const originalRoleId = user.role_id;
      const originalRoleName = user.role?.name || 'sin rol';

      if ('status' in req.body) {
        // Normalizar status a booleano
        const statusValue = [1, '1', true, 'true'].includes(req.body.status);
        if (statusValue && !user.registration_date) {
          // Solo asignar registration_date si aún no tiene (evita sobrescribir)
          updateData.registration_date = new Date();
        }
        // Convertir status a booleano para consistencia en la BD
        updateData.status = statusValue;
      }

      // Actualizar con los datos (incluyendo registration_date si aplica)
      const updatedUser = await UserRepository.update(user, updateData);

      // 👉 Detectar si hay cambio de rol o status
      const newStatus = updateData.status !== undefined ? updateData.status : originalStatus;
      const newRoleId = updateData.role_id !== undefined ? updateData.role_id : originalRoleId;

      // 👉 Registrar logs de cambios relevantes
      const logsToCreate = [];
       // 📝 Log: cambio de status
      if (updateData.status !== undefined && newStatus !== originalStatus) {
        logsToCreate.push({
          user_id: requesterId,
          action: 'user.update.status',
          description: `Actualiza el estado de ${user.name} de (${originalStatus ? 'activo' : 'inactivo'} a ${newStatus ? 'activo' : 'inactivo'})`,
          ip_address: ip,
          user_agent: userAgent,
          status: 'success',
          meta: {
            field: 'status',
            old_value: originalStatus,
            new_value: newStatus
          }
        });
      }

      // 📝 Log: cambio de rol
    if (updateData.role_id !== undefined && newRoleId !== originalRoleId) {
      // Obtener nombre del nuevo rol (si es posible)
      let newRoleName = 'desconocido';
      if (newRoleId) {
        const newRole = await RoleRepository.findById(newRoleId);
        newRoleName = newRole?.name || 'rol eliminado';
      }

      logsToCreate.push({
        user_id: requesterId,
        action: 'user.update.role',
        description: `Actualiza el rol de ${user.name} de ("${originalRoleName}" a "${newRoleName}")`,
        ip_address: ip,
        user_agent: userAgent,
        status: 'success',
        meta: {
          field: 'role_id',
          old_role_id: originalRoleId,
          old_role_name: originalRoleName,
          new_role_id: newRoleId,
          new_role_name: newRoleName
        }
      });
    }

    // Si hubo al menos un cambio relevante, registrar logs
    if (logsToCreate.length > 0) {
      await Promise.all(
        logsToCreate.map(logData => LogRepository.create(logData))
      );
    }
      // Preparar respuesta plana (opcional, pero coherente con tu estilo)
      const userResponse = await UserRepository.findAll();

      return res.status(200).json({
        msg: 'Usuario editado correctamente',
        user: userResponse
      });

    } catch (error) {
      const errorMsg = error.details
        ? error.details.map(detail => detail.message).join(', ')
        : error.message || 'Error desconocido';

      logger.error(`UserController->update: Error al actualizar el usuario: ${errorMsg}`);
      return res.status(500).json({ error: 'ServerError', details: errorMsg });
    }
  }
};

module.exports = AuthController;