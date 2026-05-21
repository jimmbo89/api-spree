const fs = require("fs").promises;
const path = require("path");
const XLSX = require("xlsx");
const axios = require("axios");
const logger = require("../../config/logger");
const { UPLOAD_BASE_PATH } = require("../../config/upload");
const { sequelize } = require("../models");
const {
  CompanyRepository,
  ProductRepository,
  ProductCategoryRepository,
  AttributeRepository,
  ProductAttributeRepository,
  ProductVariantRepository,
  ProductVariantValueRepository,
  VariantDefinitionRepository,
  VariantValueRepository,
} = require("../repositories");
const FileService = require("./FileService");

const HEADER_ALIASES = {
  sku: ["sku", "referencia", "codigo", "codigo_producto", "product_code"],
  name: ["name", "nombre", "titulo", "title"],
  category_name: ["category", "categoria", "rubro", "category_name"],
  brand: ["brand", "marca"],
  description: ["description", "descripcion", "detalle"],
  condition: ["condition", "condicion", "estado_producto"],
  gtin: ["gtin", "ean", "upc", "isbn"],
  mpn: ["mpn"],
  warranty_months: ["warranty_months", "garantia_meses"],
  warranty_text: ["warranty_text", "garantia", "texto_garantia"],
  sale_price: ["sale_price", "precio", "precio_venta", "precio_final"],
  purchase_price: ["purchase_price", "costo", "precio_compra"],
  image_url: ["image_url", "imagen", "foto", "url_imagen", "image"],
  model: ["model", "modelo"],
  weight: ["weight", "peso", "peso_g", "peso_kg"],
  weight_unit: ["weight_unit", "unidad_peso"],
  length: ["length", "largo"],
  length_unit: ["length_unit", "unidad_largo"],
  width: ["width", "ancho"],
  width_unit: ["width_unit", "unidad_ancho"],
  height: ["height", "alto"],
  height_unit: ["height_unit", "unidad_alto"],
  depth: ["depth", "profundidad"],
  depth_unit: ["depth_unit", "unidad_profundidad"],
};

const VARIANT_HEADERS = new Set([
  "color",
  "talla",
  "size",
  "capacidad",
  "sabor",
  "presentacion",
  "fragancia",
]);

const CONDITION_MAP = {
  new: "new",
  nuevo: "new",
  used: "used",
  usado: "used",
  refurbished: "refurbished",
  reacondicionado: "refurbished",
  not_specified: "not_specified",
  no_especificado: "not_specified",
};

const MIME_EXTENSION_MAP = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

const ALLOWED_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);

const FIELD_ALIAS_MAP = buildFieldAliasMap();

function buildFieldAliasMap() {
  const aliases = {};
  for (const [field, list] of Object.entries(HEADER_ALIASES)) {
    for (const item of list) {
      aliases[normalizeHeader(item)] = field;
    }
  }
  return aliases;
}

function normalizeHeader(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeNameKey(value) {
  return normalizeHeader(value);
}

function humanizeHeader(value) {
  const cleaned = String(value || "").trim().replace(/[_-]+/g, " ");
  if (!cleaned) return "";
  return cleaned
    .split(/\s+/)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function isEmptyValue(value) {
  return value === null || value === undefined || String(value).trim() === "";
}

function parseNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  let normalized = String(value).trim();
  if (!normalized) return null;

  normalized = normalized.replace(/\s+/g, "");
  if (normalized.includes(",") && normalized.includes(".")) {
    normalized = normalized.replace(/,/g, "");
  } else if (normalized.includes(",")) {
    normalized = normalized.replace(",", ".");
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function inferAttributeType(value) {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";

  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "true" || normalized === "false") return "boolean";
  if (parseNumber(value) !== null) return "number";
  return "text";
}

function normalizeCondition(value) {
  const key = normalizeHeader(value);
  return CONDITION_MAP[key] || "new";
}

function splitImageUrls(value) {
  if (isEmptyValue(value)) return [];
  return String(value)
    .split(/[|,]/)
    .map(item => item.trim())
    .filter(Boolean);
}

function toBoolean(value) {
  if (typeof value === "boolean") return value;
  const normalized = String(value || "").trim().toLowerCase();
  if (["true", "1", "si", "sí", "yes"].includes(normalized)) return true;
  if (["false", "0", "no"].includes(normalized)) return false;
  return value;
}

function convertWeightToGrams(value, unit) {
  if (value === null) return null;
  const normalizedUnit = String(unit || "g").trim().toLowerCase();
  if (normalizedUnit === "kg") return Math.round(value * 1000);
  if (normalizedUnit === "mg") return Math.round(value / 1000);
  return Math.round(value);
}

function convertDimensionToCm(value, unit) {
  if (value === null) return null;
  const normalizedUnit = String(unit || "cm").trim().toLowerCase();
  if (normalizedUnit === "m") return value * 100;
  if (normalizedUnit === "mm") return value / 10;
  return value;
}

function buildMeasurements(data) {
  const weightValue = parseNumber(data.weight);
  const weightUnit = String(data.weight_unit || "g").trim() || "g";
  const lengthValue = parseNumber(data.length);
  const lengthUnit = String(data.length_unit || "cm").trim() || "cm";
  const widthValue = parseNumber(data.width);
  const widthUnit = String(data.width_unit || "cm").trim() || "cm";
  const heightValue = parseNumber(data.height);
  const heightUnit = String(data.height_unit || "cm").trim() || "cm";
  const depthValue = parseNumber(data.depth);
  const depthUnit = String(data.depth_unit || "cm").trim() || "cm";

  const hasAnyMeasurement = [
    weightValue,
    lengthValue,
    widthValue,
    heightValue,
    depthValue,
  ].some(item => item !== null);

  if (!hasAnyMeasurement) {
    return {
      product_measurements: {},
      weight_grams: null,
      length_cm: null,
      width_cm: null,
      height_cm: null,
    };
  }

  let volumetricWeight = null;
  if (lengthValue !== null && widthValue !== null && heightValue !== null) {
    const lengthCm = convertDimensionToCm(lengthValue, lengthUnit);
    const widthCm = convertDimensionToCm(widthValue, widthUnit);
    const heightCm = convertDimensionToCm(heightValue, heightUnit);
    volumetricWeight = Number(((lengthCm * widthCm * heightCm) / 5000).toFixed(2));
  }

  return {
    product_measurements: {
      weight: { value: weightValue, unit: weightUnit },
      dimensions: {
        length: { value: lengthValue, unit: lengthUnit },
        width: { value: widthValue, unit: widthUnit },
        height: { value: heightValue, unit: heightUnit },
        depth: { value: depthValue, unit: depthUnit },
      },
      volumetric_weight: { value: volumetricWeight, unit: "kg" },
    },
    weight_grams: convertWeightToGrams(weightValue, weightUnit),
    length_cm: convertDimensionToCm(lengthValue, lengthUnit),
    width_cm: convertDimensionToCm(widthValue, widthUnit),
    height_cm: convertDimensionToCm(heightValue, heightUnit),
  };
}

async function ensureDirectory(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function safeUnlink(filePath) {
  if (!filePath) return;
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      logger.warn(`[ProductBulkImportService] No se pudo eliminar temporal ${filePath}: ${error.message}`);
    }
  }
}

class ProductBulkImportService {
  static async importFile({ filePath, companyId, userId }) {
    const company = await CompanyRepository.findById(companyId);
    if (!company) {
      throw new Error("companyNotFound");
    }

    const rows = this.parseFile(filePath);
    if (rows.length === 0) {
      throw new Error("El archivo no contiene registros para importar");
    }

    const caches = await this.buildCaches(companyId);
    const currentProductCount = await ProductRepository.countByCompanyId(companyId);
    const maxProducts = company.plan?.max_products;

    const summary = {
      success: true,
      total_rows: rows.length,
      processed_rows: 0,
      created_products: 0,
      failed_rows: 0,
      warnings_count: 0,
      rows: [],
    };

    for (const row of rows) {
      const limitReached =
        maxProducts !== undefined &&
        maxProducts !== -1 &&
        (currentProductCount + summary.created_products) >= maxProducts;

      if (limitReached) {
        summary.failed_rows += 1;
        summary.processed_rows += 1;
        summary.rows.push({
          row_number: row.row_number,
          success: false,
          sku: row.raw_sku || null,
          name: row.raw_name || null,
          errors: ["PLAN_LIMIT_REACHED"],
          warnings: [],
        });
        continue;
      }

      const result = await this.processRow({
        row,
        companyId,
        userId,
        caches,
      });

      summary.processed_rows += 1;
      summary.rows.push(result);
      summary.warnings_count += result.warnings.length;

      if (result.success) {
        summary.created_products += 1;
      } else {
        summary.failed_rows += 1;
      }
    }

    summary.success = summary.failed_rows === 0;
    return summary;
  }

  static parseFile(filePath) {
    const workbook = XLSX.readFile(filePath, { raw: false });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];

    if (!sheet) {
      return [];
    }

    const rows = XLSX.utils.sheet_to_json(sheet, {
      defval: "",
      raw: false,
    });

    return rows
      .map((row, index) => {
        const normalized = {};
        const originalHeaders = {};

        for (const [header, value] of Object.entries(row)) {
          const normalizedHeader = normalizeHeader(header);
          if (!normalizedHeader) continue;
          normalized[normalizedHeader] = value;
          originalHeaders[normalizedHeader] = header;
        }

        const hasData = Object.values(normalized).some(value => !isEmptyValue(value));
        if (!hasData) return null;

        return {
          row_number: index + 2,
          original_headers: originalHeaders,
          normalized,
          raw_sku: normalized.sku || normalized.referencia || normalized.codigo || null,
          raw_name: normalized.name || normalized.nombre || normalized.titulo || null,
        };
      })
      .filter(Boolean);
  }

  static async buildCaches(companyId) {
    const [categories, attributes, variantDefinitions] = await Promise.all([
      ProductCategoryRepository.findAll({ companyId }),
      AttributeRepository.findAll({ companyId, withUsageCount: false }),
      VariantDefinitionRepository.findAllWithValues({ companyId }),
    ]);

    const categoryByName = new Map();
    for (const category of categories) {
      categoryByName.set(normalizeNameKey(category.name), category);
    }

    const attributeByName = new Map();
    for (const attribute of attributes) {
      attributeByName.set(normalizeNameKey(attribute.name), attribute);
    }

    const variantByName = new Map();
    for (const definition of variantDefinitions) {
      const valuesByName = new Map();
      for (const value of definition.values || []) {
        valuesByName.set(normalizeNameKey(value.name), value);
      }
      variantByName.set(normalizeNameKey(definition.name), {
        definition,
        valuesByName,
      });
    }

    return {
      categoryByName,
      attributeByName,
      variantByName,
    };
  }

  static async processRow({ row, companyId, userId, caches }) {
    const warnings = [];
    const tempFiles = [];
    let transaction = null;
    let createdProduct = null;

    try {
      const mapped = await this.mapRowToProductPayload({
        row,
        companyId,
        userId,
        caches,
        warnings,
      });

      if (!mapped.payload.sku) {
        throw new Error("SKU obligatorio");
      }

      if (!mapped.payload.name) {
        throw new Error("Nombre obligatorio");
      }

      if (await ProductRepository.existsBySku(mapped.payload.sku, companyId)) {
        throw new Error(`El SKU "${mapped.payload.sku}" ya existe en empresa`);
      }

      const existingVariantSku = await ProductVariantRepository.findBySku(mapped.payload.sku);
      if (existingVariantSku) {
        throw new Error(`Ya existe variante con SKU "${mapped.payload.sku}"`);
      }

      tempFiles.push(...mapped.files);
      transaction = await sequelize.transaction();

      createdProduct = await ProductRepository.create(mapped.payload, mapped.files, {
        transaction,
      });

      for (const attribute of mapped.attributes) {
        await ProductAttributeRepository.create({
          product_id: createdProduct.id,
          attribute_id: attribute.attribute_id,
          value: String(attribute.value),
        }, { transaction });
      }

      if (mapped.variant.variant_value_ids.length > 0) {
        const productVariant = await ProductVariantRepository.create({
          product_id: createdProduct.id,
          sku: createdProduct.sku,
          attributes: mapped.variant.attributes,
        }, { transaction });

        await ProductVariantValueRepository.replaceValuesForVariant(
          productVariant.id,
          mapped.variant.variant_value_ids,
          { transaction, companyId }
        );
      } else {
        await ProductVariantRepository.create({
          product_id: createdProduct.id,
          sku: createdProduct.sku,
          attributes: {},
        }, { transaction });
      }

      await transaction.commit();

      return {
        row_number: row.row_number,
        success: true,
        sku: createdProduct.sku,
        name: createdProduct.name,
        product_id: createdProduct.id,
        warnings,
        errors: [],
      };
    } catch (error) {
      if (transaction) {
        await transaction.rollback();
      }

      if (createdProduct?.images && Array.isArray(createdProduct.images)) {
        for (const imagePath of createdProduct.images) {
          await FileService.deleteFile(imagePath);
        }
      }

      for (const file of tempFiles) {
        await safeUnlink(file.path);
      }

      logger.warn(`[ProductBulkImportService] Fila ${row.row_number} fallida: ${error.message}`);

      return {
        row_number: row.row_number,
        success: false,
        sku: row.raw_sku || null,
        name: row.raw_name || null,
        warnings,
        errors: [error.message],
      };
    }
  }

  static async mapRowToProductPayload({ row, companyId, userId, caches, warnings }) {
    const payload = {
      company_id: companyId,
      user_id: userId,
      brand: "Generico",
      condition: "new",
      sync_meta: {
        import_source: "bulk_file",
        row_number: row.row_number,
      },
    };

    const attributeEntries = [];
    const variantEntries = [];

    for (const [normalizedHeader, rawValue] of Object.entries(row.normalized)) {
      if (isEmptyValue(rawValue)) continue;

      const originalHeader = row.original_headers[normalizedHeader] || normalizedHeader;
      const directField = FIELD_ALIAS_MAP[normalizedHeader];

      if (directField) {
        payload[directField] = rawValue;
        continue;
      }

      if (normalizedHeader.startsWith("attr_")) {
        const attributeName = humanizeHeader(originalHeader.replace(/^attr[_\s-]*/i, ""));
        attributeEntries.push({ name: attributeName, value: rawValue });
        continue;
      }

      if (normalizedHeader.startsWith("variant_")) {
        const variantName = humanizeHeader(originalHeader.replace(/^variant[_\s-]*/i, ""));
        variantEntries.push({ name: variantName, value: rawValue });
        continue;
      }

      if (VARIANT_HEADERS.has(normalizedHeader)) {
        variantEntries.push({ name: humanizeHeader(originalHeader), value: rawValue });
        continue;
      }

      attributeEntries.push({ name: humanizeHeader(originalHeader), value: rawValue });
    }

    payload.sku = String(payload.sku || "").trim();
    payload.name = String(payload.name || "").trim();
    payload.brand = isEmptyValue(payload.brand) ? "Generico" : String(payload.brand).trim();
    payload.description = isEmptyValue(payload.description) ? null : String(payload.description).trim();
    payload.model = isEmptyValue(payload.model) ? null : String(payload.model).trim();
    payload.condition = normalizeCondition(payload.condition);
    payload.gtin = isEmptyValue(payload.gtin) ? null : String(payload.gtin).trim();
    payload.mpn = isEmptyValue(payload.mpn) ? null : String(payload.mpn).trim();
    payload.warranty_months = parseNumber(payload.warranty_months);
    payload.warranty_text = isEmptyValue(payload.warranty_text) ? null : String(payload.warranty_text).trim();
    payload.sale_price = parseNumber(payload.sale_price);
    payload.purchase_price = parseNumber(payload.purchase_price);

    const categoryName = isEmptyValue(payload.category_name) ? null : String(payload.category_name).trim();
    delete payload.category_name;

    if (categoryName) {
      const category = await this.ensureCategory(categoryName, companyId, caches);
      payload.category_id = category.id;
    } else {
      payload.category_id = null;
    }

    const measurements = buildMeasurements(payload);
    payload.product_measurements = measurements.product_measurements;
    payload.weight_grams = measurements.weight_grams;
    payload.length_cm = measurements.length_cm;
    payload.width_cm = measurements.width_cm;
    payload.height_cm = measurements.height_cm;
    payload.packaging_measurements = {};

    const files = await this.downloadImages(payload.image_url, payload.sku, warnings);
    delete payload.image_url;

    const attributes = [];
    for (const entry of attributeEntries) {
      const attribute = await this.ensureAttribute(entry.name, entry.value, companyId, caches);
      attributes.push({
        attribute_id: attribute.id,
        value: toBoolean(entry.value),
      });
    }

    const variantValueIds = [];
    const variantAttributes = {};
    for (const entry of variantEntries) {
      const variantValue = await this.ensureVariantValue(entry.name, entry.value, companyId, caches);
      variantValueIds.push(variantValue.id);
      variantAttributes[entry.name] = String(entry.value).trim();
    }

    return {
      payload,
      files,
      attributes,
      variant: {
        variant_value_ids: variantValueIds,
        attributes: variantAttributes,
      },
    };
  }

  static async ensureCategory(categoryName, companyId, caches) {
    const cleanName = categoryName.trim();
    const key = normalizeNameKey(cleanName);
    if (caches.categoryByName.has(key)) {
      return caches.categoryByName.get(key);
    }

    const existing = await ProductCategoryRepository.findByName(cleanName, companyId);
    if (existing) {
      caches.categoryByName.set(key, existing);
      return existing;
    }

    let created;
    try {
      created = await ProductCategoryRepository.create({
        name: cleanName,
        company_id: companyId,
        status: 1,
      });
    } catch (error) {
      const refetched = await ProductCategoryRepository.findByName(cleanName, companyId);
      if (refetched) {
        caches.categoryByName.set(key, refetched);
        return refetched;
      }
      throw error;
    }

    caches.categoryByName.set(key, created);
    return created;
  }

  static async ensureAttribute(attributeName, sampleValue, companyId, caches) {
    const cleanName = attributeName.trim();
    const key = normalizeNameKey(cleanName);
    if (caches.attributeByName.has(key)) {
      return caches.attributeByName.get(key);
    }

    const existing = await AttributeRepository.findByName(cleanName, companyId);
    if (existing) {
      caches.attributeByName.set(key, existing);
      return existing;
    }

    let created;
    try {
      created = await AttributeRepository.create({
        name: cleanName,
        company_id: companyId,
        type: inferAttributeType(sampleValue),
        cant: null,
      });
    } catch (error) {
      const refetched = await AttributeRepository.findByName(cleanName, companyId);
      if (refetched) {
        caches.attributeByName.set(key, refetched);
        return refetched;
      }
      throw error;
    }

    caches.attributeByName.set(key, created);
    return created;
  }

  static async ensureVariantValue(variantName, variantValueName, companyId, caches) {
    const cleanVariantName = variantName.trim();
    const cleanValueName = String(variantValueName).trim();
    const definitionKey = normalizeNameKey(cleanVariantName);
    let entry = caches.variantByName.get(definitionKey);

    if (!entry) {
      const existingDefinition = await VariantDefinitionRepository.findByName(cleanVariantName, companyId);
      let definition = existingDefinition;

      if (!definition) {
        try {
          definition = await VariantDefinitionRepository.create({
            name: cleanVariantName,
            company_id: companyId,
            type: "text",
            cant: null,
          });
        } catch (error) {
          definition = await VariantDefinitionRepository.findByName(cleanVariantName, companyId);
          if (!definition) throw error;
        }
      }

      entry = {
        definition,
        valuesByName: new Map(),
      };

      const existingValues = await VariantValueRepository.findByDefinitionId(definition.id);
      for (const value of existingValues) {
        entry.valuesByName.set(normalizeNameKey(value.name), value);
      }

      caches.variantByName.set(definitionKey, entry);
    }

    const valueKey = normalizeNameKey(cleanValueName);
    if (entry.valuesByName.has(valueKey)) {
      return entry.valuesByName.get(valueKey);
    }

    const existingValue = await VariantValueRepository.findByDefinitionIdAndName(entry.definition.id, cleanValueName);
    if (existingValue) {
      entry.valuesByName.set(valueKey, existingValue);
      return existingValue;
    }

    let createdValue;
    try {
      createdValue = await VariantValueRepository.create({
        variant_definition_id: entry.definition.id,
        name: cleanValueName,
        code: null,
      });
    } catch (error) {
      const refetched = await VariantValueRepository.findByDefinitionIdAndName(entry.definition.id, cleanValueName);
      if (refetched) {
        entry.valuesByName.set(valueKey, refetched);
        return refetched;
      }
      throw error;
    }

    entry.valuesByName.set(valueKey, createdValue);
    return createdValue;
  }

  static async downloadImages(imageValue, sku, warnings) {
    const urls = splitImageUrls(imageValue);
    if (urls.length === 0) return [];

    const tempDir = path.join(UPLOAD_BASE_PATH, "tmp", "product-import");
    await ensureDirectory(tempDir);

    const files = [];

    for (let i = 0; i < urls.length; i += 1) {
      const url = urls[i];
      try {
        const response = await axios.get(url, {
          responseType: "arraybuffer",
          timeout: 15000,
          maxContentLength: 10 * 1024 * 1024,
        });

        const contentType = String(response.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
        const urlExtension = path.extname(new URL(url).pathname).toLowerCase();
        const extension = ALLOWED_IMAGE_EXTENSIONS.has(urlExtension)
          ? urlExtension
          : MIME_EXTENSION_MAP[contentType];

        if (!contentType.startsWith("image/") || !extension) {
          warnings.push(`Imagen omitida por tipo no valido: ${url}`);
          continue;
        }

        const filename = `${normalizeHeader(sku) || "product"}-${Date.now()}-${i}${extension}`;
        const tempPath = path.join(tempDir, filename);
        await fs.writeFile(tempPath, response.data);

        files.push({
          path: tempPath,
          originalname: filename,
        });
      } catch (error) {
        warnings.push(`No se pudo descargar imagen: ${url}`);
      }
    }

    return files;
  }
}

module.exports = ProductBulkImportService;
