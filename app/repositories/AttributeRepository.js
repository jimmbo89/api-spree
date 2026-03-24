const { Attribute, ProductAttribute, Company, Product } = require("../models");
const logger = require("../../config/logger");
const { Op, fn, col } = require("sequelize");

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
      // ✅ Usar findAll con include condicional (igual que en categorías)
      const attributes = await Attribute.findAll({
        where,
        attributes: [
          "id",
          "company_id",
          "name",
          "type",
          "cant",
          [fn('COUNT', col('productAttributes.id')), 'usage_count']
        ],
        include: [{
          model: ProductAttribute,
          as: 'productAttributes',
          attributes: [],
          required: false,
          // ✅ Filtrar product_attributes solo si tienen productos de la empresa
          include: [{
            model: Product,
            as: 'product',
            attributes: [],
            required: true, // ✅ INNER JOIN: solo si existe el producto
            where: companyId != null && companyId !== 0 ? { company_id: companyId } : { id: { [Op.eq]: -1 } } // ✅ Si no hay companyId, no cuenta nada
          }]
        }, {
          model: Company,
          as: 'company',
          attributes: ['id', 'name', 'image'],
          required: false
        }],
        group: ['Attribute.id'],
        order: [["id", "ASC"]]
      });

      return attributes.map(attr => {
        const attrPlain = attr.get({ plain: true });
        return {
          id: attrPlain.id,
          company_id: attrPlain.company_id,
          name: attrPlain.name,
          type: attrPlain.type,
          cant: attrPlain.cant,
          usage_count: parseInt(attrPlain.usage_count || 0)
        };
      });
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