// controllers/ProductVariantController.js
const logger = require("../../config/logger");
const ProductVariantRepository = require("../repositories/ProductVariantRepository");
const ProductVariantValueRepository = require("../repositories/ProductVariantValueRepository");
const { ProductVariant, Product, sequelize } = require("../models");
const { Op } = require("sequelize");
const { ProductRepository } = require("../repositories");
const AuditEventService = require("../services/AuditEventService");
const { detectChanges } = require("../util/auditUtils");

function toPlain(record) {
  if (!record) return null;
  return typeof record.get === "function" ? record.get({ plain: true }) : record;
}

function getProductAuditLabel(product) {
  const plain = toPlain(product) || {};
  return [plain.sku, plain.name].filter(Boolean).join(" / ") || "Producto sin nombre";
}

function buildVariantAuditPayload(product, variant, data = {}) {
  const productPlain = toPlain(product) || {};
  const variantPlain = toPlain(variant) || {};
  return {
    company_id: productPlain.company_id,
    module: "product",
    resource_type: "product",
    resource_id: productPlain.id,
    resource_label: getProductAuditLabel(productPlain),
    related_resource_type: "product_variant",
    related_resource_id: variantPlain.id,
    ...data
  };
}

function changesToValueSnapshot(changes, valueKey) {
  return changes.reduce((snapshot, change) => {
    snapshot[change.field] = change[valueKey];
    return snapshot;
  }, {});
}

const ProductVariantController = {
  async update(req, res) {
     const { id, sku, attributes, variant_value_ids } = req.body;
    // Buscar variante
      const variant = await ProductVariantRepository.findById(id);
      if (!variant) {
        return res.status(404).json({
          success: false,
          message: "Variante no encontrada"
        });
      }
      
      // Opcional: validar que el producto exista (consistencia)
      const product = await ProductRepository.findById(variant.product_id);
      if (!product) {
        return res.status(400).json({
          success: false,
          message: "Producto asociado no válido"
        });
      }
  
    const t = await sequelize.transaction();
    try {
     // Actualizar solo los atributos (no SKU, no product_id)
      const updateData = { attributes };
      const previousVariant = toPlain(variant);

      const updated = await ProductVariantRepository.update(variant, updateData, { transaction: t });

      if (variant_value_ids !== undefined) {
        await ProductVariantValueRepository.replaceValuesForVariant(
          updated.id,
          variant_value_ids,
          { transaction: t, companyId: product.company_id }
        );
      }

      await t.commit();

      const changes = detectChanges(previousVariant, toPlain(updated), ["sku", "attributes"]);
      await AuditEventService.safeRecordFromRequest(req, buildVariantAuditPayload(product, updated, {
        action: "product.variant_updated",
        result: "success",
        previous_value: changesToValueSnapshot(changes, "old_value"),
        new_value: changesToValueSnapshot(changes, "new_value"),
        changes,
        description: `Variante actualizada: ${updated.sku}`,
        metadata: {
          variant_value_ids_updated: variant_value_ids !== undefined
        }
      }));

      return res.status(200).json({
        success: true,
        message: "Variante actualizada correctamente",
        data: {
          id: updated.id,
          product_id: updated.product_id,
          sku: updated.sku,
          attributes: updated.attributes
        }
      });

    } catch (error) {
      await t.rollback();
      logger.error("Error en update variante:", error);
      return res.status(500).json({
        success: false,
        message: "Error interno al actualizar la variante"
      });
    }
  },

  async create(req, res) {
  const { product_id, sku, attributes, variant_value_ids } = req.body;

  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) {
    return res.status(400).json({
      success: false,
      message: "attributes es requerido y debe ser un objeto"
    });
  }
    // Validar que el producto exista
    const product = await ProductRepository.findById(product_id);
    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Producto no encontrado"
      });
    }
  const t = await sequelize.transaction();
  try {

    // Preparar datos
    const variantData = {
      product_id,
      sku: sku.trim(),
      attributes
    };

    // Crear variante
    const newVariant = await ProductVariantRepository.create(variantData, { transaction: t });

    if (variant_value_ids !== undefined) {
      await ProductVariantValueRepository.replaceValuesForVariant(
        newVariant.id,
        variant_value_ids,
        { transaction: t, companyId: product.company_id }
      );
    }

    await t.commit();

    await AuditEventService.safeRecordFromRequest(req, buildVariantAuditPayload(product, newVariant, {
      action: "product.variant_created",
      result: "success",
      new_value: toPlain(newVariant),
      description: `Variante creada: ${newVariant.sku}`,
      metadata: {
        variant_value_ids: variant_value_ids || []
      }
    }));

    return res.status(201).json({
      success: true,
      message: "Variante creada correctamente",
      data: {
        id: newVariant.id,
        product_id: newVariant.product_id,
        sku: newVariant.sku,
        attributes: newVariant.attributes
      }
    });

  } catch (error) {
    await t.rollback();
    logger.error("Error al crear variante:", error);
    return res.status(500).json({
      success: false,
      message: "Error interno al crear la variante"
    });
  }
},
  // ✅ Reusamos tu método de eliminar (si ya existe, ignora esto)
  async delete(req, res) {
    const { id } = req.body;
    const variant = await ProductVariantRepository.findById(id);
      if (!variant) {
        return res.status(404).json({
          success: false,
          message: "Variante no encontrada"
        });
      }
    const product = await ProductRepository.findById(variant.product_id);
    if (!product) {
      return res.status(400).json({
        success: false,
        message: "Producto asociado no válido"
      });
    }
    try {

      const previousVariant = toPlain(variant);
      await ProductVariantRepository.delete(variant);

      await AuditEventService.safeRecordFromRequest(req, buildVariantAuditPayload(product, previousVariant, {
        action: "product.variant_deleted",
        result: "success",
        previous_value: previousVariant,
        description: `Variante eliminada: ${previousVariant.sku}`
      }));

      return res.status(200).json({
        success: true,
        message: "Variante eliminada correctamente"
      });

    } catch (error) {
      logger.error("Error en delete variante:", error);
      return res.status(500).json({
        success: false,
        message: "Error interno al eliminar la variante"
      });
    }
  }
};

module.exports = ProductVariantController;
