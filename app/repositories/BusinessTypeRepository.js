// src/repositories/BusinessTypeRepository.js
const { BusinessType } = require("../models");
const logger = require("../../config/logger");

const BusinessTypeRepository = {
  async findAll() {
    try {
      const businessTypes = await BusinessType.findAll({
        attributes: ["id", "name", "status", "description"],
        order: [["id", "ASC"]]
      });
      return businessTypes;
    } catch (error) {
      logger.error("Error en BusinessTypeRepository->findAll:", error);
      throw new Error(`Error al obtener tipos de negocio: ${error.message}`);
    }
  },

  async findById(id) {
    try {
      const businessType = await BusinessType.findByPk(id, {
        attributes: ["id", "name", "status", "description"]
      });
      return businessType;
    } catch (error) {
      logger.error(`Error en BusinessTypeRepository->findById (ID: ${id}):`, error);
      throw new Error(`Error al obtener el tipo de negocio: ${error.message}`);
    }
  },

  async findByName(name) {
    try {
      if (!name) {
        throw new Error("El nombre del tipo de negocio no puede estar vacío");
      }

      const businessType = await BusinessType.findOne({
        where: { name },
        attributes: ["id", "name", "status", "description"]
      });

      return businessType;
    } catch (error) {
      logger.error(`Error en BusinessTypeRepository->findByName (Name: ${name}):`, error);
      throw new Error(`Error al obtener el tipo de negocio por nombre: ${error.message}`);
    }
  },

  async create(data) {
    try {
      const { name, status, description } = data;
      const businessType = await BusinessType.create({
        name,
        status: status !== undefined ? status : true,
        description: description || null
      });
      logger.info(`Nuevo tipo de negocio creado: ID ${businessType.id}, nombre: ${businessType.name}`);
      return businessType;
    } catch (error) {
      logger.error("Error en BusinessTypeRepository->create:", error);
      throw new Error(`Error al crear tipo de negocio: ${error.message}`);
    }
  },

  async update(businessType, data) {
    try {
      const { name, status, description } = data;

      const updateData = {};
      if (name !== undefined) updateData.name = name;
      if (status !== undefined) updateData.status = status;
      if (description !== undefined) updateData.description = description;

      await businessType.update(updateData);
      logger.info(`Tipo de negocio actualizado (ID: ${businessType.id})`);
      return businessType;
    } catch (error) {
      logger.error(`Error en BusinessTypeRepository->update (ID: ${businessType.id}):`, error);
      throw new Error(`Error al actualizar tipo de negocio: ${error.message}`);
    }
  },

  async delete(businessType) {
    try {
      await businessType.destroy();
      logger.info(`Tipo de negocio eliminado (ID: ${businessType.id})`);
      return { success: true, message: "Tipo de negocio eliminado correctamente" };
    } catch (error) {
      logger.error(`Error en BusinessTypeRepository->delete (ID: ${businessType.id}):`, error);
      throw new Error(`Error al eliminar tipo de negocio: ${error.message}`);
    }
  }
};

module.exports = BusinessTypeRepository;