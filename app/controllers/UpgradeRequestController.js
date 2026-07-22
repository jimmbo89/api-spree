const logger = require("../../config/logger");
const { UpgradeRequestRepository, CompanyRepository, UserRepository, PlanRepository, UserCompanyRepository, NotificationRepository } = require("../repositories");
const { sequelize } = require('../models');
const { sendEmailsToUsers, sendEmail } = require("../services/EmailService");
const { getUserId } = require("../../config/context");

function buildUpgradeRequestSpreeLink() {
  return String(process.env.FRONTEND_URL || process.env.APP_URL || 'https://spree.api.klint.cl')
    .replace(/\/+$/, '');
}

function formatBillingCycleLabel(billingCycle) {
  const normalized = String(billingCycle || '').trim().toLowerCase();
  if (['monthly', 'month', 'mensual'].includes(normalized)) return 'mensual';
  if (['yearly', 'annual', 'annually', 'annualy', 'anual'].includes(normalized)) return 'anual';
  return billingCycle || 'mensual';
}

/**
 * Notifica a los destinatarios de una solicitud de actualizacion de plan.
 * Esta funcion NO debe ser await-eada si se quiere respuesta inmediata.
 */
async function _notifyUpgradeRequestRecipients({
  recipients,
  company,
  user,
  request,
  currentPlan,
  targetPlan,
  billing_cycle,
  message,
  recipientLabel = 'destinatarios'
}) {
  try {
    const filteredRecipients = Array.isArray(recipients)
      ? recipients.filter(recipient => recipient?.id && recipient?.email)
      : [];

    if (filteredRecipients.length === 0) {
      logger.warn(`No se encontraron ${recipientLabel} para la compania ${company.id}`);
      return;
    }

    const recipientUserIds = filteredRecipients.map(recipient => recipient.id);
    await NotificationRepository.createForMultipleUsers({
      company_id: company.id,
      user_ids: recipientUserIds,
      title: "Solicitud de actualizacion de plan",
      description: `El usuario ${user.name} ha solicitado cambiar del plan ${currentPlan.name} al plan ${targetPlan.name} (${formatBillingCycleLabel(billing_cycle)}).`,
      type: "upgraderequest",
      data: {
        upgrade_request_id: request?.id || null,
        requested_by_user_id: user.id,
        target_plan_id: targetPlan.id,
        billing_cycle,
        timestamp: new Date().toISOString()
      },
      status: 0
    });

    const spreeLink = buildUpgradeRequestSpreeLink();
    const emailSubject = `[Spree] Nueva solicitud de actualizacion de plan - ${company.name}`;
    const emailText = `
Hola,

El usuario ${user.name} (${user.email}) ha solicitado un cambio de plan en la empresa "${company.name}".

- Plan actual: ${currentPlan.name}
- Plan solicitado: ${targetPlan.name}
- Ciclo: ${formatBillingCycleLabel(billing_cycle)}
- Mensaje: ${message || "Ninguno"}

Ingresa a Spree para revisar y aprobar esta solicitud: ${spreeLink}
    `.trim();

    const emailHtml = `<p>Hola,</p>
    <p>El usuario <strong>${user.name}</strong> (${user.email}) ha solicitado un cambio de plan en la empresa <strong>"${company.name}"</strong>.</p>
    <ul>
      <li><strong>Plan actual:</strong> ${currentPlan.name}</li>
      <li><strong>Plan solicitado:</strong> ${targetPlan.name}</li>
      <li><strong>Ciclo:</strong> ${formatBillingCycleLabel(billing_cycle)}</li>
      ${message ? `<li><strong>Mensaje:</strong> ${message}</li>` : ''}
    </ul>
    <p>Ingresa a Spree para revisar y aprobar esta solicitud.</p>
    <p><a href="${spreeLink}" style="display:inline-block;padding:10px 16px;background:#111827;color:#fff;text-decoration:none;border-radius:6px;">Abrir Spree</a></p>`;

    await sendEmailsToUsers(filteredRecipients, {
      subject: emailSubject,
      text: emailText,
      html: emailHtml,
    });

    logger.info(`Notificacion completada para ${filteredRecipients.length} ${recipientLabel} de la compania ${company.id}`);
  } catch (err) {
    logger.error("Error en _notifyUpgradeRequestRecipients (background):", err.message, err.stack);
  }
}

/**
 * Notifica al usuario solicitante sobre la resolucion de su solicitud
 */
async function _notifyUserAboutUpgradeRequestResolution({
  user,
  company,
  request,
  targetPlan,
  status
}) {
  try {
    await NotificationRepository.create({
      user_id: user.id,
      company_id: company.id,
      title: status === 'approved'
        ? "Solicitud de actualizacion de plan aprobada"
        : "Solicitud de actualizacion de plan rechazada",
      description: status === 'approved'
        ? `Tu solicitud de cambio al plan ${targetPlan.name} ha sido aprobada. Bienvenido!`
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

    if (user.email) {
      const spreeLink = buildUpgradeRequestSpreeLink();
      const emailSubject = status === 'approved'
        ? `[Spree] Tu solicitud de actualizacion de plan fue aprobada`
        : `[Spree] Tu solicitud de actualizacion de plan fue rechazada`;

      const emailText = status === 'approved'
        ? `Hola ${user.name},\n\nTu solicitud de cambio al plan ${targetPlan.name} en la empresa "${company.name}" ha sido aprobada.\n\nIngresa a Spree: ${spreeLink}\n\nDisfruta de tu nuevo plan!`
        : `Hola ${user.name},\n\nTu solicitud de cambio al plan ${targetPlan.name} en la empresa "${company.name}" ha sido rechazada.\n\nContacta a un administrador si crees que esto es un error.\n\nIngresa a Spree: ${spreeLink}`;

      const emailHtml = status === 'approved'
        ? `<p>Hola <strong>${user.name}</strong>,</p>
           <p>Tu solicitud de cambio al plan <strong>${targetPlan.name}</strong> en la empresa <strong>"${company.name}"</strong> ha sido <strong>aprobada</strong>.</p>
           <p>Ingresa a Spree para ver el detalle.</p>
           <p><a href="${spreeLink}" style="display:inline-block;padding:10px 16px;background:#111827;color:#fff;text-decoration:none;border-radius:6px;">Abrir Spree</a></p>
           <p>Disfruta de tu nuevo plan!</p>`
        : `<p>Hola <strong>${user.name}</strong>,</p>
           <p>Tu solicitud de cambio al plan <strong>${targetPlan.name}</strong> en la empresa <strong>"${company.name}"</strong> ha sido <strong>rechazada</strong>.</p>
           <p>Contacta a un administrador si crees que esto es un error.</p>
           <p><a href="${spreeLink}" style="display:inline-block;padding:10px 16px;background:#111827;color:#fff;text-decoration:none;border-radius:6px;">Abrir Spree</a></p>`;

      await sendEmail({
        to: user.email,
        subject: emailSubject,
        text: emailText,
        html: emailHtml
      });
    }

    logger.info(`Notificacion completada para usuario ${user.id} (solicitud ${request.id})`);
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
      if (!request) return res.status(404).json({ success: false, message: "Solicitud de actualizacion de plan no encontrada" });
      return res.status(200).json({ success: true, upgradeRequest: request });
    } catch (err) {
      logger.error("UpgradeRequestController->show: " + err.message);
      return res.status(500).json({ success: false, message: "Error interno del servidor", details: err.message });
    }
  },

  async store(req, res) {
    logger.info(`${req.user?.name || 'Anonymous'} - Crea solicitud de actualizacion de plan`);
    logger.info(`Datos recibidos: ${JSON.stringify(req.body)}`);

    const { company_id, current_plan_id, target_plan_id, billing_cycle, message, user_id: bodyUserId } = req.body;
    const user_id = bodyUserId || getUserId();

    const company = await CompanyRepository.findById(company_id);
    if (!company) return res.status(404).json({ success: false, message: "Compania no encontrada" });

    const user = await UserRepository.findById(user_id);
    if (!user) return res.status(404).json({ success: false, message: "Usuario no encontrado" });

    const currentPlan = await PlanRepository.findById(current_plan_id);
    if (!currentPlan) return res.status(404).json({ success: false, message: "Plan actual no encontrado" });

    const targetPlan = await PlanRepository.findById(target_plan_id);
    if (!targetPlan) return res.status(404).json({ success: false, message: "Plan solicitado no encontrado" });

    const requestPayload = {
      company_id,
      user_id,
      current_plan_id,
      target_plan_id,
      billing_cycle,
      message
    };

    const t = await sequelize.transaction();
    let request;
    try {
      request = await UpgradeRequestRepository.create(requestPayload, t);
      await t.commit();
    } catch (err) {
      if (t && !t.finished) await t.rollback();
      logger.error("UpgradeRequestController->store:", + JSON.stringify(err.message));
      return res.status(500).json({ success: false, message: "Error al crear solicitud", details: JSON.stringify(err.message) });
    }

    const recipients = await UserCompanyRepository.findActiveAdminsByCompanyId(company.id);

    _notifyUpgradeRequestRecipients({
      recipients,
      company,
      user,
      request,
      currentPlan,
      targetPlan,
      billing_cycle,
      message,
      recipientLabel: 'admins'
    }).catch(err => {
      logger.error("Error inesperado en notificacion background:", err.message);
    });

    return res.status(201).json({
      success: true,
      upgradeRequest: request,
      message: "Solicitud de actualizacion de plan creada correctamente"
    });
  },

  async update(req, res) {
    logger.info(`${req.user?.user || 'Anonymous'} - Actualiza solicitud de actualizacion de plan con ID ${req.body.id}`);
    logger.info(`Datos recibidos: ${JSON.stringify(req.body)}`);

    const { id, status } = req.body;

    const request = await UpgradeRequestRepository.findById(id);
    if (!request) return res.status(404).json({ success: false, message: "Solicitud de actualizacion de plan no encontrada" });

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

      _notifyUserAboutUpgradeRequestResolution({
        user,
        company,
        request: updatedRequest,
        targetPlan,
        status
      }).catch(err => {
        logger.error("Error inesperado en notificacion al usuario:", err.message);
      });

      return res.status(200).json({
        success: true,
        upgradeRequest: updatedRequest,
        message: "Solicitud de actualizacion de plan actualizada correctamente"
      });
    } catch (err) {
      if (t && !t.finished) await t.rollback();
      logger.error("UpgradeRequestController->update: " + err.message);
      return res.status(500).json({ success: false, message: "Error al actualizar solicitud de actualizacion de plan", details: err.message });
    }
  },

  async destroy(req, res) {
    logger.info(`${req.user?.user || 'Anonymous'} - Elimina solicitud de actualizacion de plan con ID ${req.body.id}`);
    logger.info("Datos recibidos:");
    logger.info(JSON.stringify(req.body));

    try {
      const request = await UpgradeRequestRepository.findById(req.body.id);
      if (!request) return res.status(404).json({ success: false, message: "Solicitud de actualizacion de plan no encontrada" });
      await UpgradeRequestRepository.delete(request);
      return res.status(200).json({ success: true, message: "Solicitud de actualizacion de plan eliminada correctamente" });
    } catch (err) {
      logger.error("UpgradeRequestController->destroy: " + err.message);
      return res.status(500).json({ success: false, message: "Error al eliminar solicitud de actualizacion de plan", details: err.message });
    }
  }
};

module.exports = UpgradeRequestController;
