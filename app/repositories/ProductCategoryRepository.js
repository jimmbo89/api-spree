const { ProductCategory, Product, Company } = require("../models");
const logger = require("../../config/logger");
const { fn, col, Op } = require("sequelize");

const ProductCategoryRepository = {
async findAll({ companyId = null } = {}) {
  try {
    // Construir where: si hay companyId, traer categorías globales (NULL) O de la empresa
    const categoryWhere = {};
    if (companyId != null && companyId !== 0) {
      categoryWhere[Op.or] = [
        { company_id: companyId },
        { company_id: { [Op.is]: null } } // Categorías globales
      ];
    }

    // Construir where para productos: solo los de la empresa especificada
    const productWhere = {};
    if (companyId != null && companyId !== 0) {
      productWhere.company_id = companyId;
    }

    const categories = await ProductCategory.findAll({
      where: categoryWhere,
      attributes: [
        "id",
        "company_id",
        "name",
        "status",
        "description",
        [
          fn('COUNT', col('products.id')),
          'productCount'
        ]
      ],
      include: [{
        model: Product,
        as: 'products',
        attributes: [],
        required: false,
        where: productWhere // ✅ Filtrar productos por company_id
      }, {
        model: Company,
        as: 'company',
        attributes: ['id', 'name', 'image'],
        required: false
      }],
      group: ['ProductCategory.id'],
      order: [['id', 'ASC']]
    });

    return categories;
  } catch (error) {
    logger.error("Error en ProductCategoryRepository->findAll:", error);
    throw new Error(`Error al obtener categorías de productos: ${error.message}`);
  }
},

  // Filtrar categorías activas (globales O de la empresa)
async findActive({ companyId = null } = {}) {
  try {
    const where = { status: 1 };
    
    // Si hay companyId, traer categorías globales (NULL) O de la empresa
    if (companyId != null && companyId !== 0) {
      where[Op.or] = [
        { company_id: companyId },
        { company_id: { [Op.is]: null } }
      ];
    }

    const categories = await ProductCategory.findAll({
      where,
      attributes: ["id", "company_id", "name", "status", "description"],
      include: [{
        model: Company,
        as: 'company',
        attributes: ['id', 'name', 'image'],
        required: false
      }],
      order: [["name", "ASC"]]
    });
    return categories;
  } catch (error) {
    logger.error("Error en ProductCategoryRepository->findActive:", error);
    throw new Error(`Error al obtener categorías activas: ${error.message}`);
  }
},

  async findById(id) {
    try {
      const category = await ProductCategory.findByPk(id, {
        attributes: ["id", "company_id", "name", "status", "description"],
        include: [{
          model: Company,
          as: 'company',
          attributes: ['id', 'name', 'image'],
          required: false
        }]
      });
      return category;
    } catch (error) {
      logger.error(`Error en ProductCategoryRepository->findById (ID: ${id}):`, error);
      throw new Error(`Error al obtener la categoría: ${error.message}`);
    }
  },

  async findByName(name, companyId = null) {
    try {
      if (!name) throw new Error("El nombre no puede estar vacío");
      
      const where = { name };
      
      // Si hay companyId, buscar en categorías de la empresa O globales
      if (companyId != null && companyId !== 0) {
        where[Op.or] = [
          { company_id: companyId },
          { company_id: { [Op.is]: null } }
        ];
      }
      
      const category = await ProductCategory.findOne({ 
        where,
        include: [{
          model: Company,
          as: 'company',
          attributes: ['id', 'name', 'image'],
          required: false
        }]
      });
      return category;
    } catch (error) {
      logger.error(`Error en ProductCategoryRepository->findByName (Name: ${name}):`, error);
      throw new Error(`Error al buscar categoría por nombre: ${error.message}`);
    }
  },

  // ✅ Buscar categoría por nombre excluyendo un ID específico (para validación en update)
  async findByNameExcludingId(name, companyId = null, excludeId = null) {
    try {
      if (!name) throw new Error("El nombre no puede estar vacío");
      
      const where = { name };
      
      // Excluir el ID especificado
      if (excludeId) {
        where.id = { [Op.ne]: excludeId };
      }
      
      // Si hay companyId, buscar en categorías de la empresa O globales
      if (companyId != null && companyId !== 0) {
        where[Op.or] = [
          { company_id: companyId },
          { company_id: { [Op.is]: null } }
        ];
      }
      
      const category = await ProductCategory.findOne({ 
        where,
        include: [{
          model: Company,
          as: 'company',
          attributes: ['id', 'name', 'image'],
          required: false
        }]
      });
      return category;
    } catch (error) {
      logger.error(`Error en ProductCategoryRepository->findByNameExcludingId (Name: ${name}):`, error);
      throw new Error(`Error al buscar categoría por nombre excluyendo ID: ${error.message}`);
    }
  },

  async create(data) {
    try {
      const { name, company_id, status, description } = data;
      const category = await ProductCategory.create({
        name,
        company_id: company_id || null, // NULL = categoría global
        status: status !== undefined ? status : true,
        description: description || null
      });
      logger.info(`Nueva categoría creada: ID ${category.id}, nombre: ${category.name}, company_id: ${company_id || 'NULL (global)'}`);
      return category;
    } catch (error) {
      logger.error("Error en ProductCategoryRepository->create:", error);
      throw new Error(`Error al crear categoría: ${error.message}`);
    }
  },

  async update(category, data) {
    try {
      const { name, company_id, status, description } = data;
      const updateData = {};
      if (name !== undefined) updateData.name = name;
      if (company_id !== undefined) updateData.company_id = company_id;
      if (status !== undefined) updateData.status = status;
      if (description !== undefined) updateData.description = description;

      await category.update(updateData);
      logger.info(`Categoría actualizada (ID: ${category.id})`);
      return category;
    } catch (error) {
      logger.error(`Error en ProductCategoryRepository->update (ID: ${category.id}):`, error);
      throw new Error(`Error al actualizar categoría: ${error.message}`);
    }
  },

  async delete(category) {
    try {
      await category.destroy();
      logger.info(`Categoría eliminada (ID: ${category.id})`);
      return { success: true, message: "Categoría eliminada correctamente" };
    } catch (error) {
      logger.error(`Error en ProductCategoryRepository->delete (ID: ${category.id}):`, error);
      throw new Error(`Error al eliminar categoría: ${error.message}`);
    }
  }
};

module.exports = ProductCategoryRepository;