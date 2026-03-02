#!/usr/bin/env node
/**
 * Script de importación de comisiones desde CSV oficial de Falabella
 * 
 * Uso:
 *   node scripts/importCategoryCommissions.js <csv_path> <marketplace_id> [options]
 * 
 * Opciones:
 *   --dry-run              Solo simula, no guarda en BD
 *   --currency=CLP         Moneda (CLP, COP, PEN, MXN) - default: CLP
 *   --source=csv_import    Origen del dato (csv_import, manual, api_sync) - default: csv_import
 *   --skip-existing        Omite registros ya existentes (por defecto actualiza)
 *   --log-file=path        Ruta para guardar log detallado
 * 
 * Ejemplos:
 *   node scripts/importCategoryCommissions.js ./falabella_comisiones.csv 5
 *   node scripts/importCategoryCommissions.js ./falabella_comisiones.csv 5 --dry-run --currency=CLP
 *   node scripts/importCategoryCommissions.js ./falabella_comisiones.csv 5 --skip-existing --log-file=./import.log
 */

'use strict';

const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const { Sequelize, Op } = require('sequelize');
require('dotenv').config();

// Cargar modelo (ajusta la ruta según tu estructura)
const { CategoryCommission } = require('../app/models');
const logger = require('../config/logger');

/**
 * Parsea el porcentaje de comisión (ej: "17%" → 17.00)
 */
function parseCommission(value) {
  if (!value) return null;
  const cleaned = value.toString().trim().replace('%', '').replace(',', '.');
  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? null : parsed;
}

/**
 * Normaliza texto: elimina espacios extra, normaliza acentos si es necesario
 */
function normalizeText(text) {
  if (!text) return null;
  return text.toString().trim().replace(/\s+/g, ' ');
}

/**
 * Procesa una fila del CSV y retorna el objeto para BD
 */
function processRow(row, marketplaceId, currency, source) {
  const level1 = normalizeText(row['Categoría']);
  const level2 = normalizeText(row['Subcategoría 1']) || null;
  const level3 = normalizeText(row['Subcategoría 2']) || null;
  const level4 = normalizeText(row['Subcategoría 3']);
  const commission = parseCommission(row['Comisiones f.com']);

  // Validaciones mínimas
  if (!level1 || !level4 || commission === null) {
    return { error: `Datos incompletos: level1="${level1}", level4="${level4}", commission="${row['Comisiones f.com']}"` };
  }

  return {
    marketplace_id: marketplaceId,
    category_level_1: level1,
    category_level_2: level2,
    category_level_3: level3,
    category_level_4: level4,
    commission_percentage: commission,
    currency: currency,
    source: source,
    is_active: 1,
    last_synced_at: new Date()
  };
}

/**
 * Función principal de importación
 */
async function importCommissions(csvPath, marketplaceId, options) {
  const {
    dryRun = false,
    currency = 'CLP',
    source = 'csv_import',
    skipExisting = false,
    logFile = null
  } = options;

  // Validar archivo CSV
  if (!fs.existsSync(csvPath)) {
    logger.error(`Archivo no encontrado: ${csvPath}`);
    process.exit(1);
  }

  logger.info(`🚀 Iniciando importación desde: ${csvPath}`);
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
    // Leer CSV línea por línea (streaming para archivos grandes)
    await new Promise((resolve, reject) => {
      fs.createReadStream(csvPath, { encoding: 'utf8' })
        .pipe(csv({ separator: '\t' })) // ← CSV usa TAB como separador
        .on('data', async (row) => {
          stats.total++;

          try {
            // Procesar fila
            const data = processRow(row, marketplaceId, currency, source);
            
            if (data.error) {
              stats.errors++;
              stats.warnings.push(`Fila ${stats.total}: ${data.error}`);
              log(`[✗] Fila ${stats.total}: ${data.error}`);
              return;
            }

            // Buscar si ya existe (por ruta única + marketplace)
            const existing = skipExisting 
              ? await CategoryCommission.findOne({
                  where: {
                    marketplace_id: marketplaceId,
                    category_level_1: data.category_level_1,
                    category_level_2: data.category_level_2 || { [Op.is]: null },
                    category_level_3: data.category_level_3 || { [Op.is]: null },
                    category_level_4: data.category_level_4
                  }
                })
              : null;

            if (existing && skipExisting) {
              stats.skipped++;
              log(`[⏭️] Fila ${stats.total}: Registrado existente omitido - "${data.category_level_4}"`);
              return;
            }

            // Upsert (insertar o actualizar)
            if (!dryRun) {
              const [_, created] = await CategoryCommission.upsert(data, {
                conflictFields: ['marketplace_id', 'category_level_1', 'category_level_2', 'category_level_3', 'category_level_4']
              });
              
              if (created) {
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
        })
        .on('end', () => {
          log(`\n📊 Procesamiento de CSV completado`);
          resolve();
        })
        .on('error', (err) => {
          logger.error(`Error leyendo CSV: ${err.message}`);
          reject(err);
        });
    });

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
Uso: node importCategoryCommissions.js <csv_path> <marketplace_id> [options]

Argumentos obligatorios:
  csv_path          Ruta al archivo CSV de comisiones de Falabella
  marketplace_id    ID numérico de la tabla 'marketplaces' (ej: 5 para falabella_cl)

Opciones:
  --dry-run              Solo simula, no guarda en BD
  --currency=CLP         Moneda: CLP, COP, PEN, MXN (default: CLP)
  --source=csv_import    Origen: csv_import, manual, api_sync (default: csv_import)
  --skip-existing        Omite registros ya existentes (por defecto actualiza)
  --log-file=path        Ruta para guardar log detallado

Ejemplos:
  node scripts/importCategoryCommissions.js ./falabella_comisiones.csv 5
  node scripts/importCategoryCommissions.js ./falabella_comisiones.csv 5 --dry-run
  node scripts/importCategoryCommissions.js ./falabella_comisiones.csv 5 --currency=COP --skip-existing
    `);
    process.exit(1);
  }

  const [csvPath, marketplaceIdStr] = args;
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

  return { csvPath, marketplaceId, options };
}

// Ejecución principal
if (require.main === module) {
  (async () => {
    try {
      const { csvPath, marketplaceId, options } = parseArgs();
      
      // Inicializar conexión a BD (ajusta según tu config)
      // Si usas sequelize-cli, la conexión ya está configurada en models/index.js
      
      const stats = await importCommissions(csvPath, marketplaceId, options);
      
      // Código de salida según errores
      process.exit(stats.errors > 0 ? 1 : 0);
      
    } catch (error) {
      logger.error(`❌ Error fatal: ${error.message}`);
      process.exit(1);
    }
  })();
}

module.exports = { importCommissions, parseCommission, processRow };