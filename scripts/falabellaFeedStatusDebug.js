#!/usr/bin/env node
'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const { MarketplaceCredentialRepository } = require('../app/repositories');
const { sequelize } = require('../app/models');

function parseArgs(argv) {
  const args = {
    checks: [],
    credentialId: null,
    sellerEmail: process.env.FALABELLA_SELLER_EMAIL || null,
    sellerId: process.env.FALABELLA_SELLER_ID || null,
    apiKey: process.env.FALABELLA_API_KEY || null,
    logFile: process.env.FALABELLA_DEBUG_LOG_FILE || 'logs/falabella-feed-debug.json'
  };

  for (const raw of argv) {
    if (raw.startsWith('--credential-id=')) {
      args.credentialId = Number(raw.split('=')[1]);
      continue;
    }

    if (raw.startsWith('--seller-email=')) {
      args.sellerEmail = raw.split('=').slice(1).join('=');
      continue;
    }

    if (raw.startsWith('--seller-id=')) {
      args.sellerId = raw.split('=').slice(1).join('=');
      continue;
    }

    if (raw.startsWith('--api-key=')) {
      args.apiKey = raw.split('=').slice(1).join('=');
      continue;
    }

    if (raw.startsWith('--log-file=')) {
      args.logFile = raw.split('=').slice(1).join('=');
      continue;
    }

    if (raw.startsWith('--check=')) {
      const value = raw.split('=').slice(1).join('=');
      args.checks.push(parseCheck(value));
      continue;
    }

    args.checks.push(parseCheck(raw));
  }

  if (args.checks.length === 0) {
    const envRequestIds = String(process.env.FALABELLA_DEBUG_REQUEST_IDS || '')
      .split(',')
      .map(item => item.trim())
      .filter(Boolean);

    args.checks = envRequestIds.map(parseCheck);
  }

  return args;
}

function parseCheck(value) {
  const [requestId, sku] = String(value).split(':');
  return {
    requestId: requestId?.trim(),
    sku: sku?.trim() || null
  };
}

function rfc3986Encode(str) {
  return encodeURIComponent(str)
    .replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function timestampMinus03(date = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}-03:00`;
}

function buildSignedUrl(params, apiKey) {
  const canonicalQuery = Object.keys(params)
    .sort()
    .map(k => `${rfc3986Encode(k)}=${rfc3986Encode(String(params[k]))}`)
    .join('&');

  const signatureHex = crypto
    .createHmac('sha256', apiKey.trim())
    .update(canonicalQuery, 'utf8')
    .digest('hex');

  return `https://sellercenter-api.falabella.com?${canonicalQuery}&Signature=${rfc3986Encode(signatureHex)}`;
}

function normalizeMessages(items) {
  if (!items) return [];

  const list = Array.isArray(items) ? items : [items];
  return list.filter(Boolean).map(item => ({
    field: item.Field || item.Attribute || null,
    sku: item.SellerSku || item.SKU || null,
    message: item.Message || item.Error || item.Warning || item.Description || String(item),
    value: item.Value || null
  }));
}

function mapRecommendedStatus(feed) {
  const status = String(feed?.Status || '').toLowerCase();
  const warnings = normalizeMessages(feed?.FeedWarnings?.Warning);
  const errors = normalizeMessages(feed?.FeedErrors?.Error);
  const failedRecords = parseInt(feed?.FailedRecords || '0', 10);

  if (status === 'finished' && failedRecords === 0 && errors.length === 0 && warnings.length === 0) {
    return {
      internal_status: 'published',
      reason: 'Feed finalizado sin errores ni warnings'
    };
  }

  if (status === 'finished' && failedRecords === 0 && errors.length === 0 && warnings.length > 0) {
    return {
      internal_status: 'published_with_warnings',
      reason: 'Feed finalizado con warnings pero sin errores reportados'
    };
  }

  if (status === 'queued' || status === 'processing') {
    return {
      internal_status: 'pending',
      reason: 'Falabella todavía no termina de procesar el feed'
    };
  }

  return {
    internal_status: 'failed',
    reason: 'Feed con errores, cancelado o final no exitoso'
  };
}

async function fetchFeedStatus(credential, requestId) {
  const params = {
    UserID: credential.seller_email.trim(),
    Version: '1.0',
    Action: 'FeedStatus',
    Format: 'JSON',
    Timestamp: timestampMinus03(),
    FeedID: requestId
  };

  const url = buildSignedUrl(params, credential.api_key);
  const response = await axios.get(url, { timeout: 15000 });
  const feed = response.data?.SuccessResponse?.Body?.Feed;

  if (!feed) {
    throw new Error('Respuesta sin SuccessResponse.Body.Feed');
  }

  return feed;
}

async function fetchProductStatus(credential, sku) {
  const params = {
    UserID: credential.seller_email.trim(),
    Version: '1.0',
    Action: 'GetProducts',
    Format: 'JSON',
    Timestamp: timestampMinus03(),
    SellerSku: sku
  };

  const url = buildSignedUrl(params, credential.api_key);
  const response = await axios.get(url, { timeout: 15000 });
  const products = response.data?.SuccessResponse?.Body?.Products?.Product;

  if (!products) {
    return { found: false, product: null };
  }

  const list = Array.isArray(products) ? products : [products];
  const product = list.find(item => item.SellerSku === sku) || list[0];
  let businessUnit = product?.BusinessUnits?.BusinessUnit || null;

  if (Array.isArray(businessUnit)) {
    businessUnit = businessUnit[0];
  }

  return {
    found: !!product,
    product: product ? {
      sku: product.SellerSku,
      name: product.Name || null,
      status: businessUnit?.Status || null,
      published: businessUnit?.IsPublished === '1' || businessUnit?.IsPublished === 1,
      stock: businessUnit?.Stock != null ? parseInt(businessUnit.Stock, 10) : null,
      price: businessUnit?.Price != null ? Number(businessUnit.Price) : null,
      qc_status: product.QCStatus || null,
      url: product.Url || null,
      last_updated: product.LastUpdateDate || null
    } : null
  };
}

function formatFalabellaError(error) {
  const head = error?.response?.data?.ErrorResponse?.Head;
  if (head) {
    return {
      http_status: error?.response?.status || null,
      code: head.ErrorCode || null,
      message: head.ErrorMessage || error.message
    };
  }

  const rawData = error?.response?.data;
  const rawBody = typeof rawData === 'string'
    ? rawData.slice(0, 800)
    : rawData
      ? JSON.stringify(rawData).slice(0, 800)
      : null;

  return {
    http_status: error?.response?.status || null,
    code: null,
    message: error.message || 'Error desconocido',
    raw_body: rawBody
  };
}

async function resolveCredentials(args) {
  if (args.credentialId) {
    const credential = await MarketplaceCredentialRepository.findById(args.credentialId);
    if (!credential) {
      throw new Error(`No se encontró credential_id=${args.credentialId}`);
    }

    return [credential];
  }

  if (args.sellerEmail && args.apiKey) {
    return [{
      id: 'env',
      name: 'ENV',
      seller_email: args.sellerEmail,
      seller_id: args.sellerId,
      api_key: args.apiKey
    }];
  }

  const credentials = await MarketplaceCredentialRepository.findAllActiveFalabella();
  if (!credentials.length) {
    throw new Error('No hay credenciales activas de Falabella en la BD y tampoco se enviaron por variables de entorno');
  }

  return credentials;
}

async function inspectCheck(credentials, check) {
  const attempts = [];

  for (const credential of credentials) {
    try {
      const feed = await fetchFeedStatus(credential, check.requestId);
      const recommended = mapRecommendedStatus(feed);
      const warnings = normalizeMessages(feed?.FeedWarnings?.Warning);
      const errors = normalizeMessages(feed?.FeedErrors?.Error);

      const result = {
        request_id: check.requestId,
        credential: {
          id: credential.id,
          name: credential.name || null,
          seller_email: credential.seller_email || null,
          seller_id: credential.seller_id || null
        },
        feed: {
          feed_id: feed.FeedID || check.requestId,
          status: feed.Status || null,
          action: feed.Action || null,
          source: feed.Source || null,
          total_records: parseInt(feed.TotalRecords || '0', 10),
          processed_records: parseInt(feed.ProcessedRecords || '0', 10),
          failed_records: parseInt(feed.FailedRecords || '0', 10),
          created_at: feed.CreatedAt || null,
          updated_at: feed.UpdatedAt || null
        },
        recommended_status: recommended.internal_status,
        recommended_reason: recommended.reason,
        warnings,
        errors,
        product_check: null
      };

      if (check.sku) {
        try {
          result.product_check = await fetchProductStatus(credential, check.sku);
        } catch (productError) {
          result.product_check = {
            error: formatFalabellaError(productError)
          };
        }
      }

      return result;
    } catch (error) {
      attempts.push({
        credential_id: credential.id,
        credential_name: credential.name || null,
        seller_email: credential.seller_email || null,
        error: formatFalabellaError(error)
      });
    }
  }

  return {
    request_id: check.requestId,
    credential: null,
    feed: null,
    recommended_status: 'unknown',
    recommended_reason: 'No se pudo consultar el feed con las credenciales disponibles',
    warnings: [],
    errors: [],
    product_check: null,
    attempts
  };
}

function printResult(result) {
  console.log('='.repeat(100));
  console.log(`request_id: ${result.request_id}`);
  console.log(`recommended_status: ${result.recommended_status}`);
  console.log(`reason: ${result.recommended_reason}`);

  if (result.credential) {
    console.log(`credential_id: ${result.credential.id}`);
    console.log(`credential_name: ${result.credential.name || 'N/A'}`);
    console.log(`seller_email: ${result.credential.seller_email || 'N/A'}`);
  }

  if (result.feed) {
    console.log(`feed_status: ${result.feed.status || 'N/A'}`);
    console.log(`feed_action: ${result.feed.action || 'N/A'}`);
    console.log(`processed/total: ${result.feed.processed_records}/${result.feed.total_records}`);
    console.log(`failed_records: ${result.feed.failed_records}`);
    console.log(`created_at: ${result.feed.created_at || 'N/A'}`);
    console.log(`updated_at: ${result.feed.updated_at || 'N/A'}`);
  }

  if (result.warnings.length > 0) {
    console.log('warnings:');
    result.warnings.forEach((warning, index) => {
      console.log(`  ${index + 1}. ${warning.field || '-'} | ${warning.sku || '-'} | ${warning.message}`);
    });
  } else {
    console.log('warnings: none');
  }

  if (result.errors.length > 0) {
    console.log('errors:');
    result.errors.forEach((error, index) => {
      console.log(`  ${index + 1}. ${error.field || '-'} | ${error.sku || '-'} | ${error.message}`);
    });
  } else {
    console.log('errors: none');
  }

  if (result.product_check) {
    if (result.product_check.error) {
      console.log(`product_check_error: [${result.product_check.error.code || 'N/A'}] ${result.product_check.error.message}`);
      if (result.product_check.error.raw_body) {
        console.log(`product_check_raw: ${result.product_check.error.raw_body}`);
      }
    } else if (!result.product_check.found) {
      console.log('product_check: SKU no encontrado en GetProducts');
    } else {
      console.log(`product_check: found=true published=${result.product_check.product.published} status=${result.product_check.product.status || 'N/A'} qc_status=${result.product_check.product.qc_status || 'N/A'}`);
      console.log(`product_url: ${result.product_check.product.url || 'N/A'}`);
    }
  }

  if (result.attempts?.length) {
    console.log('credential_attempts:');
    result.attempts.forEach((attempt, index) => {
      console.log(`  ${index + 1}. credential_id=${attempt.credential_id} seller_email=${attempt.seller_email || 'N/A'} http=${attempt.error.http_status || 'N/A'} error=[${attempt.error.code || 'N/A'}] ${attempt.error.message}`);
      if (attempt.error.raw_body) {
        console.log(`     raw: ${attempt.error.raw_body}`);
      }
    });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.checks.length === 0) {
    console.error('Uso: node scripts/falabellaFeedStatusDebug.js <request_id> [request_id2] [--credential-id=123]');
    console.error('Uso con SKU: node scripts/falabellaFeedStatusDebug.js --check=<request_id>:<sku>');
    console.error('Uso con ENV: FALABELLA_SELLER_EMAIL=... FALABELLA_API_KEY=... node scripts/falabellaFeedStatusDebug.js <request_id>');
    console.error('Uso sin args: definir FALABELLA_DEBUG_REQUEST_IDS=id1,id2 en .env y ejecutar node scripts/falabellaFeedStatusDebug.js');
    process.exitCode = 1;
    return;
  }

  const credentials = await resolveCredentials(args);
  const results = [];

  for (const check of args.checks) {
    results.push(await inspectCheck(credentials, check));
  }

  results.forEach(printResult);

  if (args.logFile) {
    const target = path.resolve(args.logFile);
    fs.writeFileSync(target, JSON.stringify(results, null, 2), 'utf8');
    console.log(`\nLog JSON guardado en: ${target}`);
  }
}

main()
  .catch(error => {
    console.error('Error ejecutando diagnóstico:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await sequelize.close();
    } catch (e) {
      // noop
    }
  });
