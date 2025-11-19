const logger = require('../../config/logger');
const { BranchRepository, CompanyRepository, UserRepository, LogRepository, WarehouseRepository } = require('../repositories');
const { detectChanges } = require('../util/auditUtils');
const { getRequestMetadata } = require('../util/requestUtil');

const BRANCH_AUDIT_FIELDS = ['name', 'address', 'city', 'phone', 'status', 'company_id', 'user_id'];

const BranchController = {
  // ✅ Endpoint flexible: /api/branches/list
  async list(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Lista sucursales`);

    let { company_id, user_id:bodyUserId } = req.body;

    let user_id = bodyUserId || req.user.id;
    // Validar que sean números si existen
    if (company_id) {
        const company = await CompanyRepository.findById(company_id);
        if (!company) {
          logger.info(
            `BranchController->store: Compañía no encontrada con ID ${company_id}`
          );
          return res.status(400).json({ msg: "companyNotFound" });
        }
      }
     if (user_id) {
        const user = await UserRepository.findById(user_id);
        if (!user) {
          logger.info(
            `BranchController->update: Compañía no editada con ID ${user_id}`
          );
          return res.status(400).json({ msg: "userNotFound" });
        }
      }

    try {
      const mappedBranches = await BranchRepository.findFiltered({
        companyId: company_id,
        userId: user_id
      });

      if (mappedBranches.length === 0) {
        return res.status(200).json({ branches: [], msg: 'NoBranchesFound' });
      }

      res.status(200).json({ branches: mappedBranches });
    } catch (error) {
      logger.error('BranchController->list: ' + error.message);
      res.status(500).json({ error: 'ServerError', details: error.message });
    }
  },

  // Métodos CRUD estándar (crear, ver, editar, eliminar) — siguen tu estilo
  async store(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Crea nueva sucursal`);
    logger.info('Datos recibidos:');
    logger.info(JSON.stringify(req.body));
    const { company_id, user_id:bodyUserId } = req.body;

    let user_id = bodyUserId || req.user.id;

    req.body.user_id = user_id;

     if (company_id) {
        const company = await CompanyRepository.findById(company_id);
        if (!company) {
          logger.info(
            `BranchController->store: Compañía no encontrada con ID ${company_id}`
          );
          return res.status(400).json({ msg: "companyNotFound" });
        }
      }
     if (user_id) {
        const user = await UserRepository.findById(user_id);
        if (!user) {
          logger.info(
            `BranchController->update: Compañía no editada con ID ${user_id}`
          );
          return res.status(400).json({ msg: "userNotFound" });
        }
      }

    try {
      const branch = await BranchRepository.create(req.body, req.file);
      const hasPrincipal = await WarehouseRepository.existsPrincipalByEntity({ branchId: branch.id }, transaction);

      if (!hasPrincipal) {
        await WarehouseRepository.create({
          name: `Almacén Principal - ${branch.name}`,
          type: 1,
          branch_id: branch.id,
          user_id: branch.user_id,
          address: branch.address || null
        }, null, transaction); // null = sin archivo
        logger.info(`Almacén principal creado para la sucursal ID ${branch.id}`);
      }
      const branches = await BranchRepository.findFiltered({
        companyId: branch.company_id,
        userId: branch.user_id
      });
      res.status(201).json({ message: "Sucursal creada correctamente", branches: branches });
    } catch (error) {
      const errorMsg = error.message || 'Error desconocido';
      logger.error('BranchController->store: ' + errorMsg);
      res.status(500).json({ error: 'ServerError', details: errorMsg });
    }
  },

  async show(req, res) {
    try {
      const branch = await BranchRepository.findById(req.body.id);
      if (!branch) return res.status(404).json({ msg: 'BranchNotFound' });

      const mapped = {
        id: branch.id,
        company_id: branch.company_id,
        user_id: branch.user_id,
        name: branch.name,
        address: branch.address,
        city: branch.city,
        phone: branch.phone,
        status: branch.status,
        image: branch.image,
      };
      res.status(200).json({ branch: mapped });
    } catch (error) {
      logger.error('BranchController->show: ' + error.message);
      res.status(500).json({ error: 'ServerError', details: error.message });
    }
  },

  async update(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Crea nueva sucursal ${req.body.id}`);
    logger.info('Datos recibidos:');
    logger.info(JSON.stringify(req.body));
    const { id , company_id, user_id} = req.body;
    const metadata = getRequestMetadata(req);
    try {
      const branch = await BranchRepository.findById(id);
      if (!branch) return res.status(404).json({ msg: 'BranchNotFound' });

        if (company_id) {
        const company = await CompanyRepository.findById(company_id);
            if (!company) {
            logger.error(
                `BranchController->update: Compañía no encontrada con ID ${company_id}`
            );
            return res.status(400).json({ msg: "companyNotFound" });
            }
        }
        if (user_id) {
            const user = await UserRepository.findById(user_id);
            if (!user) {
            logger.error(
                `BranchController->update: Usuario no encontrado con ID ${user_id}`
            );
            return res.status(400).json({ msg: "userNotFound" });
            }
        } 

        const originalData = { ...branch.get({ plain: true }) };

        const updated = await BranchRepository.update(branch, req.body, req.file);

        // ✅ Detectar cambios y crear UN SOLO log
    const fieldChanges = detectChanges(originalData, updated.get({ plain: true }), BRANCH_AUDIT_FIELDS);

    let logEntry;
    if (fieldChanges.length > 0) {
      logEntry = {
        user_id: metadata.user_id,
        action: 'branch.update',
        description: `Sucursal actualizada: ${fieldChanges.length} campo(s) modificados`,
        ip_address: metadata.ip_address,
        user_agent: metadata.user_agent,
        status: 'success',
        meta: { changes: fieldChanges }
      };
    } else {
      logEntry = {
        user_id: metadata.user_id,
        action: 'branch.update',
        description: `Actualización de sucursal ID ${branch.id} sin cambios`,
        ip_address: metadata.ip_address,
        user_agent: metadata.user_agent,
        status: 'success',
        meta: null
      };
    }

    await LogRepository.create(logEntry);
      const branches = await BranchRepository.findFiltered({
        companyId: branch.company_id,
        userId: branch.user_id
      });
      res.status(200).json({ message: "Sucursal actualizada correctamente", branches: branches });
    } catch (error) {
       await LogRepository.create({
      user_id: metadata?.user_id,
      action: 'branch.update',
      description: `Error al actualizar sucursal ID ${req.body?.id}: ${error.message}`,
      ip_address: metadata?.ip_address,
      user_agent: metadata?.user_agent,
      status: 'error',
      meta: null
    });
      logger.error('BranchController->update: ' + error.message);
      res.status(500).json({ error: 'ServerError', details: error.message });
    }
  },

  async destroy(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Elimina sucursal con ID ${req.body.id}`);
     const metadata = getRequestMetadata(req);
    try {
      const branch = await BranchRepository.findById(req.body.id);
      if (!branch) return res.status(404).json({ msg: 'BranchNotFound' });

       // ✅ Guardar datos antes de eliminar
    const branchData = branch.get({ plain: true });

      await BranchRepository.delete(branch);

      await LogRepository.create({
      user_id: metadata.user_id,
      action: 'branch.delete',
      description: `Sucursal eliminada: ID ${branchData.id}, nombre: "${branchData.name}"`,
      ip_address: metadata.ip_address,
      user_agent: metadata.user_agent,
      status: 'success',
      meta: { deleted_record: branchData }
    });
      const branches = await BranchRepository.findFiltered({
        companyId: branch.company_id,
        userId:branch.user_id
      });
      res.status(200).json({ message: "Sucursal eliminada correctamente", branches: branches });
    } catch (error) {
      await LogRepository.create({
      user_id: metadata?.user_id,
      action: 'branch.delete',
      description: `Error al eliminar sucursal ID ${req.body?.id}: ${error.message}`,
      ip_address: metadata?.ip_address,
      user_agent: metadata?.user_agent,
      status: 'error',
      meta: null
    });
      logger.error('BranchController->destroy: ' + error.message);
      res.status(500).json({ error: 'ServerError', details: error.message });
    }
  },
};

module.exports = BranchController;