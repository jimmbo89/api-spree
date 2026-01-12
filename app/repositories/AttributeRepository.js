const { Attribute, ProductAttribute } = require("../models");
const logger = require("../../config/logger");

const AttributeRepository = {
async findAll({ withUsageCount = false } = {}) {
  try {
    if (withUsageCount) {
      const attributesWithCount = await Attribute.sequelize.query(`
        SELECT 
          a.id, 
          a.name, 
          a.type, 
          a.cant,
          COUNT(pa.id) as usage_count
        FROM attributes a
        LEFT JOIN product_attributes pa ON a.id = pa.attribute_id
        GROUP BY a.id, a.name, a.type, a.cant
        ORDER BY a.id ASC
      `, {
        type: Attribute.sequelize.QueryTypes.SELECT
      });

      return attributesWithCount.map(attr => ({
        id: parseInt(attr.id),
        name: attr.name,
        type: attr.type,
        cant: attr.cant ? parseInt(attr.cant) : null,
        usage_count: parseInt(attr.usage_count || 0)
      }));
    } else {
      return await Attribute.findAll({
        attributes: ["id", "name", "type", "cant"],
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
        attributes: ["id", "name", "type", "cant"]
      });
      return attribute;
    } catch (error) {
      logger.error(`Error en AttributeRepository->findById (ID: ${id}):`, error);
      throw new Error(`Error al obtener el atributo: ${error.message}`);
    }
  },

  async findByName(name) {
    try {
      if (!name) {
        throw new Error("El nombre del atributo no puede estar vacío");
      }

      const attribute = await Attribute.findOne({
        where: { name },
        attributes: ["id", "name", "type", "cant"]
      });

      return attribute;
    } catch (error) {
      logger.error(`Error en AttributeRepository->findByName (Name: ${name}):`, error);
      throw new Error(`Error al obtener el atributo por nombre: ${error.message}`);
    }
  },

  async create(data) {
    try {
      const { name, type, cant } = data;
      const attribute = await Attribute.create({
        name,
        type,
        cant: cant !== undefined ? cant : null
      });
      logger.info(`Nuevo atributo creado: ID ${attribute.id}, nombre: ${attribute.name}`);
      return attribute;
    } catch (error) {
      logger.error("Error en AttributeRepository->create:", error);
      throw new Error(`Error al crear atributo: ${error.message}`);
    }
  },

  async update(attribute, data) {
    try {
      const { name, type, cant } = data;

      const updateData = {};
      if (name !== undefined) updateData.name = name;
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