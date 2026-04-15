const { VariantDefinition, VariantValue, ProductVariantValue, Company } = require("../models");
const logger = require("../../config/logger");
const { Op } = require("sequelize");

const VariantDefinitionRepository = {
  async findAll({ companyId = null } = {}) {
    try {
      const where = {};
      if (companyId != null && companyId !== 0) {
        where[Op.or] = [
          { company_id: companyId },
          { company_id: { [Op.is]: null } }
        ];
      }

      const variants = await VariantDefinition.findAll({
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
      if (companyId != null && companyId !== 0) {
        const byName = new Map();
        for (const v of variants) {
          const key = (v.name || "").toLowerCase();
          const current = byName.get(key);
          if (!current) {
            byName.set(key, v);
            continue;
          }
          if (current.company_id === null && v.company_id !== null) {
            byName.set(key, v);
          }
        }
        return Array.from(byName.values());
      }
      return variants;
    } catch (error) {
      logger.error("Error en VariantDefinitionRepository->findAll:", error);
      throw new Error(`Error al obtener variantes: ${error.message}`);
    }
  },

  async findAllWithValues({ companyId = null } = {}) {
    try {
      const where = {};
      if (companyId != null && companyId !== 0) {
        where[Op.or] = [
          { company_id: companyId },
          { company_id: { [Op.is]: null } }
        ];
      }

      const variants = await VariantDefinition.findAll({
        where,
        attributes: ["id", "company_id", "name", "type", "cant"],
        include: [
          {
            model: VariantValue,
            as: 'values',
            attributes: ['id', 'variant_definition_id', 'name', 'code']
          },
          {
            model: Company,
            as: 'company',
            attributes: ['id', 'name', 'image'],
            required: false
          }
        ],
        order: [
          ["id", "ASC"],
          [{ model: VariantValue, as: "values" }, "id", "ASC"]
        ]
      });
      let finalVariants = variants;
      if (companyId != null && companyId !== 0) {
        const byName = new Map();
        for (const v of variants) {
          const key = (v.name || "").toLowerCase();
          const current = byName.get(key);
          if (!current) {
            byName.set(key, v);
            continue;
          }
          if (current.company_id === null && v.company_id !== null) {
            byName.set(key, v);
          }
        }
        finalVariants = Array.from(byName.values());
      }

      const definitionIds = finalVariants.map(v => v.id);
      if (definitionIds.length === 0) return finalVariants;

      const rows = await ProductVariantValue.findAll({
        where: { variant_definition_id: { [Op.in]: definitionIds } },
        attributes: ['variant_definition_id', 'variant_value_id']
      });

      const defCount = new Map();
      const valueCount = new Map();
      for (const r of rows) {
        defCount.set(r.variant_definition_id, (defCount.get(r.variant_definition_id) || 0) + 1);
        valueCount.set(r.variant_value_id, (valueCount.get(r.variant_value_id) || 0) + 1);
      }

      return finalVariants.map(v => {
        const plain = v.get({ plain: true });
        const values = Array.isArray(plain.values) ? plain.values.map(val => ({
          ...val,
          usage_count: valueCount.get(val.id) || 0
        })) : [];
        return {
          ...plain,
          usage_count: defCount.get(plain.id) || 0,
          values
        };
      });
    } catch (error) {
      logger.error("Error en VariantDefinitionRepository->findAllWithValues:", error);
      throw new Error(`Error al obtener variantes: ${error.message}`);
    }
  },

  async findById(id) {
    try {
      return await VariantDefinition.findByPk(id, {
        attributes: ["id", "company_id", "name", "type", "cant"],
        include: [{
          model: Company,
          as: 'company',
          attributes: ['id', 'name', 'image'],
          required: false
        }]
      });
    } catch (error) {
      logger.error(`Error en VariantDefinitionRepository->findById (ID: ${id}):`, error);
      throw new Error(`Error al obtener la variante: ${error.message}`);
    }
  },

  async findByName(name, companyId = null) {
    try {
      if (!name) throw new Error("El nombre de la variante no puede estar vacio");

      const where = { name };
      if (companyId != null && companyId !== 0) {
        where[Op.or] = [
          { company_id: companyId },
          { company_id: { [Op.is]: null } }
        ];
      }

      return await VariantDefinition.findOne({
        where,
        attributes: ["id", "company_id", "name", "type", "cant"],
        include: [{
          model: Company,
          as: 'company',
          attributes: ['id', 'name', 'image'],
          required: false
        }]
      });
    } catch (error) {
      logger.error(`Error en VariantDefinitionRepository->findByName (Name: ${name}):`, error);
      throw new Error(`Error al obtener la variante por nombre: ${error.message}`);
    }
  },

  async findByNameExcludingId(name, companyId = null, excludeId = null) {
    try {
      if (!name) throw new Error("El nombre de la variante no puede estar vacio");

      const where = { name };
      if (excludeId) where.id = { [Op.ne]: excludeId };
      if (companyId != null && companyId !== 0) {
        where[Op.or] = [
          { company_id: companyId },
          { company_id: { [Op.is]: null } }
        ];
      }

      return await VariantDefinition.findOne({
        where,
        attributes: ["id", "company_id", "name", "type", "cant"],
        include: [{
          model: Company,
          as: 'company',
          attributes: ['id', 'name', 'image'],
          required: false
        }]
      });
    } catch (error) {
      logger.error(`Error en VariantDefinitionRepository->findByNameExcludingId (Name: ${name}):`, error);
      throw new Error(`Error al obtener la variante por nombre excluyendo ID: ${error.message}`);
    }
  },

  async create(data, options = {}) {
    try {
      const { name, company_id, type, cant } = data;
      const variant = await VariantDefinition.create({
        name,
        company_id: company_id || null,
        type: type !== undefined ? type : null,
        cant: cant !== undefined ? cant : null
      }, options);
      logger.info(`Nueva variante creada: ID ${variant.id}, nombre: ${variant.name}, company_id: ${company_id || 'NULL (global)'}`);
      return variant;
    } catch (error) {
      logger.error("Error en VariantDefinitionRepository->create:", error);
      throw new Error(`Error al crear variante: ${error.message}`);
    }
  },

  async update(variant, data, options = {}) {
    try {
      const { name, company_id, type, cant } = data;
      const updateData = {};
      if (name !== undefined) updateData.name = name;
      if (company_id !== undefined) updateData.company_id = company_id;
      if (type !== undefined) updateData.type = type;
      if (cant !== undefined) updateData.cant = cant;

      await variant.update(updateData, options);
      logger.info(`Variante actualizada (ID: ${variant.id})`);
      return variant;
    } catch (error) {
      logger.error(`Error en VariantDefinitionRepository->update (ID: ${variant.id}):`, error);
      throw new Error(`Error al actualizar variante: ${error.message}`);
    }
  },

  async delete(variant) {
    try {
      await variant.destroy();
      logger.info(`Variante eliminada (ID: ${variant.id})`);
      return { success: true, message: "Variante eliminada correctamente" };
    } catch (error) {
      logger.error(`Error en VariantDefinitionRepository->delete (ID: ${variant.id}):`, error);
      throw new Error(`Error al eliminar variante: ${error.message}`);
    }
  }
};

module.exports = VariantDefinitionRepository;
