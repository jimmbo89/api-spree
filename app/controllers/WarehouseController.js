const logger = require('../../config/logger');
const { WarehouseRepository, CompanyRepository, UserRepository, BranchRepository, LogRepository, UserAclScopeRepository } = require('../repositories');
const { detectChanges } = require('../util/auditUtils');
const { getRequestMetadata } = require('../util/requestUtil');

const WAREHOUSE_AUDIT_FIELDS = [
  'code', 'name', 'description', 'type', 'address', 'city', 
  'region', 'country', 'latitude', 'longitude', 'capacity_max_units',
  'allow_mermas', 'rotation_policy', 'status', 'company_id', 
  'branch_id', 'user_id'
];

const WarehouseController = {
  async list(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Lista almacenes`);

    const { company_id, branch_id, user_id, status, type, include_products = true } = req.body;
    const roleName = (req.membership?.role?.name || req.user?.role?.name || req.user?.role_name || '').trim();
    const normalizedRole = roleName.toLowerCase();
    const privilegedRoles = new Set(['admin', 'backoffice', 'seller manager']);

    // Parsear IDs
    const companyId = company_id ? Number(company_id) : (req.companyId ? Number(req.companyId) : (req.user?.company_id ? Number(req.user.company_id) : undefined));
    const branchId = branch_id ? Number(branch_id) : undefined;
    const userId = user_id ? Number(user_id) : undefined;

    if (!companyId) {
      return res.status(400).json({ msg: "company_id es obligatorio" });
    }

    if (companyId) {
      const company = await CompanyRepository.findById(companyId);
      if (!company) {
        logger.info(`WarehouseController->list: Compañía no encontrada con ID ${companyId}`);
        return res.status(400).json({ msg: "companyNotFound" });
      }
    }
    
    if (user_id) {
      const user = await UserRepository.findById(user_id);
      if (!user) {
        logger.info(`WarehouseController->list: Usuario no encontrado con ID ${user_id}`);
        return res.status(400).json({ msg: "userNotFound" });
      }
    }

    if (branch_id) {
      const branch = await BranchRepository.findById(branch_id);
      if (!branch) {
        logger.info(`WarehouseController->list: Sucursal no encontrado con ID ${branch_id}`);
        return res.status(400).json({ msg: "BranchNotFound" });
      }
    }

    try {
      const totalCompanyWarehouses = await WarehouseRepository.countByCompanyId(companyId);
      const isPrivileged = privilegedRoles.has(normalizedRole);
      const warehouseIds = isPrivileged
        ? null
        : (await UserAclScopeRepository.findByUserAndCompany(req.user.id, companyId))
            .filter((scope) => scope.warehouse_id)
            .map((scope) => Number(scope.warehouse_id))
            .filter((warehouseId) => Number.isFinite(warehouseId));

      const mappedWarehouses = await WarehouseRepository.findFiltered({
        companyId,
        branchId,
        userId,
        warehouseIds,
        status,
        type,
        include_products
      });

      if (mappedWarehouses.length === 0) {
        return res.status(200).json({
          warehouses: [],
          total_company_warehouses: totalCompanyWarehouses,
          msg: 'NoWarehousesFound'
        });
      }

      res.status(200).json({
        warehouses: mappedWarehouses,
        total_company_warehouses: totalCompanyWarehouses
      });
    } catch (error) {
      logger.error('WarehouseController->list: ' + error.message);
      res.status(500).json({ error: 'ServerError', details: error.message });
    }
  },

  async getWarehouseMetadata(req, res) {
    const userName = req.user?.name || 'Anonymous';
    logger.info(`${userName} - Solicita metadata de almacenes`);

    try {
      // 1. Tipos de almacén (configuración fija)
      const warehouseTypes = [
        { id: "central", name: "Central" },
        { id: "tienda", name: "Tienda" },
        { id: "frio", name: "Frío/Refrigerado" },
        { id: "inflamable", name: "Inflamable" },
        { id: "externo", name: "Externo" }
      ];

      // 2. Estados de almacén (configuración fija)
      const warehouseStatus = [
        { id: "activo", name: "Activo" },
        { id: "inactivo", name: "Inactivo" }
      ];

      // 3. Políticas de rotación (configuración fija)
      const rotationPolicies = [
        { id: "FIFO", name: "FIFO (Primero en entrar, primero en salir)" },
        { id: "LIFO", name: "LIFO (Último en entrar, primero en salir)" },
        { id: "FEFO", name: "FEFO (Primero en vencer, primero en salir)" }
      ];

      // 4. Obtener compañías activas (opcional, si las necesitas para el formulario)
      /*let companies = [];
      try {
        const companyResult = await CompanyRepository.findActive();
        companies = companyResult.map(company => ({
          id: company.id,
          name: company.name || 'Sin nombre'
        }));
      } catch (error) {
        logger.warn('Error al cargar compañías para metadata de almacenes:', error.message);
        // En caso de error, devolver array vacío
        companies = [];
      }

      // 5. Obtener sucursales activas (opcional, si las necesitas para el formulario)
      let branches = [];
      try {
        const branchResult = await BranchRepository.findActive();
        branches = branchResult.map(branch => ({
          id: branch.id,
          name: branch.name || 'Sin nombre'
        }));
      } catch (error) {
        logger.warn('Error al cargar sucursales para metadata de almacenes:', error.message);
        // En caso de error, devolver array vacío
        branches = [];
      }*/

      return res.status(200).json({
          warehouseTypes: warehouseTypes,
          warehouseStatus: warehouseStatus,
          rotationPolicies: rotationPolicies
      });

    } catch (err) {
      logger.error("WarehouseController->getWarehouseMetadata: " + err.message);
      return res.status(500).json({ 
        success: false,
        error: "ServerError", 
        message: err.message 
      });
    }
  },

  async store(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Crea nuevo almacén`);
    logger.info('Datos recibidos:');
    logger.info(JSON.stringify(req.body));

    const { company_id, user_id: bodyUserId, branch_id, name, code } = req.body;
    let user_id = bodyUserId || req.user.id;
    req.body.user_id = user_id;

    if (company_id) {
      const company = await CompanyRepository.findById(company_id);
      if (!company) {
        logger.info(`WarehouseController->store: Compañía no encontrada con ID ${company_id}`);
        return res.status(404).json({ success: false, message: "Compañía encontrada" });
      }
    }

    if (user_id) {
      const user = await UserRepository.findById(user_id);
      if (!user) {
        logger.info(`WarehouseController->store: Usuario no encontrado con ID ${user_id}`);
        return res.status(404).json({ success: false, message: "Usuario no encontrado" });
      }
    }

    if (branch_id) {
      const branch = await BranchRepository.findById(branch_id);
      if (!branch) {
        logger.info(`WarehouseController->store: Sucursal no encontrado con ID ${branch_id}`);
        return res.status(404).json({ success: false, message: "Sucursal no encontrada" });
      }
    }
    const validation = await WarehouseRepository.checkUniqueName({
      name: name,
      company_id: company_id,
      branch_id: branch_id,
      code: code
    });
    
    if (validation.exists) {
      const field = validation.field === 'name' ? 'nombre' : 'código';
      return res.status(409).json({
        success: false,
        message: `Ya existe un almacén con ese ${field}.`,
        code: "EXIT_WAREHOUSE"
      });
    }

    try {
      const warehouse = await WarehouseRepository.create(req.body, req.file);
      
      // ✅ Devolver lista actualizada igual que el endpoint list
      const companyId = company_id ? Number(company_id) : undefined;
      const branchId = branch_id ? Number(branch_id) : undefined;
      const warehouses = await WarehouseRepository.findFiltered({
        companyId,
        branchId,
        include_products: true
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
        code: warehouse.code,
        user_id: warehouse.user_id,
        company_id: warehouse.company_id,
        branch_id: warehouse.branch_id,
        name: warehouse.name,
        description: warehouse.description,
        type: warehouse.type,
        address: warehouse.address,
        city: warehouse.city,
        region: warehouse.region,
        country: warehouse.country,
        latitude: warehouse.latitude,
        longitude: warehouse.longitude,
        capacity_max_units: warehouse.capacity_max_units,
        allow_mermas: warehouse.allow_mermas,
        rotation_policy: warehouse.rotation_policy,
        status: warehouse.status,
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

    const { id, company_id, user_id, branch_id, name, code } = req.body;
    const metadata = getRequestMetadata(req);

    try {
      const warehouse = await WarehouseRepository.findById(id);
      if (!warehouse) return res.status(404).json({ success: false, message: 'Alamcén no encontrado' });

      if (company_id) {
        const company = await CompanyRepository.findById(company_id);
        if (!company) {
          logger.info(`WarehouseController->update: Compañía no encontrada con ID ${company_id}`);
          return res.status(404).json({ success: false, message: "Compañía encontrada" });
        }
      }

      if (user_id) {
        const user = await UserRepository.findById(user_id);
        if (!user) {
          logger.info(`WarehouseController->update: Usuario no encontrado con ID ${user_id}`);
          return res.status(404).json({ success: false, message: "Usuario no encontrado" });
        }
      }

      if (branch_id) {
        const branch = await BranchRepository.findById(branch_id);
        if (!branch) {
          logger.info(`WarehouseController->update: Sucursal no encontrado con ID ${branch_id}`);
          return res.status(404).json({ success: false, message: "Sucursal no encontrada" });
        }
      }

      // ✅ Validar unicidad de nombre y código
      if (name !== undefined || code !== undefined) {
        const validation = await WarehouseRepository.checkUniqueName({
          name: name,
          company_id: warehouse.company_id,
          branch_id: warehouse.branch_id,
          code: code
        }, id);

        if (validation.exists) {
          const field = validation.field === 'name' ? 'nombre' : 'código';
          return res.status(409).json({
            success: false,
            message: `Ya existe un almacén con ese ${field}.`,
            code: 'EXIT_WAREHOUSE'
          });
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
      
      // ✅ Devolver lista actualizada igual que el endpoint list
      const finalCompanyId = company_id || updated.company_id;
      const finalBranchId = branch_id || updated.branch_id;
      const companyId = finalCompanyId ? Number(finalCompanyId) : undefined;
      const branchId = finalBranchId ? Number(finalBranchId) : undefined;
      const warehouses = await WarehouseRepository.findFiltered({
        companyId,
        branchId,
        include_products: true
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

  async toggleStatus(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - cambia estado almacén ${req.body.id}`);
    const metadata = getRequestMetadata(req);
    
    try {
      const warehouse = await WarehouseRepository.findById(req.body.id);
      if (!warehouse) return res.status(404).json({ msg: 'WarehouseNotFound' });

      const newStatus = warehouse.status === 'activo' ? 'inactivo' : 'activo';
      const originalData = { ...warehouse.get({ plain: true }) };
      
      await warehouse.update({ status: newStatus });
      
      // Log de auditoría
      await LogRepository.create({
        user_id: metadata.user_id,
        action: 'warehouse.toggleStatus',
        description: `Estado de almacén cambiado de ${originalData.status} a ${newStatus}`,
        ip_address: metadata.ip_address,
        user_agent: metadata.user_agent,
        status: 'success',
        meta: { 
          warehouse_id: warehouse.id,
          previous_status: originalData.status,
          new_status: newStatus
        }
      });

      const warehouses = await WarehouseRepository.findFiltered({
        companyId: warehouse.company_id,
        branchId: warehouse.branch_id,
      });
      
      res.status(200).json({ 
        message: "Estado de almacén actualizado correctamente", 
        warehouses 
      });
    } catch (error) {
      logger.error('WarehouseController->toggleStatus: ' + error.message);
      res.status(500).json({ error: 'ServerError', details: error.message });
    }
  }
};

module.exports = WarehouseController;
