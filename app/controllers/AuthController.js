const bcrypt = require("bcrypt");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const authConfig = require("../../config/auth");
const { sequelize } = require("../models");
const logger = require("../../config/logger");
const {
  UserRepository,
  UserTokenRepository,
  RoleRepository,
  LogRepository,
  CompanyRepository,
  UserCompanyRepository,
  WarehouseRepository,
  PoolRepository,
  UserAclScopeRepository,
  BranchRepository,
  RolePermissionRepository,
} = require("../repositories");
const { sendEmail } = require("../services/EmailService");
// 📨 Método independiente para enviar correo de invitación
async function sendInvitationEmail({
  to,
  inviterName,
  companyName,
  inviteLink,
  companyId,
  ip,
  userAgent,
  invitedByUserId,
}) {
  const emailHtml = `
    <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f9f9f9;">
      <div style="background-color: white; padding: 30px; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">
        <h2 style="color: #006064; margin-top: 0;">👋 ¡Hola!</h2>
        <p style="font-size: 16px; line-height: 1.6; color: #333;">
          Has sido invitado por <strong>${inviterName}</strong> a unirte al equipo de 
          <strong>${companyName}</strong> en <strong>Spree</strong>.
        </p>
        <p style="font-size: 16px; line-height: 1.6; color: #333;">
          Al aceptar esta invitación, podrás colaborar con su organización directamente desde la plataforma.
        </p>
        <div style="text-align: center; margin: 32px 0;">
          <a href="${inviteLink}" 
             style="display: inline-block; padding: 14px 32px; background-color: #006064; color: white; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px; transition: background-color 0.2s;">
            Aceptar invitación
          </a>
        </div>
        <p style="font-size: 14px; color: #555; text-align: center; margin-bottom: 0;">
          🔒 Este enlace es válido durante <strong>24 horas</strong> por seguridad.
        </p>
        <hr style="border: 0; border-top: 1px solid #eee; margin: 28px 0;">
        <p style="font-size: 13px; color: #777; margin-top: 24px; text-align: center;">
          Si no reconoces esta invitación o no esperabas unirte a <strong>${companyName}</strong>, 
          por favor ignórala.
        </p>
      </div>
      <p style="font-size: 12px; color: #999; text-align: center; margin-top: 20px;">
        © ${new Date().getFullYear()} Spree. Todos los derechos reservados.
      </p>
    </div>
  `;

  // Enviar correo
  await sendEmail({
    to,
    subject: `📬 Únete a ${companyName} en Spree Invitación de ${inviterName}`,
    text: `Hola, ${inviterName} te ha invitado a unirte al equipo de ${companyName} en Spree. Accede al enlace para aceptar: ${inviteLink}`,
    html: emailHtml,
  });

  // Registrar log
  await LogRepository.create({
    user_id: invitedByUserId,
    company_id: companyId,
    action: "user.invite",
    description: `Invitó al correo ${to} a la empresa ${companyName}`,
    ip_address: ip,
    user_agent: userAgent,
    status: "success",
  });
}
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
      } else {
        const invitedRole = await RoleRepository.findByName("Invited");
        if (invitedRole) {
          role_id = invitedRole.id;
        }
      }

      const hashedPassword = bcrypt.hashSync(
        req.body.password,
        parseInt(authConfig.rounds)
      );
      const extractedUser = req.body.user || req.body.email.split("@")[0];

      const userData = {
        name: req.body.name,
        email: req.body.email,
        password: hashedPassword,
        status: false, // ✅ nuevo usuario activo
        role_id: role_id, // ✅ asignar desde tabla roles
        image: "users/default.jpg", // o procesa avatar si lo subes
        email_verified_at: null,
        remember_token: null,
        registration_date: null,
        user: extractedUser,
      };

      const user = await UserRepository.create(userData);

      const roleName = user.role?.name || "Invited";

      const userNew = {
        id: user.id,
        email: user.email,
        name: user.name,
        user: user.user,
        image: user.image,
        role: roleName,
        role_id: user.role_id,
      };

      const token = jwt.sign({ user: userNew }, authConfig.secret, {
        expiresIn: authConfig.expires,
      });
      const decoded = jwt.decode(token);
      const expiresAt = new Date(decoded.exp * 1000);

      await UserTokenRepository.create(
        {
          user_id: user.id,
          token,
          expires_at: expiresAt,
        },
        t
      );

      await t.commit();

      return res.status(201).json({
        id: userNew.id,
        name: userNew.name,
        email: userNew.email,
        user: userNew.user,
        image: userNew.image,
        token,
        role: userNew.role,
        role_id: userNew.role_id,
      });
    } catch (error) {
      await t.rollback();
      const errorMsg = error.details
        ? error.details.map((d) => d.message).join(", ")
        : error.message;
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
      const ip = req.ip || req.connection.remoteAddress || "unknown";
      const userAgent = req.get("User-Agent") || null;
      if (!user) {
        await LogRepository.create({
          action: "auth.login",
          description: `Intento de login: usuario no encontrado (${req.body.email})`,
          ip_address: ip,
          user_agent: userAgent,
          status: "error",
        });
        return res.status(204).json({ msg: "Usuario no encontrado" });
      }

      // ✅ Verificar que el usuario esté activo
      if (user.status !== true) {
        await LogRepository.create({
          user_id: user.id,
          action: "auth.login",
          description: `Intento de login: usuario inactivo (${user.email})`,
          ip_address: ip,
          user_agent: userAgent,
          status: "error",
        });
        return res.status(403).json({ msg: "Usuario inactivo" });
      }

      if (!user.password || user.password === "") {
        await LogRepository.create({
          user_id: user.id,
          action: "auth.login",
          description: `Intento de login: credenciales inválidas (sin contraseña)`,
          ip_address: ip,
          user_agent: userAgent,
          status: "error",
        });
        return res.status(400).json({ msg: "Credenciales inválidas" });
      }

      const isMatch = await bcrypt.compare(req.body.password, user.password);
      if (!isMatch) {
        await LogRepository.create({
          user_id: user.id,
          action: "auth.login",
          description: `Intento de login: contraseña incorrecta (${user.email})`,
          ip_address: ip,
          user_agent: userAgent,
          status: "error",
        });
        return res.status(400).json({ msg: "Credenciales inválidas" });
      }
      // ✅ Rol desde la PRIMERA MEMBRESÍA ACTIVA del usuario
      let role = null;
      let role_id = null;
      let company_id = null;
      let plan = null;
      if (user.memberships && user.memberships.length > 0) {
        // Opcional: filtrar solo membresías activas (status = 1)
        const activeMemberships = user.memberships.filter(
          (m) => m.status === 1
        );
        const firstMembership = activeMemberships[0] || user.memberships[0];

        role = firstMembership.role || null;
        role_id = firstMembership.role_id || null;
        company_id = firstMembership.company_id;
        plan = firstMembership.company.plan || null;
      }

      const userNew = {
        id: user.id,
        email: user.email,
        name: user.name,
        user: user.user,
        image: user.image,
        role: role,
        role_id: role_id,
        company_id: company_id,
        plan: plan
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
        action: "auth.login",
        description: `Login exitoso (${user.email})`,
        ip_address: ip,
        user_agent: userAgent,
        status: "success",
      });

      return res.status(200).json({
        id: userNew.id,
        name: userNew.name,
        user: userNew.user,
        email: userNew.email,
        image: userNew.image,
        token,
        role: userNew.role,
        plan: userNew.plan,
        role_id: userNew.role_id,
        company_id: userNew.company_id,
      });
    } catch (error) {
      const errorMsg = error.details
        ? error.details.map((d) => d.message).join(", ")
        : error.message;
      logger.error("Error al loguear usuario: " + errorMsg);
      return res.status(500).json({ error: "ServerError", details: errorMsg });
    }
  },
  async logout(req, res) {
    logger.info(`${req.user.name} - Cierra sessión`);
    const ip = req.ip || "unknown";
    const userAgent = req.get("User-Agent") || null;
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
          action: "auth.logout",
          description: `Logout fallido: ${result.error}`,
          ip_address: ip,
          user_agent: userAgent,
          status: "error",
        });
        return res.status(400).json({ msg: result.error });
      }

      await LogRepository.create({
        user_id: userId,
        action: "auth.logout",
        description: `Logout exitoso (${req.user?.email || "desconocido"})`,
        ip_address: ip,
        user_agent: userAgent,
        status: "success",
      });
      // Responder al cliente
      res.status(200).json({ msg: "Logout exitoso" });
    } catch (err) {
      logger.error("Error al hacer logout: " + err.message);
      res.status(500).json({ error: "Error en el servidor" });
    }
  },

  async getUsers(req, res) {
    const { company_id } = req.body;
    const requester = req.user?.name || "Anonymous";

    logger.info(
      `${requester} - Solicita usuarios de la empresa ID ${company_id}`
    );

    try {
      // Validar que la empresa exista (opcional, pero buena práctica)
      const company = await CompanyRepository.findById(company_id);
      if (!company) {
        return res
          .status(404)
          .json({ success: false, message: "Empresa no encontrada" });
      }

      // Obtener usuarios
      const users = await UserCompanyRepository.getUsersByCompanyId(company_id);

      return res.status(200).json({
        success: true,
        users: users,
        count: users.length,
      });
    } catch (error) {
      logger.error(`CompanyController->getUsers: ${error.message}`);
      return res
        .status(500)
        .json({
          success: false,
          error: "Error interno",
          details: error.message,
        });
    }
  },

  async destroy(req, res) {
    const requesterId = req.user?.id || null;
    const requesterName = req.user?.name || "Anonymous";
    const userIdToDelete = req.body.user_id;

    logger.info(
      `${requesterName} - Intenta eliminar usuario con ID: ${userIdToDelete}`
    );
    logger.info("Datos recibidos (body):");
    logger.info(JSON.stringify(req.body));

    const ip = req.ip || "unknown";
    const userAgent = req.get("User-Agent") || null;

    try {
      // 2. Buscar al usuario a eliminar (con su rol cargado)
      const userToDelete = await UserRepository.findById(userIdToDelete);

      if (!userToDelete) {
        await LogRepository.create({
          user_id: requesterId,
          action: "user.delete",
          description: `Intentó eliminar usuario inexistente (ID: ${userIdToDelete})`,
          ip_address: ip,
          user_agent: userAgent,
          status: "error",
        });
        return res.status(404).json({ msg: "Usuario no encontrado" });
      }

      // 3. Evitar que un usuario se elimine a sí mismo (opcional, pero recomendado)
      if (
        req.user?.id &&
        req.user.id.toString() === userIdToDelete.toString()
      ) {
        await LogRepository.create({
          user_id: requesterId,
          action: "user.delete",
          description: `(Intentó eliminarse a sí mismo)`,
          ip_address: ip,
          user_agent: userAgent,
          status: "error",
        });
        return res.status(400).json({ msg: "No puedes eliminarte a ti mismo" });
      }

      // 4. Ejecutar la eliminación segura (incluye la validación del último Admin)
      const result = await UserRepository.delete(userToDelete);

      if (result.success) {
        // 📝 Log: eliminación exitosa
        await LogRepository.create({
          user_id: requesterId, // el usuario que fue eliminado
          action: "user.delete",
          description: `Elimina al usuario (${userToDelete.name} con rol: ${
            userToDelete.role?.name || "sin rol"
          })`,
          ip_address: ip,
          user_agent: userAgent,
          status: "success",
        });
      } else {
        // 📝 Log: eliminación fallida (ej: último admin)
        await LogRepository.create({
          user_id: requesterId,
          action: "user.delete",
          description: `Error al eliminar a (${userToDelete.name} con rol: ${
            userToDelete.role?.name || "sin rol"
          }: ${result.message})`,
          ip_address: ip,
          user_agent: userAgent,
          status: "error",
        });
      }
      if (result.code === "LAST_ADMIN") {
        return res.status(403).json({
          success: false,
          message: result.message,
        });
      } else return res.status(200).json(result);
    } catch (error) {
      // Solo para errores reales (DB caída, etc.)
      logger.error(`Error inesperado en destroy:`, error);
      await LogRepository.create({
        /* log de error crítico */
      });
      return res.status(500).json({
        success: false,
        message: "Error interno del servidor",
        details: error.message,
      });
    }
  },
  async index(req, res) {
    const requesterName = req.user?.name || "Anonymous";
    logger.info(`${requesterName} - Solicita lista de usuarios (plana)`);
    logger.info("Datos recibidos (body):");
    logger.info(JSON.stringify(req.body));
    const { company_id, role_id, status } = req.body;

    // Validar que el usuario autenticado pertenezca a la compañía
    const authUserCompany = await UserCompanyRepository.findByPk(company_id);

    if (!authUserCompany) {
      return res.status(204).json({
        success: false,
        message: "No usuarios asociados a esta compañía",
        users: [],
      });
    }

    const filters = {};
    if (company_id) filters.company_id = company_id;
    if (role_id) filters.role_id = role_id;
    if (status !== undefined) filters.status = status;

    try {
      const users = await UserRepository.findAll(filters);
      return res.status(200).json({
        success: true,
        users: users, // ya están en formato plano
      });
    } catch (error) {
      logger.error(`UserController->index: ${error.message}`);
      return res
        .status(500)
        .json({
          success: false,
          message: "Error Interno del Servidor",
          details: error.message,
        });
    }
  },

  async update(req, res) {
    const requesterId = req.user?.id || null;
    const requesterName = req.user?.name || "Anonymous";
    const ip = req.ip || "unknown";
    const userAgent = req.get("User-Agent") || null;
    logger.info(`${requesterName} - Editando un usuario`);

    try {
      const userId = req.body.id;

      // Buscar usuario con su rol
      const user = await UserRepository.findById(userId, {
        include: [{ association: "role" }],
      });

      if (!user) {
        return res.status(204).json({ msg: "UserNotFound" });
      }

      // 👇 Lógica especial: si status es 1 o true, establecer registration_date a ahora
      const updateData = { ...req.body };

      // 👉 Capturar valores actuales para comparar cambios
      const originalStatus = user.status;
      const originalRoleId = user.role_id;
      const originalRoleName = user.role?.name || "sin rol";

      if ("status" in req.body) {
        // Normalizar status a booleano
        const statusValue = [1, "1", true, "true"].includes(req.body.status);
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
      const newStatus =
        updateData.status !== undefined ? updateData.status : originalStatus;
      const newRoleId =
        updateData.role_id !== undefined ? updateData.role_id : originalRoleId;

      // 👉 Registrar logs de cambios relevantes
      const logsToCreate = [];
      // 📝 Log: cambio de status
      if (updateData.status !== undefined && newStatus !== originalStatus) {
        logsToCreate.push({
          user_id: requesterId,
          action: "user.update.status",
          description: `Actualiza el estado de ${user.name} de (${
            originalStatus ? "activo" : "inactivo"
          } a ${newStatus ? "activo" : "inactivo"})`,
          ip_address: ip,
          user_agent: userAgent,
          status: "success",
          meta: {
            field: "status",
            old_value: originalStatus,
            new_value: newStatus,
          },
        });
      }

      // 📝 Log: cambio de rol
      if (updateData.role_id !== undefined && newRoleId !== originalRoleId) {
        // Obtener nombre del nuevo rol (si es posible)
        let newRoleName = "desconocido";
        if (newRoleId) {
          const newRole = await RoleRepository.findById(newRoleId);
          newRoleName = newRole?.name || "rol eliminado";
        }

        logsToCreate.push({
          user_id: requesterId,
          action: "user.update.role",
          description: `Actualiza el rol de ${user.name} de ("${originalRoleName}" a "${newRoleName}")`,
          ip_address: ip,
          user_agent: userAgent,
          status: "success",
          meta: {
            field: "role_id",
            old_role_id: originalRoleId,
            old_role_name: originalRoleName,
            new_role_id: newRoleId,
            new_role_name: newRoleName,
          },
        });
      }

      // Si hubo al menos un cambio relevante, registrar logs
      if (logsToCreate.length > 0) {
        await Promise.all(
          logsToCreate.map((logData) => LogRepository.create(logData))
        );
      }
      // Preparar respuesta plana (opcional, pero coherente con tu estilo)
      const userResponse = await UserRepository.findAll();

      return res.status(200).json({
        msg: "Usuario editado correctamente",
        user: userResponse,
      });
    } catch (error) {
      const errorMsg = error.details
        ? error.details.map((detail) => detail.message).join(", ")
        : error.message || "Error desconocido";

      logger.error(
        `UserController->update: Error al actualizar el usuario: ${errorMsg}`
      );
      return res.status(500).json({ error: "ServerError", details: errorMsg });
    }
  },

  async forgotPassword(req, res) {
    logger.info(`${req.body.email} - solicita recuperar contraseña`);
    const t = await sequelize.transaction();

    try {
      const { email } = req.body;

      // Usar el nuevo método con transacción
      const user = await UserRepository.findByEmailWithTransaction(email, t);

      // Para evitar enumeración, responde éxito incluso si no existe
      if (!user) {
        await t.commit();
        return res.status(404).json({
          success: true,
          message: "No encontramos una cuenta con este correo.",
        });
      }

      const code = Math.floor(100000 + Math.random() * 900000).toString(); // 6 dígitos
      const hashedCode = bcrypt.hashSync(code, parseInt(authConfig.rounds));

      // Usar el nuevo método con transacción
      await UserRepository.updateResetTokenWithTransaction(
        user.id,
        {
          reset_token: hashedCode,
          reset_expire: Date.now() + 3 * 60 * 1000, // 3 min
        },
        t
      );

      logger.info(
        `Código de recuperación generado: ${code} para el usuario ${user.email}`
      );

      // Enviar correo (manteniendo tu lógica actual)
      await sendEmail(
        {
          to: email,
          subject: "Recuperación de contraseña - Huoon",
          text: `Tu código es: ${code}`,
          html: `<p>Tu código de recuperación es: <strong>${code}</strong></p>`,
        },
        { transaction: t }
      );

      await t.commit();

      res.status(200).json({
        success: true,
        message:
          "Te enviamos un código para restablecer tu contraseña. Revisa tu correo.",
      });
    } catch (error) {
      if (!t.finished) {
        await t.rollback();
      }

      logger.error("Error en forgotPassword:", error);
      res.status(500).json({
        success: false,
        message: "Hubo un problema al enviar el correo. Inténtalo más tarde.",
      });
    }
  },

  async resetPassword(req, res) {
    logger.info("Datos recibidos al cambiar la contraseña:");
    logger.info(JSON.stringify(req.body));
    try {
      const { user_id, newPassword } = req.body;

      const user = await UserRepository.findById(user_id);
      if (!user) {
        return res.json({ success: false, message: "Usuario no encontrado" });
      }

      const saltRounds = parseInt(authConfig.rounds, 10);
      logger.info("saltRounds");
      logger.info(saltRounds);
      const hashedPassword = bcrypt.hashSync(newPassword, saltRounds);

      await UserRepository.update(
        user,
        { password: hashedPassword, reset_expire: null, reset_token: null },
        null
      );

      res.json({ success: true, message: "Contraseña actualizada" });
    } catch (error) {
      logger.error("Error en resetPassword:", error);
      res.status(500).json({ success: false, message: "Error interno" });
    }
  },
  async verifyCode(req, res) {
    try {
      const { email } = req.body;
      const user = await UserRepository.findByEmailWithTransaction(email, null);

      if (!user) {
        logger.info("Usuario no encontrado");
        return res
          .status(404)
          .json({ success: false, message: "Usuario no encontrado" });
      }

      const isMatch = await bcrypt.compare(code, user.reset_token);
      if (!isMatch) {
        logger.info("Código incorrecto");
        return res
          .status(400)
          .json({ success: false, message: "Código incorrecto" });
      }

      // Opcional: verificar expiración
      if (user.reset_expire < Date.now()) {
        logger.info("Código expirado");
        return res
          .status(400)
          .json({ success: false, message: "Código expirado" });
      }

      res.status(200).json({
        success: true,
        userId: user.id,
        email: user.email,
      });
    } catch (error) {
      logger.error("Error en verifyCode:", error);
      res.status(500).json({ success: false, message: "Error interno" });
    }
  },
  async verifyInvitation(req, res) {
  const { token, company_id } = req.query;

  logger.info('Verificando invitación con token y company_id:');
  logger.info(token);
  logger.info(company_id);

  const transaction = await sequelize.transaction();
  try {
    // 🔑 1. Buscar membresía PENDIENTE usando token + company_id
    const pendingMembership = await UserCompanyRepository.findPendingByTokenAndCompany(
      token,
      company_id,
      transaction
    );

    if (!pendingMembership) {
      await transaction.rollback();
      logger.info("No se encontró invitación pendiente con ese token y empresa");
      return res.status(400).json({ success: false, message: "Token inválido, expirado o ya utilizado" });
    }

    // 📅 2. Verificar expiración (usando getTime() para evitar problemas de timezone)
    if (new Date(pendingMembership.expires_at).getTime() < Date.now()) {
      await transaction.rollback();
      logger.info("Token de invitación expirado");
      return res.status(400).json({ success: false, message: "El enlace de invitación ha expirado" });
    }

    // 👤 3. Cargar datos del usuario (para la respuesta)
    const user = await UserRepository.findById(pendingMembership.user_id, transaction);
    if (!user) {
      await transaction.rollback();
      logger.error("Usuario asociado a la membresía no encontrado");
      return res.status(500).json({ success: false, message: "Inconsistencia de datos" });
    }

    // ✅ 4. Activar la membresía
    await UserCompanyRepository.activateMembership(
      {
        user_id: pendingMembership.user_id,
        company_id: company_id,
      },
      transaction
    );

    await transaction.commit();

    logger.info(`Invitación aceptada: usuario ${user.email} en empresa ${company_id}`);
    return res.redirect(302, `${process.env.FRONTEND_URL}/login`);

  } catch (error) {
     if (!transaction.finished) {
      await transaction.rollback();
    }
    logger.error("Error en verifyInvitation:", error);
    return res.status(500).json({ success: false, message: "Error interno al procesar la invitación" });
  }
},
  async associateUserToCompany(req, res) {
    // ✅ LOG al inicio: quién y qué datos
    logger.info(`${req.user?.name || "Unknown"} - Asocia usuario a empresa`);
    logger.info("Datos recibidos:");
    logger.info(JSON.stringify(req.body));

    const {
      name,
      email,
      password,
      user,
      company_id: rawCompanyId,
      role_id: rawRoleId,
      invitation_method,
      warehouses: rawWarehouses = [],
      pools: rawPools = [],
    } = req.body;

    // Parsear si son strings
    const company_id = Number(rawCompanyId);
    const role_id = Number(rawRoleId);

    // Parsear warehouses y pools
    let warehouses = [];
    let pools = [];

    if (typeof rawWarehouses === "string" && rawWarehouses.trim()) {
      warehouses = JSON.parse(rawWarehouses);
    }
    if (typeof rawPools === "string" && rawPools.trim()) {
      pools = JSON.parse(rawPools);
    }
    // Asegurar que son arrays de números
    warehouses = (Array.isArray(warehouses) ? warehouses : []).map(Number);
    pools = (Array.isArray(pools) ? pools : []).map(Number);

    // 1. Validar entidades maestras
    let company; // 👈 declarar aquí
    let role;
    try {
      company = await CompanyRepository.findById(company_id);
      if (!company)
        return res
          .status(400)
          .json({ success: false, message: "Empresa no encontrada" });

      role = await RoleRepository.findById(role_id);
      if (!role)
        return res
          .status(400)
          .json({ success: false, message: "Rol no encontrado" });

      if (pools?.length) {
        const poolCheck = await PoolRepository.validatePoolIdsExist(pools);
        if (!poolCheck.valid) {
          return res.status(400).json({
            success: false,
            message: "Algunos pool IDs no existen",
            invalid_pools: poolCheck.invalidIds,
          });
        }
      }

      // Validar almacenes
      if (warehouses?.length) {
        const whCheck = await WarehouseRepository.validateWarehouseIdsExist(
          warehouses
        );
        if (!whCheck.valid) {
          return res.status(400).json({
            success: false,
            message: "Algunos warehouse IDs no existen",
            invalid_warehouses: whCheck.invalidIds,
          });
        }
      }
    } catch (error) {
      logger.error("Error en validación:", error.message);
      return res.status(400).json({ success: false, message: error.message });
    }
    const transaction = await sequelize.transaction();
    let userBd, membership;
    let invitationToken = null;
    try {
      // 2. Verificar si el usuario ya existe
      userBd = await UserRepository.existsByEmail(email);
      if (userBd) {
        const existingMembership =
          await UserCompanyRepository.findByUserIdAndCompanyId(
            userBd.id,
            company_id
          );
        if (existingMembership) {
          await transaction.rollback();
          return res
            .status(400)
            .json({
              success: false,
              message: "El usuario ya pertenece a esta empresa",
            });
        }
        membership = await UserCompanyRepository.create(
          {
            user_id: userBd.id,
            company_id,
            role_id,
            status: 1,
            joined_at: new Date(),
            invited_by: req.user?.id || null,
          },
          transaction
        );
      } else {
        const extractedUser = user || email.split("@")[0];
        const hashedPassword = bcrypt.hashSync(
          req.body.password || extractedUser,
          parseInt(authConfig.rounds)
        );
        userBd = await UserRepository.create(
          {
            name,
            email,
            hashedPassword,
            extractedUser,
            status: true,
            registration_date: new Date(),
          },
          req.file,
          transaction
        );
        invitationToken = crypto.randomBytes(32).toString("hex");
        logger.info('token a verificar');
        logger.info(invitationToken);
        const hashedInvitationToken = bcrypt.hashSync(
          invitationToken,
          parseInt(authConfig.rounds) // o usa un valor fijo, ej: 10
        );

        membership = await UserCompanyRepository.create(
          {
            user_id: userBd.id,
            company_id,
            role_id,
            status: -1, // pending
            joined_at: null,
            invited_by: req.user?.id || null,
            invitation_token: hashedInvitationToken,
            expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
          },
          transaction
        );
      }
      // 3. Crear scopes
      const scopes = [];
      warehouses.forEach((wid) =>
        scopes.push({ user_id: userBd.id, company_id, warehouse_id: wid })
      );
      pools.forEach((pid) =>
        scopes.push({ user_id: userBd.id, company_id, pool_id: pid })
      );

      if (scopes.length > 0) {
        await UserAclScopeRepository.bulkCreate(scopes, transaction);
      }

      await transaction.commit();
    } catch (error) {
       if (!transaction.finished) {
      await transaction.rollback();
    }
      logger.error("Error en transacción:", { error: error?.stack || error });
      return res
        .status(500)
        .json({ success: false, message: "Error al procesar solicitud" });
    }
    const filters = { company_id };
    let users;
    try {
      users = await UserRepository.findAll(filters);
    } catch (error) {
      logger.error("Error al listar usuarios tras asociación:", error.message);
      // No fallamos la operación principal
      users = [];
    }

    // 📤 Enviar respuesta inmediata
    const responsePayload = {
      success: true,
      message: userBd.id
        ? "Usuario asociado correctamente"
        : "Usuario creado y asociado",
      users,
      count: users.length,
    };

    // 👈 ¡Enviamos la respuesta AHORA!
    res.status(200).json(responsePayload);

    // ✉️ 2. Enviar correo en segundo plano (solo si aplica)
    if (invitation_method === "email" && userBd && membership) {
      setImmediate(async () => {
        try {
          const inviterName = req.user?.name || "un miembro del equipo";
          const inviteLink = `${
            process.env.FRONTEND_URL
          }?token=${encodeURIComponent(
            invitationToken
          )}&company_id=${company_id}`;

          await sendInvitationEmail({
            to: email,
            inviterName,
            companyName: company.name,
            inviteLink,
            companyId: company_id,
            ip: req.ip,
            userAgent: req.get("User-Agent"),
            invitedByUserId: req.user?.id,
          });
        } catch (emailError) {
          logger.error(
            "Falló el envío del correo de invitación en segundo plano:",
            {
              email,
              error: emailError.message,
              stack: emailError.stack,
            }
          );
          // Opcional: guardar en tabla de "notificaciones fallidas" para reintentar
        }
      });
    }
  },

  async updateUserInCompany(req, res) {
    // ✅ LOG al inicio: quién y qué datos
    logger.info(
      `${req.user?.name || "Unknown"} - Actualiza usuario en empresa`
    );
    logger.info("Datos recibidos:");
    logger.info(JSON.stringify(req.body));

    const {
      id: userId,
      company_id: rawCompanyId,
      name,
      email,
      user: username,
      role_id: rawRoleId,
      warehouses: rawWarehouses,
      pools: rawPools,
    } = req.body;

    // Parsear company_id y role_id solo si están presentes
    const company_id = Number(rawCompanyId);
    if (isNaN(company_id)) {
      return res
        .status(400)
        .json({ success: false, message: "company_id debe ser número" });
    }

    // Validar existencia del usuario y membresía
    const membership = await UserCompanyRepository.findByUserIdAndCompanyId(
      userId,
      company_id
    );
    if (!membership) {
      return res
        .status(400)
        .json({
          success: false,
          message: "Usuario no pertenece a esta empresa",
        });
    }
    logger.info("despues de cosultar si pertenece a la company");
    const userBd = await UserRepository.findById(userId);
    if (!userBd) {
      return res
        .status(400)
        .json({ success: false, message: "Usuario no encontrado" });
    }

    // Parsear warehouses y pools solo si vienen
    let warehouses = [];
    let pools = [];

    if ("warehouses" in req.body) {
      if (typeof rawWarehouses === "string" && rawWarehouses.trim()) {
        warehouses = JSON.parse(rawWarehouses);
      } else if (Array.isArray(rawWarehouses)) {
        warehouses = rawWarehouses;
      }
      warehouses = warehouses.map(Number);
    }

    if ("pools" in req.body) {
      if (typeof rawPools === "string" && rawPools.trim()) {
        pools = JSON.parse(rawPools);
      } else if (Array.isArray(rawPools)) {
        pools = rawPools;
      }
      pools = pools.map(Number);
    }

    logger.info("antes de validar");

    // 1. Validar entidades maestras (solo si hay cambios relevantes)
    try {
      // Validar rol si se envió
      let role = null;
      if ("role_id" in req.body) {
        const role_id = Number(rawRoleId);
        if (isNaN(role_id)) {
          return res
            .status(400)
            .json({ success: false, message: "role_id debe ser número" });
        }
        role = await RoleRepository.findById(role_id);
        if (!role)
          return res
            .status(400)
            .json({ success: false, message: "Rol no encontrado" });
      }

      // Validar pools si se enviaron
      if ("pools" in req.body && pools.length > 0) {
        const poolCheck = await PoolRepository.validatePoolIdsExist(pools);
        if (!poolCheck.valid) {
          return res.status(400).json({
            success: false,
            message: "Algunos pool IDs no existen",
            invalid_pools: poolCheck.invalidIds,
          });
        }
      }

      // Validar almacenes si se enviaron
      if ("warehouses" in req.body && warehouses.length > 0) {
        const whCheck = await WarehouseRepository.validateWarehouseIdsExist(
          warehouses
        );
        if (!whCheck.valid) {
          return res.status(400).json({
            success: false,
            message: "Algunos warehouse IDs no existen",
            invalid_warehouses: whCheck.invalidIds,
          });
        }
      }
    } catch (error) {
      logger.error("Error en validación:", error.message);
      return res.status(400).json({ success: false, message: error.message });
    }

    logger.info("después de validar");

    const transaction = await sequelize.transaction();
    try {
      // 2. Actualizar datos del usuario (solo campos presentes)
      const userUpdateData = {};
      if ("name" in req.body) userUpdateData.name = name;
      if ("email" in req.body) userUpdateData.email = email;
      if ("user" in req.body) userUpdateData.user = username;

      if (Object.keys(userUpdateData).length > 0 || req.file) {
        await UserRepository.update(
          userBd,
          userUpdateData,
          req.file,
          transaction
        );
      }

      // 3. Actualizar rol si cambió
      let finalRoleId = membership.role_id;
      if ("role_id" in req.body) {
        const newRoleId = Number(rawRoleId);
        if (newRoleId !== membership.role_id) {
          await UserCompanyRepository.updateRole(
            membership,
            newRoleId,
            transaction
          );
          finalRoleId = newRoleId;
        }
      }

      // 4. Determinar si el rol final es admin
      const finalRole = await RoleRepository.findById(finalRoleId);
      const isAdminRole = finalRole?.name?.toLowerCase() === "admin";

      // 5. Gestionar scopes ACL
      // → Siempre eliminar scopes actuales de esta empresa
      await UserAclScopeRepository.deleteAllByUserAndCompany(
        userId,
        company_id,
        transaction
      );

      // → Si NO es admin y se enviaron scopes (o se permiten scopes vacíos), crear nuevos
      if (!isAdminRole) {
        // Si no se enviaron `warehouses`/`pools`, mantener los anteriores NO es posible
        // porque el front envía solo lo que cambió → asumimos que si no vienen, no hay cambio intencional
        // PERO: en tu flujo, cuando se edita, el front SIEMPRE envía `selectedWarehouses` y `selectedPools`
        // así que podemos confiar en que si están ausentes, no se modificó el alcance

        // Sin embargo, para alinearse con el flujo de creación y evitar inconsistencias,
        // solo insertamos scopes si al menos uno de los dos campos fue enviado
        const shouldApplyScopes =
          "warehouses" in req.body ||
          "pools" in req.body ||
          // Caso especial: si el rol cambió de admin → editor, el front sí envía scopes
          (finalRoleId !== membership.role_id && !isAdminRole);

        if (shouldApplyScopes) {
          const newScopes = [];
          warehouses.forEach((wid) => {
            newScopes.push({ user_id: userId, company_id, warehouse_id: wid });
          });
          pools.forEach((pid) => {
            newScopes.push({ user_id: userId, company_id, pool_id: pid });
          });

          if (newScopes.length > 0) {
            await UserAclScopeRepository.bulkCreate(newScopes, transaction);
          }
        }
      }

      await transaction.commit();

      const filters = {};
      filters.company_id = company_id;
      const users = await UserRepository.findAll(filters);
      return res.status(200).json({
        success: true,
        message: "Usuario actualizado correctamente",
        users: users,
        count: users.length,
      });
    } catch (error) {
      // Solo hacemos rollback si la transacción NO ha sido commiteada
      if (!transaction.finished) {
        await transaction.rollback();
      }
      logger.error("Error en transacción:", { error: error?.stack || error });
      return res
        .status(500)
        .json({ success: false, message: "Error al procesar actualización" });
    }
  },

  async getPoolWarehouseRole(req, res) {
    const requesterName = req.user?.name || "Anonymous";
    logger.info(`${requesterName} - Ruta combinada para agregar usuarios`);
    logger.info("Datos recibidos (body):");
    logger.info(JSON.stringify(req.body));
    const { company_id, branch_id, status } = req.body;

    if (company_id) {
      // Validar que el usuario autenticado pertenezca a la compañía
      const authCompany = await CompanyRepository.findById(company_id);
      if (!authCompany) {
        return res.status(204).json({
          success: false,
          message: "Compañía no encontrada",
        });
      }
    }

    if (branch_id) {
      // Validar que el usuario autenticado pertenezca a la compañía
      const authBranch = await BranchRepository.findById(branch_id);
      if (!authBranch) {
        return res.status(204).json({
          success: false,
          message: "Sucursal no encontrada",
        });
      }
    }
    const roles = await RoleRepository.findAllManteiner({ permissions: true });
    const warehouses =
      await WarehouseRepository.findWarehousesByCompanyOrBranch(
        company_id,
        branch_id
      );
    const pools = await PoolRepository.getPoolsWithWarehousesByCompanyOrBranch(
      company_id,
      branch_id
    );
    try {
      return res.status(200).json({
        success: true,
        roles: roles, // ya están en formato plano
        warehouses: warehouses,
        pools: pools,
      });
    } catch (error) {
      logger.error(`UserController->index: ${error.message}`);
      return res
        .status(500)
        .json({
          success: false,
          message: "Error Interno del Servidor",
          details: error.message,
        });
    }
  },
};

module.exports = AuthController;
