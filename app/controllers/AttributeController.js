const logger = require("../../config/logger");
const { AttributeRepository, CompanyRepository } = require("../repositories");

const AttributeController = {
  async index(req, res) {
    const userName = req.user?.name || 'Anonymous';
    const { company_id, usage } = req.body;
    logger.info(`${userName} - Solicita listado de atributos`);
    let withUsageCount = usage || false;
    try {
      const attributes = await AttributeRepository.findAll({ 
        companyId: company_id || null,
        withUsageCount 
      });
      return attributes.length === 0
        ? res.status(204).json({ msg: "NoAttributesFound", attributes: [] })
        : res.status(200).json({ attributes: attributes });
    } catch (err) {
      logger.error("AttributeController->index: " + err.message);
      return res.status(500).json({ error: "ServerError", details: err.message });
    }
  },

  async store(req, res) {
    const userName = req.user?.name || 'Anonymous';
    logger.info(`${userName} - Crea nuevo atributo`);
    logger.info("Datos recibidos (body):");
    logger.info(JSON.stringify(req.body));

    const { name, company_id, type, cant } = req.body;
    const attributeData = { name, company_id, type, cant };
    let withUsageCount = true;
    try {
      // Validar company_id si se proporciona
      if (company_id) {
        const company = await CompanyRepository.findById(company_id);
        if (!company) {
          return res.status(400).json({ error: "CompanyNotFound", message: "La empresa especificada no existe" });
        }
      }

      // ✅ Validar que el nombre no exista en la misma empresa (o global si company_id es null)
      const existingAttribute = await AttributeRepository.findByName(name, company_id);
      if (existingAttribute) {
        const scope = company_id ? `en la empresa ${company_id}` : 'como atributo global';
        return res.status(409).json({
          error: "DuplicateName",
          message: `Ya existe un atributo con el nombre "${name}" ${scope}`
        });
      }

      await AttributeRepository.create(attributeData);
      const attributes = await AttributeRepository.findAll({ companyId: company_id || null, withUsageCount });
      return res.status(201).json({ attributes: attributes, msg: "Atributo creado correctamente" });
    } catch (err) {
      logger.error("AttributeController->store: " + err.message);
      return res.status(500).json({ error: "ServerError", details: err.message });
    }
  },

  async update(req, res) {
    const userName = req.user?.name || 'Anonymous';
    const attributeId = req.params.id || req.body.id;
    logger.info(`${userName} - Actualiza atributo ID ${attributeId}`);
    logger.info("Datos recibidos (params + body):");
    logger.info(JSON.stringify({ params: req.params, body: req.body }));

    const { name, company_id, type, cant } = req.body;
    let withUsageCount = true;
    try {
      const attribute = await AttributeRepository.findById(attributeId);
      if (!attribute) return res.status(404).json({ msg: "AttributeNotFound" });

      // ✅ Si el registro es global (company_id null) y se pasa company_id, crear uno nuevo en lugar de editar
      if (attribute.company_id === null && company_id) {
        logger.info(`Atributo global ${attributeId} - Creando nuevo atributo para empresa ${company_id}`);
        
        // Validar empresa
        const company = await CompanyRepository.findById(company_id);
        if (!company) {
          return res.status(400).json({ error: "CompanyNotFound", message: "La empresa especificada no existe" });
        }

        // Validar que no exista ya un atributo con ese nombre en la empresa
        const existingAttribute = await AttributeRepository.findByName(name, company_id);
        if (existingAttribute) {
          return res.status(409).json({
            error: "DuplicateName",
            message: `Ya existe un atributo con el nombre "${name}" en la empresa ${company_id}`
          });
        }

        // Crear nuevo atributo para la empresa
        const newAttribute = await AttributeRepository.create({ 
          name, 
          company_id, 
          type: type !== undefined ? type : attribute.type, 
          cant: cant !== undefined ? cant : attribute.cant 
        });
        
        const attributes = await AttributeRepository.findAll({ companyId: company_id, withUsageCount });
        return res.status(201).json({ 
          attributes: attributes, 
          msg: "Atributo creado correctamente para la empresa",
          created_from_global: true,
          global_attribute_id: attributeId
        });
      }

      // Validar company_id si se proporciona y es diferente (para edición normal)
      if (company_id && company_id !== attribute.company_id) {
        const company = await CompanyRepository.findById(company_id);
        if (!company) {
          return res.status(400).json({ error: "CompanyNotFound", message: "La empresa especificada no existe" });
        }
      }

      // ✅ Validar que el nombre no exista en la misma empresa (excluyendo el atributo actual)
      if (name && name !== attribute.name) {
        const targetCompanyId = company_id !== undefined ? company_id : attribute.company_id;
        const existingAttribute = await AttributeRepository.findByNameExcludingId(name, targetCompanyId, attributeId);
        if (existingAttribute) {
          const scope = targetCompanyId ? `en la empresa ${targetCompanyId}` : 'como atributo global';
          return res.status(409).json({
            error: "DuplicateName",
            message: `Ya existe un atributo con el nombre "${name}" ${scope}`
          });
        }
      }

      const updatedAttribute = await AttributeRepository.update(attribute, { name, company_id, type, cant });
      const attributes = await AttributeRepository.findAll({ companyId: company_id || attribute.company_id, withUsageCount });
      return res.status(200).json({ attributes: attributes, msg: "Atributo editado correctamente" });
    } catch (err) {
      logger.error("AttributeController->update: " + err.message);
      return res.status(500).json({ error: "ServerError", details: err.message });
    }
  },

  async destroy(req, res) {
    const userName = req.user?.name || 'Anonymous';
    const attributeId = req.params.id || req.body.id;
    logger.info(`${userName} - Elimina atributo ID ${attributeId}`);
    logger.info("Datos recibidos (params):");
    logger.info(JSON.stringify({ params: req.params, body: req.body }));
    let withUsageCount = true;
    try {
      const attribute = await AttributeRepository.findById(attributeId);
      if (!attribute) return res.status(404).json({ msg: "AttributeNotFound" });

      await AttributeRepository.delete(attribute);
      const attributes = await AttributeRepository.findAll({ companyId: attribute.company_id, withUsageCount });
      return res.status(200).json({ msg: "Atributo eliminado correctamente", attributes: attributes });
    } catch (err) {
      logger.error("AttributeController->destroy: " + err.message);
      return res.status(500).json({ error: "ServerError", details: err.message });
    }
  },

  async show(req, res) {
    const userName = req.user?.name || 'Anonymous';
    const attributeId = req.params.id || req.body.id;
    logger.info(`${userName} - Consulta atributo ID ${attributeId}`);
    logger.info("Datos recibidos (params):");
    logger.info(JSON.stringify({ params: req.params, body: req.body }));

    try {
      const attribute = await AttributeRepository.findById(attributeId);
      if (!attribute) return res.status(404).json({ msg: "AttributeNotFound" });
      return res.status(200).json({ attribute: attribute });
    } catch (err) {
      logger.error("AttributeController->show: " + err.message);
      return res.status(500).json({ error: "ServerError", details: err.message });
    }
  }
};

module.exports = AttributeController;