const { Product } = require("../models");
const logger = require("../../config/logger");
const ImageService = require("../services/ImageService");

const DEFAULT_IMAGE = "products/default.jpg";

const ProductRepository = {
  async findFiltered({ companyId, userId, branchId, categoryId }) {
    const where = { company_id: companyId };

    if (userId !== undefined) where.user_id = userId;
    if (companyId !== undefined) where.user_id = companyId;
    if (categoryId !== undefined) where.user_id = categoryId;
    if (branchId !== undefined) where.branch_id = branchId;

    const products = await Product.findAll({
      where,
      attributes: [
        "id",
        "sku",
        "name",
        "description",
        "status",
        "category_id",
        "base_price",
        "user_id",
        "company_id",
        "branch_id",
      ],
    });

    return products.map((product) => ({
      id: product.id,
      sku: product.sku,
      name: product.name,
      description: product.description,
      status: product.status,
      status_label:
        product.status === 0
          ? "draft"
          : product.status === 1
          ? "published"
          : product.status === 2
          ? "error"
          : "archived",
      category_id: product.category_id,
      base_price: product.base_price,
      user_id: product.user_id,
      company_id: product.company_id,
      branch_id: product.branch_id,
      images: Array.isArray(product.images)
            ? product.images
            : JSON.parse(product.images || "[]"),
    }));
  },

  async findById(id) {
    return await Product.findByPk(id, {
      attributes: [
        "id",
        "sku",
        "name",
        "description",
        "status",
        "category_id",
        "base_price",
        "user_id",
        "company_id",
        "branch_id",
        "images"
      ],
    });
  },

  async create(body, files = [], options = {}) {
    try {
      const {
        sku,
        name,
        description,
        status,
        category_id,
        base_price,
        user_id,
        company_id,
        branch_id,
      } = body;

      const product = await Product.create(
        {
          sku,
          name,
          description: description || null,
          status: status !== undefined ? status : 0,
          category_id: category_id || null,
          base_price: base_price || null,
          user_id: user_id || null,
          company_id: company_id || null,
          branch_id: branch_id || null,
        },
        options
      );

      if (Array.isArray(files) && files.length > 0) {
        const imagePaths = [];

        for (const file of files) {
          if (file && file.originalname) {
            const newFilename = ImageService.generateFilename(
              "products",
              `${product.id}_${Date.now()}`, // nombre único
              file.originalname
            );
            const filePath = await ImageService.moveFile(file, newFilename);
            imagePaths.push(filePath);
          }
        }

        // Guardar array de rutas
        if (imagePaths.length > 0) {
          await product.update(
            {
              images: imagePaths,
              image: imagePaths[0], // primera imagen como portada
            },
            { transaction: t }
          );
        }
      }

      logger.info(`Producto creado: ${product.title} (ID: ${product.id})`);
      return product;
    } catch (error) {
      logger.error("Error en ProductRepository->create:", error);
      throw new Error(`Error al crear producto: ${error.message}`);
    }
  },

  async update(product, body, files = []) {
    try {
    const fieldsToUpdate = [
      "sku",
      "name",
      "description",
      "status",
      "category_id",
      "base_price",
      "user_id",
      "company_id",
      "branch_id"
    ];
    const updatedData = Object.keys(body)
      .filter((key) => fieldsToUpdate.includes(key) && body[key] !== undefined)
      .reduce((obj, key) => {
        obj[key] = body[key];
        return obj;
      }, {});

      // Manejar archivo si se proporciona
      if (Array.isArray(files) && files.length > 0) {
      if (Array.isArray(product.images)) {
        for (const imagePath of product.images) {
          if (imagePath && imagePath !== DEFAULT_IMAGE) {
            await ImageService.deleteFile(imagePath);
          }
        }
      }

      // 2. Subir y registrar las nuevas imágenes
      const newImagePaths = [];
      for (const file of files) {
        if (file && file.originalname) {
          const newFilename = ImageService.generateFilename(
            "products",
            `${product.id}_${Date.now()}`,
            file.originalname
          );
          const filePath = await ImageService.moveFile(file, newFilename);
          newImagePaths.push(filePath);
        }
      }
      updatedData.images = newImagePaths;    
    }

    if (Object.keys(updatedData).length > 0) {
      await product.update(updatedData);
      logger.info(`Producto actualizado (ID: ${product.id})`);
    }

    return product;
    } catch (error) {
      logger.error(`Error en ProductRepository->update (ID: ${product.id}):`, error);
      throw new Error(`Error al actualizar producto: ${error.message}`);
    }
  },

  async delete(product) {
    return await product.destroy();
  },

  async existsBySku(sku, excludeId = null) {
    const whereCondition = excludeId
      ? { sku, id: { [Op.ne]: excludeId } }
      : { sku };

    const product = await Product.findOne({ where: whereCondition });
    return !!product;
  },
  async findBySku(sku) {
    return await Product.findOne({ where: { sku } });
  },
  async findBySkus(skus) {
    return await Product.findAll({
      where: {
        sku: skus,
      },
    });
  },
};

module.exports = ProductRepository;
