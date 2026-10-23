'use strict';

const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs').promises;
const net = require('net');
const path = require('path');
const logger = require('../../config/logger');
const FileService = require('./FileService');
const { UPLOAD_BASE_PATH } = require('../../config/upload');

const MAX_IMAGE_BYTES = Math.max(Number(process.env.MARKETPLACE_IMPORT_IMAGE_MAX_BYTES) || 10 * 1024 * 1024, 1024 * 1024);
const MAX_IMAGES = Math.max(Number(process.env.MARKETPLACE_IMPORT_MAX_IMAGES) || 20, 1);
const PREVIEW_TEMP_FOLDER = 'tmp';
const PREVIEW_TEMP_PREFIX = 'marketplace-preview-';

const EXTENSIONS_BY_TYPE = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif'
};

function asImageUrl(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'object') return String(value.url || value.secure_url || '').trim() || null;
  return null;
}

function normalizeLocalImage(value) {
  const raw = String(value || '').trim().split(/[?#]/, 1)[0];
  if (!raw) return null;
  const match = raw.match(/^\/images\/(products|tmp)\/([^/]+)$/)
    || raw.match(/^(products|tmp)\/([^/]+)$/);
  if (match) return `${match[1]}/${path.basename(match[2])}`;
  return null;
}

function publicImageUrl(relativePath) {
  return `/images/${relativePath}`;
}

function isPreviewTemporaryPath(relativePath) {
  return typeof relativePath === 'string'
    && relativePath.startsWith(`${PREVIEW_TEMP_FOLDER}/${PREVIEW_TEMP_PREFIX}`);
}

function assertExternalImageUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('marketplace_image_url_invalid');
  }

  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('marketplace_image_url_invalid');
  }

  const hostname = parsed.hostname.toLowerCase();
  const ipVersion = net.isIP(hostname);
  const privateIpv4 = ipVersion === 4 && (
    hostname === '127.0.0.1'
    || hostname === '0.0.0.0'
    || hostname.startsWith('10.')
    || hostname.startsWith('192.168.')
    || /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)
  );
  if (hostname === 'localhost' || hostname.endsWith('.local') || privateIpv4 || hostname === '::1') {
    throw new Error('marketplace_image_url_forbidden');
  }

  return parsed;
}

function extensionFor(url, contentType) {
  const normalizedType = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (EXTENSIONS_BY_TYPE[normalizedType]) return EXTENSIONS_BY_TYPE[normalizedType];

  const urlExtension = path.extname(url.pathname || '').toLowerCase();
  return ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif'].includes(urlExtension)
    ? (urlExtension === '.jpeg' ? '.jpg' : urlExtension)
    : null;
}

function assertFalabellaImageUrl(value) {
  const parsed = assertExternalImageUrl(value);
  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== 'falabella.com' && !hostname.endsWith('.falabella.com')) {
    throw new Error('marketplace_preview_image_host_forbidden');
  }
  return parsed;
}

async function downloadImage(url, { falabellaOnly = false } = {}) {
  const parsed = falabellaOnly ? assertFalabellaImageUrl(url) : assertExternalImageUrl(url);
  const response = await axios.get(parsed.toString(), {
    responseType: 'arraybuffer',
    timeout: Math.max(Number(process.env.MARKETPLACE_IMPORT_IMAGE_TIMEOUT_MS) || 30000, 5000),
    maxContentLength: MAX_IMAGE_BYTES,
    maxBodyLength: MAX_IMAGE_BYTES,
    maxRedirects: 3,
    headers: { Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' }
  });

  const contentType = String(response.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!contentType.startsWith('image/')) throw new Error('marketplace_image_content_type_invalid');

  const buffer = Buffer.from(response.data);
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) throw new Error('marketplace_image_size_invalid');

  const extension = extensionFor(parsed, contentType);
  if (!extension) throw new Error('marketplace_image_extension_unsupported');

  return { parsed, buffer, extension };
}

async function findPreviewImage(url) {
  const digest = crypto.createHash('sha256').update(url).digest('hex').slice(0, 40);
  const baseName = `${PREVIEW_TEMP_PREFIX}${digest}`;
  const extensions = Object.values(EXTENSIONS_BY_TYPE).filter((extension, index, values) => values.indexOf(extension) === index);

  for (const extension of extensions) {
    const relativePath = `${PREVIEW_TEMP_FOLDER}/${baseName}${extension}`;
    try {
      await fs.access(path.join(UPLOAD_BASE_PATH, relativePath));
      return relativePath;
    } catch {
      // La imagen todavía no ha sido materializada con esta extensión.
    }
  }

  return null;
}

async function materializePreviewImage(url) {
  const existing = await findPreviewImage(url);
  if (existing) return existing;

  const downloaded = await downloadImage(url, { falabellaOnly: true });
  const digest = crypto.createHash('sha256').update(url).digest('hex').slice(0, 40);
  const relativePath = `${PREVIEW_TEMP_FOLDER}/${PREVIEW_TEMP_PREFIX}${digest}${downloaded.extension}`;
  const fullPath = path.join(UPLOAD_BASE_PATH, relativePath);

  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  try {
    await fs.writeFile(fullPath, downloaded.buffer, { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }

  return relativePath;
}

const MarketplaceImageService = {
  async preparePreviewImages({ images = [], mainImage = null } = {}) {
    const cache = new Map();
    const errors = [];

    const prepareOne = async (value) => {
      const raw = asImageUrl(value);
      if (!raw) return null;
      if (cache.has(raw)) return cache.get(raw);

      const promise = (async () => {
        const localPath = normalizeLocalImage(raw);
        if (localPath) {
          await fs.access(path.join(UPLOAD_BASE_PATH, localPath));
          return publicImageUrl(localPath);
        }

        const localPathForPreview = await materializePreviewImage(raw);
        return publicImageUrl(localPathForPreview);
      })().catch(error => {
        errors.push({
          url: raw,
          code: error.code || 'marketplace_preview_image_unavailable',
          status: error.response?.status || null,
          message: error.response?.data?.message || error.message || 'No se pudo guardar temporalmente la imagen'
        });
        return null;
      });

      cache.set(raw, promise);
      return promise;
    };

    const preparedImages = [];
    for (const image of Array.isArray(images) ? images : []) {
      const preparedUrl = await prepareOne(image);
      if (!preparedUrl) continue;
      preparedImages.push(
        typeof image === 'object' && image !== null
          ? { ...image, url: preparedUrl }
          : { url: preparedUrl }
      );
    }

    const preparedMainImage = mainImage ? await prepareOne(mainImage) : null;
    return {
      images: preparedImages,
      main_image: preparedMainImage,
      errors
    };
  },

  async materialize({ images = [], productId }) {
    if (!Array.isArray(images)) throw new Error('marketplace_images_must_be_array');
    if (images.length > MAX_IMAGES) throw new Error(`marketplace_images_limit_${MAX_IMAGES}`);

    const paths = [];
    const createdPaths = [];
    const seen = new Set();

    try {
      for (const image of images) {
        const raw = asImageUrl(image);
        if (!raw || seen.has(raw)) continue;
        seen.add(raw);

        const localPath = normalizeLocalImage(raw);
        if (localPath) {
          if (!isPreviewTemporaryPath(localPath)) {
            await fs.access(path.join(UPLOAD_BASE_PATH, localPath));
            paths.push(localPath);
            continue;
          }

          const temporaryPath = path.join(UPLOAD_BASE_PATH, localPath);
          await fs.access(temporaryPath);
          const extension = path.extname(localPath).toLowerCase() || '.jpg';
          const destination = FileService.generateFilename(
            'products',
            `${productId}_${Date.now()}_${crypto.randomBytes(5).toString('hex')}`,
            `marketplace${extension}`
          );
          const destinationPath = path.join(UPLOAD_BASE_PATH, destination);
          await fs.mkdir(path.dirname(destinationPath), { recursive: true });
          await fs.copyFile(temporaryPath, destinationPath);
          paths.push(destination);
          createdPaths.push(destination);
          continue;
        }

        const { buffer, extension } = await downloadImage(raw);

        const filename = FileService.generateFilename(
          'products',
          `${productId}_${Date.now()}_${crypto.randomBytes(5).toString('hex')}`,
          `marketplace${extension}`
        );
        const fullPath = path.join(UPLOAD_BASE_PATH, filename);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, buffer);
        paths.push(filename);
        createdPaths.push(filename);
      }

      return { paths, createdPaths };
    } catch (error) {
      await this.remove(createdPaths);
      logger.warn(`[MarketplaceImageService] No se pudieron materializar imágenes: ${error.message}`);
      throw error;
    }
  },

  async cleanupPreviewImages({ maxAgeMs } = {}) {
    const directory = path.join(UPLOAD_BASE_PATH, PREVIEW_TEMP_FOLDER);
    const age = Number(maxAgeMs) > 0
      ? Number(maxAgeMs)
      : (Math.max(Number(process.env.MARKETPLACE_PREVIEW_TTL_HOURS) || 6, 1) + 1) * 60 * 60 * 1000;
    const now = Date.now();
    let removed = 0;

    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return 0;
      throw error;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith(PREVIEW_TEMP_PREFIX)) continue;
      const relativePath = `${PREVIEW_TEMP_FOLDER}/${entry.name}`;
      const fullPath = path.join(UPLOAD_BASE_PATH, relativePath);
      const stats = await fs.stat(fullPath).catch(() => null);
      if (!stats || now - stats.mtimeMs < age) continue;
      await fs.unlink(fullPath).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
      removed += 1;
    }

    return removed;
  },

  async remove(paths = []) {
    for (const relativePath of paths) {
      try {
        await fs.unlink(path.join(UPLOAD_BASE_PATH, relativePath));
      } catch (error) {
        if (error.code !== 'ENOENT') logger.warn(`[MarketplaceImageService] No se pudo limpiar ${relativePath}: ${error.message}`);
      }
    }
  }
};

module.exports = MarketplaceImageService;
