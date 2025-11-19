const logger = require("../../config/logger");
const { ProductCategoryRepository } = require("../repositories");

const ProductCategoryController = {
  async index(req, res) {
    const userName = req.user?.name || 'Anonymous';
    logger.info(`${userName} - Solicita listado de categorías de productos`);
    try {
      const categories = await ProductCategoryRepository.findAll();
      return categories.length === 0
        ? res.status(204).json({ msg: "NoProductCategoriesFound", categories: [] })
        : res.status(200).json({ categories: categories });
    } catch (err) {
      logger.error("ProductCategoryController->index: " + err.message);
      return res.status(500).json({ error: "ServerError", details: err.message });
    }
  },

  async store(req, res) {
    const { name, status, description } = req.body;
    const userName = req.user?.name || 'Anonymous';
    logger.info(`${userName} - Crea nueva categoría`);
    try {
      await ProductCategoryRepository.create({ name, status, description });
      const categories = await ProductCategoryRepository.findAll();
      return res.status(201).json({ categories: categories, msg: "Categoría creada correctamente" });
    } catch (err) {
      logger.error("ProductCategoryController->store: " + err.message);
      return res.status(500).json({ error: "ServerError", details: err.message });
    }
  },

  async update(req, res) {
    const id = req.params.id || req.body.id;
    const { name, status, description } = req.body;
    const userName = req.user?.name || 'Anonymous';
    logger.info(`${userName} - Actualiza categoría ID ${id}`);
    try {
      const category = await ProductCategoryRepository.findById(id);
      if (!category) return res.status(404).json({ msg: "ProductCategoryNotFound" });
      await ProductCategoryRepository.update(category, { name, status, description });
      const categories = await ProductCategoryRepository.findAll();
      return res.status(200).json({ categories: categories, msg: "Categoría actualizada correctamente" });
    } catch (err) {
      logger.error("ProductCategoryController->update: " + err.message);
      return res.status(500).json({ error: "ServerError", details: err.message });
    }
  },

  async destroy(req, res) {
    const id = req.params.id || req.body.id;
    const userName = req.user?.name || 'Anonymous';
    logger.info(`${userName} - Elimina categoría ID ${id}`);
    try {
      const category = await ProductCategoryRepository.findById(id);
      if (!category) return res.status(404).json({ msg: "ProductCategoryNotFound" });
      await ProductCategoryRepository.delete(category);
      const categories = await ProductCategoryRepository.findAll();
      return res.status(200).json({ msg: "Categoría eliminada correctamente", categories: categories });
    } catch (err) {
      logger.error("ProductCategoryController->destroy: " + err.message);
      return res.status(500).json({ error: "ServerError", details: err.message });
    }
  },

  async show(req, res) {
    const id = req.params.id || req.body.id;
    const userName = req.user?.name || 'Anonymous';
    logger.info(`${userName} - Consulta categoría ID ${id}`);
    try {
      const category = await ProductCategoryRepository.findById(id);
      if (!category) return res.status(404).json({ msg: "ProductCategoryNotFound" });
      return res.status(200).json({ category });
    } catch (err) {
      logger.error("ProductCategoryController->show: " + err.message);
      return res.status(500).json({ error: "ServerError", details: err.message });
    }
  }
};

module.exports = ProductCategoryController;