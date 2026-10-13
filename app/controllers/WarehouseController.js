const logger = require('../../config/logger');
const { sequelize } = require('../models');
const { WarehouseRepository, CompanyRepository, UserRepository, BranchRepository, LogRepository, UserAclScopeRepository, UserCompanyRepository } = require('../repositories');
const { detectChanges } = require('../util/auditUtils');
const { getRequestMetadata } = require('../util/requestUtil');
const AuditEventService = require('../services/AuditEventService');

const WAREHOUSE_AUDIT_FIELDS = [
  'code', 'name', 'description', 'type', 'address', 'city', 
  'region', 'country', 'latitude', 'longitude', 'capacity_max_units',
  'allow_mermas', 'rotation_policy', 'status', 'company_id', 
  'branch_id', 'user_id'
];

function toPlain(record) {
  if (!record) return null;
  return typeof record.get === 'function' ? record.get({ plain: true }) : record;
}

function getWarehouseAuditLabel(warehouse) {
  const plain = toPlain(warehouse) || {};
  return [plain.code, plain.name].filter(Boolean).join(' / ') || 'Almacén sin nombre';
}

function buildWarehouseAuditPayload(warehouse, data = {}) {
  const plain = toPlain(warehouse) || {};
  const companyId = data.company_id || plain.company_id;
  return {
    company_id: companyId,
    module: 'warehouse',
    resource_type: 'warehouse',
    resource_id: plain.id,
    resource_label: getWarehouseAuditLabel(plain),
    warehouse_id: plain.id,
    branch_id: plain.branch_id,
    ...data
  };
}

async function resolveWarehouseCompanyId(warehouse, requestedCompanyId = null) {
  const plain = toPlain(warehouse) || {};
  const companyId = requestedCompanyId ?? plain.company_id;
  if (companyId !== undefined && companyId !== null && companyId !== '') {
    return Number(companyId);
  }

  if (plain.branch_id !== undefined && plain.branch_id !== null) {
    const branch = await BranchRepository.findById(plain.branch_id);
    if (branch?.company_id !== undefined && branch.company_id !== null) {
      return Number(branch.company_id);
    }
  }

  return null;
}

function changesToValueSnapshot(changes, valueKey) {
  return changes.reduce((snapshot, change) => {
    snapshot[change.field] = change[valueKey];
    return snapshot;
  }, {});
}

function parseWarehouseAccessUserIds(payload = {}) {
  const provided = Object.prototype.hasOwnProperty.call(payload, 'access_user_ids');
  if (!provided) return { provided: false, userIds: [] };

  let value = payload.access_user_ids;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch (error) {
      const invalid = new Error('La lista de usuarios con acceso debe ser un JSON válido');
      invalid.statusCode = 400;
      invalid.field = 'access_user_ids';
      throw invalid;
    }
  }

  if (!Array.isArray(value)) {
    const invalid = new Error('La lista de usuarios con acceso debe enviarse como un arreglo');
    invalid.statusCode = 400;
    invalid.field = 'access_user_ids';
    throw invalid;
  }

  const userIds = [...new Set(value.map(userId => Number(userId)))];
  if (userIds.some(userId => !Number.isInteger(userId) || userId <= 0)) {
    const invalid = new Error('La lista de usuarios con acceso contiene IDs inválidos');
    invalid.statusCode = 400;
    invalid.field = 'access_user_ids';
    throw invalid;
  }

  return { provided: true, userIds };
}

function sendWarehouseValidationError(res, error) {
  const message = error.message || 'La solicitud contiene datos inválidos';
  return res.status(error.statusCode || 400).json({
    success: false,
    msg: 'Solicitud inválida',
    message,
    details: [message],
    error_details: [{
      field: error.field || 'body',
      message,
      source: 'body'
    }]
  });
}

function normalizeAccessUserIds(userIds = []) {
  return [...new Set(
    (Array.isArray(userIds) ? userIds : [])
      .map(userId => Number(userId))
      .filter(userId => Number.isInteger(userId) && userId > 0)
  )].sort((left, right) => left - right);
}

function accessUsersChanged(previousSnapshot, currentSnapshot) {
  if (!previousSnapshot || !currentSnapshot) return false;

  return JSON.stringify(normalizeAccessUserIds(previousSnapshot.access_user_ids)) !==
    JSON.stringify(normalizeAccessUserIds(currentSnapshot.access_user_ids));
}

async function getWarehouseAccessAuditSnapshot(warehouseId, companyId) {
  try {
    const usersByWarehouseId = await UserAclScopeRepository.findActiveUsersByWarehouseIds(
      [warehouseId],
      companyId
    );
    const accessUsers = usersByWarehouseId.get(Number(warehouseId)) || [];

    return {
      access_user_ids: accessUsers.map(user => user.id),
      access_users: accessUsers
    };
  } catch (error) {
    logger.error(`[WarehouseController->audit access] ${error.message}`);
    return null;
  }
}

async function enrichWarehousesWithAccessUsers(warehouses = [], companyId) {
  // Mantener compatible cualquier consumidor que todavía no exponga el
  // enriquecimiento ACL; en la aplicación el repositorio sí lo implementa.
  if (typeof UserAclScopeRepository.findActiveUsersByWarehouseIds !== 'function') {
    return warehouses.map(warehouse => ({
      ...warehouse,
      access_user_ids: [],
      access_users: []
    }));
  }

  const usersByWarehouseId = await UserAclScopeRepository.findActiveUsersByWarehouseIds(
    warehouses.map(warehouse => warehouse.id),
    companyId
  );

  return warehouses.map((warehouse) => {
    const accessUsers = usersByWarehouseId.get(Number(warehouse.id)) || [];

    return {
      ...warehouse,
      access_user_ids: accessUsers.map(user => user.id),
      access_users: accessUsers
    };
  });
}

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
      const warehousesWithAccessUsers = await enrichWarehousesWithAccessUsers(mappedWarehouses, companyId);

      if (warehousesWithAccessUsers.length === 0) {
        return res.status(200).json({
          warehouses: [],
          total_company_warehouses: totalCompanyWarehouses,
          msg: 'NoWarehousesFound'
        });
      }

      res.status(200).json({
        warehouses: warehousesWithAccessUsers,
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
      const rawCompanyId = req.body?.company_id ??
        req.query?.company_id ??
        req.companyId ??
        req.user?.company_id;
      const companyId = rawCompanyId !== undefined && rawCompanyId !== null && rawCompanyId !== ''
        ? Number(rawCompanyId)
        : null;
      const users = Number.isInteger(companyId) && companyId > 0
        ? await UserCompanyRepository.findActiveUsersByCompanyId(companyId)
        : [];

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
          rotationPolicies: rotationPolicies,
          users
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
    let accessInput;

    try {
      accessInput = parseWarehouseAccessUserIds(req.body);
    } catch (error) {
      return sendWarehouseValidationError(res, error);
    }

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

    let transaction = null;
    try {
      transaction = accessInput.provided ? await sequelize.transaction() : null;
      const warehouse = await WarehouseRepository.create(req.body, req.file, transaction);
      const auditCompanyId = await resolveWarehouseCompanyId(warehouse, company_id);

      if (accessInput.provided) {
        await UserAclScopeRepository.syncWarehouseAccessUsers({
          warehouseId: warehouse.id,
          companyId: auditCompanyId,
          userIds: accessInput.userIds,
          transaction
        });
      }

      if (transaction) {
        await transaction.commit();
        transaction = null;
      }
      const accessSnapshot = await getWarehouseAccessAuditSnapshot(warehouse.id, auditCompanyId);

      await AuditEventService.safeRecordFromRequest(req, buildWarehouseAuditPayload(warehouse, {
        company_id: auditCompanyId,
        action: 'warehouse.created',
        result: 'success',
        new_value: {
          ...toPlain(warehouse),
          ...(accessSnapshot || { access_user_ids: [], access_users: [] })
        },
        description: `Almacen creado: ${warehouse.name}`,
        metadata: {
          source: 'manual',
          ...(accessSnapshot || { access_user_ids: [], access_users: [] })
        }
      }));
      
      // ✅ Devolver lista actualizada igual que el endpoint list
      const companyId = company_id ? Number(company_id) : undefined;
      const branchId = branch_id ? Number(branch_id) : undefined;
       const warehouses = await WarehouseRepository.findFiltered({
         companyId,
         branchId,
         include_products: true
       });
       const warehousesWithAccessUsers = await enrichWarehousesWithAccessUsers(
         warehouses,
         auditCompanyId
       );

       res.status(201).json({ message: "Almacén creado correctamente", warehouses: warehousesWithAccessUsers });
     } catch (error) {
       if (transaction && !transaction.finished) {
         await transaction.rollback();
       }
      logger.error('WarehouseController->store: ' + error.message);
      if (error.field) return sendWarehouseValidationError(res, error);
      res.status(error.statusCode || 500).json({
         success: false,
         error: error.statusCode ? error.message : 'ServerError',
         details: error.statusCode ? undefined : error.message
       });
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
    let accessInput;

    try {
      accessInput = parseWarehouseAccessUserIds(req.body);
    } catch (error) {
      return sendWarehouseValidationError(res, error);
    }

    let transaction = null;
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

      // El snapshot anterior debe usar la empresa actual del almacén. El
      // company_id recibido pertenece al estado nuevo y no debe contaminar la
      // comparación de permisos si la empresa también cambia.
      const existingCompanyId = await resolveWarehouseCompanyId(warehouse);
      const previousAccessSnapshot = accessInput.provided
        ? await getWarehouseAccessAuditSnapshot(warehouse.id, existingCompanyId)
        : null;

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
      transaction = accessInput.provided ? await sequelize.transaction() : null;
      const updated = await WarehouseRepository.update(warehouse, req.body, req.file, transaction);
      if (accessInput.provided) {
        const updatedCompanyId = await resolveWarehouseCompanyId(updated, company_id);
        await UserAclScopeRepository.syncWarehouseAccessUsers({
          warehouseId: updated.id,
          companyId: updatedCompanyId,
          userIds: accessInput.userIds,
          transaction
        });
      }
      if (transaction) {
        await transaction.commit();
        transaction = null;
      }
      const updatedData = updated.get({ plain: true });
      const auditCompanyId = await resolveWarehouseCompanyId(updatedData, company_id);
      const currentAccessSnapshot = accessInput.provided
        ? await getWarehouseAccessAuditSnapshot(updated.id, auditCompanyId)
        : null;

      // ✅ Detectar cambios y crear UN SOLO log
      const fieldChanges = detectChanges(originalData, updatedData, WAREHOUSE_AUDIT_FIELDS);
      const accessUserChanges = accessUsersChanged(previousAccessSnapshot, currentAccessSnapshot)
        ? [{
            field: 'access_users',
            old_value: previousAccessSnapshot.access_users,
            new_value: currentAccessSnapshot.access_users
          }]
        : [];
      const allChanges = [...fieldChanges, ...accessUserChanges];

      await AuditEventService.safeRecordFromRequest(req, buildWarehouseAuditPayload(updated, {
        company_id: auditCompanyId,
        action: 'warehouse.updated',
        result: 'success',
        previous_value: changesToValueSnapshot(allChanges, 'old_value'),
        new_value: changesToValueSnapshot(allChanges, 'new_value'),
        changes: allChanges,
        description: allChanges.length > 0
          ? `Almacen actualizado: ${allChanges.length} campo(s) modificado(s)`
          : `Actualizacion de almacen sin cambios: ${updated.name}`,
        metadata: {
          image_updated: Boolean(req.file),
          ...(accessUserChanges.length > 0
            ? {
                previous_access_user_ids: previousAccessSnapshot.access_user_ids,
                access_user_ids: currentAccessSnapshot.access_user_ids,
                previous_access_users: previousAccessSnapshot.access_users,
                access_users: currentAccessSnapshot.access_users
              }
            : {})
        }
      }));

      let logEntry;
      if (allChanges.length > 0) {
        logEntry = {
          user_id: metadata.user_id,
          action: 'warehouse.update',
          description: `Almacén actualizado: ${allChanges.length} campo(s) modificados`,
          ip_address: metadata.ip_address,
          user_agent: metadata.user_agent,
          status: 'success',
          meta: { changes: allChanges }
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
      const warehousesWithAccessUsers = await enrichWarehousesWithAccessUsers(
        warehouses,
        auditCompanyId
      );
      
      res.status(200).json({ message: "Almacén actualizado correctamente", warehouses: warehousesWithAccessUsers });
    } catch (error) {
      if (transaction && !transaction.finished) {
        await transaction.rollback();
      }
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
      if (error.field) return sendWarehouseValidationError(res, error);
      res.status(error.statusCode || 500).json({
        success: false,
        error: error.statusCode ? error.message : 'ServerError',
        details: error.statusCode ? undefined : error.message
      });
    }
  },

  async destroy(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - elimina un almacén ${req.body.id}`);
    logger.info('Datos recibidos:');
    logger.info(JSON.stringify(req.body));
    try {
      const warehouse = await WarehouseRepository.findById(req.body.id);
      if (!warehouse) return res.status(404).json({ msg: 'WarehouseNotFound' });
      const warehouseBeforeDelete = toPlain(warehouse);
      const auditCompanyId = await resolveWarehouseCompanyId(warehouseBeforeDelete);

      await WarehouseRepository.delete(warehouse);
      await AuditEventService.safeRecordFromRequest(req, buildWarehouseAuditPayload(warehouseBeforeDelete, {
        company_id: auditCompanyId,
        action: 'warehouse.deleted',
        result: 'success',
        previous_value: warehouseBeforeDelete,
        description: `Almacen eliminado: ${warehouseBeforeDelete.name}`
      }));
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
      const auditCompanyId = await resolveWarehouseCompanyId(warehouse);

      await AuditEventService.safeRecordFromRequest(req, buildWarehouseAuditPayload(warehouse, {
        company_id: auditCompanyId,
        action: 'warehouse.status_changed',
        result: 'success',
        previous_value: { status: originalData.status },
        new_value: { status: newStatus },
        changes: [{
          field: 'status',
          old_value: originalData.status,
          new_value: newStatus
        }],
        description: `Estado de almacen cambiado de ${originalData.status} a ${newStatus}`
      }));
      
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
