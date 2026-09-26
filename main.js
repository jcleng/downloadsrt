import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chardet from 'chardet';
import * as cheerio from 'cheerio';
import iconv from 'iconv-lite';
import unrar from 'node-unrar-js';
import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici';
import yauzl from 'yauzl';

const ASSRT_ORIGIN = 'https://assrt.net';
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAX_SRT_BYTES = 32 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 1000;

let proxyDispatcherState = null;

function getProxyDispatcher() {
  const httpProxy = process.env.http_proxy || process.env.HTTP_PROXY || '';
  const httpsProxy = process.env.https_proxy || process.env.HTTPS_PROXY || '';
  const noProxy = process.env.no_proxy || process.env.NO_PROXY || '';
  const key = `${httpProxy}\u0000${httpsProxy}\u0000${noProxy}`;

  if (!httpProxy && !httpsProxy) {
    return null;
  }

  if (proxyDispatcherState?.key !== key) {
    proxyDispatcherState?.dispatcher?.close().catch(() => {});
    proxyDispatcherState = {
      key,
      dispatcher: new EnvHttpProxyAgent()
    };
  }

  return proxyDispatcherState.dispatcher;
}

class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
  }
}

function isAssrtHost(hostname) {
  const host = hostname.toLowerCase();
  return host === 'assrt.net' || host.endsWith('.assrt.net');
}

function isAssrtFileHost(hostname) {
  return /^file\d*\.assrt\.net$/iu.test(hostname);
}

function toSecureUrl(value) {
  if (value.protocol === 'http:' && isAssrtFileHost(value.hostname)) {
    const secureUrl = new URL(value);
    secureUrl.protocol = 'https:';
    return secureUrl;
  }
  return value;
}

function assertAllowedUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new AppError(400, 'INVALID_URL', 'Invalid URL');
  }

  const isAllowedHttps = url.protocol === 'https:' && isAssrtHost(url.hostname);
  const isAllowedFileHttp = url.protocol === 'http:' && isAssrtFileHost(url.hostname);
  if (!isAllowedHttps && !isAllowedFileHttp) {
    throw new AppError(400, 'INVALID_URL', 'URL is not allowed');
  }

  return url;
}

function getResponseHeader(response, name) {
  return response.headers?.get?.(name) || null;
}

async function readResponseBuffer(response, maxBytes) {
  const contentLength = Number(getResponseHeader(response, 'content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new AppError(502, 'UPSTREAM_TOO_LARGE', 'Upstream response is too large');
  }

  if (!response.body || typeof response.body.getReader !== 'function') {
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > maxBytes) {
      throw new AppError(502, 'UPSTREAM_TOO_LARGE', 'Upstream response is too large');
    }
    return data;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new AppError(502, 'UPSTREAM_TOO_LARGE', 'Upstream response is too large');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }

  return Buffer.concat(chunks);
}

async function fetchBuffer(value, options, maxBytes) {
  let url = toSecureUrl(assertAllowedUrl(value));
  const fetchImpl = options.fetchImpl || undiciFetch;
  const dispatcher = options.dispatcher ?? getProxyDispatcher();
  const controller = new AbortController();
  const configuredTimeout = Number(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : DEFAULT_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
      const requestOptions = {
        redirect: 'manual',
        signal: controller.signal
      };
      if (dispatcher) {
        requestOptions.dispatcher = dispatcher;
      }
      const response = await fetchImpl(url, requestOptions);

      if (response.status >= 300 && response.status < 400) {
        const location = getResponseHeader(response, 'location');
        if (!location) {
          throw new AppError(502, 'UPSTREAM_ERROR', 'Upstream returned an invalid redirect');
        }
        try {
          url = toSecureUrl(assertAllowedUrl(new URL(location, url)));
        } catch {
          throw new AppError(502, 'INVALID_REDIRECT', 'Upstream redirect is not allowed');
        }
        continue;
      }

      if (!response.ok) {
        const status = response.status === 404 ? 404 : 502;
        const code = response.status === 404 ? 'UPSTREAM_NOT_FOUND' : 'UPSTREAM_ERROR';
        throw new AppError(status, code, `Upstream returned HTTP ${response.status}`);
      }

      return await readResponseBuffer(response, maxBytes);
    }

    throw new AppError(502, 'TOO_MANY_REDIRECTS', 'Upstream redirected too many times');
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    if (error?.name === 'AbortError') {
      throw new AppError(504, 'UPSTREAM_TIMEOUT', 'Upstream request timed out');
    }
    throw new AppError(502, 'UPSTREAM_ERROR', 'Unable to reach upstream');
  } finally {
    clearTimeout(timeout);
  }
}

const detailUrls = new Map();
const inFlightDownloads = new Map();

function getCacheDirectory(options) {
  return path.resolve(options.cacheDir || process.env.CACHE_DIR || path.join(process.cwd(), '.cache', 'srt'));
}

function getCacheTtl(options) {
  const value = Number(options.ttlMs ?? process.env.CACHE_TTL_MS ?? 24 * 60 * 60 * 1000);
  return Number.isFinite(value) && value > 0 ? value : 24 * 60 * 60 * 1000;
}

async function readCachedSubtitle(id, cacheDir, ttlMs) {
  const filePath = path.join(cacheDir, `${id}.srt`);

  try {
    const fileStat = await stat(filePath);
    if (Date.now() - fileStat.mtimeMs > ttlMs || fileStat.size > MAX_SRT_BYTES) {
      await unlink(filePath).catch(() => {});
      return null;
    }
    return await readFile(filePath);
  } catch {
    return null;
  }
}

async function writeCachedSubtitle(id, data, cacheDir) {
  await mkdir(cacheDir, { recursive: true });
  const filePath = path.join(cacheDir, `${id}.srt`);
  const temporaryPath = path.join(cacheDir, `.${id}.${randomUUID()}.tmp`);

  try {
    await writeFile(temporaryPath, data, { flag: 'wx' });
    await rename(temporaryPath, filePath);
  } finally {
    await unlink(temporaryPath).catch(() => {});
  }
}

function getDetailCandidates(id) {
  const knownUrl = detailUrls.get(id);
  if (knownUrl) {
    return [knownUrl];
  }

  const group = id.slice(0, 3);
  const candidates = [
    `${ASSRT_ORIGIN}/xml/sub/${group}/${id}.xml`,
    `${ASSRT_ORIGIN}/sub/${id}.html`,
    `${ASSRT_ORIGIN}/sub/${id}`
  ];

  if (group !== id) {
    candidates.push(`${ASSRT_ORIGIN}/xml/sub/${id}/${id}.xml`);
  }

  return candidates;
}

async function findDownloadUrl(id, options) {
  let lastError = null;

  for (const detailUrl of getDetailCandidates(id)) {
    try {
      const html = decodeSubtitle(await fetchBuffer(detailUrl, options, MAX_PAGE_BYTES));
      const downloadUrl = extractDownloadUrl(html, detailUrl);
      if (downloadUrl) {
        return downloadUrl;
      }
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError instanceof AppError && lastError.status >= 500) {
    throw lastError;
  }
  throw new AppError(404, 'SUBTITLE_NOT_FOUND', 'Subtitle download was not found');
}

export async function downloadSubtitle(id, options = {}) {
  if (typeof id !== 'string' || !/^\d{1,12}$/u.test(id)) {
    throw new AppError(400, 'INVALID_ID', 'id must be numeric');
  }

  const cacheDir = getCacheDirectory(options);
  const ttlMs = getCacheTtl(options);
  const existing = inFlightDownloads.get(id);
  if (existing) {
    return existing;
  }

  const task = (async () => {
    const cached = await readCachedSubtitle(id, cacheDir, ttlMs);
    if (cached) {
      return cached;
    }

    const downloadUrl = await findDownloadUrl(id, options);
    const archive = await fetchBuffer(downloadUrl, options, MAX_ARCHIVE_BYTES);
    let extracted;

    try {
      extracted = await extractFirstSrt(archive, {
        maxEntries: MAX_ARCHIVE_ENTRIES,
        maxSrtBytes: MAX_SRT_BYTES
      });
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError(422, 'INVALID_ARCHIVE', error.message || 'Unable to extract SRT');
    }

    if (extracted.data.length > MAX_SRT_BYTES) {
      throw new AppError(422, 'SRT_TOO_LARGE', 'SRT file is too large');
    }

    const subtitle = Buffer.from(decodeSubtitle(extracted.data), 'utf8');
    if (subtitle.length > MAX_SRT_BYTES) {
      throw new AppError(422, 'SRT_TOO_LARGE', 'SRT file is too large');
    }

    await writeCachedSubtitle(id, subtitle, cacheDir).catch(() => {});
    return subtitle;
  })();

  inFlightDownloads.set(id, task);
  try {
    return await task;
  } finally {
    inFlightDownloads.delete(id);
  }
}

const MAX_SEARCH_PAGE = 100;

export function normalizeSearchPage(value) {
  if (value === undefined || value === null || value === '') {
    return 1;
  }

  const text = String(value).trim();
  if (!/^\d+$/u.test(text)) {
    throw new AppError(400, 'INVALID_PAGE', 'page must be an integer between 1 and 100');
  }

  const page = Number(text);
  if (!Number.isSafeInteger(page) || page < 1 || page > MAX_SEARCH_PAGE) {
    throw new AppError(400, 'INVALID_PAGE', 'page must be an integer between 1 and 100');
  }

  return page;
}

export async function searchSubtitles(query, options = {}, page = 1) {
  if (typeof query !== 'string' || !query.trim() || query.length > 100) {
    throw new AppError(400, 'INVALID_QUERY', 'q must be between 1 and 100 characters');
  }

  const currentPage = normalizeSearchPage(page);
  const url = new URL('/sub/', ASSRT_ORIGIN);
  url.searchParams.set('searchword', query.trim());
  if (currentPage > 1) {
    url.searchParams.set('page', String(currentPage));
  }

  const html = decodeSubtitle(await fetchBuffer(url, options, MAX_PAGE_BYTES));
  const results = parseSearchResults(html);

  detailUrls.clear();
  for (const result of results) {
    detailUrls.set(result.id, result.detailUrl);
  }

  return results;
}

function sendJson(response, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': data.length,
    'x-content-type-options': 'nosniff'
  });
  response.end(data);
}

function sendAppError(response, error) {
  const status = error instanceof AppError ? error.status : 500;
  const code = error instanceof AppError ? error.code : 'INTERNAL_ERROR';
  const message = error instanceof AppError ? error.message : 'Internal server error';
  sendJson(response, status, { error: code, message });
}

const CORS_DEFAULT_MAX_AGE = 86400;
const CORS_EXPOSED_HEADERS = 'content-disposition, content-length, content-type';

function resolveCorsPolicy(value) {
  const text = value === undefined || value === null ? '*' : String(value).trim();
  if (!text) {
    return { wildcard: true, origins: new Set() };
  }

  const origins = new Set(
    text.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean)
  );

  if (origins.has('*')) {
    return { wildcard: true, origins: new Set() };
  }

  return { wildcard: false, origins };
}

function applyCorsHeaders(request, response, policy) {
  const origin = request.headers.origin;

  if (policy.wildcard) {
    response.setHeader('access-control-allow-origin', '*');
  } else if (origin && policy.origins.has(String(origin).toLowerCase())) {
    response.setHeader('access-control-allow-origin', origin);
    response.setHeader('vary', 'Origin');
  }

  response.setHeader('access-control-expose-headers', CORS_EXPOSED_HEADERS);
}

function sendPreflight(request, response, policy) {
  applyCorsHeaders(request, response, policy);
  response.setHeader('access-control-allow-methods', 'GET, HEAD, OPTIONS');

  const requestedHeaders = request.headers['access-control-request-headers'];
  response.setHeader(
    'access-control-allow-headers',
    requestedHeaders || 'content-type'
  );

  const configuredMaxAge = Number(policy.maxAge ?? process.env.CORS_MAX_AGE ?? CORS_DEFAULT_MAX_AGE);
  const maxAge = Number.isFinite(configuredMaxAge) && configuredMaxAge > 0
    ? Math.floor(configuredMaxAge)
    : CORS_DEFAULT_MAX_AGE;
  response.setHeader('access-control-max-age', String(maxAge));

  response.writeHead(204, { 'content-length': '0' });
  response.end();
}

export function createApp(options = {}) {
  const corsPolicy = resolveCorsPolicy(options.corsOrigin ?? process.env.CORS_ORIGIN);
  if (options.corsMaxAge !== undefined) {
    corsPolicy.maxAge = options.corsMaxAge;
  }

  return createServer(async (request, response) => {
    try {
      applyCorsHeaders(request, response, corsPolicy);

      if (request.method === 'OPTIONS') {
        sendPreflight(request, response, corsPolicy);
        return;
      }

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.setHeader('allow', 'GET, HEAD, OPTIONS');
        sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED', message: 'Only GET is supported' });
        return;
      }

      const requestUrl = new URL(request.url, 'http://localhost');
      if (requestUrl.pathname === '/search') {
        const page = normalizeSearchPage(requestUrl.searchParams.get('page'));
        const results = await searchSubtitles(requestUrl.searchParams.get('q'), options, page);
        sendJson(response, 200, results);
        return;
      }

      const downloadMatch = requestUrl.pathname.match(/^\/download\/([^/]+?)(?i:\.srt)?\/?$/u);
      if (downloadMatch) {
        let id;
        try {
          id = decodeURIComponent(downloadMatch[1]);
        } catch {
          throw new AppError(400, 'INVALID_ID', 'id must be numeric');
        }
        const subtitle = await downloadSubtitle(id, options);
        response.writeHead(200, {
          'content-type': 'application/x-subrip; charset=utf-8',
          'content-length': subtitle.length,
          'content-disposition': `attachment; filename="${id}.srt"`,
          'x-content-type-options': 'nosniff'
        });
        response.end(subtitle);
        return;
      }

      sendJson(response, 404, { error: 'NOT_FOUND', message: 'Route not found' });
    } catch (error) {
      sendAppError(response, error);
    }
  });
}

export function startServer(options = {}) {
  const port = Number(options.port ?? process.env.PORT ?? 3000);
  return createApp(options).listen(port);
}

function normalizeText(value) {
  return value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function getLabeledValue(text, label) {
  const match = text.match(new RegExp(`${label}\\s*[：:]\\s*(.*?)(?=\\s*(?:版本|格式|字幕格式|语种|语言|字幕语种|来源|制作|校订|上传|日期|发布时间|字幕文件名|查阅次数|下载次数|翻译质量)\\s*[：:]|\\s+\\d{4}-\\d{2}-\\d{2}(?:\\s|$)|\\s+\\d+周前(?:\\s|$)|$)`, 'u'));
  return match ? normalizeText(match[1]) : null;
}

function getCardVersion($, card) {
  const version = card.find('#meta_top b, .sublist_box_title_l + * b').first().text();
  if (version) {
    return normalizeText(version);
  }
  return getLabeledValue(normalizeText(card.text()), '版本');
}

function openZip(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, autoClose: false, decodeStrings: false }, (error, zipFile) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(zipFile);
    });
  });
}

function listZipEntries(zipFile, maxEntries) {
  return new Promise((resolve, reject) => {
    const entries = [];
    let settled = false;

    const fail = (error) => {
      if (!settled) {
        settled = true;
        reject(error);
        zipFile.close();
      }
    };

    zipFile.on('entry', (entry) => {
      if (entries.length >= maxEntries) {
        fail(new Error('Archive contains too many entries'));
        return;
      }
      entries.push(entry);
      zipFile.readEntry();
    });
    zipFile.on('end', () => {
      if (!settled) {
        settled = true;
        resolve(entries);
      }
    });
    zipFile.on('error', fail);
    zipFile.readEntry();
  });
}

function getZipEntryName(entry) {
  return yauzl.getFileNameLowLevel(
    entry.generalPurposeBitFlag,
    entry.fileName,
    entry.extraFields,
    false
  );
}

function isSafeArchivePath(name) {
  if (typeof name !== 'string' || !name || name.includes('\0')) {
    return false;
  }

  const normalized = name.replaceAll('\\', '/');
  return !normalized.startsWith('/')
    && !/^[a-z]:/iu.test(normalized)
    && !normalized.split('/').includes('..');
}

function readZipEntry(zipFile, entry, maxBytes) {
  return new Promise((resolve, reject) => {
    if (entry.uncompressedSize > maxBytes) {
      reject(new Error('SRT file is too large'));
      return;
    }

    zipFile.openReadStream(entry, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }

      const chunks = [];
      let size = 0;
      stream.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          stream.destroy(new Error('SRT file is too large'));
          return;
        }
        chunks.push(chunk);
      });
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  });
}

async function extractFirstSrtFromZip(buffer, options = {}) {
  const maxEntries = options.maxEntries || MAX_ARCHIVE_ENTRIES;
  const maxSrtBytes = options.maxSrtBytes || MAX_SRT_BYTES;
  const zipFile = await openZip(buffer);

  try {
    const entries = await listZipEntries(zipFile, maxEntries);
    const candidates = entries
      .map((item) => ({ entry: item, name: getZipEntryName(item) }))
      .filter(({ name }) => (
        isSafeArchivePath(name)
        && !name.endsWith('/')
        && name.toLowerCase().endsWith('.srt')
      ))
      .sort((left, right) => left.name.localeCompare(right.name, 'en'));
    const candidate = candidates[0];

    if (!candidate) {
      throw new Error('Archive does not contain an SRT file');
    }

    return {
      name: candidate.name,
      data: await readZipEntry(zipFile, candidate.entry, maxSrtBytes)
    };
  } finally {
    zipFile.close();
  }
}

async function extractFirstSrtFromRar(buffer, options = {}) {
  const maxEntries = options.maxEntries || MAX_ARCHIVE_ENTRIES;
  const maxSrtBytes = options.maxSrtBytes || MAX_SRT_BYTES;
  const data = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const extractor = await unrar.createExtractorFromData({ data });
  const fileHeaders = [...extractor.getFileList().fileHeaders];

  if (fileHeaders.length > maxEntries) {
    throw new Error('Archive contains too many entries');
  }

  const candidate = fileHeaders
    .filter((item) => (
      !item.flags.directory
      && isSafeArchivePath(item.name)
      && item.name.toLowerCase().endsWith('.srt')
    ))
    .sort((left, right) => left.name.localeCompare(right.name, 'en'))[0];

  if (!candidate) {
    throw new Error('Archive does not contain an SRT file');
  }

  if (candidate.unpSize > maxSrtBytes) {
    throw new Error('SRT file is too large');
  }

  const extracted = [...extractor.extract({ files: [candidate.name] }).files];
  const file = extracted.find((item) => item.fileHeader.name === candidate.name);

  if (!file?.extraction) {
    throw new Error(`Unable to extract ${candidate.name}`);
  }

  const dataBuffer = Buffer.from(file.extraction);
  if (dataBuffer.length > maxSrtBytes) {
    throw new Error('SRT file is too large');
  }

  return {
    name: candidate.name,
    data: dataBuffer
  };
}

function hasUtfBom(buffer) {
  return buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
}

function isValidUtf8(buffer) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

function scoreDecodedText(text) {
  const cjkCount = (text.match(/[\u3400-\u9fff]/gu) || []).length;
  const replacementCount = (text.match(/\ufffd/gu) || []).length;
  const controlCount = (text.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu) || []).length;
  return cjkCount * 20 - replacementCount * 10 - controlCount * 5;
}

export function decodeSubtitle(buffer) {
  if (hasUtfBom(buffer)) {
    return iconv.decode(buffer.subarray(3), 'utf8');
  }

  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return iconv.decode(buffer.subarray(2), 'utf16le');
  }

  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return iconv.decode(buffer.subarray(2), 'utf16be');
  }

  if (isValidUtf8(buffer)) {
    return iconv.decode(buffer, 'utf8');
  }

  const detected = chardet.detect(buffer);
  const candidates = [...new Set([
    detected,
    'GB18030',
    'Big5',
    'Shift_JIS',
    'EUC-JP',
    'EUC-KR',
    'windows-1252'
  ].filter((encoding) => encoding && iconv.encodingExists(encoding)))];
  const analyses = chardet.analyse(buffer);
  let best = detected && iconv.encodingExists(detected)
    ? {
        encoding: detected,
        text: iconv.decode(buffer, detected),
        score: (analyses.find((item) => item.name === detected)?.confidence || 0)
          + scoreDecodedText(iconv.decode(buffer, detected))
      }
    : null;

  for (const encoding of candidates) {
    const text = iconv.decode(buffer, encoding);
    const confidence = analyses.find((item) => item.name === encoding)?.confidence || 0;
    const score = confidence + scoreDecodedText(text);

    if (!best || score > best.score) {
      best = { encoding, text, score };
    }
  }

  return best?.text || iconv.decode(buffer, 'utf8');
}

function looksLikeSrt(text) {
  return /\d{1,3}:\d{2}:\d{2}[,.]\d{1,3}\s*-->\s*\d{1,3}:\d{2}:\d{2}[,.]\d{1,3}/u.test(text);
}

export async function extractFirstSrt(buffer, options = {}) {
  if (buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50) {
    return extractFirstSrtFromZip(buffer, options);
  }

  const rar4Signature = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]);
  const rar5Signature = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]);
  if (buffer.subarray(0, rar4Signature.length).equals(rar4Signature)
    || buffer.subarray(0, rar5Signature.length).equals(rar5Signature)) {
    return extractFirstSrtFromRar(buffer, options);
  }

  const maxSrtBytes = options.maxSrtBytes ?? MAX_SRT_BYTES;
  if (buffer.length <= maxSrtBytes && looksLikeSrt(decodeSubtitle(buffer))) {
    return { name: 'subtitle.srt', data: buffer };
  }

  throw new Error('Unsupported archive format');
}

export function extractDownloadUrl(html, pageUrl = ASSRT_ORIGIN) {
  const $ = cheerio.load(html);
  const candidates = [];

  for (const element of $('a').toArray()) {
    const link = $(element);
    candidates.push(link.attr('href'));
    const onclick = link.attr('onclick') || '';
    for (const match of onclick.matchAll(/location\.href='([^']+)'/gu)) {
      candidates.push(match[1]);
    }
  }

  for (const candidate of candidates) {
    if (!candidate || candidate === '#') {
      continue;
    }

    try {
      const url = new URL(candidate, pageUrl);
      const isAssrtDownloadHost = isAssrtHost(url.hostname);
      const isAllowedProtocol = url.protocol === 'https:' || (url.protocol === 'http:' && isAssrtFileHost(url.hostname));
      const hasSubtitleExtension = /^\/download\/.+\.(?:srt|zip|rar)$/iu.test(url.pathname);

      if (isAllowedProtocol && isAssrtDownloadHost && hasSubtitleExtension) {
        return url.toString();
      }
    } catch {
      continue;
    }
  }

  return null;
}

export function parseSearchResults(html) {
  const $ = cheerio.load(html);
  const results = [];

  $('.resultcard > .subitem:not(#top-banner):not(#bottom-banner)').each((_, element) => {
    const card = $(element);
    const text = normalizeText(card.text());
    const format = getLabeledValue(text, '格式');

    if (format?.toLowerCase() !== 'subrip(srt)') {
      return;
    }

    const detailLink = card.find('a[href*="/sub/"]').first();
    const href = detailLink.attr('href');
    if (!href) {
      return;
    }

    let detailUrl;
    try {
      detailUrl = new URL(href, ASSRT_ORIGIN);
    } catch {
      return;
    }

    if (detailUrl.protocol !== 'https:' || !isAssrtHost(detailUrl.hostname)) {
      return;
    }

    const id =
      detailUrl.pathname.match(/^\/xml\/sub\/\d+\/(\d+)\.xml$/u)?.[1] ??
      detailUrl.pathname.match(/^\/sub\/(\d+)(?:\/|\.html?$)/u)?.[1];
    if (!id) {
      return;
    }

    const dateText = getLabeledValue(text, '日期') || getLabeledValue(text, '发布时间');
    const dateMatch = text.match(/\b\d{4}-\d{2}-\d{2}\b/u);

    results.push({
      id,
      title: normalizeText(detailLink.attr('title') || detailLink.text()) || null,
      version: getCardVersion($, card),
      format,
      language: getLabeledValue(text, '语言') || getLabeledValue(text, '语种') || getLabeledValue(text, '字幕语种'),
      date: dateText || dateMatch?.[0] || null,
      detailUrl: detailUrl.toString()
    });
  });

  return results;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer();
}
