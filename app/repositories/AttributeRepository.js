const { Attribute, ProductAttribute, Company } = require("../models");
const logger = require("../../config/logger");
const { Op } = require("sequelize");

const AttributeRepository = {
async findAll({ companyId = null, withUsageCount = false } = {}) {
  try {
    // Construir where: si hay companyId, traer atributos globales (NULL) O de la empresa
    const where = {};
    if (companyId != null && companyId !== 0) {
      where[Op.or] = [
        { company_id: companyId },
        { company_id: { [Op.is]: null } } // Atributos globales
      ];
    }

    if (withUsageCount) {
      // Query manual con COUNT
      const replacements = [];
      let whereClause = '';
      
      if (companyId != null && companyId !== 0) {
        whereClause = `WHERE (a.company_id = ? OR a.company_id IS NULL)`;
        replacements.push(companyId);
      }

      const attributesWithCount = await Attribute.sequelize.query(`
        SELECT
          a.id,
          a.company_id,
          a.name,
          a.type,
          a.cant,
          COUNT(pa.id) as usage_count
        FROM attributes a
        LEFT JOIN product_attributes pa ON a.id = pa.attribute_id
        ${whereClause}
        GROUP BY a.id, a.company_id, a.name, a.type, a.cant
        ORDER BY a.id ASC
      `, {
        replacements: companyId != null && companyId !== 0 ? [companyId] : [],
        type: Attribute.sequelize.QueryTypes.SELECT
      });

      return attributesWithCount.map(attr => ({
        id: parseInt(attr.id),
        company_id: attr.company_id,
        name: attr.name,
        type: attr.type,
        cant: attr.cant ? parseInt(attr.cant) : null,
        usage_count: parseInt(attr.usage_count || 0)
      }));
    } else {
      return await Attribute.findAll({
        where,
        attributes: ["id", "company_id", "name", "type", "cant"],
        include: [{
          model: Company,
          as: 'company',
          attributes: ['id', 'name', 'image'],
          required: false
        }],
        order: [["id", "ASC"]]
      });
    }
  } catch (error) {
    logger.error("Error en AttributeRepository->findAll:", error);
    throw new Error(`Error al obtener atributos: ${error.message}`);
  }
},

  async findById(id) {
    try {
      const attribute = await Attribute.findByPk(id, {
        attributes: ["id", "company_id", "name", "type", "cant"],
        include: [{
          model: Company,
          as: 'company',
          attributes: ['id', 'name', 'image'],
          required: false
        }]
      });
      return attribute;
    } catch (error) {
      logger.error(`Error en AttributeRepository->findById (ID: ${id}):`, error);
      throw new Error(`Error al obtener el atributo: ${error.message}`);
    }
  },

  async findByName(name, companyId = null) {
    try {
      if (!name) {
        throw new Error("El nombre del atributo no puede estar vacío");
      }

      const where = { name };
      
      // Si hay companyId, buscar en atributos de la empresa O globales
      if (companyId != null && companyId !== 0) {
        where[Op.or] = [
          { company_id: companyId },
          { company_id: { [Op.is]: null } }
        ];
      }

      const attribute = await Attribute.findOne({
        where,
        attributes: ["id", "company_id", "name", "type", "cant"],
        include: [{
          model: Company,
          as: 'company',
          attributes: ['id', 'name', 'image'],
          required: false
        }]
      });

      return attribute;
    } catch (error) {
      logger.error(`Error en AttributeRepository->findByName (Name: ${name}):`, error);
      throw new Error(`Error al obtener el atributo por nombre: ${error.message}`);
    }
  },

  // ✅ Buscar atributo por nombre excluyendo un ID específico (para validación en update)
  async findByNameExcludingId(name, companyId = null, excludeId = null) {
    try {
      if (!name) {
        throw new Error("El nombre del atributo no puede estar vacío");
      }

      const where = { name };
      
      // Excluir el ID especificado
      if (excludeId) {
        where.id = { [Op.ne]: excludeId };
      }
      
      // Si hay companyId, buscar en atributos de la empresa O globales
      if (companyId != null && companyId !== 0) {
        where[Op.or] = [
          { company_id: companyId },
          { company_id: { [Op.is]: null } }
        ];
      }

      const attribute = await Attribute.findOne({
        where,
        attributes: ["id", "company_id", "name", "type", "cant"],
        include: [{
          model: Company,
          as: 'company',
          attributes: ['id', 'name', 'image'],
          required: false
        }]
      });

      return attribute;
    } catch (error) {
      logger.error(`Error en AttributeRepository->findByNameExcludingId (Name: ${name}):`, error);
      throw new Error(`Error al obtener el atributo por nombre excluyendo ID: ${error.message}`);
    }
  },

  async create(data) {
    try {
      const { name, company_id, type, cant } = data;
      const attribute = await Attribute.create({
        name,
        company_id: company_id || null, // NULL = atributo global
        type,
        cant: cant !== undefined ? cant : null
      });
      logger.info(`Nuevo atributo creado: ID ${attribute.id}, nombre: ${attribute.name}, company_id: ${company_id || 'NULL (global)'}`);
      return attribute;
    } catch (error) {
      logger.error("Error en AttributeRepository->create:", error);
      throw new Error(`Error al crear atributo: ${error.message}`);
    }
  },

  async update(attribute, data) {
    try {
      const { name, company_id, type, cant } = data;

      const updateData = {};
      if (name !== undefined) updateData.name = name;
      if (company_id !== undefined) updateData.company_id = company_id;
      if (type !== undefined) updateData.type = type;
      if (cant !== undefined) updateData.cant = cant;

      await attribute.update(updateData);
      logger.info(`Atributo actualizado (ID: ${attribute.id})`);
      return attribute;
    } catch (error) {
      logger.error(`Error en AttributeRepository->update (ID: ${attribute.id}):`, error);
      throw new Error(`Error al actualizar atributo: ${error.message}`);
    }
  },

  async delete(attribute) {
    try {
      await attribute.destroy();
      logger.info(`Atributo eliminado (ID: ${attribute.id})`);
      return { success: true, message: "Atributo eliminado correctamente" };
    } catch (error) {
      logger.error(`Error en AttributeRepository->delete (ID: ${attribute.id}):`, error);
      throw new Error(`Error al eliminar atributo: ${error.message}`);
    }
  }
};

module.exports = AttributeRepository;