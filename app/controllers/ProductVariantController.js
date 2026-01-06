// controllers/ProductVariantController.js
const logger = require("../../config/logger");
const ProductVariantRepository = require("../repositories/ProductVariantRepository");
const { ProductVariant, Product, sequelize } = require("../models");
const { Op } = require("sequelize");
const { ProductRepository } = require("../repositories");

const ProductVariantController = {
  async update(req, res) {
     const { id, sku, attributes } = req.body;
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

      const updated = await ProductVariantRepository.update(variant, updateData, { transaction: t });

      await t.commit();

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
  const { product_id, sku, attributes } = req.body;

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

    await t.commit();

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
    try {

      await ProductVariantRepository.delete(variant);

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