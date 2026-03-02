#!/usr/bin/env node
/**
 * Script de importación de comisiones desde XLSX oficial de Falabella
 * 
 * Uso desde VSCode terminal:
 *   node scripts/importCategoryCommissions.js ./data/falabella_comisiones.xlsx 5
 * 
 * Opciones:
 *   --dry-run              Solo simula, no guarda en BD
 *   --currency=CLP         Moneda (CLP, COP, PEN, MXN) - default: CLP
 *   --source=csv_import    Origen del dato - default: csv_import
 *   --skip-existing        Omite registros ya existentes
 *   --log-file=path        Ruta para guardar log detallado
 */

'use strict';

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const logger = require('../config/logger');
const { CategoryCommissionRepository } = require('../app/repositories');
require('dotenv').config();

/**
 * Parsea el porcentaje de comisión (ej: "17%" → 17.00, "0.17" → 17.00)
 */
function parseCommission(value) {
  if (!value && value !== 0) return null;
  
  let cleaned = value.toString().trim().replace('%', '').replace(',', '.');
  let parsed = parseFloat(cleaned);
  
  if (isNaN(parsed)) return null;
  
  // Si es decimal (0.13), convertir a porcentaje (13.00)
  if (parsed < 1 && parsed > 0) {
    parsed = parsed * 100;
  }
  
  return parsed;
}

/**
 * Normaliza texto: elimina espacios extra
 */
function normalizeText(text) {
  if (!text) return null;
  return text.toString().trim().replace(/\s+/g, ' ');
}

/**
 * Procesa una fila del XLSX y retorna el objeto para BD
 */
function processRow(row, marketplaceId, currency, source) {
  const level1 = normalizeText(row['Categoría']);
  const level2 = normalizeText(row['Subcategoría 1']) || null;
  const level3 = normalizeText(row['Subcategoría 2']) || null;
  
  // 🔹 FALLBACK: Usar el nivel más bajo disponible
  let level4 = normalizeText(row['Subcategoría 3']);
  if (!level4 && level3) level4 = level3;
  if (!level4 && level2) level4 = level2;
  if (!level4) level4 = level1;
  
  const commission = parseCommission(row['Comisiones f.com']);

  if (!level1 || commission === null) {
    return { 
      error: `Datos incompletos: level1="${level1}", commission="${row['Comisiones f.com']}"` 
    };
  }

  return {
    marketplace_id: marketplaceId,
    category_level_1: level1,
    category_level_2: level2,
    category_level_3: level3,
    category_level_4: level4,
    commission_percentage: commission,
    currency: currency,
    source: source
  };
}

/**
 * Función principal de importación desde XLSX
 */
async function importCommissions(xlsxPath, marketplaceId, options) {
  const {
    dryRun = false,
    currency = 'CLP',
    source = 'csv_import',
    skipExisting = false,
    logFile = null
  } = options;

  // Validar archivo XLSX
  if (!fs.existsSync(xlsxPath)) {
    logger.error(`Archivo no encontrado: ${xlsxPath}`);
    process.exit(1);
  }

  logger.info(`🚀 Iniciando importación desde: ${xlsxPath}`);
  logger.info(`📦 Marketplace ID: ${marketplaceId}, Moneda: ${currency}, Source: ${source}`);
  if (dryRun) logger.info(`🔍 Modo DRY-RUN: No se guardarán cambios en la BD`);
  if (skipExisting) logger.info(`⏭️ Modo SKIP-EXISTING: Se omitirán registros ya existentes`);

  // Stats
  const stats = {
    total: 0,
    processed: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
    warnings: []
  };

  // Log file opcional
  let logStream = null;
  if (logFile) {
    logStream = fs.createWriteStream(logFile, { flags: 'a' });
    logStream.write(`\n=== Importación iniciada: ${new Date().toISOString()} ===\n`);
  }

  const log = (msg) => {
    console.log(msg);
    if (logStream) logStream.write(msg + '\n');
  };

  try {
    // Leer archivo XLSX
    const workbook = XLSX.readFile(xlsxPath);
    const sheetName = workbook.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);

    log(`📊 Total filas encontradas: ${rows.length}`);

    // Procesar cada fila
    for (const row of rows) {
      stats.total++;

      try {
        // Procesar fila
        const data = processRow(row, marketplaceId, currency, source);
        
        if (data.error) {
          stats.errors++;
          stats.warnings.push(`Fila ${stats.total}: ${data.error}`);
          log(`[✗] Fila ${stats.total}: ${data.error}`);
          continue;
        }

        // Si skip-existing, verificar si ya existe (usando Repository)
        if (skipExisting) {
          const existing = await CategoryCommissionRepository.findByCategoryPath(
            marketplaceId,
            data.category_level_1,
            data.category_level_4
          );

          if (existing) {
            stats.skipped++;
            log(`[⏭️] Fila ${stats.total}: Registrado existente omitido - "${data.category_level_4}"`);
            continue;
          }
        }

        // Upsert (insertar o actualizar) - USANDO REPOSITORY
        if (!dryRun) {
          const commissionData = {
            ...data,
            is_active: 1,
            last_synced_at: new Date()
          };

          // ✅ CORRECCIÓN: Usar bulkImport del Repository
          const result = await CategoryCommissionRepository.bulkImport([commissionData], marketplaceId, {
            currency,
            source
          });

          if (result.success > 0) {
            stats.inserted++;
            log(`[✓+] Fila ${stats.total}: Insertado - "${data.category_level_4}" (${data.commission_percentage}%)`);
          } else {
            stats.updated++;
            log(`[✓~] Fila ${stats.total}: Actualizado - "${data.category_level_4}" (${data.commission_percentage}%)`);
          }
        } else {
          // Dry-run: solo simular
          stats.processed++;
          log(`[🔍] Fila ${stats.total}: Simulado - "${data.category_level_4}" (${data.commission_percentage}%)`);
        }

      } catch (err) {
        stats.errors++;
        stats.warnings.push(`Fila ${stats.total}: ${err.message}`);
        log(`[✗] Fila ${stats.total}: Error - ${err.message}`);
      }
    }

    // Resumen final
    log('\n' + '='.repeat(60));
    log('📈 RESUMEN DE IMPORTACIÓN');
    log('='.repeat(60));
    log(`Total filas procesadas: ${stats.total}`);
    log(`Insertadas: ${stats.inserted}`);
    log(`Actualizadas: ${stats.updated}`);
    log(`Omitidas (skip-existing): ${stats.skipped}`);
    log(`Errores: ${stats.errors}`);
    
    if (stats.warnings.length > 0) {
      log(`\n⚠️ Primeras 10 advertencias:`);
      stats.warnings.slice(0, 10).forEach(w => log(`   - ${w}`));
      if (stats.warnings.length > 10) {
        log(`   ... y ${stats.warnings.length - 10} más`);
      }
    }
    log('='.repeat(60) + '\n');

    // Cerrar log file
    if (logStream) {
      logStream.write(`=== Importación finalizada: ${new Date().toISOString()} ===\n`);
      logStream.end();
    }

    return stats;

  } catch (error) {
    logger.error(`❌ Error crítico en importación: ${error.message}`);
    if (logStream) {
      logStream.write(`ERROR CRÍTICO: ${error.message}\n`);
      logStream.end();
    }
    throw error;
  }
}

/**
 * Parsea argumentos de línea de comandos
 */
function parseArgs() {
  const args = process.argv.slice(2);
  
  if (args.length < 2) {
    console.error(`
Uso: node scripts/importCategoryCommissions.js <xlsx_path> <marketplace_id> [options]

Argumentos obligatorios:
  xlsx_path         Ruta al archivo XLSX de comisiones de Falabella
  marketplace_id    ID numérico de la tabla 'marketplaces' (ej: 5 para falabella_cl)

Opciones:
  --dry-run              Solo simula, no guarda en BD
  --currency=CLP         Moneda: CLP, COP, PEN, MXN (default: CLP)
  --source=csv_import    Origen: csv_import, manual, api_sync (default: csv_import)
  --skip-existing        Omite registros ya existentes (por defecto actualiza)
  --log-file=path        Ruta para guardar log detallado

Ejemplos:
  node scripts/importCategoryCommissions.js ./data/falabella_comisiones.xlsx 5
  node scripts/importCategoryCommissions.js ./data/falabella_comisiones.xlsx 5 --dry-run
  node scripts/importCategoryCommissions.js ./data/falabella_comisiones.xlsx 5 --currency=COP --skip-existing
    `);
    process.exit(1);
  }

  const [xlsxPath, marketplaceIdStr] = args;
  const marketplaceId = parseInt(marketplaceIdStr);
  
  if (isNaN(marketplaceId)) {
    logger.error(`marketplace_id debe ser un número válido, recibido: "${marketplaceIdStr}"`);
    process.exit(1);
  }

  const options = {};
  
  args.slice(2).forEach(arg => {
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg.startsWith('--currency=')) options.currency = arg.split('=')[1];
    else if (arg.startsWith('--source=')) options.source = arg.split('=')[1];
    else if (arg === '--skip-existing') options.skipExisting = true;
    else if (arg.startsWith('--log-file=')) options.logFile = arg.split('=')[1];
  });

  return { xlsxPath, marketplaceId, options };
}

// Ejecución principal
if (require.main === module) {
  (async () => {
    try {
      const { xlsxPath, marketplaceId, options } = parseArgs();
      const stats = await importCommissions(xlsxPath, marketplaceId, options);
      process.exit(stats.errors > 0 ? 1 : 0);
    } catch (error) {
      logger.error(`❌ Error fatal: ${error.message}`);
      process.exit(1);
    }
  })();
}

module.exports = { importCommissions, parseCommission, processRow };