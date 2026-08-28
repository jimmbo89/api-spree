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
  MarketplaceCredentialRepository,
  UserCompanyRepository,
  WarehouseRepository,
  PoolRepository,
  UserAclScopeRepository,
  BranchRepository,
  RolePermissionRepository,
  UserMarketplaceCredentialRepository,
} = require("../repositories");
const AuditEventService = require("../services/AuditEventService");
const { detectChanges } = require("../util/auditUtils");
const { sendEmail } = require("../services/EmailService");

// 📨 Plantilla de correo de invitación (consistente en toda la app)
function buildInvitationEmailHtml({ inviterName, companyName, inviteLink, email, temporalPassword, user }) {
  return `
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

        ${temporalPassword ? `
        <div style="background-color: #f0f8ff; padding: 20px; border-radius: 8px; margin: 24px 0; border-left: 4px solid #006064;">
          <h3 style="color: #006064; margin-top: 0; font-size: 18px;">🔐 Credenciales de acceso</h3>
          <p style="font-size: 15px; line-height: 1.6; color: #333; margin: 10px 0;">
            <strong>Usuario:</strong> <span style="font-family: monospace; background-color: #e8e8e8; padding: 2px 6px; border-radius: 4px;">${user}</span>
          </p>
          <p style="font-size: 15px; line-height: 1.6; color: #333; margin: 10px 0;">
            <strong>Correo:</strong> <span style="font-family: monospace; background-color: #e8e8e8; padding: 2px 6px; border-radius: 4px;">${email}</span>
          </p>
          <p style="font-size: 15px; line-height: 1.6; color: #333; margin: 10px 0;">
            <strong>Contraseña temporal:</strong> <span style="font-family: monospace; background-color: #e8e8e8; padding: 2px 6px; border-radius: 4px;">${temporalPassword}</span>
          </p>
        </div>

        <div style="background-color: #fff3cd; padding: 16px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #ffc107;">
          <p style="font-size: 15px; line-height: 1.6; color: #856404; margin: 0;">
            ⚠️ <strong>Importante:</strong> Por motivos de seguridad es necesario que una vez ingresado al sistema cambie esta contraseña en su Perfil de usuario.
          </p>
        </div>
        ` : ''}

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
}

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
  email,
  temporalPassword = null,
  user = null
}) {
  const emailHtml = buildInvitationEmailHtml({
    inviterName,
    companyName,
    inviteLink,
    email,
    temporalPassword,
    user
  });

  // Enviar correo
  await sendEmail({
    to,
    subject: `📬 Únete a ${companyName} en Spree Invitación de ${inviterName}`,
    text: `Hola, ${inviterName} te ha invitado a unirte al equipo de ${companyName} en Spree. Accede al enlace para aceptar: ${inviteLink}${temporalPassword ? `\n\nUsuario: ${user}\nCorreo: ${email}\nContraseña temporal: ${temporalPassword}\n\n⚠️ Importante: Por motivos de seguridad es necesario que una vez ingresado al sistema cambie esta contraseña en su Perfil de usuario.` : ''}`,
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

function parseMarketplaceCredentialAssignments(rawValue) {
  if (rawValue === undefined) {
    return { provided: false, items: [] };
  }

  let value = rawValue;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return { provided: true, items: [] };
    }

    try {
      value = JSON.parse(trimmed);
    } catch (error) {
      throw new Error('El campo "marketplace_credentials" debe ser un array JSON válido');
    }
  }

  if (!Array.isArray(value)) {
    throw new Error('El campo "marketplace_credentials" debe ser un array');
  }

  const normalized = value.map((item) => {
    if (typeof item === 'number' || typeof item === 'string') {
      const marketplace_credential_id = Number(item);
      if (!Number.isInteger(marketplace_credential_id) || marketplace_credential_id <= 0) {
        throw new Error('marketplace_credentials contiene un ID inválido');
      }
      return { marketplace_credential_id, status: 1 };
    }

    if (!item || typeof item !== 'object') {
      throw new Error('marketplace_credentials contiene un elemento inválido');
    }

    const marketplace_credential_id = Number(
      item.marketplace_credential_id ?? item.credential_id ?? item.id
    );
    if (!Number.isInteger(marketplace_credential_id) || marketplace_credential_id <= 0) {
      throw new Error('marketplace_credentials contiene un ID inválido');
    }

    let status = 1;
    if (item.status !== undefined && item.status !== null && item.status !== '') {
      status = Number(item.status);
      if (!Number.isInteger(status) || ![0, 1].includes(status)) {
        throw new Error('marketplace_credentials.status debe ser 0 o 1');
      }
    }

    return { marketplace_credential_id, status };
  });

  const map = new Map();
  normalized.forEach((item) => {
    map.set(Number(item.marketplace_credential_id), item);
  });

  return { provided: true, items: Array.from(map.values()) };
}

function toPlain(record) {
  if (!record) return null;
  return typeof record.get === 'function' ? record.get({ plain: true }) : record;
}

function getUserAuditLabel(user) {
  const plain = toPlain(user) || {};
  return [plain.name || null, plain.user || null, plain.email || null].filter(Boolean).join(' / ') || 'Usuario sin nombre';
}

function getCompanyAuditLabel(company) {
  const plain = toPlain(company) || {};
  return plain.name || 'Empresa sin nombre';
}

function getRoleAuditLabel(role) {
  const plain = toPlain(role) || {};
  return plain.name || 'Rol sin nombre';
}

function buildUserAuditPayload(user, data = {}) {
  const plain = toPlain(user) || {};
  return {
    ...data,
    company_id: data.company_id ?? plain.company_id ?? data.resource_id ?? null,
    module: 'user',
    resource_type: data.resource_type || 'user',
    resource_id: data.resource_id ?? plain.id ?? data.company_id ?? null,
    resource_label: data.resource_label || getUserAuditLabel(plain),
  };
}

function buildMembershipAuditPayload(membership, data = {}) {
  const plain = toPlain(membership) || {};
  const companyId = data.company_id ?? plain.company_id ?? data.resource_id ?? null;
  const userName = data.user_name || plain.user?.name || plain.user?.email || plain.user?.user || null;
  const companyName = data.company_name || plain.company?.name || null;
  return {
    ...data,
    company_id: companyId,
    module: 'user',
    resource_type: 'user_company',
    resource_id: data.resource_id ?? plain.id ?? companyId ?? null,
    resource_label: data.resource_label || [
      userName ? `Usuario ${userName}` : null,
      companyName ? `Empresa ${companyName}` : null
    ].filter(Boolean).join(' / ') || 'Membresía de usuario',
  };
}

function changesToValueSnapshot(changes, valueKey) {
  return (changes || []).reduce((snapshot, change) => {
    snapshot[change.field] = change[valueKey];
    return snapshot;
  }, {});
}

function uniqueNumericIds(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(Number)
    .filter((id) => Number.isInteger(id) && id > 0))];
}

function mapWarehouseAuditItem(warehouse) {
  const plain = toPlain(warehouse) || {};
  return {
    name: [plain.code || null, plain.name || null].filter(Boolean).join(' / ') || 'Almacén sin nombre'
  };
}

function mapPoolAuditItem(pool) {
  const plain = toPlain(pool) || {};
  return {
    name: plain.name || 'Pool sin nombre'
  };
}

function mapCredentialAuditItem(credential, status = null) {
  const plain = toPlain(credential) || {};
  return {
    name: plain.name || 'Credencial sin nombre',
    marketplace_name: plain.marketplace?.name || plain.marketplace?.domain || 'Marketplace',
    status: status === null || status === undefined ? undefined : Number(status) === 1 ? 'Activo' : 'Inactivo'
  };
}

function sortAuditItems(items = []) {
  return [...items].sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'es'));
}

async function getWarehouseAuditItems(ids = []) {
  const records = await Promise.all(uniqueNumericIds(ids).map((id) => WarehouseRepository.findById(id)));
  return sortAuditItems(records.filter(Boolean).map(mapWarehouseAuditItem));
}

async function getPoolAuditItems(ids = []) {
  const records = await Promise.all(uniqueNumericIds(ids).map((id) => PoolRepository.findById(id, false)));
  return sortAuditItems(records.filter(Boolean).map(mapPoolAuditItem));
}

async function getCredentialAuditItems(items = []) {
  const normalized = Array.isArray(items) ? items : [];
  const statusById = new Map(normalized.map((item) => [Number(item.marketplace_credential_id), item.status]));
  const records = await MarketplaceCredentialRepository.findByIds([...statusById.keys()]);
  return sortAuditItems(records.map((record) => mapCredentialAuditItem(record, statusById.get(Number(record.id)))));
}

async function getCurrentUserAccessSnapshot(userId, companyId) {
  const [scopes, credentialAccess] = await Promise.all([
    UserAclScopeRepository.findByUserAndCompany(userId, companyId),
    UserMarketplaceCredentialRepository.findByUserAndCompany(userId, companyId)
  ]);

  return {
    warehouses: sortAuditItems(scopes.filter((scope) => scope.warehouse).map((scope) => mapWarehouseAuditItem(scope.warehouse))),
    pools: sortAuditItems(scopes.filter((scope) => scope.pool).map((scope) => mapPoolAuditItem(scope.pool))),
    marketplace_credentials: sortAuditItems(credentialAccess.map((access) => mapCredentialAuditItem(
      access.marketplaceCredential,
      access.status
    )))
  };
}

function accessSnapshotCounts(snapshot = {}) {
  return {
    warehouses_count: snapshot.warehouses?.length || 0,
    pools_count: snapshot.pools?.length || 0,
    marketplace_credentials_count: snapshot.marketplace_credentials?.length || 0
  };
}
const AuthController = {

  async register(req, res) {
    logger.info("Registrando Usuario.");
    logger.info("Datos recibidos al registrarse:");
    logger.info(JSON.stringify(req.body));

    const { name, user, password, email } = req.body;

    const userBd = await UserRepository.existsByEmail(email);
    if (userBd) {
      return res
            .status(409)
            .json({
              success: false,
              message: "Correo existente",
              code: "EMAIL_EXISTS"
            });
    }
    const t = await sequelize.transaction();
    try {
      const hashedPassword = bcrypt.hashSync(
        password,
        parseInt(authConfig.rounds)
      );
      const extractedUser = req.body.user || req.body.email.split("@")[0];

      const userData = {
        name: req.body.name,
        email: req.body.email,
        password: hashedPassword,
        status: true, // ✅ nuevo usuario activo
        image: "users/default.jpg", // o procesa avatar si lo subes
        email_verified_at: null,
        remember_token: null,
        registration_date: null,
        user: extractedUser,
      };

      const user = await UserRepository.create(userData, null, null);

      const userNew = {
        id: user.id,
        email: user.email,
        name: user.name,
        user: user.user,
        image: user.image
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
        memberships: user.memberships || [],
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
    logger.info(`'Datos recibidos al loguearse:', ${JSON.stringify(req.body)}`);

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
      const userNew = {
        id: user.id,
        email: user.email,
        name: user.name,
        user: user.user,
        image: user.image,
        role_id: user.role_id || null // Rol global (BackOffice)
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

      // ✅ Usuario con rol global (BackOffice) - retornar rol global y sus membresías
      if (user.role_id) {
        const globalRole = user.role ? {
          id: user.role.id,
          name: user.role.name,
          description: user.role.description,
          permissions: user.role.permissions || []
        } : null;

        return res.status(200).json({
          id: user.id,
          name: user.name,
          user: user.user,
          email: user.email,
          image: user.image,
          role_id: user.role_id,
          global_role: globalRole, // ✅ Rol global con permisos
          is_global_user: true, // ✅ Flag para que el frontend sepa que es BackOffice
          token,
          memberships: [] // ❌ Vacío porque no necesita empresas
        });
      }

      const activeMemberships = (user.memberships || []).filter(m => m.status === 1);
      const memberships = activeMemberships.map(m => ({
        id: m.id,
        company_id: m.company_id,
        role_id: m.role_id,
        status: m.status,
        company: {
          id: m.company.id,
          name: m.company.name,
          image: m.company.image,
          plan: m.company.plan
        },
        role: {
          id: m.role.id,
          name: m.role.name,
          permissions: m.role.permissions || []
        }
      }));

      return res.status(200).json({
        id: user.id,
        name: user.name,
        user: user.user,
        email: user.email,
        image: user.image,
        role_id: null,
        global_role: null,
        is_global_user: false,
        token,
        memberships,
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
  const { user_id: userId, company_id, status } = req.body;

  // Validación básica
  if (!userId || !company_id) {
    return res.status(400).json({
      success: false,
      message: "Faltan parámetros: user_id y company_id son requeridos"
    });
  }

  // Validar estado permitido (0 = desasociado, 1 = activo, 2 = desactivado)
  if (status !== 0 && status !== 1 && status !== 2) {
    return res.status(400).json({
      success: false,
      message: "El estado debe ser 0 (desasociado), 1 (activo) o 2 (desactivado)"
    });
  }

  logger.info(`${requesterName} - Actualiza membresía: user=${userId}, company=${company_id}, status=${status}`);
  logger.info("Datos recibidos (body):", req.body);

  const ip = req.ip || "unknown";
  const userAgent = req.get("User-Agent") || null;

  try {
    // 1. Verificar que la membresía exista
    const membership = await UserCompanyRepository.findByUserIdAndCompanyId(userId, company_id);
    const targetUser = membership ? await UserRepository.findById(userId) : null;
    const targetCompany = await CompanyRepository.findById(company_id);
    if (!membership) {
      await LogRepository.create({
        user_id: requesterId,
        action: "membership.update",
        description: `Membresía no encontrada para user=${userId}, company=${company_id}`,
        ip_address: ip,
        user_agent: userAgent,
        status: "error",
      });
      return res.status(404).json({ success: false, message: "Membresía no encontrada" });
    }

    // 2. Evitar auto-modificación
    if (requesterId && requesterId.toString() === userId.toString()) {
      await LogRepository.create({
        user_id: requesterId,
        action: "membership.update",
        description: "Intentó modificar su propia membresía",
        ip_address: ip,
        user_agent: userAgent,
        status: "error",
      });
      return res.status(400).json({ success: false, message: "No puedes modificar tu propia membresía" });
    }

    // 3. Verificar si es el último admin (solo si se va a desactivar O desasociar)
    if (status === 2 || status === 0) {
      const userRole = await RoleRepository.findById(membership.role_id);
      if (userRole && userRole.name === 'Admin') {
        const otherAdmins = await UserCompanyRepository.countActiveAdminsInCompany(company_id, userId);
        if (otherAdmins === 0) {
          return res.status(403).json({
            success: false,
            message: "No puedes desactivar o desasociar al último administrador de la empresa"
          });
        }
      }
    }

    // 4. Actualizar el estado
    await UserCompanyRepository.updateStatus(membership, status);

    // 5. Registrar log
    let actionText = '';
    if (status === 0) actionText = "desasociada";
    else if (status === 1) actionText = "activada";
    else actionText = "desactivada";
    
    await LogRepository.create({
      user_id: requesterId,
      action: "membership.update",
      description: `Membresía ${actionText} para user=${userId}, company=${company_id}`,
      ip_address: ip,
      user_agent: userAgent,
      status: "success",
    });

    await AuditEventService.safeRecordFromRequest(req, buildMembershipAuditPayload(membership, {
      action: 'user.destroy',
      result: 'success',
      company_id,
      previous_value: { status: membership.status },
      new_value: { status },
      changes: [{
        field: 'status',
        old_value: membership.status,
        new_value: status
      }],
      resource_label: `Usuario ${getUserAuditLabel(targetUser || { id: userId })} / Empresa ${getCompanyAuditLabel(targetCompany || { id: company_id })}`,
      description: `Usuario desasociado de ${getCompanyAuditLabel(targetCompany || { id: company_id })}`,
      metadata: {
        company_name: getCompanyAuditLabel(targetCompany || { id: company_id }),
        user_name: getUserAuditLabel(targetUser || { id: userId }),
        action_text: actionText
      }
    }));

    // 6. Responder
    return res.status(200).json({
      success: true,
      message: `Membresía ${status === 0 ? 'desasociada' : (status === 1 ? 'activada' : 'desactivada')} exitosamente`,
      membership: {
        ...membership,
        membership_status: status
      }
    });

  } catch (error) {
    logger.error(`Error en updateMembershipStatus:`, error);
    await LogRepository.create({
      user_id: requesterId,
      action: "membership.update",
      description: `Error crítico: ${error.message}`,
      ip_address: ip,
      user_agent: userAgent,
      status: "error",
    });
    return res.status(500).json({
      success: false,
      message: "Error interno del servidor",
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
  },
  async index(req, res) {
    const requesterName = req.user?.name || "Anonymous";
    logger.info(`${requesterName} - Solicita lista de usuarios (plana)`);
    logger.info("Datos recibidos (body):");
    logger.info(JSON.stringify(req.body));
    const { company_id, role_id, status } = req.body;

    // ✅ Validar que la empresa exista
    const company = await CompanyRepository.findById(company_id);
    if (!company) {
      return res.status(404).json({
        success: false,
        message: "Empresa no encontrada",
        users: [],
      });
    }

    const filters = {};
    if (company_id) filters.company_id = company_id;
    if (role_id) filters.role_id = role_id;

    // ✅ Si se especifica status, se usa ese filtro
    // Si no se especifica, el repository excluye status 0 (desasociado) por defecto
    // status: -1 = pendiente, 1 = activo, 2 = desactivado (todos se incluyen excepto 0)
    if (status !== undefined) {
      filters.status = status;
    }
    // ✅ Si status es undefined, el repository filtra: status != 0

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

      // Buscar usuario
      const user = await UserRepository.findById(userId);

      if (!user) {
        return res.status(204).json({ msg: "UserNotFound" });
      }

      // 👇 Lógica especial: si status es 1 o true, establecer registration_date a ahora
      const updateData = { ...req.body };

      // 👉 Capturar valores actuales para comparar cambios
      const originalStatus = user.status;

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
          subject: "Recuperación de contraseña - Spree",
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

  async changePassword(req, res) {
    logger.info("Datos recibidos al actualizar la contraseña:");
    logger.info(JSON.stringify(req.body));
    try {
      const { user_id: bodyUserId, newPassword, currentPassword } = req.body;
      const user_id = bodyUserId || req.user.id;
      const user = await UserRepository.findById(user_id);
      if (!user) {
        return res.json({ success: false, message: "Usuario no encontrado" });
      }
      logger.info('user')
      logger.info(JSON.stringify(user))
      const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res.status(404).json({
        success: false,
        message: "La contraseña actual es incorrecta"
      });
    }

    // Evitar que la nueva contraseña sea igual a la actual
    if (await bcrypt.compare(newPassword, user.password)) {
      return res.status(404).json({
        success: false,
        message: "La nueva contraseña no puede ser igual a la actual"
      });
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
      logger.error("Error en changePassword:", error);
      res.status(500).json({ success: false, message: "Error interno" });
    }
  },
  async verifyCode(req, res) {
    try {
      const { email, code } = req.body;
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
      marketplace_credentials: rawMarketplaceCredentials,
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
      if (Number(role.visible_to_companies) !== 1) {
        return res.status(400).json({
          success: false,
          message: "El rol seleccionado no está disponible para empresas"
        });
      }

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
    let typeStatus = -1;
    let isNewUser = false; // 👈 Trackear si es usuario nuevo
    let passwordValue = null; // 👈 Declarar en scope superior
    let userValue = null; // 👈 Declarar en scope superior
    
    if(invitation_method !== 'email'){
      typeStatus = 1;
    }
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
        isNewUser = true; // 👈 Marcar como usuario nuevo
        userValue = user || email.split("@")[0]; // evita usar "user" como nombre de variable
        passwordValue = password || userValue;

        const hashedPassword = bcrypt.hashSync(
          passwordValue,
          parseInt(authConfig.rounds)
        );

        userBd = await UserRepository.create(
          {
            name,
            email,
            password: hashedPassword, // ✅ clave correcta
            user: userValue,          // ✅ clave correcta
            status: 1,
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
            status: typeStatus, // pending
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

      const marketplaceCredentialsInput = parseMarketplaceCredentialAssignments(rawMarketplaceCredentials);
      if (marketplaceCredentialsInput.provided) {
        await UserMarketplaceCredentialRepository.syncUserMarketplaceCredentials({
          userId: userBd.id,
          companyId: company_id,
          items: marketplaceCredentialsInput.items,
          transaction
        });
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

    try {
      const currentAccess = await getCurrentUserAccessSnapshot(userBd.id, company_id);
      const baseMetadata = {
        company_name: getCompanyAuditLabel(company),
        user_name: getUserAuditLabel(userBd),
        role_name: getRoleAuditLabel(role),
        invitation_method: invitation_method || null,
        warehouses: currentAccess.warehouses,
        pools: currentAccess.pools,
        marketplace_credentials: currentAccess.marketplace_credentials,
        ...accessSnapshotCounts(currentAccess)
      };

      await AuditEventService.safeRecordFromRequest(req, (isNewUser ? buildUserAuditPayload(userBd, {
        company_id,
        action: 'user.created',
        result: 'success',
        resource_id: userBd.id,
        new_value: {
          name: userBd.name || null,
          email: userBd.email || null,
          user: userBd.user || null,
          status: userBd.status
        },
        description: `Usuario creado y asociado a ${getCompanyAuditLabel(company)}`,
        metadata: baseMetadata
      }) : buildMembershipAuditPayload(membership, {
        company_id,
        action: 'user.associated',
        result: 'success',
        new_value: {
          status: membership.status,
          role_id: membership.role_id
        },
        description: `Usuario asociado a ${getCompanyAuditLabel(company)}`,
        metadata: {
          ...baseMetadata,
          is_new_user: isNewUser
        }
      })));
    } catch (auditError) {
      logger.error(`[AuthController->associateUserToCompany audit] ${auditError.message}`);
    }

    // 👈 ¡Enviamos la respuesta AHORA!
    res.status(200).json(responsePayload);

    // ✉️ 2. Enviar correo en segundo plano (solo si aplica)
    if (invitation_method === "email" && userBd && membership) {
      setImmediate(async () => {
        try {
          const inviterName = req.user?.name || "un miembro del equipo";
          const inviteLink = `${process.env.FRONTEND_URL}/login?token=${encodeURIComponent(invitationToken)}&company_id=${company_id}`;

          // ✅ Pasar contraseña y usuario solo si es usuario nuevo (no existía)
          const passwordToSend = isNewUser ? passwordValue : null;
          const userToSend = isNewUser ? userValue : null;

          await sendInvitationEmail({
            to: email,
            inviterName,
            companyName: company.name,
            inviteLink,
            companyId: company_id,
            ip: req.ip,
            userAgent: req.get("User-Agent"),
            invitedByUserId: req.user?.id,
            email,
            temporalPassword: passwordToSend,
            user: userToSend
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

    /*invitationToken = crypto.randomBytes(32).toString("hex");
        logger.info('token a verificar editando');
        logger.info(invitationToken);
        const hashedInvitationToken = bcrypt.hashSync(
          invitationToken,
          parseInt(authConfig.rounds) // o usa un valor fijo, ej: 10
        );

        logger.info('token a verificar editando codificado');
        logger.info(hashedInvitationToken);*/

    const {
      id: userId,
      company_id: rawCompanyId,
      name,
      email,
      user: username,
      role_id: rawRoleId,
      warehouses: rawWarehouses,
      pools: rawPools,
      marketplace_credentials: rawMarketplaceCredentials,
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

    const company = await CompanyRepository.findById(company_id);
    if (!company) {
      return res
        .status(400)
        .json({ success: false, message: "Empresa no encontrada" });
    }

    // Parsear warehouses y pools solo si vienen
    let warehouses = [];
    let pools = [];
    const hasWarehouses = Object.prototype.hasOwnProperty.call(req.body, "warehouses");
    const hasPools = Object.prototype.hasOwnProperty.call(req.body, "pools");

    if (hasWarehouses) {
      if (typeof rawWarehouses === "string" && rawWarehouses.trim()) {
        warehouses = JSON.parse(rawWarehouses);
      } else if (Array.isArray(rawWarehouses)) {
        warehouses = rawWarehouses;
      }
      warehouses = warehouses.map(Number);
    }

    if (hasPools) {
      if (typeof rawPools === "string" && rawPools.trim()) {
        pools = JSON.parse(rawPools);
      } else if (Array.isArray(rawPools)) {
        pools = rawPools;
      }
      pools = pools.map(Number);
    }

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
        if (Number(role.visible_to_companies) !== 1) {
          return res.status(400).json({
            success: false,
            message: "El rol seleccionado no está disponible para empresas"
          });
        }
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

    let marketplaceCredentialsInput = { provided: false, items: [] };
    try {
      marketplaceCredentialsInput = parseMarketplaceCredentialAssignments(rawMarketplaceCredentials);
    } catch (error) {
      return res.status(400).json({ success: false, message: error.message });
    }

    logger.info("después de validar");

    const transaction = await sequelize.transaction();
    try {
      const previousUserSnapshot = {
        name: userBd.name || null,
        email: userBd.email || null,
        user: userBd.user || null,
        image: userBd.image || null
      };
      const previousRoleId = membership.role_id;
      const previousRole = await RoleRepository.findById(previousRoleId);
      const previousMembershipSnapshot = {
        role_id: membership.role_id,
        status: membership.status
      };
      let previousAccessSnapshot = {
        warehouses: [],
        pools: [],
        marketplace_credentials: []
      };
      try {
        previousAccessSnapshot = await getCurrentUserAccessSnapshot(userId, company_id);
      } catch (auditSnapshotError) {
        logger.error(`[AuthController->updateUserInCompany previous access audit snapshot] ${auditSnapshotError.message}`);
      }

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

      // 5. Gestionar scopes ACL de forma parcial
      // Solo se reemplaza el tipo de scope que realmente venga en el body.
      if (hasWarehouses) {
        await UserAclScopeRepository.deleteWarehousesByUserAndCompany(
          userId,
          company_id,
          transaction
        );

        const warehouseScopes = warehouses.map((wid) => ({
          user_id: userId,
          company_id,
          warehouse_id: wid
        }));

        if (warehouseScopes.length > 0) {
          await UserAclScopeRepository.bulkCreate(warehouseScopes, transaction);
        }
      }

      if (hasPools) {
        await UserAclScopeRepository.deletePoolsByUserAndCompany(
          userId,
          company_id,
          transaction
        );

        const poolScopes = pools.map((pid) => ({
          user_id: userId,
          company_id,
          pool_id: pid
        }));

        if (poolScopes.length > 0) {
          await UserAclScopeRepository.bulkCreate(poolScopes, transaction);
        }
      }

      if (marketplaceCredentialsInput.provided) {
        await UserMarketplaceCredentialRepository.syncUserMarketplaceCredentials({
          userId,
          companyId: company_id,
          items: marketplaceCredentialsInput.items,
          transaction
        });
      }

      await transaction.commit();

      const filters = {};
      filters.company_id = company_id;
      const users = await UserRepository.findAll(filters);

      try {
        const refreshedUser = await UserRepository.findById(userId);
        const currentAccessSnapshot = await getCurrentUserAccessSnapshot(userId, company_id);
        const finalRoleForAudit = await RoleRepository.findById(finalRoleId);
        const userLabel = getUserAuditLabel(refreshedUser || userBd);
        const baseMetadata = {
          company_name: getCompanyAuditLabel(company),
          user_name: userLabel,
          role_name: getRoleAuditLabel(finalRoleForAudit),
          previous_role_name: getRoleAuditLabel(previousRole),
          warehouses: currentAccessSnapshot.warehouses,
          pools: currentAccessSnapshot.pools,
          marketplace_credentials: currentAccessSnapshot.marketplace_credentials,
          ...accessSnapshotCounts(currentAccessSnapshot)
        };

        const userChanges = detectChanges(previousUserSnapshot, {
          name: refreshedUser?.name || null,
          email: refreshedUser?.email || null,
          user: refreshedUser?.user || null,
          image: refreshedUser?.image || null
        }, ['name', 'email', 'user', 'image']);

        if (userChanges.length > 0 || Object.keys(userUpdateData).length > 0 || req.file) {
          await AuditEventService.safeRecordFromRequest(req, buildUserAuditPayload(refreshedUser || userBd, {
            company_id,
            action: 'user.updated',
            result: 'success',
            resource_id: userId,
            previous_value: changesToValueSnapshot(userChanges, 'old_value'),
            new_value: changesToValueSnapshot(userChanges, 'new_value'),
            changes: userChanges,
            description: `Usuario actualizado: ${userLabel}`,
            metadata: baseMetadata
          }));
        }

        if (finalRoleId !== previousRoleId) {
          const roleNameChanges = [{
            field: 'role_name',
            old_value: getRoleAuditLabel(previousRole),
            new_value: getRoleAuditLabel(finalRoleForAudit)
          }];

          await AuditEventService.safeRecordFromRequest(req, buildMembershipAuditPayload(membership, {
            company_id,
            action: 'user.company_role_updated',
            result: 'success',
            resource_id: membership.id,
            previous_value: {
              role_name: getRoleAuditLabel(previousRole)
            },
            new_value: {
              role_name: getRoleAuditLabel(finalRoleForAudit)
            },
            changes: roleNameChanges,
            description: `Rol de ${userLabel} actualizado en ${getCompanyAuditLabel(company)}`,
            metadata: baseMetadata
          }));
        }

        if (hasWarehouses || hasPools || marketplaceCredentialsInput.provided) {
          const accessChanges = [];
          if (hasWarehouses) {
            accessChanges.push({
              field: 'warehouses',
              old_value: previousAccessSnapshot.warehouses,
              new_value: currentAccessSnapshot.warehouses
            });
          }
          if (hasPools) {
            accessChanges.push({
              field: 'pools',
              old_value: previousAccessSnapshot.pools,
              new_value: currentAccessSnapshot.pools
            });
          }
          if (marketplaceCredentialsInput.provided) {
            accessChanges.push({
              field: 'marketplace_credentials',
              old_value: previousAccessSnapshot.marketplace_credentials,
              new_value: currentAccessSnapshot.marketplace_credentials
            });
          }

          await AuditEventService.safeRecordFromRequest(req, buildMembershipAuditPayload(membership, {
            company_id,
            action: 'user.access_updated',
            result: 'success',
            resource_id: membership.id,
            previous_value: previousAccessSnapshot,
            new_value: currentAccessSnapshot,
            changes: accessChanges,
            description: `Accesos de ${userLabel} actualizados en ${getCompanyAuditLabel(company)}`,
            metadata: {
              ...baseMetadata,
              previous_warehouses: previousAccessSnapshot.warehouses,
              previous_pools: previousAccessSnapshot.pools,
              previous_marketplace_credentials: previousAccessSnapshot.marketplace_credentials
            }
          }));
        }
      } catch (auditError) {
        logger.error(`[AuthController->updateUserInCompany audit] ${auditError.message}`);
      }

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
    const credentials = company_id
      ? (await MarketplaceCredentialRepository.findByCompany(company_id)).filter(
          (credential) => credential.active !== false && Number(credential.active) !== 0
        )
      : [];

    // La forma más confiable de distinguir global vs empresa es leer el
    // role_id real guardado en users por user_id.
    const isGlobalUser = await UserRepository.hasGlobalRole(req.user?.id);

    // Usuario global: ve todos los roles.
    // Usuario normal: solo ve roles visibles para empresas.
    const filteredRoles = isGlobalUser
      ? roles
      : roles.filter((role) => Number(role.visible_to_companies) === 1);

    try {
    return res.status(200).json({
      success: true,
      roles: filteredRoles, // ya están en formato plano
      warehouses: warehouses,
      pools: pools,
      credentials: (Array.isArray(credentials) ? credentials : []).map((credential) => ({
        id: credential.id || null,
        name: credential.name || null,
        marketplace_domain: credential.marketplace?.domain || null
      })),
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
