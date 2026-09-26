/**
 * assrt.net 字幕代理服务 —— Cloudflare Worker 版本（单文件 / ESM）
 *
 * 与原 Node.js 版本的差异说明：
 *  1. 入口：export default { fetch(request, env, ctx) }，不再使用 node:http。
 *  2. 去掉 node:fs 磁盘缓存 -> 改用 Cache API（caches.default，开箱即用）
 *     以及可选的 KV 命名空间绑定（env.SUBTITLE_KV）。
 *  3. 去掉 undici 代理 -> Workers 本身不支持 HTTP 代理，直接使用全局 fetch。
 *  4. 去掉 cheerio -> 内置轻量 HTML 解析 + 选择器引擎（见 mini cheerio 章节）。
 *  5. 去掉 iconv-lite / chardet -> 使用 TextDecoder（Workers 支持 Encoding 标准
 *     里的全部编码） + 内置打分式编码嗅探。
 *  6. 去掉 yauzl -> 内置 ZIP 解析器（store / deflate，含 zip64 兜底），
 *     用 DecompressionStream('deflate-raw') 解压。
 *  7. node-unrar-js -> 无法在单文件 Workers 中实现（RAR 解压算法过于复杂）。
 *     RAR 包会返回 422 UNSUPPORTED_ARCHIVE；如需支持，可把 wasm 版 unrar
 *     作为模块引入，并在 extractFirstSrtFromRar() 里调用（已留出扩展点）。
 *  8. Buffer -> Uint8Array；randomUUID -> crypto.randomUUID()。
 *
 * 环境变量 / 绑定（都在 env 上）：
 *  CORS_ORIGIN          允许的来源，逗号分隔，默认 '*'
 *  CORS_MAX_AGE         预检缓存秒数，默认 86400
 *  CACHE_TTL_MS         字幕缓存时间，默认 24h
 *  CACHE_DISABLE        '1' 时关闭缓存
 *  UPSTREAM_TIMEOUT_MS  上游超时，默认 15000
 *  UPSTREAM_UA          请求上游时的 User-Agent
 *  SUBTITLE_KV          可选：KV 命名空间绑定（二进制以 base64 存储）
 *  SUBTITLE_CACHE       可选：自定义 Cache API 存储（默认 caches.default）
 */

/* --------------------------------- 常量配置 -------------------------------- */

const ASSRT_ORIGIN = 'https://assrt.net';
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAX_SRT_BYTES = 32 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 1000;
const KV_MAX_BYTES = 4 * 1024 * 1024; // KV 单值上限 25MB，base64 会膨胀，留足余量
const CACHE_KEY_ORIGIN = 'https://subtitle-cache.local';
const CORS_DEFAULT_MAX_AGE = 86400;
const CORS_EXPOSED_HEADERS = 'content-disposition, content-length, content-type';
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

/* --------------------------------- 基础工具 -------------------------------- */

class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
  }
}

function concatBytes(chunks) {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function readU32LE(bytes, offset) {
  if (offset + 4 > bytes.length) return null;
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    ((bytes[offset + 3] << 24) >>> 0)
  ) >>> 0;
}

function bytesToBase64(bytes) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/* --------------------------------- URL 校验 -------------------------------- */

function isAssrtHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'assrt.net' || host.endsWith('.assrt.net');
}

function isAssrtFileHost(hostname) {
  return /^file\d*\.assrt\.net$/iu.test(String(hostname || ''));
}

function toSecureUrl(value) {
  if (value.protocol === 'http:' && isAssrtFileHost(value.hostname)) {
    const secureUrl = new URL(value.toString());
    secureUrl.protocol = 'https:';
    return secureUrl;
  }
  return value;
}

function assertAllowedUrl(value) {
  let url;
  try {
    url = new URL(String(value));
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

/* ---------------------------------- 网络层 --------------------------------- */

function getHeader(response, name) {
  try {
    return response.headers?.get?.(name) || null;
  } catch {
    return null;
  }
}

async function readResponseBuffer(response, maxBytes) {
  const contentLength = Number(getHeader(response, 'content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new AppError(502, 'UPSTREAM_TOO_LARGE', 'Upstream response is too large');
  }

  if (!response.body || typeof response.body.getReader !== 'function') {
    const data = new Uint8Array(await response.arrayBuffer());
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
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new AppError(502, 'UPSTREAM_TOO_LARGE', 'Upstream response is too large');
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }

  return concatBytes(chunks);
}

async function fetchBuffer(value, options, maxBytes) {
  let url = toSecureUrl(assertAllowedUrl(value));
  const fetchImpl = options.fetchImpl || fetch;
  const controller = new AbortController();
  const configuredTimeout = Number(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? configuredTimeout
      : DEFAULT_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const headers = {
    'user-agent': options.userAgent || DEFAULT_USER_AGENT,
    accept: '*/*',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    referer: `${ASSRT_ORIGIN}/`
  };

  try {
    for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
      const response = await fetchImpl(url.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers
      });

      if (response.status >= 300 && response.status < 400) {
        const location = getHeader(response, 'location');
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
    if (error instanceof AppError) throw error;
    if (error?.name === 'AbortError') {
      throw new AppError(504, 'UPSTREAM_TIMEOUT', 'Upstream request timed out');
    }
    throw new AppError(502, 'UPSTREAM_ERROR', 'Unable to reach upstream');
  } finally {
    clearTimeout(timeout);
  }
}

/* ------------------------------ 编码识别与解码 ------------------------------ */

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  hellip: '…',
  mdash: '—',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’'
};

function decodeEntities(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (match, body) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

function hasUtfBom(bytes) {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

function isValidUtf8(bytes) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function tryDecode(bytes, encoding) {
  try {
    return new TextDecoder(encoding, { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}

function scoreDecodedText(text) {
  const cjkCount = (text.match(/[㐀-鿿豈-﫿]/gu) || []).length;
  const replacementCount = (text.match(/�/gu) || []).length;
  const controlCount = (text.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu) || []).length;
  return cjkCount * 20 - replacementCount * 10 - controlCount * 5;
}

/** 候选编码按优先级排列，分数相同时排在前面的胜出（中文站点优先 GB18030）。 */
const ENCODING_CANDIDATES = [
  'gb18030',
  'big5',
  'shift_jis',
  'euc-jp',
  'euc-kr',
  'windows-1252'
];

export function decodeSubtitle(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);

  if (hasUtfBom(bytes)) return tryDecode(bytes.subarray(3), 'utf-8') ?? '';
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return tryDecode(bytes.subarray(2), 'utf-16le') ?? '';
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return tryDecode(bytes.subarray(2), 'utf-16be') ?? '';
  }

  // 无 BOM 的 UTF-16：靠 NUL 字节比例猜测
  if (bytes.length >= 16 && bytes.length % 2 === 0) {
    let asciiBytes = 0;
    for (let i = 0; i < Math.min(bytes.length, 512); i += 2) {
      if (bytes[i] >= 0x20 && bytes[i] < 0x7f && bytes[i + 1] === 0) asciiBytes += 1;
    }
    if (asciiBytes > 32) {
      const utf16 = tryDecode(bytes, 'utf-16le');
      if (utf16 && !/[\u0000-\u0002]/u.test(utf16.slice(0, 64))) return utf16;
    }
  }

  if (isValidUtf8(bytes)) return tryDecode(bytes, 'utf-8') ?? '';

  let best = null;
  for (const encoding of ENCODING_CANDIDATES) {
    const text = tryDecode(bytes, encoding);
    if (text === null) continue;
    const score = scoreDecodedText(text);
    if (!best || score > best.score) best = { encoding, text, score };
  }

  return best?.text ?? tryDecode(bytes, 'utf-8') ?? '';
}

function decodeArchiveName(bytes, utf8Flag) {
  if (utf8Flag) return tryDecode(bytes, 'utf-8') ?? '';
  return tryDecode(bytes, 'gb18030') ?? tryDecode(bytes, 'windows-1252') ?? '';
}

/* ------------------------------ mini cheerio ------------------------------- */
/* 仅实现本项目用到的能力：
 *   $('选择器')            -> 选择集
 *   .find(选择器)          -> 后代选择（',' '>' '+' 组合）
 *   .each((i, el) => {})  .first()  .text()  .attr(name)  .toArray()  .length
 * 选择器支持：tag / * / #id / .class / [attr] / [attr*=v] / [attr=v] / :not(#id)
 */

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr'
]);
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title']);

function makeNode(name, attrs, parent) {
  return { name, attrs, children: [], parent };
}

function isTagNode(node) {
  return !!node && Array.isArray(node.children);
}

function appendText(parent, text) {
  if (!parent || !text) return;
  const last = parent.children[parent.children.length - 1];
  if (last && !isTagNode(last)) {
    last.text += text;
    return;
  }
  parent.children.push({ text });
}

function findTagEnd(text, start) {
  let quote = null;
  for (let i = start + 1; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '>') return i;
  }
  return -1;
}

function parseAttributes(raw) {
  const attrs = {};
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let match;
  while ((match = re.exec(raw)) !== null) {
    const name = match[1].toLowerCase();
    if (name in attrs) continue;
    const rawValue = match[2] ?? match[3] ?? match[4] ?? '';
    attrs[name] = decodeEntities(rawValue);
  }
  return attrs;
}

function findClosingTag(text, from, name) {
  const re = new RegExp(`</${name}\\s*>`, 'iu');
  const match = re.exec(text.slice(from));
  return match ? from + match.index : -1;
}

function parseHtml(source) {
  const text = String(source ?? '');
  const root = makeNode('#root', {}, null);
  const stack = [root];
  let i = 0;

  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt === -1) {
      appendText(stack[stack.length - 1], text.slice(i));
      break;
    }
    if (lt > i) appendText(stack[stack.length - 1], text.slice(i, lt));

    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      i = end === -1 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith('<!', lt)) {
      const end = text.indexOf('>', lt);
      i = end === -1 ? text.length : end + 1;
      continue;
    }

    const isClose = text[lt + 1] === '/';
    const nameStart = lt + (isClose ? 2 : 1);
    const nameMatch = /^[a-zA-Z][\w:-]*/.exec(text.slice(nameStart, nameStart + 64));
    if (!nameMatch) {
      appendText(stack[stack.length - 1], '<');
      i = lt + 1;
      continue;
    }

    const end = findTagEnd(text, lt);
    if (end === -1) {
      appendText(stack[stack.length - 1], text.slice(lt));
      break;
    }

    const name = nameMatch[0].toLowerCase();
    if (isClose) {
      for (let s = stack.length - 1; s > 0; s -= 1) {
        if (stack[s].name === name) {
          stack.length = s;
          break;
        }
      }
      i = end + 1;
      continue;
    }

    const tagInner = text.slice(lt + 1, end);
    const selfClosing = /\/\s*$/.test(tagInner);
    const node = makeNode(name, parseAttributes(tagInner.slice(name.length).replace(/\/\s*$/, '')), stack[stack.length - 1]);
    stack[stack.length - 1].children.push(node);
    i = end + 1;

    if (!selfClosing && !VOID_TAGS.has(name)) {
      stack.push(node);
      if (RAW_TEXT_TAGS.has(name)) {
        const closeIdx = findClosingTag(text, i, name);
        if (closeIdx !== -1) {
          appendText(node, text.slice(i, closeIdx));
          i = closeIdx;
          continue;
        }
      }
    }
  }

  return root;
}

function nodeText(node) {
  if (!isTagNode(node)) return node.text || '';
  if (node.name === 'script' || node.name === 'style') return '';
  let out = '';
  for (const child of node.children) out += nodeText(child);
  return out;
}

function parseCompound(input) {
  const compound = { tag: null, id: null, classes: [], attrs: [], not: [] };
  let rest = String(input);

  const tagMatch = /^([a-zA-Z][\w:-]*|\*)/.exec(rest);
  if (tagMatch) {
    if (tagMatch[1] !== '*') compound.tag = tagMatch[1].toLowerCase();
    rest = rest.slice(tagMatch[0].length);
  }

  const re =
    /#([^\s>+~.,:]+)|\.([^\s>+~.,:]+)|\[([^\]=]+?)(?:([~^$*|]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]]*?))\s*)?\]|:not\(\s*([^)]*?)\s*\)/gu;
  let match;
  while ((match = re.exec(rest)) !== null) {
    if (match[1] !== undefined) compound.id = match[1];
    else if (match[2] !== undefined) compound.classes.push(match[2]);
    else if (match[3] !== undefined) {
      const value = (match[5] ?? match[6] ?? match[7] ?? '').trim();
      compound.attrs.push({ name: match[3].trim().toLowerCase(), op: match[4] || '', value });
    } else if (match[8] !== undefined) {
      compound.not.push(parseCompound(match[8]));
    }
  }
  return compound;
}

function parseSelectorSequence(input) {
  const tokens = [];
  let rest = String(input).trim();
  while (rest) {
    rest = rest.replace(/^\s+/, '');
    if (!rest) break;
    let comb = ' ';
    const combMatch = /^(>|\+|~)\s*/.exec(rest);
    if (combMatch) {
      comb = combMatch[1];
      rest = rest.slice(combMatch[0].length).replace(/^\s+/, '');
    }
    const compoundMatch =
      /^(?:[a-zA-Z][\w:-]*|\*|#[^\s>+~.,:]+|\.[^\s>+~.,:]+|\[[^\]]*\]|:not\([^)]*\))+/.exec(rest);
    if (!compoundMatch) break;
    tokens.push({ comb: tokens.length === 0 ? null : comb, compound: parseCompound(compoundMatch[0]) });
    rest = rest.slice(compoundMatch[0].length);
  }
  return tokens;
}

function matchesCompound(node, compound) {
  if (!isTagNode(node)) return false;
  if (compound.tag && node.name !== compound.tag) return false;
  if (compound.id && node.attrs.id !== compound.id) return false;
  for (const cls of compound.classes) {
    const classes = (node.attrs.class || '').split(/\s+/u);
    if (!classes.includes(cls)) return false;
  }
  for (const attr of compound.attrs) {
    const value = node.attrs[attr.name];
    if (value === undefined) return false;
    if (!attr.op) continue;
    if (attr.op === '=' && value !== attr.value) return false;
    if (attr.op === '*=' && !value.includes(attr.value)) return false;
    if (attr.op === '^=' && !value.startsWith(attr.value)) return false;
    if (attr.op === '$=' && !value.endsWith(attr.value)) return false;
    if (attr.op === '~=' && !value.split(/\s+/u).includes(attr.value)) return false;
    if (attr.op === '|=' && value !== attr.value && !value.startsWith(`${attr.value}-`)) return false;
  }
  for (const not of compound.not) {
    if (matchesCompound(node, not)) return false;
  }
  return true;
}

function walk(node, visit) {
  for (const child of node.children) {
    if (!isTagNode(child)) continue;
    visit(child);
    walk(child, visit);
  }
}

function nextElementSibling(node) {
  if (!node?.parent) return null;
  const siblings = node.parent.children;
  const index = siblings.indexOf(node);
  for (let i = index + 1; i < siblings.length; i += 1) {
    if (isTagNode(siblings[i])) return siblings[i];
  }
  return null;
}

function dedupe(nodes) {
  const seen = new Set();
  const out = [];
  for (const node of nodes) {
    if (seen.has(node)) continue;
    seen.add(node);
    out.push(node);
  }
  return out;
}

function selectElements(roots, selector) {
  const sequences = String(selector)
    .split(',')
    .map((part) => parseSelectorSequence(part))
    .filter((tokens) => tokens.length > 0);

  const results = [];
  for (const tokens of sequences) {
    let current = roots.filter(isTagNode);
    for (let i = 0; i < tokens.length; i += 1) {
      const { comb, compound } = tokens[i];
      if (i === 0 || comb === ' ') {
        const found = [];
        for (const root of current) walk(root, (node) => {
          if (matchesCompound(node, compound)) found.push(node);
        });
        current = dedupe(found);
      } else if (comb === '>') {
        const found = [];
        for (const node of current) {
          for (const child of node.children) {
            if (isTagNode(child) && matchesCompound(child, compound)) found.push(child);
          }
        }
        current = dedupe(found);
      } else if (comb === '+' || comb === '~') {
        const found = [];
        for (const node of current) {
          if (comb === '+') {
            const sibling = nextElementSibling(node);
            if (sibling && matchesCompound(sibling, compound)) found.push(sibling);
          } else {
            let sibling = nextElementSibling(node);
            while (sibling) {
              if (matchesCompound(sibling, compound)) found.push(sibling);
              sibling = nextElementSibling(sibling);
            }
          }
        }
        current = dedupe(found);
      }
    }
    results.push(...current);
  }
  return dedupe(results);
}

function createSelection(nodes) {
  return {
    length: nodes.length,
    toArray: () => nodes.slice(),
    find(selector) {
      return createSelection(selectElements(nodes, selector));
    },
    first() {
      return createSelection(nodes.slice(0, 1));
    },
    each(callback) {
      nodes.forEach((node, index) => callback.call(node, index, node));
      return this;
    },
    text() {
      return nodes.map(nodeText).join('');
    },
    attr(name) {
      if (!nodes.length) return null;
      return nodes[0].attrs[name] ?? null;
    }
  };
}

function loadHtml(html) {
  const root = parseHtml(html);
  const $ = (selector, context) => {
    // $(element) / $([element])：直接包装节点（兼容 cheerio 用法）
    if (selector && typeof selector !== 'string') {
      const nodes = Array.isArray(selector) ? selector.filter(isTagNode) : [selector];
      return createSelection(nodes.filter(isTagNode));
    }
    if (!selector) return createSelection([root]);
    const contexts = context ? (Array.isArray(context) ? context : [context]) : [root];
    return createSelection(selectElements(contexts, selector));
  };
  $.root = root;
  $.html = () => html;
  return $;
}

/* -------------------------------- 解析业务 --------------------------------- */

function normalizeText(value) {
  return String(value ?? '')
    .replace(/\u00a0/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function getLabeledValue(text, label) {
  const match = text.match(
    new RegExp(
      `${label}\\s*[：:]\\s*(.*?)(?=\\s*(?:版本|格式|字幕格式|语种|语言|字幕语种|来源|制作|校订|上传|日期|发布时间|字幕文件名|查阅次数|下载次数|翻译质量)\\s*[：:]|\\s+\\d{4}-\\d{2}-\\d{2}(?:\\s|$)|\\s+\\d+周前(?:\\s|$)|$)`,
      'u'
    )
  );
  return match ? normalizeText(match[1]) : null;
}

function getCardVersion($, card) {
  const version = card.find('#meta_top b, .sublist_box_title_l + * b').first().text();
  if (version) return normalizeText(version);
  return getLabeledValue(normalizeText(card.text()), '版本');
}

export function extractDownloadUrl(html, pageUrl = ASSRT_ORIGIN) {
  const $ = loadHtml(html);
  const candidates = [];
  const onclickRe = /location\.href\s*=\s*['"]([^'"]+)['"]/gu;

  $('a').each((_, element) => {
    const link = $(element);
    candidates.push(link.attr('href'));
    const onclick = link.attr('onclick') || '';
    for (const match of onclick.matchAll(onclickRe)) {
      candidates.push(match[1]);
    }
  });

  for (const candidate of candidates) {
    if (!candidate || candidate === '#') continue;
    try {
      const url = new URL(candidate, pageUrl);
      const isAssrtDownloadHost = isAssrtHost(url.hostname);
      const isAllowedProtocol =
        url.protocol === 'https:' || (url.protocol === 'http:' && isAssrtFileHost(url.hostname));
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
  const $ = loadHtml(html);
  const results = [];

  $('.resultcard > .subitem:not(#top-banner):not(#bottom-banner)').each((_, element) => {
    const card = $(element);
    const text = normalizeText(card.text());
    const format = getLabeledValue(text, '格式');

    if (format?.toLowerCase() !== 'subrip(srt)') return;

    const detailLink = card.find('a[href*="/sub/"]').first();
    const href = detailLink.attr('href');
    if (!href) return;

    let detailUrl;
    try {
      detailUrl = new URL(href, ASSRT_ORIGIN);
    } catch {
      return;
    }
    if (detailUrl.protocol !== 'https:' || !isAssrtHost(detailUrl.hostname)) return;

    const id =
      detailUrl.pathname.match(/^\/xml\/sub\/\d+\/(\d+)\.xml$/u)?.[1] ??
      detailUrl.pathname.match(/^\/sub\/(\d+)(?:\/|\.html?$)/u)?.[1];
    if (!id) return;

    const dateText = getLabeledValue(text, '日期') || getLabeledValue(text, '发布时间');
    const dateMatch = text.match(/\b\d{4}-\d{2}-\d{2}\b/u);

    results.push({
      id,
      title: normalizeText(detailLink.attr('title') || detailLink.text()) || null,
      version: getCardVersion($, card),
      format,
      language:
        getLabeledValue(text, '语言') ||
        getLabeledValue(text, '语种') ||
        getLabeledValue(text, '字幕语种'),
      date: dateText || dateMatch?.[0] || null,
      detailUrl: detailUrl.toString()
    });
  });

  return results;
}

/* --------------------------------- 压缩包 ---------------------------------- */

function isSafeArchivePath(name) {
  if (typeof name !== 'string' || !name || name.includes('\0')) return false;
  const normalized = name.replace(/\\/gu, '/');
  return (
    !normalized.startsWith('/') &&
    !/^[a-z]:/iu.test(normalized) &&
    !normalized.split('/').includes('..')
  );
}

function findSignature(view, signature, from, to = view.byteLength - 4) {
  const start = Math.max(0, from);
  const end = Math.min(to, view.byteLength - 4);
  for (let i = start; i <= end; i += 1) {
    if (view.getUint32(i, true) === signature) return i;
  }
  return -1;
}

async function inflateRaw(data, maxBytes) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const response = new Response(stream);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error('SRT file is too large');
  return bytes;
}

function readZip64Extra(extra) {
  const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
  let offset = 0;
  while (offset + 4 <= extra.length) {
    const headerId = view.getUint16(offset, true);
    const size = view.getUint16(offset + 2, true);
    const body = offset + 4;
    if (headerId === 0x0001) {
      const values = [];
      for (let i = body; i + 8 <= body + size; i += 8) values.push(Number(view.getBigUint64(i, true)));
      return values;
    }
    offset = body + size;
  }
  return [];
}

async function extractFirstSrtFromZip(buffer, options = {}) {
  const maxEntries = options.maxEntries ?? MAX_ARCHIVE_ENTRIES;
  const maxSrtBytes = options.maxSrtBytes ?? MAX_SRT_BYTES;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const eocd = findSignature(view, 0x06054b50, Math.max(0, buffer.length - 65558));
  if (eocd < 0) throw new Error('Invalid ZIP archive');

  let entryCount = view.getUint16(eocd + 10, true);
  let cdSize = view.getUint32(eocd + 12, true);
  let cdOffset = view.getUint32(eocd + 16, true);

  if (entryCount === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    const locator = findSignature(view, 0x07064b50, Math.max(0, eocd - 20), eocd);
    if (locator >= 0) {
      const z64 = Number(view.getBigUint64(locator + 8, true));
      if (z64 >= 0 && z64 + 56 <= buffer.length && view.getUint32(z64, true) === 0x06064b50) {
        entryCount = Number(view.getBigUint64(z64 + 32, true));
        cdSize = Number(view.getBigUint64(z64 + 40, true));
        cdOffset = Number(view.getBigUint64(z64 + 48, true));
      }
    }
  }

  if (entryCount > maxEntries) throw new Error('Archive contains too many entries');

  const entries = [];
  let offset = cdOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (offset + 46 > buffer.length || view.getUint32(offset, true) !== 0x02014b50) break;
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    let compressedSize = view.getUint32(offset + 20, true);
    let uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    let localOffset = view.getUint32(offset + 42, true);

    const nameStart = offset + 46;
    const extra = buffer.subarray(nameStart + nameLength, nameStart + nameLength + extraLength);
    if (uncompressedSize === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      const zip64 = readZip64Extra(extra);
      if (zip64.length >= 2) {
        if (uncompressedSize === 0xffffffff) uncompressedSize = zip64[0];
        if (compressedSize === 0xffffffff) compressedSize = zip64[1];
        if (localOffset === 0xffffffff && zip64.length >= 3) localOffset = zip64[2];
      }
    }

    entries.push({
      name: decodeArchiveName(buffer.subarray(nameStart, nameStart + nameLength), (flags & 0x800) !== 0),
      method,
      compressedSize,
      uncompressedSize,
      localOffset
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  const candidate = entries
    .filter(
      (entry) =>
        isSafeArchivePath(entry.name) &&
        !entry.name.endsWith('/') &&
        entry.name.toLowerCase().endsWith('.srt')
    )
    .sort((left, right) => left.name.localeCompare(right.name, 'en'))[0];

  if (!candidate) throw new Error('Archive does not contain an SRT file');
  if (candidate.uncompressedSize > maxSrtBytes) throw new Error('SRT file is too large');

  if (
    candidate.localOffset + 30 > buffer.length ||
    view.getUint32(candidate.localOffset, true) !== 0x04034b50
  ) {
    throw new Error('Invalid ZIP local file header');
  }

  const localNameLength = view.getUint16(candidate.localOffset + 26, true);
  const localExtraLength = view.getUint16(candidate.localOffset + 28, true);
  const dataStart = candidate.localOffset + 30 + localNameLength + localExtraLength;
  const raw = buffer.subarray(dataStart, Math.min(dataStart + candidate.compressedSize, buffer.length));

  let data;
  if (candidate.method === 0) {
    data = raw;
  } else if (candidate.method === 8) {
    data = await inflateRaw(raw, maxSrtBytes);
  } else {
    throw new Error(`Unsupported ZIP compression method ${candidate.method}`);
  }

  if (data.length > maxSrtBytes) throw new Error('SRT file is too large');
  return { name: candidate.name, data };
}

async function extractFirstSrtFromRar(buffer, options = {}) {
  // RAR（尤其 RAR5 的过滤算法）无法用纯 JS 单文件实现。
  // 扩展点：把 wasm 版 unrar 作为模块 import 进来后，在这里解包即可。
  if (typeof options.rarExtractor === 'function') {
    return options.rarExtractor(buffer, options);
  }
  throw new Error(
    'RAR archives are not supported in the Cloudflare Worker build (needs a wasm unrar module)'
  );
}

function looksLikeSrt(text) {
  return /\d{1,3}:\d{2}:\d{2}[,.]\d{1,3}\s*-->\s*\d{1,3}:\d{2}:\d{2}[,.]\d{1,3}/u.test(text);
}

export async function extractFirstSrt(buffer, options = {}) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);

  if (readU32LE(bytes, 0) === 0x04034b50 || readU32LE(bytes, 0) === 0x06054b50) {
    return extractFirstSrtFromZip(bytes, options);
  }

  const rar4 = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00];
  const rar5 = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00];
  const startsWith = (sig) => sig.every((byte, index) => bytes[index] === byte);
  if (startsWith(rar4) || startsWith(rar5)) {
    return extractFirstSrtFromRar(bytes, options);
  }

  const maxSrtBytes = options.maxSrtBytes ?? MAX_SRT_BYTES;
  if (bytes.length <= maxSrtBytes && looksLikeSrt(decodeSubtitle(bytes))) {
    return { name: 'subtitle.srt', data: bytes };
  }

  throw new Error('Unsupported archive format');
}

/* ---------------------------------- 缓存 ----------------------------------- */

const inFlightDownloads = new Map(); // 单 isolate 内的并发去重
const detailUrls = new Map(); // 搜索结果 -> 详情页 URL（单 isolate 内有效）

function getCacheTtl(options) {
  const value = Number(options.cacheTtlMs ?? 24 * 60 * 60 * 1000);
  return Number.isFinite(value) && value > 0 ? value : 24 * 60 * 60 * 1000;
}

function cacheKeyRequest(id) {
  return new Request(`${CACHE_KEY_ORIGIN}/subtitle/${id}.srt`, { method: 'GET' });
}

function getCache(options) {
  if (options.cacheDisabled) return null;
  return options.cache ?? (typeof caches !== 'undefined' ? caches.default : null);
}

async function readCachedSubtitle(id, options) {
  const ttlMs = getCacheTtl(options);

  if (options.kv) {
    try {
      const raw = await options.kv.get(id, 'text');
      if (raw) return base64ToBytes(raw);
    } catch {
      /* 缓存读取失败忽略 */
    }
  }

  const cache = getCache(options);
  if (!cache) return null;
  try {
    const response = await cache.match(cacheKeyRequest(id));
    if (!response) return null;
    const cachedAt = Number(response.headers.get('x-cached-at') || 0);
    if (!cachedAt || Date.now() - cachedAt > ttlMs) {
      options.ctx?.waitUntil?.(cache.delete(cacheKeyRequest(id)).catch(() => {}));
      return null;
    }
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.length > MAX_SRT_BYTES) return null;
    return data;
  } catch {
    return null;
  }
}

async function writeCachedSubtitle(id, data, options) {
  const ttlMs = getCacheTtl(options);
  const ttlSeconds = Math.max(1, Math.floor(ttlMs / 1000));

  if (options.kv && data.length <= KV_MAX_BYTES) {
    options.ctx?.waitUntil?.(
      options.kv
        .put(id, bytesToBase64(data), { expirationTtl: ttlSeconds })
        .catch(() => {})
    );
  }

  const cache = getCache(options);
  if (!cache) return;
  options.ctx?.waitUntil?.(
    cache
      .put(
        cacheKeyRequest(id),
        new Response(data, {
          headers: {
            'content-type': 'application/x-subrip; charset=utf-8',
            'cache-control': `public, max-age=${ttlSeconds}`,
            'x-cached-at': String(Date.now())
          }
        })
      )
      .catch(() => {})
  );
}

/* --------------------------------- 业务 API -------------------------------- */

function getDetailCandidates(id) {
  const knownUrl = detailUrls.get(id);
  if (knownUrl) return [knownUrl];

  const group = id.slice(0, 3);
  const candidates = [
    `${ASSRT_ORIGIN}/xml/sub/${group}/${id}.xml`,
    `${ASSRT_ORIGIN}/sub/${id}.html`,
    `${ASSRT_ORIGIN}/sub/${id}`
  ];
  if (group !== id) candidates.push(`${ASSRT_ORIGIN}/xml/sub/${id}/${id}.xml`);
  return candidates;
}

async function findDownloadUrl(id, options) {
  let lastError = null;

  for (const detailUrl of getDetailCandidates(id)) {
    try {
      const html = decodeSubtitle(await fetchBuffer(detailUrl, options, MAX_PAGE_BYTES));
      const downloadUrl = extractDownloadUrl(html, detailUrl);
      if (downloadUrl) return downloadUrl;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError instanceof AppError && lastError.status >= 500) throw lastError;
  throw new AppError(404, 'SUBTITLE_NOT_FOUND', 'Subtitle download was not found');
}

export async function downloadSubtitle(id, options = {}) {
  if (typeof id !== 'string' || !/^\d{1,12}$/u.test(id)) {
    throw new AppError(400, 'INVALID_ID', 'id must be numeric');
  }

  const existing = inFlightDownloads.get(id);
  if (existing) return existing;

  const task = (async () => {
    const cached = await readCachedSubtitle(id, options);
    if (cached) return cached;

    const downloadUrl = await findDownloadUrl(id, options);
    const archive = await fetchBuffer(downloadUrl, options, MAX_ARCHIVE_BYTES);

    let extracted;
    try {
      extracted = await extractFirstSrt(archive, {
        maxEntries: MAX_ARCHIVE_ENTRIES,
        maxSrtBytes: MAX_SRT_BYTES
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(422, 'INVALID_ARCHIVE', error.message || 'Unable to extract SRT');
    }

    if (extracted.data.length > MAX_SRT_BYTES) {
      throw new AppError(422, 'SRT_TOO_LARGE', 'SRT file is too large');
    }

    const subtitle = new TextEncoder().encode(decodeSubtitle(extracted.data));
    if (subtitle.length > MAX_SRT_BYTES) {
      throw new AppError(422, 'SRT_TOO_LARGE', 'SRT file is too large');
    }

    await writeCachedSubtitle(id, subtitle, options).catch(() => {});
    return subtitle;
  })();

  inFlightDownloads.set(id, task);
  try {
    return await task;
  } finally {
    inFlightDownloads.delete(id);
  }
}

export async function searchSubtitles(query, options = {}) {
  if (typeof query !== 'string' || !query.trim() || query.length > 100) {
    throw new AppError(400, 'INVALID_QUERY', 'q must be between 1 and 100 characters');
  }

  const url = new URL('/sub/', ASSRT_ORIGIN);
  url.searchParams.set('searchword', query.trim());
  const html = decodeSubtitle(await fetchBuffer(url, options, MAX_PAGE_BYTES));
  const results = parseSearchResults(html);

  detailUrls.clear();
  for (const result of results) detailUrls.set(result.id, result.detailUrl);

  return results;
}

/* ---------------------------------- HTTP 层 -------------------------------- */

function jsonResponse(status, body, corsHeaders, extraHeaders) {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff'
  });
  if (corsHeaders) {
    for (const [name, value] of corsHeaders) headers.set(name, value);
  }
  if (extraHeaders) {
    for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function resolveCorsPolicy(value) {
  const text = value === undefined || value === null ? '*' : String(value).trim();
  if (!text) return { wildcard: true, origins: new Set(), maxAge: undefined };
  const origins = new Set(
    text
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
  );
  if (origins.has('*')) return { wildcard: true, origins: new Set(), maxAge: undefined };
  return { wildcard: false, origins, maxAge: undefined };
}

function applyCorsHeaders(request, headers, policy) {
  const origin = request.headers.get('origin');
  headers.set('access-control-expose-headers', CORS_EXPOSED_HEADERS);

  if (policy.wildcard) {
    headers.set('access-control-allow-origin', '*');
    return;
  }
  if (origin && policy.origins.has(String(origin).toLowerCase())) {
    headers.set('access-control-allow-origin', origin);
    headers.append('vary', 'Origin');
  }
}

function corsMaxAge(policy) {
  const configured = Number(policy.maxAge ?? CORS_DEFAULT_MAX_AGE);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : CORS_DEFAULT_MAX_AGE;
}

function buildOptions(env = {}, ctx) {
  const timeoutMs = Number(env.UPSTREAM_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const cacheTtlMs = Number(env.CACHE_TTL_MS ?? 24 * 60 * 60 * 1000);

  return {
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
    cacheTtlMs: Number.isFinite(cacheTtlMs) && cacheTtlMs > 0 ? cacheTtlMs : 24 * 60 * 60 * 1000,
    cacheDisabled: String(env.CACHE_DISABLE ?? '') === '1',
    userAgent: env.UPSTREAM_UA || DEFAULT_USER_AGENT,
    kv: env.SUBTITLE_KV || null,
    cache: env.SUBTITLE_CACHE || null,
    ctx
  };
}

const DOWNLOAD_ROUTE = /^\/download\/([^/]+?)(?:\.srt)?\/?$/iu;

function buildCorsHeaders(request, env) {
  const policy = resolveCorsPolicy(env.CORS_ORIGIN);
  const maxAgeValue = Number(env.CORS_MAX_AGE);
  if (Number.isFinite(maxAgeValue)) policy.maxAge = maxAgeValue;

  const headers = new Headers();
  applyCorsHeaders(request, headers, policy);
  return { headers, policy };
}

async function handleRequest(request, env, ctx) {
  const { headers: corsHeaders, policy } = buildCorsHeaders(request, env);

  if (request.method === 'OPTIONS') {
    corsHeaders.set('access-control-allow-methods', 'GET, HEAD, OPTIONS');
    corsHeaders.set(
      'access-control-allow-headers',
      request.headers.get('access-control-request-headers') || 'content-type'
    );
    corsHeaders.set('access-control-max-age', String(corsMaxAge(policy)));
    corsHeaders.set('content-length', '0');
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return jsonResponse(
      405,
      { error: 'METHOD_NOT_ALLOWED', message: 'Only GET is supported' },
      corsHeaders,
      { allow: 'GET, HEAD, OPTIONS' }
    );
  }

  const options = buildOptions(env, ctx);
  const requestUrl = new URL(request.url);

  if (requestUrl.pathname === '/search') {
    const results = await searchSubtitles(requestUrl.searchParams.get('q'), options);
    return jsonResponse(200, results, corsHeaders);
  }

  const downloadMatch = DOWNLOAD_ROUTE.exec(requestUrl.pathname);
  if (downloadMatch) {
    let id;
    try {
      id = decodeURIComponent(downloadMatch[1]);
    } catch {
      throw new AppError(400, 'INVALID_ID', 'id must be numeric');
    }

    const subtitle = await downloadSubtitle(id, options);
    const headers = new Headers({
      'content-type': 'application/x-subrip; charset=utf-8',
      'content-length': String(subtitle.length),
      'content-disposition': `attachment; filename="${id}.srt"`,
      'x-content-type-options': 'nosniff'
    });
    for (const [name, value] of corsHeaders) headers.set(name, value);

    return new Response(request.method === 'HEAD' ? null : subtitle, { status: 200, headers });
  }

  return jsonResponse(404, { error: 'NOT_FOUND', message: 'Route not found' }, corsHeaders);
}

export default {
  async fetch(request, env, ctx) {
    const safeEnv = env ?? {};
    try {
      return await handleRequest(request, safeEnv, ctx);
    } catch (error) {
      const { headers: corsHeaders } = buildCorsHeaders(request, safeEnv);
      return jsonResponse(errorResponseStatus(error), errorResponseBody(error), corsHeaders);
    }
  }
};

function errorResponseStatus(error) {
  return error instanceof AppError ? error.status : 500;
}

function errorResponseBody(error) {
  return {
    error: error instanceof AppError ? error.code : 'INTERNAL_ERROR',
    message: error instanceof AppError ? error.message : 'Internal server error'
  };
}
