const logger = require('../../config/logger');
const { sequelize } = require('../models');
const {
  WarehouseProductRepository,
  ProductRepository,
  WarehouseRepository,
  CompanyRepository,
  UserRepository,
  BranchRepository,
  LogRepository
} = require('../repositories');
const BulkProductUploadService = require('../services/BulkProductUploadService');
const fs = require('fs').promises;
const { detectChanges } = require('../util/auditUtils');
const { getRequestMetadata } = require('../util/requestUtil');
const WAREHOUSE_PRODUCT_AUDIT_FIELDS = [
  'product_id', 'warehouse_id', 'stock', 'price', 'published',
  'company_id', 'branch_id', 'user_id'
];

const WarehouseProductController = {
  async list(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Lista warehouse_products`);

    const { company_id, user_id: bodyUserId, branch_id, warehouse_id } = req.body;
    const user_id = bodyUserId || req.user.id;

    if (company_id) {
      const company = await CompanyRepository.findById(company_id);
      if (!company) {
        logger.info(`WarehouseProductController->list: Compañía no encontrada con ID ${company_id}`);
        return res.status(400).json({ msg: "companyNotFound" });
      }
    } else {
      return res.status(400).json({ msg: "company_id es obligatorio" });
    }

    if (user_id) {
      const user = await UserRepository.findById(user_id);
      if (!user) {
        logger.info(`WarehouseProductController->list: Usuario no encontrado con ID ${user_id}`);
        return res.status(400).json({ msg: "userNotFound" });
      }
    }

    if (branch_id) {
      const branch = await BranchRepository.findById(branch_id);
      if (!branch) {
        logger.info(`WarehouseProductController->list: Sucursal no encontrada con ID ${branch_id}`);
        return res.status(400).json({ msg: "branchNotFound" });
      }
    }

    if (warehouse_id) {
      const warehouse = await WarehouseRepository.findById(warehouse_id);
      if (!warehouse) {
        logger.info(`WarehouseProductController->list: Almacén no encontrado con ID ${warehouse_id}`);
        return res.status(400).json({ msg: "warehouseNotFound" });
      }
    }

    try {
      const mapped = await WarehouseProductRepository.findFiltered({
        companyId: company_id,
        userId: user_id,
        branchId: branch_id,
        warehouseId: warehouse_id
      });

      if (mapped.length === 0) {
        return res.status(200).json({ warehouse_products: [], msg: 'NoWarehouseProductsFound' });
      }

      res.status(200).json({ warehouse_products: mapped });
    } catch (error) {
      logger.error('WarehouseProductController->list: ' + error.message);
      res.status(500).json({ error: 'ServerError', details: error.message });
    }
  },

  async store(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Crea nuevo warehouse_product`);
    logger.info('Datos recibidos:');
    logger.info(JSON.stringify(req.body));

    const { company_id: inputCompanyId, user_id: bodyUserId, product_id, sku, warehouse_id } = req.body;
    const user_id = bodyUserId || req.user.id;

    let transaction;

    try {
      // 🔁 Iniciar transacción
      transaction = await sequelize.transaction();

      // Validar warehouse (fuente de truth para company_id y branch_id)
      const warehouse = await WarehouseRepository.findById(warehouse_id);
      if (!warehouse ) {
        logger.info(`WarehouseProductController->store: Almacén no válido`);
        await transaction.rollback();
        return res.status(400).json({ msg: "warehouseNotFound" });
      }

      // 🔁 Obtener o crear producto
      let product;
      if (product_id) {
        product = await ProductRepository.findById(product_id);
        if (!product) {
          await transaction.rollback();
          return res.status(400).json({ msg: "productNotFound" });
        }
      } else if (sku) {
        product = await ProductRepository.findBySku(sku);
        if (!product) {
          // Crear producto DENTRO de la transacción
          product = await ProductRepository.create({
            sku,
            name: req.body.name,
            description: req.body.description,
            status: req.body.status,
            category_id: req.body.category_id,
            base_price: req.body.base_price,
            branch_id: warehouse.branch_id,
            user_id,
            company_id: warehouse.company_id
          }, { transaction }); // 👈 pasar transaction al repositorio

          logger.info(`Producto creado con SKU ${sku} (ID: ${product.id})`);
        }
      } else {
        await transaction.rollback();
        return res.status(400).json({ msg: "Debe proporcionar product_id o sku" });
      }

      // Verificar duplicado
      const existing = await WarehouseProductRepository.findByProductAndWarehouse(product.id, warehouse.id);
      if (existing) {
        await transaction.rollback();
        return res.status(400).json({ msg: "warehouseProductAlreadyExists" });
      }

      // ✅ Construir warehouse_product con datos del WAREHOUSE
      const wpData = {
        product_id: product.id,
        warehouse_id: warehouse.id,
        stock: req.body.stock ?? 0,
        price: req.body.price || null,
        published: req.body.published ?? false,
        company_id: warehouse.company_id,
        branch_id: warehouse.branch_id,
        user_id
      };

      // Crear warehouse_product DENTRO de la transacción
      const record = await WarehouseProductRepository.create(wpData, req.file, { transaction });

      // ✅ Confirmar transacción
      await transaction.commit();

      // ✅ Log de éxito (fuera de transacción)
      const metadata = getRequestMetadata(req);
      await LogRepository.create({
        user_id: metadata.user_id,
        action: 'warehouse_product.create',
        description: `Creado: producto ${product.sku} en almacén ${warehouse.id}`,
        ip_address: metadata.ip_address,
        user_agent: metadata.user_agent,
        status: 'success',
        meta: { id: record.id }
      });

      const list = await WarehouseProductRepository.findFiltered({
        companyId: warehouse.company_id,
        userId: user_id
      });

      res.status(201).json({ message: "Registro creado correctamente", warehouse_products: list });

    } catch (error) {
      // ✅ Revertir transacción si existe
      if (transaction) {
        await transaction.rollback();
        // Opcional: eliminar imagen si se creó y falló después
        // (tu ImageService moveFile ya ocurrió, pero es riesgoso revertirlo;
        // en sistemas críticos se usa colas para limpieza diferida)
      }

      // ✅ Log de error
      const metadata = getRequestMetadata(req);
      await LogRepository.create({
        user_id: metadata?.user_id,
        action: 'warehouse_product.create',
        description: `Error: ${error.message}`,
        ip_address: metadata?.ip_address,
        user_agent: metadata?.user_agent,
        status: 'error',
        meta: null
      });

      logger.error('WarehouseProductController->store: ' + error.message);
      res.status(500).json({ error: 'ServerError' });
    }
  },

  async show(req, res) {
    try {
      const record = await WarehouseProductRepository.findById(req.body.id);
      if (!record) return res.status(404).json({ msg: 'WarehouseProductNotFound' });

      res.status(200).json({
        warehouse_product: {
          id: record.id,
          product_id: record.product_id,
          warehouse_id: record.warehouse_id,
          stock: record.stock,
          image: record.image,
          price: record.price,
          published: record.published,
          company_id: record.company_id,
          branch_id: record.branch_id,
          user_id: record.user_id
        }
      });
    } catch (error) {
      logger.error('WarehouseProductController->show: ' + error.message);
      res.status(500).json({ error: 'ServerError' });
    }
  },

  async update(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Actualiza warehouse_product ${req.body.id}`);
    logger.info('Datos recibidos:');
    logger.info(JSON.stringify(req.body));

    const { id, company_id, user_id, product_id, warehouse_id } = req.body;
    const metadata = getRequestMetadata(req);

    try {
      const record = await WarehouseProductRepository.findById(id);
      if (!record) return res.status(404).json({ msg: 'WarehouseProductNotFound' });

      if (company_id) {
        const company = await CompanyRepository.findById(company_id);
        if (!company) return res.status(400).json({ msg: "companyNotFound" });
      }

      if (user_id) {
        const user = await UserRepository.findById(user_id);
        if (!user) return res.status(400).json({ msg: "userNotFound" });
      }

      if (product_id) {
        const product = await ProductRepository.findById(product_id);
        if (!product) return res.status(400).json({ msg: "productNotFound" });
      }

      if (warehouse_id) {
        const warehouse = await WarehouseRepository.findById(warehouse_id);
        if (!warehouse) return res.status(400).json({ msg: "warehouseNotFound" });
      }

       const originalData = { ...record.get({ plain: true }) };

      const updated = await WarehouseProductRepository.update(record, req.body, req.file);

       const fieldChanges = detectChanges(originalData, updated.get({ plain: true }), WAREHOUSE_PRODUCT_AUDIT_FIELDS);

       let logEntry;
        if (fieldChanges.length > 0) {
        logEntry = {
            user_id: metadata.user_id,
            action: 'warehouse_product.update',
            description: `Registro warehouse_product actualizado: ${fieldChanges.length} campo(s) modificados`,
            ip_address: metadata.ip_address,
            user_agent: metadata.user_agent,
            status: 'success',
            meta: { changes: fieldChanges }
        };
        } else {
        logEntry = {
            user_id: metadata.user_id,
            action: 'warehouse_product.update',
            description: `Actualización de registro ID ${record.id} sin cambios`,
            ip_address: metadata.ip_address,
            user_agent: metadata.user_agent,
            status: 'success',
            meta: null
        };
        }

        await LogRepository.create(logEntry);

      const list = await WarehouseProductRepository.findFiltered({
        companyId: updated.company_id,
        userId: updated.user_id
      });

      res.status(200).json({ message: "Registro actualizado correctamente", warehouse_products: list });
    } catch (error) {
        await LogRepository.create({
        user_id: metadata?.user_id,
        action: 'warehouse_product.update',
        description: `Error al actualizar warehouse_product ID ${req.body?.id}: ${error.message}`,
        ip_address: metadata?.ip_address,
        user_agent: metadata?.user_agent,
        status: 'error',
        meta: null
        });
      logger.error('WarehouseProductController->update: ' + error.message);
      res.status(500).json({ error: 'ServerError', details: error.message });
    }
  },

  async destroy(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Elimina warehouse_product con ID ${req.body.id}`);
    const metadata = getRequestMetadata(req);

    try {
      const record = await WarehouseProductRepository.findById(req.body.id);
      if (!record) return res.status(404).json({ msg: 'WarehouseProductNotFound' });

      const recordData = record.get({ plain: true });

      await WarehouseProductRepository.delete(record);

      await LogRepository.create({
        user_id: metadata.user_id,
        action: 'warehouse_product.delete',
        description: `Registro warehouse_product eliminado: ID ${recordData.id}, producto: ${recordData.product_id}, almacén: ${recordData.warehouse_id}`,
        ip_address: metadata.ip_address,
        user_agent: metadata.user_agent,
        status: 'success',
        meta: { deleted_record: recordData }
        });

      const list = await WarehouseProductRepository.findFiltered({
        companyId: record.company_id,
        userId: record.user_id
      });

      res.status(200).json({ message: "Registro eliminado correctamente", warehouse_products: list });
    } catch (error) {
        await LogRepository.create({
      user_id: metadata?.user_id,
      action: 'warehouse_product.delete',
      description: `Error al eliminar warehouse_product ID ${req.body?.id}: ${error.message}`,
      ip_address: metadata?.ip_address,
      user_agent: metadata?.user_agent,
      status: 'error',
      meta: null
    });
      logger.error('WarehouseProductController->destroy: ' + error.message);
      res.status(500).json({ error: 'ServerError', details: error.message });
    }
  },

  async transfer(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Transfiere stock entre almacenes`);
    logger.info('Datos recibidos:');
    logger.info(JSON.stringify(req.body));

    const { 
      product_id, 
      from_warehouse_id, 
      to_warehouse_id, 
      quantity 
    } = req.body;

    const user_id = req.user.id;
    const metadata = getRequestMetadata(req);

    if (from_warehouse_id == to_warehouse_id) {
      return res.status(400).json({ msg: "Los almacenes de origen y destino deben ser distintos" });
    }

    if (!Number.isInteger(quantity) || quantity <= 0) {
      return res.status(400).json({ msg: "quantity debe ser un entero positivo" });
    }

    let transaction;

    try {
      transaction = await sequelize.transaction();

      // Validar ambos almacenes
      const fromWarehouse = await WarehouseRepository.findById(from_warehouse_id);
      const toWarehouse = await WarehouseRepository.findById(to_warehouse_id);

      if (!fromWarehouse || !toWarehouse) {
        await transaction.rollback();
        return res.status(400).json({ msg: "Almacén no encontrado" });
      }
      // Validar producto
      const product = await ProductRepository.findById(product_id);
      if (!product) {
        await transaction.rollback();
        return res.status(400).json({ msg: "productNotFound" });
      }

      // Validar stock en origen
      const originRecord = await WarehouseProductRepository.findByProductAndWarehouse(
        product_id,
        from_warehouse_id
      );

      if (!originRecord) {
        await transaction.rollback();
        return res.status(400).json({ msg: "El producto no existe en el almacén de origen" });
      }

      if (originRecord.stock < quantity) {
        await transaction.rollback();
        return res.status(400).json({ 
          msg: "stockInsufficient",
          available: originRecord.stock,
          requested: quantity
        });
      }

      // Reducir stock en origen
      const newOriginStock = originRecord.stock - quantity;
      await WarehouseProductRepository.updateStock(
        originRecord,
        newOriginStock,
        { transaction }
      );

      // Obtener o crear registro en destino
      const destRecord = await WarehouseProductRepository.getOrCreateForWarehouse(
        product_id,
        to_warehouse_id,
        { 
          transaction,
          company_id: toWarehouse.company_id,
          branch_id: toWarehouse.branch_id,
          user_id
        }
      );

      // Aumentar stock en destino
      const newDestStock = destRecord.stock + quantity;
      await WarehouseProductRepository.updateStock(
        destRecord,
        newDestStock,
        { transaction }
      );

      // ✅ Confirmar transacción
      await transaction.commit();

      // ✅ Log de éxito
      await LogRepository.create({
        user_id: metadata.user_id,
        action: 'warehouse_product.transfer',
        description: `Transferencia de stock: ${quantity} unidades del producto ${product.sku} del almacén ${from_warehouse_id} al ${to_warehouse_id}`,
        ip_address: metadata.ip_address,
        user_agent: metadata.user_agent,
        status: 'success',
        meta: {
          product_id,
          sku: product.sku,
          from_warehouse_id,
          to_warehouse_id,
          quantity,
          origin_stock_after: newOriginStock,
          dest_stock_after: newDestStock
        }
      });

      res.status(200).json({
        message: "Transferencia realizada correctamente",
        from: { warehouse_id: from_warehouse_id, stock: newOriginStock },
        to: { warehouse_id: to_warehouse_id, stock: newDestStock }
      });

    } catch (error) {
      if (transaction) await transaction.rollback();

      // ✅ Log de error
      await LogRepository.create({
        user_id: metadata?.user_id,
        action: 'warehouse_product.transfer',
        description: `Error en transferencia: ${error.message}`,
        ip_address: metadata?.ip_address,
        user_agent: metadata?.user_agent,
        status: 'error',
        meta: {
          product_id,
          from_warehouse_id,
          to_warehouse_id,
          quantity
        }
      });

      logger.error('WarehouseProductController->transfer: ' + error.message);
      res.status(500).json({ error: 'ServerError', details: error.message });
    }
  },
  async bulkUploadPreview(req, res) {
    const { warehouse_id, company_id } = req.body;
    const user_id = req.user.id;

    if (!req.file) {
      return res.status(400).json({ msg: "fileRequired" });
    }

    try {
      const warehouse = await WarehouseRepository.findById(warehouse_id);
      if (!warehouse) {
        return res.status(400).json({ msg: "warehouseNotFound" });
      }

      const fileBuffer = await fs.readFile(req.file.path);
      let rows = BulkProductUploadService.parseFile(fileBuffer, req.file.mimetype);
      rows = BulkProductUploadService.validateRows(rows);
      rows = await BulkProductUploadService.enrichWithProductData(rows);

      // Eliminar archivo temporal
      await fs.unlink(req.file.path);

      const hasErrors = rows.some(r => r.errors.length > 0);

      res.status(200).json({
        success: !hasErrors,
        message: hasErrors ? "Hay errores en el archivo" : "Listo para importar",
        rows: rows.map(r => ({
          row_number: r.index,
          sku: r.parsed?.sku || r.raw.sku,
          name: r.parsed?.name || r.raw.name,
          stock: r.parsed?.stock,
          price: r.parsed?.price,
          published: r.parsed?.published,
          product_exists: !!r.parsed?.product,
          errors: r.errors
        }))
      });

    } catch (error) {
      await fs.unlink(req.file.path).catch(() => {});
      logger.error('WarehouseProductController->bulkUploadPreview: ' + error.message);
      res.status(400).json({ msg: "fileInvalid", details: error.message });
    }
  },

  async bulkUploadConfirm(req, res) {
    const { warehouse_id, rows } = req.body;
    const user_id = req.user.id;
    const metadata = getRequestMetadata(req);

    let transaction;

    try {
      const warehouse = await WarehouseRepository.findById(warehouse_id);
      if (!warehouse) {
        return res.status(400).json({ msg: "warehouseNotFound" });
      }

      transaction = await sequelize.transaction();

      const results = [];
      for (const row of rows) {
        if (row.errors && row.errors.length > 0) {
          results.push({ ...row, status: 'skipped', reason: 'validation_error' });
          continue;
        }

        try {
          let product = row.product_exists ? row.product : null;

          // Crear producto si no existe
          if (!product) {
            product = await ProductRepository.create({
              sku: row.sku,
              name: row.name,
              company_id: warehouse.company_id,
              user_id,
              branch_id: warehouse.branch_id
            }, { transaction });
          }

          // Obtener o crear warehouse_product
          let wp = await WarehouseProductRepository.findByProductAndWarehouse(
            product.id,
            warehouse_id
          );

          if (wp) {
            // Actualizar stock y otros campos
            const newStock = wp.stock + row.stock;
            await WarehouseProductRepository.updateStock(wp, newStock, { transaction });
            if (row.price !== undefined) await wp.update({ price: row.price }, { transaction });
            if (row.published !== undefined) await wp.update({ published: row.published }, { transaction });
          } else {
            // Crear nuevo
            wp = await WarehouseProductRepository.create({
              product_id: product.id,
              warehouse_id,
              stock: row.stock,
              price: row.price,
              published: row.published,
              company_id: warehouse.company_id,
              branch_id: warehouse.branch_id,
              user_id
            }, { transaction });
          }

          results.push({ ...row, status: 'success', warehouse_product_id: wp.id });

        } catch (err) {
          results.push({ ...row, status: 'error', reason: err.message });
        }
      }

      await transaction.commit();

      // Log
      const successCount = results.filter(r => r.status === 'success').length;
      await LogRepository.create({
        user_id: metadata.user_id,
        action: 'warehouse_product.bulk_upload',
        description: `Carga masiva completada: ${successCount} productos procesados`,
        ip_address: metadata.ip_address,
        user_agent: metadata.user_agent,
        status: 'success',
        meta: { warehouse_id, company_id, total: rows.length, success: successCount }
      });

      res.status(200).json({
        message: "Importación completada",
        results
      });

    } catch (error) {
      if (transaction) await transaction.rollback();
      await LogRepository.create({
        user_id: metadata?.user_id,
        action: 'warehouse_product.bulk_upload',
        description: `Error en carga masiva: ${error.message}`,
        ip_address: metadata?.ip_address,
        user_agent: metadata?.user_agent,
        status: 'error',
        meta: null
      });
      logger.error('WarehouseProductController->bulkUploadConfirm: ' + error.message);
      res.status(500).json({ error: 'ServerError' });
    }
  }
};

module.exports = WarehouseProductController;