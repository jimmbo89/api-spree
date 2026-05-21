const { VariantValue } = require("../models");
const logger = require("../../config/logger");

const VariantValueRepository = {
  async findByDefinitionId(variantDefinitionId) {
    try {
      return await VariantValue.findAll({
        where: { variant_definition_id: variantDefinitionId },
        attributes: ["id", "variant_definition_id", "name", "code"],
        order: [["id", "ASC"]]
      });
    } catch (error) {
      logger.error("Error en VariantValueRepository->findByDefinitionId:", error);
      throw new Error(`Error al obtener valores de variante: ${error.message}`);
    }
  },

  async findByDefinitionIdAndName(variantDefinitionId, name) {
    try {
      return await VariantValue.findOne({
        where: {
          variant_definition_id: variantDefinitionId,
          name
        },
        attributes: ["id", "variant_definition_id", "name", "code"]
      });
    } catch (error) {
      logger.error("Error en VariantValueRepository->findByDefinitionIdAndName:", error);
      throw new Error(`Error al obtener valor de variante por nombre: ${error.message}`);
    }
  },

  async findById(id) {
    try {
      return await VariantValue.findByPk(id, {
        attributes: ["id", "variant_definition_id", "name", "code"]
      });
    } catch (error) {
      logger.error(`Error en VariantValueRepository->findById (ID: ${id}):`, error);
      throw new Error(`Error al obtener el valor de variante: ${error.message}`);
    }
  },

  async findByIds(ids) {
    try {
      return await VariantValue.findAll({
        where: { id: ids },
        attributes: ["id", "variant_definition_id", "name", "code"]
      });
    } catch (error) {
      logger.error("Error en VariantValueRepository->findByIds:", error);
      throw new Error(`Error al obtener valores de variante: ${error.message}`);
    }
  },

  async create(data, options = {}) {
    try {
      const { variant_definition_id, name, code } = data;
      return await VariantValue.create({
        variant_definition_id,
        name,
        code: code !== undefined ? code : null
      }, options);
    } catch (error) {
      logger.error("Error en VariantValueRepository->create:", error);
      throw new Error(`Error al crear valor de variante: ${error.message}`);
    }
  },

  async update(variantValue, data) {
    try {
      const updateData = {};
      if (data.name !== undefined) updateData.name = data.name;
      if (data.code !== undefined) updateData.code = data.code;
      if (data.variant_definition_id !== undefined) {
        updateData.variant_definition_id = data.variant_definition_id;
      }
      return await variantValue.update(updateData);
    } catch (error) {
      logger.error(`Error en VariantValueRepository->update (ID: ${variantValue.id}):`, error);
      throw new Error(`Error al actualizar valor de variante: ${error.message}`);
    }
  },

  async delete(variantValue) {
    try {
      await variantValue.destroy();
      return { success: true, message: "Valor de variante eliminado correctamente" };
    } catch (error) {
      logger.error(`Error en VariantValueRepository->delete (ID: ${variantValue.id}):`, error);
      throw new Error(`Error al eliminar valor de variante: ${error.message}`);
    }
  }
};

module.exports = VariantValueRepository;
