const logger = require('../../config/logger');
const { sequelize } = require('../models');
const { CompanyRepository, WarehouseRepository, LogRepository, BusinessTypeRepository } = require('../repositories');
const { getRequestMetadata } = require('../util/requestUtil');
const { detectChanges } = require('../util/auditUtils');

// Campos que queremos auditar en Company
const COMPANY_AUDIT_FIELDS = ['name', 'description', 'rut', 'address', 'city', 'country', 'phone', 'user_id'];

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
        businessTypeName: company.businessType.name // ← añadido
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

    const { rut, business_type_id } = req.body;
    if (req.user) req.body.user_id = req.user.id;
      const existingCompany = await CompanyRepository.existsByRut(rut);
      if (existingCompany) {
        logger.error('El RUT ya está registrado: ' + rut);
        return res.status(400).json({ error: 'DuplicateRut', msg: 'El RUT ya está registrado en otra empresa.' });
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

      const transaction = await sequelize.transaction();
    try {

      const company = await CompanyRepository.create(req.body, req.file, transaction);
       // ✅ Usar el nuevo método del repositorio
      const hasPrincipal = await WarehouseRepository.existsPrincipalByCompany(company.id, transaction);

      if (!hasPrincipal) {
        await WarehouseRepository.create({
          name: `Almacén Principal - ${company.name}`,
          type: 1,
          company_id: company.id,
          user_id: company.user_id,
          address: company.address || null
        }, null, transaction); // null = sin archivo
        logger.info(`Almacén principal creado para la empresa ID ${company.id}`);
      }
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
        businessTypeName: company.businessType.name // ← añadido
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

    const { id, rut, business_type_id } = req.body;
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

      if (rut) {
        const existingCompany = await CompanyRepository.existsByRut(rut, id);
        if (existingCompany) {
          logger.error('El RUT ya está registrado: ' + rut);
          return res.status(400).json({ error: 'DuplicateRut', msg: 'El RUT ya está registrado en otra empresa.' });
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
};

module.exports = CompanyController;