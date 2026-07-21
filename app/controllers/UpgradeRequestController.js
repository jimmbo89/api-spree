const logger = require("../../config/logger");
const { UpgradeRequestRepository, CompanyRepository, UserRepository, PlanRepository, UserCompanyRepository, NotificationRepository } = require("../repositories");
const { sequelize } = require('../models');
const { sendEmailsToUsers, sendEmail } = require("../services/EmailService");
const { getUserId } = require("../../config/context");

/**
 * Notifica a los admins de una solicitud de actualización de plan (notificación in-app + correo).
 * Esta función NO debe ser await-eada si se quiere respuesta inmediata.
 */
async function _notifyAdminsAboutUpgradeRequest({
  company,
  user,
  request,
  currentPlan,
  targetPlan,
  billing_cycle,
  message
}) {
  try {
    const admins = await UserCompanyRepository.findActiveAdminsByCompanyId(company.id);
    if (!admins || admins.length === 0) {
      logger.warn(`No se encontraron admins activos en la compañía ${company.id}`);
      return;
    }

    // 1. Notificación in-app (rápida, local, síncrona)
    const adminUserIds = admins.map(admin => admin.id);
    await NotificationRepository.createForMultipleUsers({
      company_id: company.id,
      user_ids: adminUserIds,
      title: "Solicitud de actualización de plan",
      description: `El usuario ${user.name} ha solicitado cambiar del plan ${currentPlan.name} al plan ${targetPlan.name} (${billing_cycle}).`,
      type: "upgraderequest",
      data: {
        upgrade_request_id: request.id,
        requested_by_user_id: user.id,
        target_plan_id: targetPlan.id,
        billing_cycle,
        timestamp: new Date().toISOString()
      },
      status: 0
    });

    // 2. Correos electrónicos (asíncronos, no críticos)
    const emailSubject = `[Klint] Nueva solicitud de actualización de plan - ${company.name}`;
    const emailText = `
    Hola,

    El usuario ${user.name} (${user.email}) ha solicitado un cambio de plan en la empresa "${company.name}".

    - Plan actual: ${currentPlan.name}
    - Plan solicitado: ${targetPlan.name}
    - Ciclo: ${billing_cycle}
    - Mensaje: ${message || "Ninguno"}

    Ingresa a la plataforma para revisar y aprobar esta solicitud.
        `.trim();

        const emailHtml = `<p>Hola,</p>
    <p>El usuario <strong>${user.name}</strong> (${user.email}) ha solicitado un cambio de plan en la empresa <strong>"${company.name}"</strong>.</p>
    <ul>
      <li><strong>Plan actual:</strong> ${currentPlan.name}</li>
      <li><strong>Plan solicitado:</strong> ${targetPlan.name}</li>
      <li><strong>Ciclo:</strong> ${billing_cycle}</li>
      ${message ? `<li><strong>Mensaje:</strong> ${message}</li>` : ''}
    </ul>
    <p>Ingresa a la plataforma para revisar y aprobar esta solicitud.</p>`;

    // ✅ Esto puede fallar parcialmente, pero no detiene el resto
    await sendEmailsToUsers(admins, {
      subject: emailSubject,
      text: emailText,
      html: emailHtml,
    });

    logger.info(`Notificación completada para ${admins.length} admins de la compañía ${company.id}`);
  } catch (err) {
    // ⚠️ Nunca debe romper el flujo principal
    logger.error("Error en _notifyAdminsAboutUpgradeRequest (background):", err.message, err.stack);
  }
}

/**
 * Notifica al usuario solicitante sobre la resolución de su solicitud
 */
async function _notifyUserAboutUpgradeRequestResolution({
  user,
  company,
  request,
  targetPlan,
  status
}) {
  try {
    // 1. Notificación in-app (a un solo usuario)
    await NotificationRepository.create({
      user_id: user.id,
      company_id: company.id,
      title: status === 'approved' 
        ? "Solicitud de actualización de plan aprobada" 
        : "Solicitud de actualización de plan rechazada",
      description: status === 'approved'
        ? `Tu solicitud de cambio al plan ${targetPlan.name} ha sido aprobada. ¡Bienvenido!`
        : `Tu solicitud de cambio al plan ${targetPlan.name} ha sido rechazada.`,
        type: "upgraderequest",
       data: {
        upgrade_request_id: request.id,
        target_plan_id: targetPlan.id,
        status: status,
        timestamp: new Date().toISOString()
      },
      status: 0
    });

    // 2. Correo electrónico (a un solo destinatario)
    if (user.email) {
      const emailSubject = status === 'approved'
        ? `[Spree] ¡Tu solicitud de actualización de plan fue aprobada!`
        : `[Spree] Tu solicitud de actualización de plan fue rechazada`;

      const emailText = status === 'approved'
        ? `Hola ${user.name},\n\nTu solicitud de cambio al plan ${targetPlan.name} en la empresa "${company.name}" ha sido aprobada.\n\n¡Disfruta de tu nuevo plan!`
        : `Hola ${user.name},\n\nTu solicitud de cambio al plan ${targetPlan.name} en la empresa "${company.name}" ha sido rechazada.\n\nContacta a un administrador si crees que esto es un error.`;

      const emailHtml = status === 'approved'
        ? `<p>Hola <strong>${user.name}</strong>,</p>
           <p>Tu solicitud de cambio al plan <strong>${targetPlan.name}</strong> en la empresa <strong>"${company.name}"</strong> ha sido <strong>aprobada</strong>.</p>
           <p>¡Disfruta de tu nuevo plan!</p>`
        : `<p>Hola <strong>${user.name}</strong>,</p>
           <p>Tu solicitud de cambio al plan <strong>${targetPlan.name}</strong> en la empresa <strong>"${company.name}"</strong> ha sido <strong>rechazada</strong>.</p>
           <p>Contacta a un administrador si crees que esto es un error.</p>`;

      await sendEmail({
        to: user.email,
        subject: emailSubject,
        text: emailText,
        html: emailHtml
      });
    }

    logger.info(`Notificación completada para usuario ${user.id} (solicitud ${request.id})`);
  } catch (err) {
    logger.error("Error en _notifyUserAboutUpgradeRequestResolution (background):", err.message);
  }
}
const UpgradeRequestController = {
  async index(req, res) {
    try {
      const { company_id, status, page, limit } = req.body;
      const result = await UpgradeRequestRepository.findFiltered({ company_id, status, page, limit });
      return res.status(200).json({ success: true, ...result });
    } catch (err) {
      logger.error("UpgradeRequestController->index: " + err.message);
      return res.status(500).json({ success: false, message: "Error interno del servidor", details: err.message });
    }
  },

  async show(req, res) {
    try {
      const request = await UpgradeRequestRepository.findById(req.body.id);
      if (!request) return res.status(404).json({ success: false, message: "Solicitud de actualización de plan no encontrada" });
      return res.status(200).json({ success: true, upgradeRequest: request });
    } catch (err) {
      logger.error("UpgradeRequestController->show: " + err.message);
      return res.status(500).json({ success: false, message: "Error interno del servidor", details: err.message });
    }
  },

  async store(req, res) {
  logger.info(`${req.user?.name || 'Anonymous'} - Crea solicitud de actualización de plan`);
  logger.info(`"Datos recibidos:", ${JSON.stringify(req.body)}`);

  const { company_id, current_plan_id, target_plan_id, billing_cycle, message, user_id: bodyUserId } = req.body;
    const user_id = bodyUserId || getUserId();

  // Validaciones
  const company = await CompanyRepository.findById(company_id);
  if (!company) return res.status(404).json({ success: false, message: "Compañía no encontrada" });

  const user = await UserRepository.findById(user_id);
  if (!user) return res.status(404).json({ success: false, message: "Usuario no encontrado" });

  const currentPlan = await PlanRepository.findById(current_plan_id);
  if (!currentPlan) return res.status(404).json({ success: false, message: "Plan actual no encontrado" });

  const targetPlan = await PlanRepository.findById(target_plan_id);
  if (!targetPlan) return res.status(404).json({ success: false, message: "Plan solicitado no encontrado" });

  const t = await sequelize.transaction();
  let request;

  try {
    request = await UpgradeRequestRepository.create(req.body, t);
    await t.commit();
  } catch (err) {
    await t.rollback();
    logger.error("UpgradeRequestController->store:", + JSON.stringify(err.message));
    return res.status(500).json({ success: false, message: "Error al crear solicitud", details: JSON.stringify(err.message) });
  }

  // ✅ Lanzar notificación en segundo plano (sin await)
  // Esto no bloquea la respuesta
  _notifyAdminsAboutUpgradeRequest({
    company,
    user,
    request,
    currentPlan,
    targetPlan,
    billing_cycle,
    message
  }).catch(err => {
    // Este catch es redundante (ya hay uno dentro), pero por seguridad
    logger.error("Error inesperado en notificación background:", err.message);
  });

  // ✅ Responder inmediatamente
  return res.status(201).json({
    success: true,
    upgradeRequest: request,
    message: "Solicitud de actualización de plan creada correctamente"
  });
  },

  /*async update(req, res) {
    logger.info(`${req.user?.user || 'Anonymous'} - Actualiza solicitud de actualización de plan con ID ${req.body.id}`);
    logger.info(`"Datos recibidos:" ${JSON.stringify(req.body)}`);

    const { id, status } = req.body;

    const request = await UpgradeRequestRepository.findById(id);
    if (!request) return res.status(404).json({ success: false, message: "Solicitud de actualización de plan no encontrada" });

    const t = await sequelize.transaction();
    try {
      const updatedRequest = await UpgradeRequestRepository.update(request, { status }, t);
      await t.commit();

      return res.status(200).json({
        success: true,
        upgradeRequest: updatedRequest,
        message: "Solicitud de actualización de plan actualizada correctamente"
      });
    } catch (err) {
      if (t && !t.finished) await t.rollback();
      logger.error("UpgradeRequestController->update: " + err.message);
      return res.status(500).json({ success: false, message: "Error al actualizar solicitud de actualización de plan", details: err.message });
    }
  },*/

async update(req, res) {
  logger.info(`${req.user?.user || 'Anonymous'} - Actualiza solicitud de actualización de plan con ID ${req.body.id}`);
  logger.info(`"Datos recibidos:" ${JSON.stringify(req.body)}`);

  const { id, status } = req.body;

  const request = await UpgradeRequestRepository.findById(id);
  if (!request) return res.status(404).json({ success: false, message: "Solicitud de actualización de plan no encontrada" });

  // Cargar datos relacionados necesarios para la notificación
  const company = await CompanyRepository.findById(request.company_id);
  const user = await UserRepository.findById(request.user_id);
  const targetPlan = await PlanRepository.findById(request.target_plan_id);

  if (!company || !user || !targetPlan) {
    return res.status(404).json({ success: false, message: "Datos relacionados no encontrados" });
  }

  const t = await sequelize.transaction();
  try {
    const updatedRequest = await UpgradeRequestRepository.update(request, { status }, t);
    await t.commit();

    // ✅ Notificar al usuario solicitante en segundo plano (sin await)
    _notifyUserAboutUpgradeRequestResolution({
      user,
      company,
      request: updatedRequest,
      targetPlan,
      status
    }).catch(err => {
      logger.error("Error inesperado en notificación al usuario:", err.message);
    });

    return res.status(200).json({
      success: true,
      upgradeRequest: updatedRequest,
      message: "Solicitud de actualización de plan actualizada correctamente"
    });
  } catch (err) {
    if (t && !t.finished) await t.rollback();
    logger.error("UpgradeRequestController->update: " + err.message);
    return res.status(500).json({ success: false, message: "Error al actualizar solicitud de actualización de plan", details: err.message });
  }
},
  async destroy(req, res) {
    logger.info(`${req.user?.user || 'Anonymous'} - Elimina solicitud de actualización de plan con ID ${req.body.id}`);
    logger.info("Datos recibidos:");
    logger.info(JSON.stringify(req.body));

    try {
      const request = await UpgradeRequestRepository.findById(req.body.id);
      if (!request) return res.status(404).json({ success: false, message: "Solicitud de actualización de plan no encontrada" });
      await UpgradeRequestRepository.delete(request);
      return res.status(200).json({ success: true, message: "Solicitud de actualización de plan eliminada correctamente" });
    } catch (err) {
      logger.error("UpgradeRequestController->destroy: " + err.message);
      return res.status(500).json({ success: false, message: "Error al eliminar solicitud de actualización de plan", details: err.message });
    }
  }
};

module.exports = UpgradeRequestController;