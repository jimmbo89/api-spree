const logger = require('../../config/logger');
const { WarehouseRepository, CompanyRepository, UserRepository, BranchRepository, LogRepository } = require('../repositories');
const { detectChanges } = require('../util/auditUtils');
const { getRequestMetadata } = require('../util/requestUtil');

const WAREHOUSE_AUDIT_FIELDS = ['name', 'type', 'address', 'company_id', 'branch_id', 'user_id'];

const WarehouseController = {
  // ✅ Endpoint flexible: /api/warehouses/list
  async list(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Lista almacenes`);

    const { company_id, branch_id, user_id } = req.body;

   // Parsear IDs
    const companyId = company_id ? Number(company_id) : undefined;
    const branchId = branch_id ? Number(branch_id) : undefined;
    const userId = user_id ? Number(user_id) : undefined;

     if (company_id) {
        const company = await CompanyRepository.findById(company_id);
        if (!company) {
          logger.info(
            `BranchController->list: Compañía no encontrada con ID ${company_id}`
          );
          return res.status(400).json({ msg: "companyNotFound" });
        }
      }
     if (user_id) {
        const user = await UserRepository.findById(user_id);
        if (!user) {
          logger.info(
            `BranchController->list: Compañía no editada con ID ${user_id}`
          );
          return res.status(400).json({ msg: "userNotFound" });
        }
      }

      if (branch_id) {
        const branch = await BranchRepository.findById(branch_id);
        if (!branch) {
          logger.info(
            `WarehouseController->list: Sucursal no encontrado con ID ${branch_id}`
          );
          return res.status(400).json({ msg: "BranchNotFound" });
        }
      }

    try {
      const mappedWarehouses = await WarehouseRepository.findFiltered({
        companyId,
        branchId,
        userId
      });

      if (mappedWarehouses.length === 0) {
        return res.status(200).json({ warehouses: [], msg: 'NoWarehousesFound' });
      }

      res.status(200).json({ warehouses: mappedWarehouses });
    } catch (error) {
      logger.error('WarehouseController->list: ' + error.message);
      res.status(500).json({ error: 'ServerError', details: error.message });
    }
  },

  // CRUD estándar (store, show, update, destroy) — mismo estilo que Branch
  async store(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Crea nuevo almacén`);
    logger.info('Datos recibidos:');
    logger.info(JSON.stringify(req.body));
    const { company_id, user_id:bodyUserId, branch_id } = req.body;

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
            `BranchController->store: Compañía no editada con ID ${user_id}`
          );
          return res.status(400).json({ msg: "userNotFound" });
        }
      }

      if (branch_id) {
        const branch = await BranchRepository.findById(branch_id);
        if (!branch) {
          logger.info(
            `WarehouseController->store: Sucursal no encontrado con ID ${branch_id}`
          );
          return res.status(400).json({ msg: "BranchNotFound" });
        }
      }

    try {
      const warehouse = await WarehouseRepository.create(req.body, req.file);
      const warehouses = await WarehouseRepository.findFiltered({
        companyId: warehouse.company_id,
        branchId: warehouse.branch_id,
      });
      res.status(201).json({ message: "Almacén creado correctamente", warehouses });
    } catch (error) {
      logger.error('WarehouseController->store: ' + error.message);
      res.status(500).json({ error: 'ServerError', details: error.message });
    }
  },

  async show(req, res) {
    try {
      const warehouse = await WarehouseRepository.findById(req.body.id);
      if (!warehouse) return res.status(404).json({ msg: 'WarehouseNotFound' });

      const mapped = {
        id: warehouse.id,
        user_id: warehouse.user_id,
        company_id: warehouse.company_id,
        branch_id: warehouse.branch_id,
        name: warehouse.name,
        type: warehouse.type,
        address: warehouse.address,
        image: warehouse.image,
      };
      res.status(200).json({ warehouse: mapped });
    } catch (error) {
      logger.error('WarehouseController->show: ' + error.message);
      res.status(500).json({ error: 'ServerError', details: error.message });
    }
  },

  async update(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - edita un almacén ${req.body.id}`);
    logger.info('Datos recibidos:');
    logger.info(JSON.stringify(req.body));
     const { company_id, user_id, branch_id } = req.body;
     const metadata = getRequestMetadata(req);
    try {
      const warehouse = await WarehouseRepository.findById(req.body.id);
      if (!warehouse) return res.status(404).json({ msg: 'WarehouseNotFound' });
        if (company_id) {
        const company = await CompanyRepository.findById(company_id);
        if (!company) {
          logger.info(
            `BranchController->update: Compañía no encontrada con ID ${company_id}`
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

      if (branch_id) {
        const branch = await BranchRepository.findById(branch_id);
        if (!branch) {
          logger.info(
            `WarehouseController->update: Sucursal no encontrado con ID ${branch_id}`
          );
          return res.status(400).json({ msg: "BranchNotFound" });
        }
      }

      const originalData = { ...warehouse.get({ plain: true }) };
      const updated = await WarehouseRepository.update(warehouse, req.body, req.file);
       // ✅ Detectar cambios y crear UN SOLO log
    const fieldChanges = detectChanges(originalData, updated.get({ plain: true }), WAREHOUSE_AUDIT_FIELDS);

    let logEntry;
    if (fieldChanges.length > 0) {
      logEntry = {
        user_id: metadata.user_id,
        action: 'warehouse.update',
        description: `Almacén actualizado: ${fieldChanges.length} campo(s) modificados`,
        ip_address: metadata.ip_address,
        user_agent: metadata.user_agent,
        status: 'success',
        meta: { changes: fieldChanges }
      };
    } else {
      logEntry = {
        user_id: metadata.user_id,
        action: 'warehouse.update',
        description: `Actualización de almacén ID ${warehouse.id} sin cambios`,
        ip_address: metadata.ip_address,
        user_agent: metadata.user_agent,
        status: 'success',
        meta: null
      };
    }

    await LogRepository.create(logEntry);
      const warehouses = await WarehouseRepository.findFiltered({
        companyId: updated.company_id,
        branchId: updated.branch_id,
      });
      res.status(200).json({ message: "Almacén actualizado correctamente", warehouses });
    } catch (error) {
         await LogRepository.create({
      user_id: metadata?.user_id,
      action: 'warehouse.update',
      description: `Error al actualizar almacén ID ${req.body?.id}: ${error.message}`,
      ip_address: metadata?.ip_address,
      user_agent: metadata?.user_agent,
      status: 'error',
      meta: null
    });
      logger.error('WarehouseController->update: ' + error.message);
      res.status(500).json({ error: 'ServerError', details: error.message });
    }
  },

  async destroy(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - elimina un almacén ${req.body.id}`);
    logger.info('Datos recibidos:');
    logger.info(JSON.stringify(req.body));
    try {
      const warehouse = await WarehouseRepository.findById(req.body.id);
      if (!warehouse) return res.status(404).json({ msg: 'WarehouseNotFound' });

      await WarehouseRepository.delete(warehouse);
      const warehouses = await WarehouseRepository.findFiltered({
        companyId: warehouse.company_id,
        branchId: warehouse.branch_id,
        userId: warehouse.user_id
      });
      res.status(200).json({ message: "Almacén eliminado correctamente", warehouses });
    } catch (error) {
      logger.error('WarehouseController->destroy: ' + error.message);
      res.status(500).json({ error: 'ServerError', details: error.message });
    }
  },
};

module.exports = WarehouseController;