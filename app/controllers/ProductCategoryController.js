const logger = require("../../config/logger");
const { ProductCategoryRepository, CompanyRepository } = require("../repositories");

const ProductCategoryController = {
  async index(req, res) {
    const userName = req.user?.name || 'Anonymous';
    const { company_id } = req.body;
    logger.info(`${userName} - Solicita listado de categorías de productos`);
    try {
      const categories = await ProductCategoryRepository.findAll({ 
        companyId: company_id || null 
      });
      return categories.length === 0
        ? res.status(204).json({ msg: "NoProductCategoriesFound", categories: [] })
        : res.status(200).json({ categories: categories });
    } catch (err) {
      logger.error("ProductCategoryController->index: " + err.message);
      return res.status(500).json({ error: "ServerError", details: err.message });
    }
  },

  async store(req, res) {
    const { name, company_id, status, description } = req.body;
    const userName = req.user?.name || 'Anonymous';
    logger.info(`${userName} - Crea nueva categoría`);
    try {
      // Validar company_id si se proporciona
      if (company_id) {
        const company = await CompanyRepository.findById(company_id);
        if (!company) {
          return res.status(400).json({ error: "CompanyNotFound", message: "La empresa especificada no existe" });
        }
      }

      // ✅ Validar que el nombre no exista en la misma empresa (o global si company_id es null)
      const existingCategory = await ProductCategoryRepository.findByName(name, company_id);
      if (existingCategory) {
        const scope = company_id ? `en la empresa ${company_id}` : 'como categoría global';
        return res.status(409).json({
          error: "DuplicateName",
          message: `Ya existe una categoría con el nombre "${name}" ${scope}`
        });
      }

      await ProductCategoryRepository.create({ name, company_id, status, description });
      const categories = await ProductCategoryRepository.findAll({ companyId: company_id || null });
      return res.status(201).json({ categories: categories, msg: "Categoría creada correctamente" });
    } catch (err) {
      logger.error("ProductCategoryController->store: " + err.message);
      return res.status(500).json({ error: "ServerError", details: err.message });
    }
  },

  async update(req, res) {
    const id = req.params.id || req.body.id;
    const { name, company_id, status, description } = req.body;
    const userName = req.user?.name || 'Anonymous';
    logger.info(`${userName} - Actualiza categoría ID ${id}`);
    try {
      const category = await ProductCategoryRepository.findById(id);
      if (!category) return res.status(404).json({ msg: "ProductCategoryNotFound" });

      // ✅ Si el registro es global (company_id null) y se pasa company_id, crear uno nuevo en lugar de editar
      if (category.company_id === null && company_id) {
        logger.info(`Categoría global ${id} - Creando nueva categoría para empresa ${company_id}`);
        
        // Validar empresa
        const company = await CompanyRepository.findById(company_id);
        if (!company) {
          return res.status(400).json({ error: "CompanyNotFound", message: "La empresa especificada no existe" });
        }

        // Validar que no exista ya una categoría con ese nombre en la empresa
        const existingCategory = await ProductCategoryRepository.findByName(name, company_id);
        if (existingCategory) {
          return res.status(409).json({
            error: "DuplicateName",
            message: `Ya existe una categoría con el nombre "${name}" en la empresa ${company_id}`
          });
        }

        // Crear nueva categoría para la empresa
        const newCategory = await ProductCategoryRepository.create({ 
          name, 
          company_id, 
          status: status !== undefined ? status : category.status, 
          description: description !== undefined ? description : category.description 
        });
        
        const categories = await ProductCategoryRepository.findAll({ companyId: company_id });
        return res.status(201).json({ 
          categories: categories, 
          msg: "Categoría creada correctamente para la empresa",
          created_from_global: true,
          global_category_id: id
        });
      }

      // Validar company_id si se proporciona y es diferente (para edición normal)
      if (company_id && company_id !== category.company_id) {
        const company = await CompanyRepository.findById(company_id);
        if (!company) {
          return res.status(400).json({ error: "CompanyNotFound", message: "La empresa especificada no existe" });
        }
      }

      // ✅ Validar que el nombre no exista en la misma empresa (excluyendo la categoría actual)
      if (name && name !== category.name) {
        const targetCompanyId = company_id !== undefined ? company_id : category.company_id;
        const existingCategory = await ProductCategoryRepository.findByNameExcludingId(name, targetCompanyId, id);
        if (existingCategory) {
          const scope = targetCompanyId ? `en la empresa ${targetCompanyId}` : 'como categoría global';
          return res.status(409).json({
            error: "DuplicateName",
            message: `Ya existe una categoría con el nombre "${name}" ${scope}`
          });
        }
      }

      await ProductCategoryRepository.update(category, { name, company_id, status, description });
      const categories = await ProductCategoryRepository.findAll({ companyId: company_id || category.company_id });
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
      const categories = await ProductCategoryRepository.findAll({ companyId: category.company_id });
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