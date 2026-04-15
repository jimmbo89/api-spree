const { ProductVariantValue, VariantValue, VariantDefinition } = require("../models");
const logger = require("../../config/logger");

const ProductVariantValueRepository = {
  async replaceValuesForVariant(productVariantId, variantValueIds = [], options = {}) {
    try {
      if (!Array.isArray(variantValueIds)) {
        throw new Error("variant_value_ids debe ser un array");
      }

      const uniqueIds = [...new Set(variantValueIds.map(id => Number(id)).filter(id => !Number.isNaN(id)))];

      // Limpiar si viene vacio
      if (uniqueIds.length === 0) {
        await ProductVariantValue.destroy({
          where: { product_variant_id: productVariantId },
          transaction: options.transaction
        });
        return [];
      }

      const values = await VariantValue.findAll({
        where: { id: uniqueIds },
        attributes: ["id", "variant_definition_id"],
        include: [{
          model: VariantDefinition,
          as: "definition",
          attributes: ["id", "company_id"]
        }],
        transaction: options.transaction
      });

      if (values.length !== uniqueIds.length) {
        throw new Error("Uno o mas variant_value_ids no existen");
      }

      const definitionMap = new Map();
      for (const v of values) {
        if (options.companyId !== undefined && options.companyId !== null) {
          const defCompanyId = v.definition ? v.definition.company_id : null;
          if (defCompanyId !== null && defCompanyId !== options.companyId) {
            throw new Error("variant_value_ids fuera del scope de la empresa");
          }
        }
        if (definitionMap.has(v.variant_definition_id)) {
          throw new Error("No se puede asignar mas de un valor por tipo de variante");
        }
        definitionMap.set(v.variant_definition_id, v.id);
      }

      const rows = values.map(v => ({
        product_variant_id: productVariantId,
        variant_value_id: v.id,
        variant_definition_id: v.variant_definition_id
      }));

      await ProductVariantValue.destroy({
        where: { product_variant_id: productVariantId },
        transaction: options.transaction
      });

      return await ProductVariantValue.bulkCreate(rows, { transaction: options.transaction });
    } catch (error) {
      logger.error("Error en ProductVariantValueRepository->replaceValuesForVariant:", error);
      throw error;
    }
  }
};

module.exports = ProductVariantValueRepository;
