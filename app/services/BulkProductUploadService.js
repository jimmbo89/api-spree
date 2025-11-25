// src/services/BulkProductUploadService.js
const XLSX = require('xlsx');
const {
  ProductRepository,
  MarketplaceRepository
} = require('../repositories');
const logger = require('../../config/logger');

class BulkProductUploadService {
  // --- Parsing y validación (sin cambios en lógica, pero datos en snake_case) ---
  static parseFile(fileBuffer, mimetype) {
    const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    if (jsonData.length < 2) {
      throw new Error('El archivo está vacío o no tiene datos');
    }

    const headers = jsonData[0].map(h => h?.toString().trim().toLowerCase());
    const requiredHeaders = ['sku', 'name', 'stock'];

    for (const req of requiredHeaders) {
      if (!headers.includes(req)) {
        throw new Error(`Falta la columna obligatoria: ${req}`);
      }
    }

    const rows = [];
    for (let i = 1; i < jsonData.length; i++) {
      const row = jsonData[i];
      if (!row || row.length === 0 || (row.length === 1 && !row[0])) continue;

      const rowData = {};
      headers.forEach((header, idx) => {
        rowData[header] = row[idx] !== undefined ? row[idx] : null;
      });

      rows.push({
        index: i + 1,
        raw: rowData,
        parsed: null,
        errors: []
      });
    }

    return rows;
  }

  static validateRows(rows) {
    const validated = [];

    for (const row of rows) {
      const { sku, name, stock, price, published } = row.raw;

      if (!sku || typeof sku !== 'string' || sku.trim() === '') {
        row.errors.push('sku es obligatorio y debe ser texto');
      } else {
        row.parsed = { ...row.parsed, sku: sku.trim() };
      }

      if (!name || typeof name !== 'string' || name.trim() === '') {
        row.errors.push('name es obligatorio y debe ser texto');
      } else {
        row.parsed = { ...row.parsed, name: name.trim() };
      }

      const stock_num = parseInt(stock);
      if (isNaN(stock_num) || stock_num < 0) {
        row.errors.push('stock debe ser un entero ≥ 0');
      } else {
        row.parsed = { ...row.parsed, stock: stock_num };
      }

      if (price !== undefined && price !== null && price !== '') {
        const price_num = parseFloat(price);
        if (isNaN(price_num) || price_num <= 0) {
          row.errors.push('price debe ser un número positivo');
        } else {
          row.parsed = { ...row.parsed, price: parseFloat(price_num.toFixed(2)) };
        }
      }

      if (published !== undefined && published !== null && published !== '') {
        const pub = published.toString().toLowerCase();
        if (['true', '1', 'yes', 'si'].includes(pub)) {
          row.parsed = { ...row.parsed, published: true };
        } else if (['false', '0', 'no'].includes(pub)) {
          row.parsed = { ...row.parsed, published: false };
        } else {
          row.errors.push('published debe ser booleano (true/false, 1/0, sí/no)');
        }
      } else {
        row.parsed = { ...row.parsed, published: false };
      }

      validated.push(row);
    }

    return validated;
  }

  static async enrichWithProductData(rows) {
    const skus = [...new Set(rows.map(r => r.parsed?.sku).filter(s => s))];
    const existing_products = await ProductRepository.findBySkus(skus);

    const sku_map = {};
    existing_products.forEach(p => {
      sku_map[p.sku] = p;
    });

    for (const row of rows) {
      if (row.errors.length > 0) continue;
      row.parsed.product = sku_map[row.parsed.sku] || null;
    }

    return rows;
  }

  // --- Resolver campos internos en snake_case ---
  static resolveInternalField(internal_field, product_data, warehouse_data = null) {
    const basic_fields = {
      'name': product_data.name,
      'description': product_data.description,
      'sku': product_data.sku,
      'base_price': product_data.base_price,
      'category_name': product_data.category?.name || null,
      'brand_name': product_data.brand?.name || null
    };

    if (basic_fields[internal_field] !== undefined) {
      return basic_fields[internal_field];
    }

    if (internal_field === 'stock_main_warehouse' && warehouse_data) {
      return warehouse_data.stock;
    }

    if (internal_field === 'primary_image_url' && product_data.images && product_data.images.length > 0) {
      return product_data.images[0].url;
    }

    if (internal_field === 'gallery_image_urls' && product_data.images) {
      return product_data.images.map(img => img.url);
    }

    logger.warn(`[BulkUpload] Campo interno no reconocido: ${internal_field}`);
    return null;
  }

  // --- Formatear para marketplace (snake_case en mapeos) ---
  static async formatForMarketplace(rows, marketplace_id) {
    const marketplace = await MarketplaceRepository.findById(marketplace_id);
    if (!marketplace) {
      throw new Error('marketplace_not_found');
    }

    const mappings = await MarketplaceRepository.findMappingsByMarketplace(marketplace_id);
    const export_mappings = mappings.filter(m => m.direction === 'export');

    const formatted_rows = [];

    for (const row of rows) {
      if (row.errors.length > 0) {
        formatted_rows.push({
          ...row,
          payload: null,
          payload_errors: ['Fila con errores de validación']
        });
        continue;
      }

      const product_data = row.parsed.product || {
        name: row.parsed.name,
        description: null,
        sku: row.parsed.sku,
        base_price: row.parsed.price,
        category: null,
        brand: null,
        images: []
      };

      const warehouse_data = { stock: row.parsed.stock };

      const payload = {};
      const payload_errors = [];

      for (const mapping of export_mappings) {
        const { internal_field, external_field, required, default_value } = mapping;

        let value = this.resolveInternalField(internal_field, product_data, warehouse_data);

        if (value === null || value === undefined || (typeof value === 'string' && value === '')) {
          if (default_value !== null && default_value !== undefined) {
            value = default_value;
          } else if (required) {
            payload_errors.push(`Campo requerido faltante: ${internal_field} (→ ${external_field})`);
          }
        }

        payload[external_field] = value;
      }

      formatted_rows.push({
        ...row,
        payload,
        payload_errors
      });
    }

    return formatted_rows;
  }
}

module.exports = BulkProductUploadService;