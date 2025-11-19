const { ProductCategory } = require("../models");
const logger = require("../../config/logger");

const ProductCategoryRepository = {
  async findAll() {
    try {
      const categories = await ProductCategory.findAll({
        attributes: ["id", "name", "status", "description"],
        order: [["id", "ASC"]]
      });
      return categories;
    } catch (error) {
      logger.error("Error en ProductCategoryRepository->findAll:", error);
      throw new Error(`Error al obtener categorías de productos: ${error.message}`);
    }
  },

  async findById(id) {
    try {
      const category = await ProductCategory.findByPk(id, {
        attributes: ["id", "name", "status", "description"]
      });
      return category;
    } catch (error) {
      logger.error(`Error en ProductCategoryRepository->findById (ID: ${id}):`, error);
      throw new Error(`Error al obtener la categoría: ${error.message}`);
    }
  },

  async findByName(name) {
    try {
      if (!name) throw new Error("El nombre no puede estar vacío");
      const category = await ProductCategory.findOne({ where: { name } });
      return category;
    } catch (error) {
      logger.error(`Error en ProductCategoryRepository->findByName (Name: ${name}):`, error);
      throw new Error(`Error al buscar categoría por nombre: ${error.message}`);
    }
  },

  async create(data) {
    try {
      const { name, status, description } = data;
      const category = await ProductCategory.create({
        name,
        status: status !== undefined ? status : true,
        description: description || null
      });
      logger.info(`Nueva categoría creada: ID ${category.id}, nombre: ${category.name}`);
      return category;
    } catch (error) {
      logger.error("Error en ProductCategoryRepository->create:", error);
      throw new Error(`Error al crear categoría: ${error.message}`);
    }
  },

  async update(category, data) {
    try {
      const { name, status, description } = data;
      const updateData = {};
      if (name !== undefined) updateData.name = name;
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