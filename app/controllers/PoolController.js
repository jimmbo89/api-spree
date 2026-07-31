// controllers/PoolController.js
const logger = require("../../config/logger");
const {
  PoolRepository,
  PoolWarehouseRepository,
  CompanyRepository,
  UserAclScopeRepository,
  UserRepository,
  WarehouseRepository,
  LogRepository
} = require("../repositories");
const { sequelize } = require("../models");
const { getRequestMetadata } = require("../util/requestUtil");

// Campos auditables
const POOL_AUDIT_FIELDS = [
  "name",
  "description",
  "company_id",
  "user_id",
  "is_active"
];

const PoolController = {
  async list(req, res) {
    logger.info(`${req.user?.name || "Unknown"} - Lista pools`);
    const { company_id, is_active } = req.body;
    const roleName = (req.membership?.role?.name || req.user?.role?.name || req.user?.role_name || "").trim();
    const normalizedRole = roleName.toLowerCase();
    const privilegedRoles = new Set(["admin", "backoffice", "seller manager"]);
    const companyId = company_id || req.companyId || req.user?.company_id || null;

    if (!companyId) {
      return res.status(400).json({
        success: false,
        msg: "company_id es obligatorio"
      });
    }

    // Validaciones
    const company = await CompanyRepository.findById(companyId);
    if (!company) return res.status(400).json({ success: false, msg: "companyNotFound" });
    try {
      const totalCompanyPools = await PoolRepository.countByCompanyId(companyId);
      const isPrivileged = privilegedRoles.has(normalizedRole);
      const filters = {
        companyId,
        isActive: is_active
      };

      if (isPrivileged) {
        const pools = await PoolRepository.findFiltered(filters);

        return res.status(200).json({
          success: true,
          pools: pools.length ? pools : [],
          total_company_pools: totalCompanyPools,
          message: pools.length ? "Pools encontrados" : "NoPoolsFound"
        });
      }

      const aclScopes = await UserAclScopeRepository.findByUserAndCompany(req.user.id, companyId);
      const allowedPoolIds = [...new Set(
        aclScopes
          .filter((scope) => scope.pool_id)
          .map((scope) => Number(scope.pool_id))
          .filter((poolId) => Number.isFinite(poolId))
      )];

      const pools = await PoolRepository.findFiltered({
        ...filters,
        poolIds: allowedPoolIds
      });

      return res.status(200).json({
        success: true,
        pools: pools.length ? pools : [],
        total_company_pools: totalCompanyPools,
        message: pools.length ? "Pools encontrados" : "NoPoolsFound"
      });
    } catch (error) {
      logger.error("PoolController->list: " + error.message);
      return res.status(500).json({ 
        success: false, 
        error: "ServerError", 
        details: error.message 
      });
    }
  },

  async store(req, res) {
    logger.info(`${req.user?.name || "Unknown"} - Crea nuevo pool`);
    logger.info("Datos recibidos:");
    logger.info(JSON.stringify(req.body));

    const { company_id, user_id: bodyUserId, warehouses, source } = req.body;
    const user_id = bodyUserId || req.user.id;
    const shouldAssignAclScopes = source === "publication_flow";
    req.body.user_id = user_id;

    // Validar company_id
    if (!company_id) {
      return res.status(400).json({
        success: false,
        msg: "company_id es obligatorio"
      });
    }

    const company = await CompanyRepository.findById(company_id);
    if (!company) {
      return res.status(400).json({
        success: false,
        msg: "companyNotFound"
      });
    }

    // Validar nombre único por empresa
    if (await PoolRepository.existsByName(req.body.name, company_id)) {
      return res.status(400).json({
        success: false,
        msg: "Ya existe un pool con ese nombre en esta empresa"
      });
    }

    // Validar que hay al menos un almacén
    if (!warehouses || !Array.isArray(warehouses) || warehouses.length === 0) {
      return res.status(400).json({
        success: false,
        msg: "Debe especificar al menos un almacén"
      });
    }

    // Validar que los almacenes existan y pertenezcan a la empresa
    const warehouseIds = warehouses.map(w => w.warehouse_id);
    const validation = await PoolWarehouseRepository.validateWarehousesExist(warehouseIds, company_id);
    
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        msg: `Almacenes no encontrados o no pertenecen a la empresa: ${validation.missingIds.join(', ')}`
      });
    }

    // Validar que solo haya un principal
    const primaryCount = warehouses.filter(w => w.is_primary).length;
    if (primaryCount > 1) {
      return res.status(400).json({
        success: false,
        msg: "Solo puede haber un almacén principal por pool"
      });
    }

    // Si no hay principal, marcar el primero
     if (primaryCount === 0) {
        // Asegurar que solo el primero con position 1 se marque
        const firstWithPos1 = warehouses.find(w => w.position === 1);
        if (firstWithPos1) {
            // Desmarcar cualquier otro que pudiera tener is_primary (por seguridad)
            warehouses.forEach(w => w.is_primary = false);
            firstWithPos1.is_primary = true;
        }
        }

    let transaction;
    try {
      transaction = await sequelize.transaction();

      // 1. Crear pool
      const pool = await PoolRepository.create(req.body, { transaction });

      // 2. Asociar almacenes
      for (let i = 0; i < warehouses.length; i++) {
        const warehouseData = warehouses[i];
        await PoolWarehouseRepository.create(
          pool.id,
          warehouseData.warehouse_id,
          {
            is_primary: warehouseData.is_primary,
            position: warehouseData.position || i
          },
          { transaction }
        );
      }

      if (shouldAssignAclScopes) {
        const aclScopes = await UserAclScopeRepository.findByUserAndCompany(user_id, company_id);
        const existingPoolIds = new Set(
          aclScopes
            .filter((scope) => scope.pool_id)
            .map((scope) => Number(scope.pool_id))
            .filter((poolId) => Number.isFinite(poolId))
        );
        const existingWarehouseIds = new Set(
          aclScopes
            .filter((scope) => scope.warehouse_id)
            .map((scope) => Number(scope.warehouse_id))
            .filter((warehouseId) => Number.isFinite(warehouseId))
        );
        const aclScopesToCreate = [];

        if (!existingPoolIds.has(Number(pool.id))) {
          aclScopesToCreate.push({ user_id, company_id, pool_id: pool.id });
        }

        warehouses.forEach((warehouseData) => {
          const warehouseId = Number(warehouseData.warehouse_id);
          if (Number.isFinite(warehouseId) && !existingWarehouseIds.has(warehouseId)) {
            aclScopesToCreate.push({ user_id, company_id, warehouse_id: warehouseId });
          }
        });

        if (aclScopesToCreate.length > 0) {
          await UserAclScopeRepository.bulkCreate(aclScopesToCreate, transaction);
        }
      }

      await transaction.commit();

      // 3. Obtener pool completo con almacenes
      const poolWithWarehouses = await PoolRepository.findById(pool.id);

      logger.info(`Pool ${pool.name} creado exitosamente con ID: ${pool.id}`);

      // 4. Obtener pools actualizados
      let pools;
      if (shouldAssignAclScopes) {
        const aclScopes = await UserAclScopeRepository.findByUserAndCompany(user_id, company_id);
        const allowedPoolIds = [...new Set(
          aclScopes
            .filter((scope) => scope.pool_id)
            .map((scope) => Number(scope.pool_id))
            .filter((poolId) => Number.isFinite(poolId))
        )];
        const allowedWarehouseIds = [...new Set(
          aclScopes
            .filter((scope) => scope.warehouse_id)
            .map((scope) => Number(scope.warehouse_id))
            .filter((warehouseId) => Number.isFinite(warehouseId))
        )];

        pools = await PoolRepository.findFiltered({
          companyId: company_id,
          userId: user_id,
          isActive: 1,
          poolIds: allowedPoolIds,
          warehouseIds: allowedWarehouseIds
        });
      } else {
        pools = await PoolRepository.findFiltered({
          companyId: company_id,
          userId: user_id,
          isActive: 1
        });
      }

      return res.status(201).json({
        success: true,
        message: "Pool creado correctamente",
        data: poolWithWarehouses,
        pools
      });

    } catch (error) {
      if (transaction) await transaction.rollback();
      logger.error("PoolController->store - Error: " + error.message);
      logger.error("Stack: " + error.stack);
      return res.status(500).json({
        success: false,
        error: "ServerError",
        details: error.message
      });
    }
  },

  async show(req, res) {
    try {
      const pool = await PoolRepository.findById(req.body.id);
      if (!pool) {
        return res.status(404).json({ 
          success: false,
          msg: "PoolNotFound" 
        });
      }

      return res.status(200).json({
        success: true,
        pool
      });
    } catch (error) {
      logger.error("PoolController->show: " + error.message);
      return res.status(500).json({ 
        success: false,
        error: "ServerError", 
        details: error.message 
      });
    }
  },

  async update(req, res) {
    logger.info(`${req.user?.name || "Unknown"} - Actualiza pool ${req.body.id}`);
    logger.info("Datos recibidos:");
    logger.info(JSON.stringify(req.body));

    const { id, warehouses, userId : bodyUserId } = req.body;
     const user_id = bodyUserId || req.user.id;
    const metadata = getRequestMetadata(req);

    try {
      const pool = await PoolRepository.findById(id, true);
      if (!pool) {
        return res.status(404).json({ 
          success: false, 
          msg: "PoolNotFound" 
        });
      }

      // Validar nombre único si se está cambiando
      if (req.body.name && req.body.name !== pool.name) {
        if (await PoolRepository.existsByName(req.body.name, pool.company_id, pool.id)) {
          return res.status(400).json({
            success: false,
            msg: "Ya existe un pool con ese nombre en esta empresa"
          });
        }
      }

      // Validar relaciones
      if (req.body.company_id) {
        const company = await CompanyRepository.findById(req.body.company_id);
        if (!company) {
          return res.status(400).json({ 
            success: false, 
            msg: "companyNotFound" 
          });
        }
      }
      // Si se envían warehouses, validarlos
      if (warehouses && Array.isArray(warehouses)) {
        // Validar que hay al menos un almacén
        if (warehouses.length === 0) {
          return res.status(400).json({
            success: false,
            msg: "Debe especificar al menos un almacén"
          });
        }

        // Validar que los almacenes existan y pertenezcan a la empresa
        const warehouseIds = warehouses.map(w => w.warehouse_id);
        const validation = await PoolWarehouseRepository.validateWarehousesExist(warehouseIds, pool.company_id);
        
        if (!validation.valid) {
          return res.status(400).json({
            success: false,
            msg: `Almacenes no encontrados o no pertenecen a la empresa: ${validation.missingIds.join(', ')}`
          });
        }

        // Validar que solo haya un principal
        const primaryCount = warehouses.filter(w => w.is_primary).length;
        if (primaryCount > 1) {
          return res.status(400).json({
            success: false,
            msg: "Solo puede haber un almacén principal por pool"
          });
        }

        // Si no hay principal, marcar el primero
       if (primaryCount === 0) {
        // Asegurar que solo el primero con position 1 se marque
        const firstWithPos1 = warehouses.find(w => w.position === 1);
        if (firstWithPos1) {
            // Desmarcar cualquier otro que pudiera tener is_primary (por seguridad)
            warehouses.forEach(w => w.is_primary = false);
            firstWithPos1.is_primary = true;
        }
        }
      }
      let transaction;
      try {
        transaction = await sequelize.transaction();

        // 1. Actualizar datos básicos del pool
        const updated = await PoolRepository.update(pool, req.body, { transaction });

        // 2. Si se proporcionan warehouses, sincronizar asociaciones
        if (warehouses && Array.isArray(warehouses)) {
          // Obtener asociaciones actuales
          const currentAssociations = await PoolWarehouseRepository.findByPoolId(pool.id);
          const currentWarehouseIds = currentAssociations.map(a => a.warehouse_id);
          const newWarehouseIds = warehouses.map(w => w.warehouse_id);
            
          // Identificar warehouses a eliminar (están actualmente pero no en el nuevo array)
          const warehousesToRemove = currentWarehouseIds.filter(id => !newWarehouseIds.includes(id));
          
          // Identificar warehouses a agregar (están en el nuevo array pero no actualmente)
          const warehousesToAdd = warehouses.filter(w => !currentWarehouseIds.includes(w.warehouse_id));
          
          // Identificar warehouses a actualizar (están en ambos arrays)
          const warehousesToUpdate = warehouses.filter(w => currentWarehouseIds.includes(w.warehouse_id));

          // a) Eliminar warehouses que ya no están
          
          for (const warehouseId of warehousesToRemove) {
            await PoolWarehouseRepository.deleteByPoolAndWarehouse(pool.id, warehouseId, { transaction });
          }
          // b) Agregar nuevos warehouses
          for (const warehouseData of warehousesToAdd) {
            
          logger.info('antes de crear en editar');
            await PoolWarehouseRepository.create(
              pool.id,
              warehouseData.warehouse_id,
              {
                is_primary: warehouseData.is_primary,
                position: warehouseData.position || 999
              },
              { transaction }
            );
          }

          // c) Actualizar warehouses existentes (principal, posición)
          for (const warehouseData of warehousesToUpdate) {
            logger.info('consulta para Actualizar existete');
            const association = await PoolWarehouseRepository.findByPoolAndWarehouse(
              pool.id, 
              warehouseData.warehouse_id
            );
            
            if (association) {
                 logger.info('Actualizabdo existete');
              await PoolWarehouseRepository.update(
                association.id,
                {
                  is_primary: warehouseData.is_primary,
                  position: warehouseData.position || association.position
                },
                { transaction }
              );
            }
          }
        }

        await transaction.commit();

        // 3. Obtener pool actualizado con almacenes
        const updatedPool = await PoolRepository.findById(pool.id);

         const pools = await PoolRepository.findFiltered({
            companyId: updated.company_id,
            userId: user_id,
            isActive: 1
        });

        // 5. Log de auditoría
        await LogRepository.create({
          user_id: metadata.user_id,
          action: "pool.update",
          description: `Pool actualizado: ${pool.name}`,
          ip_address: metadata.ip_address,
          user_agent: metadata.user_agent,
          status: "success",
          meta: { pool_id: pool.id }
        });

        return res.status(200).json({
          success: true,
          message: "Pool actualizado correctamente",
          data: updatedPool,
          pools
        });

      } catch (error) {
        if (transaction) await transaction.rollback();
        throw error;
      }

    } catch (error) {
      await LogRepository.create({
        user_id: metadata?.user_id,
        action: "pool.update",
        description: `Error al actualizar pool ID ${id}: ${error.message}`,
        ip_address: metadata?.ip_address,
        user_agent: metadata?.user_agent,
        status: "error"
      });

      logger.error("PoolController->update: " + error.message);
      return res.status(500).json({
        success: false,
        error: "ServerError",
        details: error.message
      });
    }
  },

  async destroy(req, res) {
    logger.info(`${req.user?.name || "Unknown"} - Elimina pool ${req.body.id}`);
    const metadata = getRequestMetadata(req);

    try {
      const pool = await PoolRepository.findById(req.body.id, false);
      if (!pool) {
        return res.status(404).json({ 
          success: false, 
          msg: "PoolNotFound" 
        });
      }

      await PoolRepository.delete(pool);

      await LogRepository.create({
        user_id: metadata.user_id,
        action: "pool.delete",
        description: `Pool eliminado: ID ${pool.id}, nombre: "${pool.name}"`,
        ip_address: metadata.ip_address,
        user_agent: metadata.user_agent,
        status: "success"
      });

      // Obtener pools actualizados
      const pools = await PoolRepository.findFiltered({
        companyId: pool.company_id
      });

      return res.status(200).json({
        success: true,
        message: "Pool eliminado correctamente",
        pools
      });

    } catch (error) {
      await LogRepository.create({
        user_id: metadata?.user_id,
        action: "pool.delete",
        description: `Error al eliminar pool ID ${req.body?.id}: ${error.message}`,
        ip_address: metadata?.ip_address,
        user_agent: metadata?.user_agent,
        status: "error"
      });

      logger.error("PoolController->destroy: " + error.message);
      return res.status(500).json({
        success: false,
        error: "ServerError",
        details: error.message
      });
    }
  }
};

module.exports = PoolController;
