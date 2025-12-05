const logger = require('../../config/logger');
const {
  ProductRepository,
  CompanyRepository,
  UserRepository,
  BranchRepository,
  ProductCategoryRepository,
  LogRepository
} = require('../repositories');
const BulkProductUploadService = require('../services/BulkProductUploadService');
const MarketplaceTransformer = require('../services/MarketplaceTransformer');
const { detectChanges } = require('../util/auditUtils');
const { getRequestMetadata } = require('../util/requestUtil');

const PRODUCT_AUDIT_FIELDS = [
  'sku', 'name', 'description', 'status', 'category_id',
  'base_price', 'user_id', 'company_id', 'branch_id', 'images',
  'brand', 'model', 'condition', 'gtin', 'mpn', 'attributes',
  'warranty_months', 'warranty_text', 'weight_grams',
  'length_cm', 'width_cm', 'height_cm', 'sync_meta'
];

const ProductController = {
  async list(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Lista productos`);
    const { company_id, user_id, branch_id, category_id, brand, status, has_gtin } = req.body;

    //if (!company_id) return res.status(400).json({ msg: "company_id es obligatorio" });

    if (company_id) {
      const company = await CompanyRepository.findById(company_id);
      if (!company) return res.status(400).json({ msg: "companyNotFound" });
    }
    if (user_id) {
      const user = await UserRepository.findById(user_id);
      if (!user) return res.status(400).json({ msg: "userNotFound" });
    }
    if (branch_id) {
      const branch = await BranchRepository.findById(branch_id);
      if (!branch) return res.status(400).json({ msg: "branchNotFound" });
    }
    if (category_id) {
      const category = await ProductCategoryRepository.findById(category_id);
      if (!category) return res.status(400).json({ msg: "categoryNotFound" });
    }

    try {
      const mappedProducts = await ProductRepository.findFiltered({
        companyId: company_id,
        userId: user_id,
        branchId: branch_id,
        categoryId: category_id,
        brand,
        status,
        hasGtin: has_gtin
      });
      if (mappedProducts.length === 0) {
        return res.status(200).json({ products: [], msg: 'NoProductsFound' });
      }
      res.status(200).json({ products: mappedProducts });
    } catch (error) {
      logger.error('ProductController->list: ' + error.message);
      res.status(500).json({ error: 'ServerError', details: error.message });
    }
  },

  async getProductMetadata(req, res) {
  const userName = req.user?.name || 'Anonymous';
  logger.info(`${userName} - Solicita metadata de productos: categorías y estados`);

  try {
    // 1. Obtener categorías activas
    const categories = await ProductCategoryRepository.findActive();

    // 2. Definir estados del producto (fijo)
    const productStatus = [
      { id: 0, name: 'Inactivo', key: 'inactive' },
      { id: 1, name: 'Activo', key: 'active' },
      { id: 2, name: 'Archivado', key: 'archived' }
    ];

    const conditions = [
      { id: "new", name: "Nuevo" },
      { id: "used", name: "Usado" },
      { id: "refurbished", name: "Reacondicionado" },
      { id: "not_specified", name: "No especificado" }
    ];

    return res.status(200).json({
      productcategories: categories,
      productstatus: productStatus,
      conditions: conditions
    });
  } catch (err) {
    logger.error("ProductController->getProductMetadata: " + err.message);
    return res.status(500).json({ error: "ServerError", details: err.message });
  }
},
  async store(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Crea nuevo producto`);
    logger.info('Datos recibidos:');
    logger.info(JSON.stringify(req.body));

    const { company_id, user_id: bodyUserId } = req.body;
    const user_id = bodyUserId || req.user.id;
    req.body.user_id = user_id;

    if (!company_id) return res.status(400).json({ msg: "company_id es obligatorio" });

    const company = await CompanyRepository.findById(company_id);
    if (!company) return res.status(400).json({ msg: "companyNotFound" });

    if (user_id) {
      const user = await UserRepository.findById(user_id);
      if (!user) return res.status(400).json({ msg: "userNotFound" });
    }

    if (req.body.category_id) {
      const category = await ProductCategoryRepository.findById(req.body.category_id);
      if (!category) return res.status(400).json({ msg: "categoryNotFound" });
    }

    if (req.body.branch_id) {
      const branch = await BranchRepository.findById(req.body.branch_id);
      if (!branch) return res.status(400).json({ msg: "branchNotFound" });
    }

    if (await ProductRepository.existsBySku(req.body.sku)) {
      return res.status(400).json({ msg: "skuAlreadyExists" });
    }

    if (req.body.brand && req.body.brand.trim() === '') {
      req.body.brand = 'Generico';
    }
    if (!req.body.condition) {
      req.body.condition = 'new';
    }

    if (req.body.attributes && typeof req.body.attributes === 'string') {
      try {
        req.body.attributes = JSON.parse(req.body.attributes);
      } catch (e) {
        return res.status(400).json({ msg: "attributesInvalidJSON" });
      }
    }

    const files = (req.files && Array.isArray(req.files.images)) ? req.files.images : [];

    try {
      const product = await ProductRepository.create(req.body, files);
      const products = await ProductRepository.findFiltered({
        companyId: product.company_id,
        userId: product.user_id
      });
      res.status(201).json({ message: "Producto creado correctamente", products: products });
    } catch (error) {
      logger.error('ProductController->store: ' + error.message);
      res.status(500).json({ error: 'ServerError', details: error.message });
    }
  },

  async show(req, res) {
    try {
      const product = await ProductRepository.findById(req.body.id);
      if (!product) return res.status(404).json({ msg: 'ProductNotFound' });

      const mapped = {
        id: product.id,
        sku: product.sku,
        name: product.name,
        description: product.description,
        status: product.status,
        status_label: product.status === 0 ? 'draft'
                      : product.status === 1 ? 'published'
                      : product.status === 2 ? 'error'
                      : 'archived',
        category_id: product.category_id,
        base_price: product.base_price,
        user_id: product.user_id,
        company_id: product.company_id,
        branch_id: product.branch_id,
        brand: product.brand,
        model: product.model,
        condition: product.condition,
        gtin: product.gtin,
        mpn: product.mpn,
        attributes: Array.isArray(product.attributes) ? product.attributes : [],
        warranty_months: product.warranty_months,
        warranty_text: product.warranty_text,
        weight_grams: product.weight_grams,
        dimensions: {
          length: product.length_cm,
          width: product.width_cm,
          height: product.height_cm
        },
        images: Array.isArray(product.images) ? product.images : JSON.parse(product.images || "[]"),
        sync_meta: product.sync_meta || {}
      };
      res.status(200).json({ product: mapped });
    } catch (error) {
      logger.error('ProductController->show: ' + error.message);
      res.status(500).json({ error: 'ServerError', details: error.message });
    }
  },

  async update(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Actualiza producto ${req.body.id}`);
    logger.info('Datos recibidos:');
    logger.info(JSON.stringify(req.body));

    const { id } = req.body;
    const metadata = getRequestMetadata(req);

    try {
      const product = await ProductRepository.findById(id);
      if (!product) return res.status(404).json({ msg: 'ProductNotFound' });

      if (req.body.attributes && typeof req.body.attributes === 'string') {
        try {
          req.body.attributes = JSON.parse(req.body.attributes);
        } catch (e) {
          return res.status(400).json({ msg: "attributesInvalidJSON" });
        }
      }

      if (req.body.sync_meta) {
        try {
          const currentMetadata = product.sync_meta || {};
          const newMetadata = typeof req.body.sync_meta === 'string'
            ? JSON.parse(req.body.sync_meta)
            : req.body.sync_meta;
          req.body.sync_meta = { ...currentMetadata, ...newMetadata };
        } catch (e) {
          return res.status(400).json({ msg: "syncMetadataInvalidJSON" });
        }
      }

      const { company_id, user_id, category_id, branch_id } = req.body;
      if (company_id) {
        const company = await CompanyRepository.findById(company_id);
        if (!company) return res.status(400).json({ msg: "companyNotFound" });
      }
      if (user_id) {
        const user = await UserRepository.findById(user_id);
        if (!user) return res.status(400).json({ msg: "userNotFound" });
      }
      if (category_id !== undefined && category_id !== null) {
        const category = await ProductCategoryRepository.findById(category_id);
        if (!category) return res.status(400).json({ msg: "categoryNotFound" });
      }
      if (branch_id !== undefined && branch_id !== null) {
        const branch = await BranchRepository.findById(branch_id);
        if (!branch) return res.status(400).json({ msg: "branchNotFound" });
      }

      if (req.body.sku && req.body.sku !== product.sku) {
        if (await ProductRepository.existsBySku(req.body.sku, product.id)) {
          return res.status(400).json({ msg: "skuAlreadyExists" });
        }
      }

      const originalData = { ...product.get({ plain: true }) };
      const files = (req.files && Array.isArray(req.files.images)) ? req.files.images : [];
      const updated = await ProductRepository.update(product, req.body, files);

      const fieldChanges = detectChanges(originalData, updated.get({ plain: true }), PRODUCT_AUDIT_FIELDS);
      const logEntry = fieldChanges.length > 0
        ? {
            user_id: metadata.user_id,
            action: 'product.update',
            description: `Producto actualizado: ${fieldChanges.length} campo(s) modificados`,
            ip_address: metadata.ip_address,
            user_agent: metadata.user_agent,
            status: 'success',
            meta: { changes: fieldChanges }
          }
        : {
            user_id: metadata.user_id,
            action: 'product.update',
            description: `Actualización de producto ID ${product.id} sin cambios`,
            ip_address: metadata.ip_address,
            user_agent: metadata.user_agent,
            status: 'success',
            meta: null
          };
      await LogRepository.create(logEntry);

      const products = await ProductRepository.findFiltered({
        companyId: updated.company_id,
        userId: updated.user_id
      });
      res.status(200).json({ message: "Producto actualizado correctamente", products: products });
    } catch (error) {
      await LogRepository.create({
        user_id: metadata?.user_id,
        action: 'product.update',
        description: `Error al actualizar producto ID ${req.body?.id}: ${error.message}`,
        ip_address: metadata?.ip_address,
        user_agent: metadata?.user_agent,
        status: 'error',
        meta: null
      });
      logger.error('ProductController->update: ' + error.message);
      res.status(500).json({ error: 'ServerError', details: error.message });
    }
  },

  async destroy(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Elimina producto con ID ${req.body.id}`);
    const metadata = getRequestMetadata(req);
    try {
      const product = await ProductRepository.findById(req.body.id);
      if (!product) return res.status(404).json({ msg: 'ProductNotFound' });

      const productData = product.get({ plain: true });
      await ProductRepository.delete(product);

      await LogRepository.create({
        user_id: metadata.user_id,
        action: 'product.delete',
        description: `Producto eliminado: ID ${productData.id}, nombre: "${productData.name}", SKU: "${productData.sku}"`,
        ip_address: metadata.ip_address,
        user_agent: metadata.user_agent,
        status: 'success',
        meta: { deleted_record: productData }
      });

      const products = await ProductRepository.findFiltered({
        companyId: product.company_id,
        userId: product.user_id
      });
      res.status(200).json({ message: "Producto eliminado correctamente", products: products });
    } catch (error) {
      await LogRepository.create({
        user_id: metadata?.user_id,
        action: 'product.delete',
        description: `Error al eliminar producto ID ${req.body?.id}: ${error.message}`,
        ip_address: metadata?.ip_address,
        user_agent: metadata?.user_agent,
        status: 'error',
        meta: null
      });
      logger.error('ProductController->destroy: ' + error.message);
      res.status(500).json({ error: 'ServerError', details: error.message });
    }
  },

  async previewPublishing(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Vista previa de publicación para marketplace`);
    logger.info('Datos recibidos:');
    logger.info(JSON.stringify(req.body));
    const { rows, marketplace_id } = req.body;
    if (!marketplace_id) return res.status(400).json({ msg: "marketplace_id es obligatorio" });
    if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ msg: "Debe proporcionar al menos una fila de productos" });

    try {
      const formatted = await BulkProductUploadService.formatForMarketplace(rows, marketplace_id);
      const has_errors = formatted.some(r => (r.errors.length > 0) || (r.payload_errors && r.payload_errors.length > 0));
      res.status(200).json({
        success: !has_errors,
        message: has_errors ? "Hay errores en los datos o en el mapeo" : "Listo para publicar",
        rows: formatted.map(r => ({
          row_number: r.index,
          sku: r.parsed?.sku,
          name: r.parsed?.name,
          stock: r.parsed?.stock,
          price: r.parsed?.price,
          errors: r.errors,
          payload_errors: r.payload_errors,
          payload: r.payload
        }))
      });
    } catch (error) {
      logger.error('ProductController->previewPublishing: ' + error.message);
      res.status(500).json({ error: 'ServerError', details: error.message });
    }
  },

  async transformForMarketplace(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Transformar productos para marketplace`);
    logger.info('Datos recibidos:');
    logger.info(JSON.stringify(req.body));
    const { products, marketplace_id } = req.body;
    if (!marketplace_id) return res.status(400).json({ msg: "marketplace_id es obligatorio" });
    if (!Array.isArray(products) || products.length === 0) return res.status(400).json({ msg: "Debe proporcionar al menos un producto" });

    try {
      const transformed = await MarketplaceTransformer.transformProducts(products, marketplace_id);
      res.status(200).json({ success: true, transformed_products: transformed });
    } catch (error) {
      logger.error('ProductController->transformForMarketplace: ' + error.message);
      res.status(500).json({ error: 'ServerError', details: error.message });
    }
  }
};

module.exports = ProductController;