const logger = require("../../config/logger");
const { VariantDefinitionRepository, VariantValueRepository, CompanyRepository } = require("../repositories");
const { VariantValue, sequelize } = require("../models");

async function syncVariantValues(variantDefinitionId, values = [], transaction) {
  if (!Array.isArray(values)) {
    throw new Error("values debe ser un array");
  }

  const existing = await VariantValue.findAll({
    where: { variant_definition_id: variantDefinitionId },
    transaction
  });
  const existingMap = new Map(existing.map(v => [v.id, v]));

  for (const v of values) {
    if (v.id && existingMap.has(v.id)) {
      const current = existingMap.get(v.id);
      await current.update({
        name: v.name !== undefined ? v.name : current.name,
        code: v.code !== undefined ? v.code : current.code
      }, { transaction });
      existingMap.delete(v.id);
    } else {
      await VariantValueRepository.create({
        variant_definition_id: variantDefinitionId,
        name: v.name,
        code: v.code
      }, { transaction });
    }
  }

  for (const toDelete of existingMap.values()) {
    await toDelete.destroy({ transaction });
  }
}

const VariantDefinitionController = {
  async index(req, res) {
    const userName = req.user?.name || 'Anonymous';
    const { company_id } = req.body;
    logger.info(`${userName} - Solicita listado de variantes (definiciones)`);
    let t;
    try {
      const variants = await VariantDefinitionRepository.findAllWithValues({
        companyId: company_id || null
      });
      return variants.length === 0
        ? res.status(204).json({ msg: "NoVariantsFound", variants: [] })
        : res.status(200).json({ variants });
    } catch (err) {
      logger.error("VariantDefinitionController->index: " + err.message);
      return res.status(500).json({ error: "ServerError", details: err.message });
    }
  },

  async store(req, res) {
    const userName = req.user?.name || 'Anonymous';
    logger.info(`${userName} - Crea nueva variante (definicion)`);
    logger.info(JSON.stringify(req.body));

    const { name, company_id, type, cant, values } = req.body;
    const variantData = { name, company_id, type, cant };
    try {
      if (company_id) {
        const company = await CompanyRepository.findById(company_id);
        if (!company) {
          return res.status(400).json({ error: "CompanyNotFound", message: "La empresa especificada no existe" });
        }
      }

      const existing = await VariantDefinitionRepository.findByName(name, company_id);
      if (existing) {
        const scope = company_id ? `en la empresa ${company_id}` : 'como variante global';
        return res.status(409).json({
          error: "DuplicateName",
          message: `Ya existe una variante con el nombre "${name}" ${scope}`
        });
      }

      t = await sequelize.transaction();
      const created = await VariantDefinitionRepository.create(variantData, { transaction: t });
      if (values !== undefined) {
        await syncVariantValues(created.id, values, t);
      }
      await t.commit();

      const variants = await VariantDefinitionRepository.findAllWithValues({ companyId: company_id || null });
      return res.status(201).json({ variants, msg: "Variante creada correctamente" });
    } catch (err) {
      if (t) {
        await t.rollback();
      }
      logger.error("VariantDefinitionController->store: " + err.message);
      return res.status(500).json({ error: "ServerError", details: err.message });
    }
  },

  async update(req, res) {
    const userName = req.user?.name || 'Anonymous';
    const variantId = req.params.id || req.body.id;
    logger.info(`${userName} - Actualiza variante ID ${variantId}`);
    logger.info(JSON.stringify({ params: req.params, body: req.body }));

    const { name, company_id, type, cant, values } = req.body;

    try {
      const variant = await VariantDefinitionRepository.findById(variantId);
      if (!variant) return res.status(404).json({ msg: "VariantNotFound" });

      if (variant.company_id === null && company_id) {
        const t = await sequelize.transaction();
        try {
          const effectiveName = name !== undefined ? name : variant.name;
          const company = await CompanyRepository.findById(company_id);
          if (!company) {
            await t.rollback();
            return res.status(400).json({ error: "CompanyNotFound", message: "La empresa especificada no existe" });
          }

          const existing = await VariantDefinitionRepository.findByName(effectiveName, company_id);
          if (existing) {
            await t.rollback();
            return res.status(409).json({
              error: "DuplicateName",
              message: `Ya existe una variante con el nombre "${effectiveName}" en la empresa ${company_id}`
            });
          }

          const newVariant = await VariantDefinitionRepository.create({
            name: effectiveName,
            company_id,
            type: type !== undefined ? type : variant.type,
            cant: cant !== undefined ? cant : variant.cant
          }, { transaction: t });

          if (values !== undefined) {
            await syncVariantValues(newVariant.id, values, t);
          } else {
            const existingValues = await VariantValueRepository.findByDefinitionId(variant.id);
            const payload = existingValues.map(v => ({ name: v.name, code: v.code }));
            await syncVariantValues(newVariant.id, payload, t);
          }

          await t.commit();

          const variants = await VariantDefinitionRepository.findAllWithValues({ companyId: company_id });
          return res.status(201).json({
            variants,
            msg: "Variante creada correctamente para la empresa",
            created_from_global: true,
            global_variant_id: variantId,
            new_variant_id: newVariant.id
          });
        } catch (err) {
          await t.rollback();
          throw err;
        }
      }

      if (company_id && company_id !== variant.company_id) {
        const company = await CompanyRepository.findById(company_id);
        if (!company) {
          return res.status(400).json({ error: "CompanyNotFound", message: "La empresa especificada no existe" });
        }
      }

      if (name && name !== variant.name) {
        const targetCompanyId = company_id !== undefined ? company_id : variant.company_id;
        const existing = await VariantDefinitionRepository.findByNameExcludingId(name, targetCompanyId, variantId);
        if (existing) {
          const scope = targetCompanyId ? `en la empresa ${targetCompanyId}` : 'como variante global';
          return res.status(409).json({
            error: "DuplicateName",
            message: `Ya existe una variante con el nombre "${name}" ${scope}`
          });
        }
      }

      const t = await sequelize.transaction();
      try {
        await VariantDefinitionRepository.update(variant, { name, company_id, type, cant }, { transaction: t });
        if (values !== undefined) {
          await syncVariantValues(variant.id, values, t);
        }
        await t.commit();
      } catch (err) {
        await t.rollback();
        throw err;
      }

      const variants = await VariantDefinitionRepository.findAllWithValues({ companyId: company_id || variant.company_id });
      return res.status(200).json({ variants, msg: "Variante editada correctamente" });
    } catch (err) {
      logger.error("VariantDefinitionController->update: " + err.message);
      return res.status(500).json({ error: "ServerError", details: err.message });
    }
  },

  async destroy(req, res) {
    const userName = req.user?.name || 'Anonymous';
    const variantId = req.params.id || req.body.id;
    logger.info(`${userName} - Elimina variante ID ${variantId}`);
    logger.info(JSON.stringify({ params: req.params, body: req.body }));

    try {
      const variant = await VariantDefinitionRepository.findById(variantId);
      if (!variant) return res.status(404).json({ msg: "VariantNotFound" });

      await VariantDefinitionRepository.delete(variant);
      const variants = await VariantDefinitionRepository.findAllWithValues({ companyId: variant.company_id });
      return res.status(200).json({ msg: "Variante eliminada correctamente", variants });
    } catch (err) {
      logger.error("VariantDefinitionController->destroy: " + err.message);
      return res.status(500).json({ error: "ServerError", details: err.message });
    }
  },

  async show(req, res) {
    const userName = req.user?.name || 'Anonymous';
    const variantId = req.params.id || req.body.id;
    logger.info(`${userName} - Consulta variante ID ${variantId}`);
    logger.info(JSON.stringify({ params: req.params, body: req.body }));

    try {
      const variant = await VariantDefinitionRepository.findById(variantId);
      if (!variant) return res.status(404).json({ msg: "VariantNotFound" });
      return res.status(200).json({ variant });
    } catch (err) {
      logger.error("VariantDefinitionController->show: " + err.message);
      return res.status(500).json({ error: "ServerError", details: err.message });
    }
  }
};

module.exports = VariantDefinitionController;
