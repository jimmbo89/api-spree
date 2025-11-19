const XLSX = require('xlsx');
const { ProductRepository, ProductCategoryRepository } = require('../repositories');
const logger = require('../../config/logger');

class BulkProductUploadService {
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
        index: i + 1, // Número de fila (para mostrar errores)
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

      // Validar SKU
      if (!sku || typeof sku !== 'string' || sku.trim() === '') {
        row.errors.push('sku es obligatorio y debe ser texto');
      } else {
        row.parsed = { ...row.parsed, sku: sku.trim() };
      }

      // Validar name
      if (!name || typeof name !== 'string' || name.trim() === '') {
        row.errors.push('name es obligatorio y debe ser texto');
      } else {
        row.parsed = { ...row.parsed, name: name.trim() };
      }

      // Validar stock
      const stockNum = parseInt(stock);
      if (isNaN(stockNum) || stockNum < 0) {
        row.errors.push('stock debe ser un entero ≥ 0');
      } else {
        row.parsed = { ...row.parsed, stock: stockNum };
      }

      // Validar price (opcional)
      if (price !== undefined && price !== null && price !== '') {
        const priceNum = parseFloat(price);
        if (isNaN(priceNum) || priceNum <= 0) {
          row.errors.push('price debe ser un número positivo');
        } else {
          row.parsed = { ...row.parsed, price: parseFloat(priceNum.toFixed(2)) };
        }
      }

      // Validar published (opcional)
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
    // Extraer SKUs únicos
    const skus = [...new Set(rows.map(r => r.parsed?.sku).filter(s => s))];
    const existingProducts = await ProductRepository.findBySkus(skus);

    const skuMap = {};
    existingProducts.forEach(p => {
      skuMap[p.sku] = p;
    });

    for (const row of rows) {
      if (row.errors.length > 0) continue;
      row.parsed.product = skuMap[row.parsed.sku] || null;
    }

    return rows;
  }
}

module.exports = BulkProductUploadService;