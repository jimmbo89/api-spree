const logger = require('../../config/logger');
const { sequelize } = require('../models');
const { CompanyRepository, WarehouseRepository, LogRepository, BusinessTypeRepository, PlanRepository, UserCompanyRepository, RoleRepository, UserRepository } = require('../repositories');
const { getRequestMetadata } = require('../util/requestUtil');
const { detectChanges } = require('../util/auditUtils');

// Campos que queremos auditar en Company
const COMPANY_AUDIT_FIELDS = ['name', 'description', 'rut', 'address', 'city', 'country', 'phone', 'user_id', 'email', 'currency'];

const CompanyController = {
  async index(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Entra a buscar las compañías`);

    try {
      const companies = await CompanyRepository.findAll();

      if (!companies.length) {
        return res.status(204).json({ msg: 'CompaniesNotFound' });
      }

      const mappedCompanies = companies.map(company => ({
        id: company.id,
        name: company.name,
        description: company.description,
        address: company.address,
        city: company.city,
        country: company.country,
        rut: company.rut,
        phone: company.phone,
        image: company.image,
        business_type_id: company.business_type_id,
        businessTypeName: company.businessType.name,
        email: company.email,
        currency: company.currency,
      }));

      res.status(200).json({ companies: mappedCompanies });
    } catch (error) {
      logger.error('CompanyController->index: ' + error.message);
      res.status(500).json({ error: 'ServerError', details: error.message });
    }
  },

  async store(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Crea una nueva compañía`);
    logger.info('Datos recibidos:');
    logger.info(JSON.stringify(req.body));

    const { rut, business_type_id, warehouse, email, plan_id, name, description, phone, country, address, currency } = req.body;
    if (req.user) req.body.user_id = req.user.id;
      const uniqueCheck = await CompanyRepository.checkUniqueFields({ rut, email });
      if (uniqueCheck.exists) {
        const field = uniqueCheck.field;
        const fieldName = field === 'rut' ? 'RUT' : 'email';
        logger.error(`El ${fieldName} ya está registrado: ${field === 'rut' ? rut : email}`);
        return res.status(400).json({
          error: `Duplicate${field.charAt(0).toUpperCase() + field.slice(1)}`,
          msg: `El ${fieldName} ya está registrado en otra empresa.`
        });
      }

       if (business_type_id) {
        const businessType = await BusinessTypeRepository.findById(business_type_id);
            if (!businessType) {
            logger.error(
                `CompanyController->store: Tipo de negocio no encontrado con ID ${business_type_id}`
            );
            return res.status(400).json({ msg: "BusinessTypeNotFound" });
            }
        }

        if(!plan_id)
        {
          let plan = await PlanRepository.findByName('FREE');
          if (plan) {
            req.body.plan_id = plan.id;
          }
        }

      const transaction = await sequelize.transaction();
    try {

      const company = await CompanyRepository.create(req.body, req.file, transaction);
       // ✅ Usar el nuevo método del repositorio
      //const hasPrincipal = await WarehouseRepository.existsPrincipalByEntity({ companyId: company.id }, transaction);

      if (warehouse) {
        try {
          const warehouseData = JSON.parse(warehouse);
          
          // Validar que tengamos los campos mínimos
          if (!warehouseData.code || !warehouseData.name) {
            throw new Error('El almacén debe tener código y nombre');
          }
          
          // Asignar company_id y user_id
          warehouseData.company_id = company.id;
          warehouseData.user_id = company.user_id;
          
          // Si no viene address, usar el de la empresa
          if (!warehouseData.address && company.address) {
            warehouseData.address = company.address;
          }
          
          await WarehouseRepository.create(warehouseData, null, transaction);
          logger.info(`Almacén creado para la empresa ID ${company.id}: ${warehouseData.name}`);
          
        } catch (error) {
          logger.error(`Error al procesar warehouse JSON: ${error.message}`);
          // No hacemos rollback, solo logueamos el error
          // El almacén se puede crear después manualmente
        }
      }
      /*if (!hasPrincipal) {
        await WarehouseRepository.create({
          name: `Almacén Principal - ${company.name}`,
          type: 1,
          company_id: company.id,
          user_id: company.user_id,
          address: company.address || null
        }, null, transaction); // null = sin archivo
        logger.info(`Almacén principal creado para la empresa ID ${company.id}`);
      }*/
      await transaction.commit();
      const companies = await CompanyRepository.getMappedCompaniesByUserId(req.user.id);
      res.status(201).json({ message: "Compañía creada correctamente", companies: companies });
    } catch (error) {
      await transaction.rollback();
      const errorMsg = error.details
        ? error.details.map(detail => detail.message).join(', ')
        : error.message || 'Error desconocido';
      logger.error('CompanyController->store: ' + errorMsg);
      res.status(500).json({ error: 'ServerError', details: errorMsg });
    }
  },

  async storeLogin(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Crea una nueva compañía desde el login`);
    logger.info('Datos recibidos:');
    logger.info(JSON.stringify(req.body));

    const { rut, business_type_id, name, country, address, email, currency } = req.body;
    let user_id = req.user.id;
    req.body.user_id = user_id;
      const existingCompany = await CompanyRepository.checkUniqueFields({ rut, email });
      logger.info('JSON.stringify(existingCompany)');
      logger.info(JSON.stringify(existingCompany));
      if (existingCompany.exists) {
          // 2. Verificar si el usuario YA es miembro
          const existingMembership = await UserCompanyRepository.findByUserIdAndCompanyId(
            user_id, 
            existingCompany.id
          );

          if (existingMembership && [0, 1].includes(existingMembership.status)) {
            // Ya es miembro → error ALREADY_MEMBER
            return res.status(409).json({
              success: false,
              code: 'ALREADY_MEMBER',
              message: 'Ya perteneces a esta empresa.',
              companyId: existingCompany.id
            });
          } else {
            // Empresa existe, pero NO es miembro → COMPANY_EXISTS_NOT_MEMBER
            return res.status(409).json({
              success: false,
              code: 'COMPANY_EXISTS_NOT_MEMBER',
              message: 'Esta empresa ya existe en Spree. Para ingresar, necesitas invitación de un administrador.',
              companyId: existingCompany.id,
              companyName: existingCompany.name
            });
          }
        }

       if (business_type_id) {
        const businessType = await BusinessTypeRepository.findById(business_type_id);
            if (!businessType) {
            logger.error(
                `CompanyController->store: Tipo de negocio no encontrado con ID ${business_type_id}`
            );
            return res.status(400).json({ status: false, message: "Tipo de negocio no encontrado" });
            }
        }
        let role_id = null;
        let membership = {};
        const adminRole = await RoleRepository.findByName("Admin");
        if (adminRole) {
          role_id = adminRole.id;
        }
         let plan = await PlanRepository.findByName('FREE');
          if (plan) {
            req.body.plan_id = plan.id;
          }
      const transaction = await sequelize.transaction();
    try {

      const company = await CompanyRepository.create(req.body, req.file, transaction);

      membership = await UserCompanyRepository.create(
          {
            user_id,
            company_id: company.id,
            role_id,
            status: 1,
            joined_at: new Date(),
            invited_by: null,
          },
          transaction
        );
       // ✅ Usar el nuevo método del repositorio
      //const hasPrincipal = await WarehouseRepository.existsPrincipalByEntity({ companyId: company.id }, transaction);
      await transaction.commit();
      res.status(201).json({success: true,
      message: "Compañía creada correctamente",
        company: {
          id: company.id,
          name: company.name,
          plan: plan
        },
        membership: {
          id: membership.id,
          company_id: membership.company_id,
          role_id: membership.role_id,
          status: membership.status,
          company: {
            id: company.id,
            name: company.name,
            plan: plan
          },
          role: adminRole
        }
   });
    } catch (error) {
      await transaction.rollback();
      const errorMsg = error.details
        ? error.details.map(detail => detail.message).join(', ')
        : error.message || 'Error desconocido';
      logger.error('CompanyController->store: ' + errorMsg);
      res.status(500).json({ status: false, message: 'Error interno del servidor', details: errorMsg });
    }
  },

  async getCompaniesByUser(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Visualiza las compañías`);
    const user_id = req.body.user_id || req.user?.id;

    try {
      const mappedCompanies = await CompanyRepository.getMappedCompaniesByUserId(user_id);

      if (!mappedCompanies.length) {
        return res.status(200).json({ companies: [], msg: 'NoCompaniesFound' });
      }

      res.status(200).json({ companies: mappedCompanies });
    } catch (error) {
      const errorMsg = error.message || 'Error desconocido';
      logger.error('CompanyController->getCompaniesByUser: ' + errorMsg);
      res.status(500).json({ error: 'ServerError', details: errorMsg });
    }
  },

  async show(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Busca compañía con ID ${req.body.id}`);

    try {
      const company = await CompanyRepository.findById(req.body.id);
      if (!company) {
        return res.status(404).json({ msg: 'CompanyNotFound' });
      }

      const mappedCompany = {
        id: company.id,
        name: company.name,
        description: company.description,
        address: company.address,
        city: company.city,
        country: company.country,
        rut: company.rut,
        phone: company.phone,
        image: company.image,
        business_type_id: company.business_type_id,
        businessTypeName: company.businessType.name,
        email: company.email,
        currency: company.currency
      };

      res.status(200).json({ company: mappedCompany });
    } catch (error) {
      const errorMsg = error.details
        ? error.details.map(detail => detail.message).join(', ')
        : error.message || 'Error desconocido';
      logger.error('CompanyController->show: ' + errorMsg);
      res.status(500).json({ error: 'ServerError', details: errorMsg });
    }
  },

  async update(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Actualiza compañía con ID ${req.body.id}`);
    logger.info('Datos recibidos:');
    logger.info(JSON.stringify(req.body));

    const { id, rut, email, business_type_id } = req.body;
    const metadata = getRequestMetadata(req);

  if (business_type_id) {
        const businessType = await BusinessTypeRepository.findById(business_type_id);
            if (!businessType) {
            logger.error(
                `CompanyController->update: Tipo de negocio no encontrado con ID ${business_type_id}`
            );
            return res.status(400).json({ msg: "BusinessTypeNotFound" });
            }
        }

    try {
      const company = await CompanyRepository.findById(id);
      if (!company) {
        return res.status(404).json({ msg: 'CompanyNotFound' });
      }

      // Guardar valores originales para auditoría
      const originalData = { ...company.get({ plain: true }) };

     if (rut || email) {
      const uniqueCheck = await CompanyRepository.checkUniqueFields({ rut, email }, id);
      if (uniqueCheck.exists) {
        const field = uniqueCheck.field;
        const fieldName = field === 'rut' ? 'RUT' : 'email';
        const value = field === 'rut' ? rut : email;
        logger.error(`El ${fieldName} ya está registrado: ${value}`);
        return res.status(400).json({
          error: `Duplicate${field.charAt(0).toUpperCase() + field.slice(1)}`,
          msg: `El ${fieldName} ya está registrado en otra empresa.`
        });
      }
    }

      // ✅ Realizar la actualización
      const updatedCompany = await CompanyRepository.update(company, req.body, req.file);

      // Detectar todos los cambios
      const fieldChanges = detectChanges(
        originalData,
        updatedCompany.get({ plain: true }),
        COMPANY_AUDIT_FIELDS
      );
      let logEntry;

      if (fieldChanges.length > 0) {
        // Hay cambios → registrar los detalles
        logEntry = {
          user_id: metadata.user_id,
          action: 'company.update',
          description: `Compañía actualizada: ${fieldChanges.length} campo(s) modificados`,
          ip_address: metadata.ip_address,
          user_agent: metadata.user_agent,
          status: 'success',
          meta: {
            changes: fieldChanges // ← array de todos los cambios
          }
        };
      } else {
        // Sin cambios → igual registrar la operación
        logEntry = {
          user_id: metadata.user_id,
          action: 'company.update',
          description: `Actualización de compañía ID ${company.id} sin cambios`,
          ip_address: metadata.ip_address,
          user_agent: metadata.user_agent,
          status: 'success',
          meta: null
        };
      }

      // ✅ Crear UN solo registro
      await LogRepository.create(logEntry);
      const companies = await CompanyRepository.getMappedCompaniesByUserId(req.user.id);
      res.status(200).json({ message: 'Compañía editada correctamente', companies: companies });
    } catch (error) {
       await LogRepository.create({
        user_id: metadata.user_id,
        action: 'company.update',
        description: `Error al actualizar compañía ID ${id}: ${error.message}`,
        ip_address: metadata.ip_address,
        user_agent: metadata.user_agent,
        status: 'error',
        meta: null
      });
      const errorMsg = error.details
        ? error.details.map(detail => detail.message).join(', ')
        : error.message || 'Error desconocido';
      logger.error('CompanyController->update: ' + errorMsg);
      res.status(500).json({ error: 'ServerError', details: errorMsg });
    }
  },

  async destroy(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Elimina compañía con ID ${req.body.id}`);
    const metadata = getRequestMetadata(req);

    try {
      const company = await CompanyRepository.findById(req.body.id);
      if (!company) {
        return res.status(404).json({ msg: 'CompanyNotFound' });
      }
      // ✅ Guardar datos originales PARA EL LOG antes de eliminar
    const companyData = company.get({ plain: true });

      await CompanyRepository.delete(company);

      // ✅ Registrar UN SOLO log de eliminación
    await LogRepository.create({
      user_id: metadata.user_id,
      action: 'company.delete',
      description: `Compañía eliminada: ID ${companyData.id}, nombre: "${companyData.name}"`,
      ip_address: metadata.ip_address,
      user_agent: metadata.user_agent,
      status: 'success',
      meta: {
        deleted_record: companyData // ← toda la compañía antes de ser eliminada
      }
    });
      const companies = await CompanyRepository.getMappedCompaniesByUserId(req.user.id);
      res.status(200).json({ message: 'Compañía eliminada correctamente', companies: companies });
    } catch (error) {
      await LogRepository.create({
      user_id: metadata.user_id,
      action: 'company.delete',
      description: `Error al eliminar compañía ID ${req.body.id}: ${error.message}`,
      ip_address: metadata.ip_address,
      user_agent: metadata.user_agent,
      status: 'error',
      meta: null
    });

      const errorMsg = error.details
        ? error.details.map(detail => detail.message).join(', ')
        : error.message || 'Error desconocido';
      logger.error('CompanyController->destroy: ' + errorMsg);
      res.status(500).json({ error: 'ServerError', details: errorMsg });
    }
  },

    async joinInvitation(req, res) {
  const { token } = req.body;
  logger.info('Verificando invitación con token desde login:');
  logger.info(JSON.stringify(req.body));
      const user_id = req.user.id;
  const transaction = await sequelize.transaction();
  try {
    // 🔑 1. Buscar membresía PENDIENTE usando token + company_id
    const pendingMembership = await UserCompanyRepository.findPendingByTokenAndCompany(
      token,
      null,
      transaction,
      user_id
    );

    if (!pendingMembership) {
      await transaction.rollback();
      logger.info("No se encontró invitación pendiente con ese token y empresa");
      return res.status(400).json({ success: false, message: "Token inválido, expirado o ya utilizado", code:'INVITATION_ALREADY_USED' });
    }

    // 📅 2. Verificar expiración (usando getTime() para evitar problemas de timezone)
    if (new Date(pendingMembership.expires_at).getTime() < Date.now()) {
      await transaction.rollback();
      logger.info("Token de invitación expirado");
      return res.status(400).json({ success: false, message: "El enlace de invitación ha expirado", code:'INVITATION_EXPIRED' });
    }

    // 👤 3. Cargar datos del usuario (para la respuesta)
    const user = await UserRepository.findById(pendingMembership.user_id, transaction);
    if (!user) {
      await transaction.rollback();
      logger.error("Usuario asociado a la membresía no encontrado");
      return res.status(500).json({ success: false, message: "Inconsistencia de datos" });
    }

    // ✅ 4. Activar la membresía
    const membership = await UserCompanyRepository.activateMembership(
      {
        user_id: pendingMembership.user_id,
        company_id: pendingMembership.company_id,
      },
      transaction
    );

    await transaction.commit();

    logger.info(`Invitación aceptada: usuario ${user.email}`);
    res.status(201).json({success: true,
      message: "Compañía creada correctamente",
        company: {
          id: pendingMembership.company_id,
          name: pendingMembership.company.name,
          plan: pendingMembership.company.plan
        },
        membership: {
          id: membership.id,
          company_id: membership.company_id,
          role_id: membership.role_id,
          status: membership.status,
          company: {
            id: pendingMembership.company_id,
            name: pendingMembership.company.name,
            plan: pendingMembership.company.plan
          },
          role: pendingMembership.role
        }
   });

  } catch (error) {
     if (!transaction.finished) {
      await transaction.rollback();
    }
    logger.error("Error en joinInvitation:", error);
    return res.status(500).json({ success: false, message: "Error interno al procesar la invitación" });
  }
},
};

module.exports = CompanyController;