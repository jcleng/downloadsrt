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
 *  7. node-unrar-js -> 内置纯 JS RAR 解压器，算法参照官方 unrar 源码翻译，
 *     支持 RAR 2.x/3.x/4.x 的 LZ 与 RAR 5.0（含 delta / x86 / ARM 过滤器）。
 *     不支持 PPMd、加密、RAR 1.5、RAR 7.0 与多卷分卷，遇到时返回明确错误。
 *     仍保留 options.rarExtractor 扩展点，可换成 wasm 版 unrar。
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

/* ============================ RAR 解压引擎 ============================
 * 纯 JavaScript 实现，算法参照官方 unrar 源码翻译：
 *   RAR 2.x -> unpack20.cpp，RAR 3.x/4.x -> unpack30.cpp，RAR 5.0 -> unpack50.cpp
 * 支持：RAR 2.x / 3.x / 4.x 的 LZ 压缩、RAR 5.0 完整解码（含 delta / x86 / ARM
 * 过滤器）与 store 条目。
 * 不支持（会给出明确错误）：PPMd 压缩、加密、RAR 1.5、RAR 7.0 算法、多卷分卷。
 * ------------------------------------------------------------------ */

/**
 * 纯 JS RAR 解压器（RAR 2.x/3.x/4.x + RAR 5.0）
 *
 * 算法照 unrar 7.30 官方源码翻译：
 *   - RAR 2.x : unpack20.cpp  (Unpack20 / ReadTables20)
 *   - RAR 3/4 : unpack30.cpp  (Unpack29 / ReadTables30 / ReadEndOfBlock)
 *   - RAR 5   : unpack50.cpp  (Unpack5 / ReadBlockHeader / ReadTables)
 *   - 公共    : unpack.cpp MakeDecodeTables、unpackinline.cpp DecodeNumber/CopyString
 *
 * 不支持（遇到会明确报错）：PPMd 压缩、加密、RAR 1.5、RAR 7.0 算法、
 * 过滤器（x86/delta/BCJ/ARM）、多卷、分卷。
 */

/* ------------------------------- 常量 ------------------------------- */

// RAR 2.x
const NC20 = 298, DC20 = 48, RC20 = 28, BC20 = 19, MC20 = 257;
// RAR 3.x / 4.x
const NC30 = 299, DC30 = 60, LDC30 = 17, RC30 = 28, BC30 = 20;
const HUFF_TABLE_SIZE30 = NC30 + DC30 + RC30 + LDC30; // 404
// RAR 5.x
const NCR = 306, DCB = 64, DCX = 80, LDC = 16, RCR = 44, BC = 20;
const HUFF_TABLE_SIZEB = NCR + DCB + RCR + LDC; // 430
const HUFF_TABLE_SIZEX = NCR + DCX + RCR + LDC; // 446

const MAX_QUICK_DECODE_BITS = 9;
const LOW_DIST_REP_COUNT = 16;
const MAX3_INC_LZ_MATCH = 0x101 + 3; // 260
const MAX_INC_LZ_MATCH = 0x1001 + 3; // 4100

const LDecode = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 16, 20, 24, 28, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224];
const LBits = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5];
const SDDecode = [0, 4, 8, 16, 32, 64, 128, 192];
const SDBits = [2, 2, 3, 4, 5, 6, 6, 6];

const DDecode20 = [0, 1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512, 768,
  1024, 1536, 2048, 3072, 4096, 6144, 8192, 12288, 16384, 24576, 32768, 49152, 65536, 98304,
  131072, 196608, 262144, 327680, 393216, 458752, 524288, 589824, 655360, 720896, 786432, 851968, 917504, 983040];
const DBits20 = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10,
  11, 11, 12, 12, 13, 13, 14, 14, 15, 15, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16];

const DBitLengthCounts = [4, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 14, 0, 12];
const DDecode30 = new Int32Array(DC30);
const DBits30 = new Uint8Array(DC30);
(() => {
  let dist = 0, bitLength = 0, slot = 0;
  for (let i = 0; i < DBitLengthCounts.length; i += 1, bitLength += 1) {
    for (let j = 0; j < DBitLengthCounts[i]; j += 1, slot += 1, dist += (1 << bitLength)) {
      DDecode30[slot] = dist;
      DBits30[slot] = bitLength;
    }
  }
})();

const MAX_WINDOW_BYTES = 16 * 1024 * 1024; // Workers 内存有限，字典上限收到 16MB
const MAX_FILTER_BLOCK_SIZE = 0x400000;
const MAX_UNPACK_FILTERS = 8192;

// unrar compress.hpp FilterType
const FILTER_NONE = 255, FILTER_DELTA = 0, FILTER_E8 = 1, FILTER_E8E9 = 2, FILTER_ARM = 3;

class RarError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RarError';
  }
}

/* ------------------------------ 位输入流 ------------------------------ */

class BitInput {
  constructor(buf, start, end) {
    this.buf = buf;
    this.inAddr = start;
    this.inBit = 0;
    this.end = end;
  }

  at(i) {
    return i < this.end ? this.buf[i] : 0;
  }

  // 返回从当前位置起的 16 位（MSB first，左对齐）。
  getbits() {
    const i = this.inAddr;
    let bf = ((this.at(i) << 16) | (this.at(i + 1) << 8) | this.at(i + 2)) >>> 0;
    bf = (bf >>> (8 - this.inBit)) & 0xffff;
    return bf;
  }

  getbits32() {
    const i = this.inAddr;
    let bf = ((this.at(i) << 24) | (this.at(i + 1) << 16) | (this.at(i + 2) << 8) | this.at(i + 3)) >>> 0;
    bf = (bf << this.inBit) >>> 0;
    bf = (bf | (this.at(i + 4) >> (8 - this.inBit))) >>> 0;
    return bf;
  }

  getbits64() {
    const i = this.inAddr;
    let bf = 0n;
    for (let k = 0; k < 8; k += 1) bf = (bf << 8n) | BigInt(this.at(i + k));
    bf = (bf << BigInt(this.inBit)) | (BigInt(this.at(i + 8)) >> BigInt(8 - this.inBit));
    return bf;
  }

  addbits(bits) {
    const total = bits + this.inBit;
    this.inAddr += total >> 3;
    this.inBit = total & 7;
  }

  alignByte() {
    if (this.inBit !== 0) this.addbits((8 - this.inBit) & 7);
  }
}

/* ------------------------------ Huffman 表 ------------------------------ */

function makeDecodeTables(lengthTable, size) {
  const lengthCount = new Int32Array(16);
  for (let i = 0; i < size; i += 1) lengthCount[lengthTable[i] & 0xf] += 1;
  lengthCount[0] = 0;

  const dec = {
    maxNum: size,
    decodeNum: new Uint16Array(size),
    decodePos: new Int32Array(16),
    decodeLen: new Uint32Array(16),
    quickBits: 0,
    quickLen: null,
    quickNum: null
  };

  dec.decodePos[0] = 0;
  dec.decodeLen[0] = 0;

  let upperLimit = 0;
  for (let i = 1; i < 16; i += 1) {
    upperLimit += lengthCount[i];
    const leftAligned = upperLimit << (16 - i);
    upperLimit *= 2;
    dec.decodeLen[i] = leftAligned;
    dec.decodePos[i] = dec.decodePos[i - 1] + lengthCount[i - 1];
  }

  const copyDecodePos = Int32Array.from(dec.decodePos);
  for (let i = 0; i < size; i += 1) {
    const curBitLength = lengthTable[i] & 0xf;
    if (curBitLength !== 0) {
      dec.decodeNum[copyDecodePos[curBitLength]] = i;
      copyDecodePos[curBitLength] += 1;
    }
  }

  dec.quickBits =
    size === NCR || size === NC20 || size === NC30
      ? MAX_QUICK_DECODE_BITS
      : (MAX_QUICK_DECODE_BITS > 3 ? MAX_QUICK_DECODE_BITS - 3 : 0);

  const quickDataSize = 1 << dec.quickBits;
  dec.quickLen = new Uint8Array(quickDataSize);
  dec.quickNum = new Uint16Array(quickDataSize);

  let curBitLength = 1;
  for (let code = 0; code < quickDataSize; code += 1) {
    const bitField = code << (16 - dec.quickBits);
    while (curBitLength < 16 && bitField >= dec.decodeLen[curBitLength]) curBitLength += 1;
    dec.quickLen[code] = curBitLength;
    let dist = bitField - dec.decodeLen[curBitLength - 1];
    dist >>= 16 - curBitLength;
    const pos = dec.decodePos[curBitLength] + dist;
    dec.quickNum[code] = curBitLength < 16 && pos < size ? dec.decodeNum[pos] : 0;
  }

  return dec;
}

function decodeNumber(inp, dec) {
  const bitField = inp.getbits() & 0xfffe;

  if (bitField < dec.decodeLen[dec.quickBits]) {
    const code = bitField >> (16 - dec.quickBits);
    inp.addbits(dec.quickLen[code]);
    return dec.quickNum[code];
  }

  let bits = 15;
  for (let i = dec.quickBits + 1; i < 15; i += 1) {
    if (bitField < dec.decodeLen[i]) {
      bits = i;
      break;
    }
  }

  inp.addbits(bits);

  let dist = bitField - dec.decodeLen[bits - 1];
  dist >>= 16 - bits;

  let pos = dec.decodePos[bits] + dist;
  if (pos >= dec.maxNum) pos = 0;
  return dec.decodeNum[pos];
}

/* ------------------------------ 小工具 ------------------------------ */

function readU16LE(bytes, pos) {
  return bytes[pos] | (bytes[pos + 1] << 8);
}

function readU32At(bytes, pos) {
  return (bytes[pos] | (bytes[pos + 1] << 8) | (bytes[pos + 2] << 16) | ((bytes[pos + 3] << 24) >>> 0)) >>> 0;
}

function readVint(bytes, pos, end) {
  let result = 0;
  let p = pos;
  for (let shift = 0; p < end && shift < 64; shift += 7) {
    const cur = bytes[p];
    p += 1;
    result += (cur & 0x7f) * 2 ** shift;
    if ((cur & 0x80) === 0) return [result, p];
  }
  return [0, p];
}

function tryDecodeUtf8(bytes) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return text.includes('\0') ? null : text;
  } catch {
    return null;
  }
}

function decodeRarName(bytes, preferUtf8) {
  // 先试严格 UTF-8：合法的 UTF-8 序列几乎不可能是有效的 GBK 名字，
  // 这样既能处理新版归档的 UTF-8 名字，也不会破坏 GBK 名字（GBK 字节通常不是合法 UTF-8）。
  const utf8Text = tryDecodeUtf8(bytes);
  if (utf8Text !== null) return utf8Text;

  if (preferUtf8) {
    return new TextDecoder('utf-8').decode(bytes);
  }
  for (const encoding of ['gb18030', 'big5', 'shift_jis', 'windows-1252']) {
    try {
      return new TextDecoder(encoding).decode(bytes);
    } catch {
      /* continue */
    }
  }
  return new TextDecoder('utf-8').decode(bytes);
}

// RAR 归档内部统一用 '\' 作路径分隔符，对外按 unrar 惯例转成 '/'
function normalizeRarPath(name) {
  return String(name).replace(/\\/gu, '/');
}

// RAR 4.x 的 LHD_UNICODE 名字：ASCII 部分 + \0 + 编码后的 UTF-16 序列
// 算法照 unrar encname.cpp EncodeFileName::Decode
function decodeRar4UnicodeName(nameBytes) {
  let zero = nameBytes.length;
  for (let i = 0; i < nameBytes.length; i += 1) {
    if (nameBytes[i] === 0) { zero = i; break; }
  }
  const name = nameBytes.subarray(0, zero);
  const encName = nameBytes.subarray(Math.min(zero + 1, nameBytes.length));
  const encSize = encName.length;

  let encPos = 0;
  let decPos = 0;
  const highByte = encPos < encSize ? encName[encPos++] : 0;
  const codes = [];
  let flags = 0;
  let flagBits = 0;

  while (encPos < encSize) {
    if (flagBits === 0) {
      flags = encName[encPos];
      encPos += 1;
      flagBits = 8;
    }
    switch (flags >> 6) {
      case 0:
        if (encPos >= encSize) break;
        codes.push(encName[encPos]);
        encPos += 1;
        decPos += 1;
        break;
      case 1:
        if (encPos >= encSize) break;
        codes.push((encName[encPos] + (highByte << 8)) & 0xffff);
        encPos += 1;
        decPos += 1;
        break;
      case 2:
        if (encPos + 1 >= encSize) break;
        codes.push((encName[encPos] + (encName[encPos + 1] << 8)) & 0xffff);
        encPos += 2;
        decPos += 1;
        break;
      default: {
        if (encPos >= encSize) break;
        let length = encName[encPos];
        encPos += 1;
        if ((length & 0x80) !== 0) {
          if (encPos >= encSize) break;
          const correction = encName[encPos];
          encPos += 1;
          for (length = (length & 0x7f) + 2; length > 0 && decPos < name.length; length -= 1, decPos += 1) {
            codes.push((((name[decPos] + correction) & 0xff) + (highByte << 8)) & 0xffff);
          }
        } else {
          for (length += 2; length > 0 && decPos < name.length; length -= 1, decPos += 1) {
            codes.push(name[decPos]);
          }
        }
        break;
      }
    }
    flags = (flags << 2) & 0xff;
    flagBits -= 2;
  }

  if (!codes.length) return null;
  return String.fromCharCode(...codes);
}

function nextPow2(value) {
  let v = 1;
  while (v < value) v *= 2;
  return v;
}

/* --------------------------- 解压器公共基类 --------------------------- */

class UnpackerBase {
  constructor(winSize) {
    this.winSize = winSize;
    this.mask = winSize - 1;
    this.window = new Uint8Array(winSize);
    this.unpPtr = 0;
    this.wrPtr = 0;
    this.prevPtr = 0;
    this.firstWinDone = false;
    this.oldDist = [-1, -1, -1, -1];
    this.lastDist = -1;
    this.lastLength = 0;
    this.oldDistPtr = 0;
    this.chunks = [];
    this.writtenFileSize = 0;
    this.destUnpSize = 0;
  }

  resetFileState(solid) {
    this.chunks = [];
    this.writtenFileSize = 0;
    if (!solid) {
      this.unpPtr = 0;
      this.wrPtr = 0;
      this.prevPtr = 0;
      this.firstWinDone = false;
      this.oldDist = [-1, -1, -1, -1];
      this.lastDist = -1;
      this.lastLength = 0;
      this.oldDistPtr = 0;
    }
  }

  insertOldDist(distance) {
    this.oldDist[3] = this.oldDist[2];
    this.oldDist[2] = this.oldDist[1];
    this.oldDist[1] = this.oldDist[0];
    this.oldDist[0] = distance;
  }

  copyString(length, distance) {
    const win = this.window;
    const winSize = this.winSize;
    const mask = this.mask;
    let src = this.unpPtr - distance;

    if (distance > this.unpPtr) {
      src += winSize;
      if (distance > winSize || !this.firstWinDone) {
        while (length > 0) {
          win[this.unpPtr] = 0;
          this.unpPtr = (this.unpPtr + 1) & mask;
          length -= 1;
        }
        return;
      }
    }

    // 不重叠且两端都不越界时可整块拷贝（memcpy 语义，安全）。
    if (
      distance >= length &&
      src >= 0 &&
      src + length <= winSize &&
      this.unpPtr + length <= winSize
    ) {
      win.set(win.subarray(src, src + length), this.unpPtr);
      this.unpPtr += length;
      return;
    }

    while (length > 0) {
      win[this.unpPtr] = win[src++ & mask];
      this.unpPtr = (this.unpPtr + 1) & mask;
      length -= 1;
    }
  }

  writeArea(start, end) {
    if (end === start) return;
    const win = this.window;
    if (end > start) {
      this.chunks.push(win.slice(start, end));
      this.writtenFileSize += end - start;
    } else {
      this.chunks.push(win.slice(start, this.winSize));
      this.chunks.push(win.slice(0, end));
      this.writtenFileSize += this.winSize - start + end;
    }
    if (this.writtenFileSize > this.destUnpSize + (1024 * 1024)) {
      throw new RarError('RAR output exceeds expected size');
    }
  }

  // 从环形窗口读取 len 字节（处理环绕）
  readWindow(start, len) {
    const out = new Uint8Array(len);
    const win = this.window;
    for (let i = 0; i < len; i += 1) out[i] = win[(start + i) & this.mask];
    return out;
  }

  // 直接输出已经过 filter 处理的数据（不经过窗口）
  writeFiltered(data) {
    this.chunks.push(data);
    this.writtenFileSize += data.length;
    if (this.writtenFileSize > this.destUnpSize + (1024 * 1024)) {
      throw new RarError('RAR output exceeds expected size');
    }
  }

  result() {
    let total = 0;
    for (const chunk of this.chunks) total += chunk.length;
    const out = new Uint8Array(Math.min(total, this.destUnpSize >= 0 ? this.destUnpSize : total));
    let offset = 0;
    for (const chunk of this.chunks) {
      if (offset >= out.length) break;
      const take = Math.min(chunk.length, out.length - offset);
      out.set(chunk.subarray(0, take), offset);
      offset += take;
    }
    return out;
  }
}

/* ---------------------- RAR 2.x / 3.x / 4.x 解压器 ---------------------- */

class Unpacker4 extends UnpackerBase {
  constructor(winSize, unpVer) {
    super(winSize);
    this.unpVer = unpVer;
    this.unpOldTable = new Uint8Array(HUFF_TABLE_SIZE30);
    this.unpOldTable20 = new Uint8Array(MC20 * 4);
    this.tablesRead = false;
    this.prevLowDist = 0;
    this.lowDistRepCount = 0;
    this.blockType = 0; // 0 = BLOCK_LZ
    this.LD = null;
    this.DD = null;
    this.LDD = null;
    this.RD = null;
    this.BD = null;
    this.readTop = 0;
    this.readBorder = 0;
    this.inp = null;
  }

  resetTableState(solid) {
    if (!solid) {
      this.tablesRead = false;
      this.unpOldTable.fill(0);
      this.unpOldTable20.fill(0);
      this.blockType = 0;
      this.prevLowDist = 0;
      this.lowDistRepCount = 0;
    }
  }

  readBuf() {
    this.readBorder = this.readTop - 30;
    return true; // 数据全部在内存，靠 destUnpSize / 块结束标志终止
  }

  writeBuf() {
    const writtenBorder = this.wrPtr;
    this.writeArea(writtenBorder & this.mask, this.unpPtr & this.mask);
    this.wrPtr = this.unpPtr & this.mask;
  }

  readTables30() {
    const inp = this.inp;
    if (inp.inAddr > this.readTop - 25) this.readBuf();

    inp.alignByte();
    const bitField = inp.getbits();
    if (bitField & 0x8000) {
      throw new RarError('PPMd compressed RAR is not supported');
    }
    this.prevLowDist = 0;
    this.lowDistRepCount = 0;

    if (!(bitField & 0x4000)) this.unpOldTable.fill(0);
    inp.addbits(2);

    const bitLength = new Uint8Array(BC30);
    for (let i = 0; i < BC30; i += 1) {
      let length = inp.getbits() >> 12;
      inp.addbits(4);
      if (length === 15) {
        let zeroCount = inp.getbits() >> 12;
        inp.addbits(4);
        if (zeroCount === 0) {
          bitLength[i] = 15;
        } else {
          zeroCount += 2;
          while (zeroCount > 0 && i < bitLength.length) {
            bitLength[i] = 0;
            i += 1;
            zeroCount -= 1;
          }
          i -= 1;
        }
      } else {
        bitLength[i] = length;
      }
    }

    this.BD = makeDecodeTables(bitLength, BC30);

    const table = new Uint8Array(HUFF_TABLE_SIZE30);
    const tableSize = HUFF_TABLE_SIZE30;
    for (let i = 0; i < tableSize;) {
      if (inp.inAddr > this.readTop - 5) this.readBuf();
      const number = decodeNumber(inp, this.BD);
      if (number < 16) {
        table[i] = (number + this.unpOldTable[i]) & 0xf;
        i += 1;
      } else if (number < 18) {
        let n;
        if (number === 16) {
          n = (inp.getbits() >> 13) + 3;
          inp.addbits(3);
        } else {
          n = (inp.getbits() >> 9) + 11;
          inp.addbits(7);
        }
        if (i === 0) return false;
        while (n > 0 && i < tableSize) {
          table[i] = table[i - 1];
          i += 1;
          n -= 1;
        }
      } else {
        let n;
        if (number === 18) {
          n = (inp.getbits() >> 13) + 3;
          inp.addbits(3);
        } else {
          n = (inp.getbits() >> 9) + 11;
          inp.addbits(7);
        }
        while (n > 0 && i < tableSize) {
          table[i] = 0;
          i += 1;
          n -= 1;
        }
      }
    }

    this.tablesRead = true;
    this.LD = makeDecodeTables(table.subarray(0, NC30), NC30);
    this.DD = makeDecodeTables(table.subarray(NC30, NC30 + DC30), DC30);
    this.LDD = makeDecodeTables(table.subarray(NC30 + DC30, NC30 + DC30 + LDC30), LDC30);
    this.RD = makeDecodeTables(table.subarray(NC30 + DC30 + LDC30, tableSize), RC30);
    this.unpOldTable.set(table);
    return true;
  }

  readTables20() {
    const inp = this.inp;
    if (inp.inAddr > this.readTop - 25) this.readBuf();

    const bitField = inp.getbits();
    const audioBlock = (bitField & 0x8000) !== 0;
    if (audioBlock) throw new RarError('RAR 2.x multimedia compression is not supported');

    if (!(bitField & 0x4000)) this.unpOldTable20.fill(0);
    inp.addbits(2);

    const tableSize = NC20 + DC20 + RC20;
    const bitLength = new Uint8Array(BC20);
    for (let i = 0; i < BC20; i += 1) {
      bitLength[i] = inp.getbits() >> 12;
      inp.addbits(4);
    }
    this.BD = makeDecodeTables(bitLength, BC20);

    const table = new Uint8Array(MC20 * 4);
    for (let i = 0; i < tableSize;) {
      if (inp.inAddr > this.readTop - 5) this.readBuf();
      const number = decodeNumber(inp, this.BD);
      if (number < 16) {
        table[i] = (number + this.unpOldTable20[i]) & 0xf;
        i += 1;
      } else if (number === 16) {
        let n = (inp.getbits() >> 14) + 3;
        inp.addbits(2);
        if (i === 0) return false;
        while (n > 0 && i < tableSize) {
          table[i] = table[i - 1];
          i += 1;
          n -= 1;
        }
      } else {
        let n;
        if (number === 17) {
          n = (inp.getbits() >> 13) + 3;
          inp.addbits(3);
        } else {
          n = (inp.getbits() >> 9) + 11;
          inp.addbits(7);
        }
        while (n > 0 && i < tableSize) {
          table[i] = 0;
          i += 1;
          n -= 1;
        }
      }
    }

    this.tablesRead = true;
    this.LD = makeDecodeTables(table.subarray(0, NC20), NC20);
    this.DD = makeDecodeTables(table.subarray(NC20, NC20 + DC20), DC20);
    this.RD = makeDecodeTables(table.subarray(NC20 + DC20, tableSize), RC20);
    this.unpOldTable20.set(table.subarray(0, tableSize));
    return true;
  }

  readEndOfBlock() {
    const inp = this.inp;
    const bitField = inp.getbits();
    let newTable;
    let newFile = false;

    if ((bitField & 0x8000) !== 0) {
      newTable = true;
      inp.addbits(1);
    } else {
      newFile = true;
      newTable = (bitField & 0x4000) !== 0;
      inp.addbits(2);
    }
    this.tablesRead = !newTable;

    if (newFile) return false;
    return this.readTables30();
  }

  unpack20(dataOffset, dataEnd, unpSize, solid) {
    const inp = new BitInput(this.buf, dataOffset, dataEnd);
    this.inp = inp;
    this.readTop = dataEnd;
    this.destUnpSize = unpSize;
    this.resetFileState(solid);
    this.resetTableState(solid);

    if (!this.readBuf()) return this.result();
    if ((!solid || !this.tablesRead) && !this.readTables20()) return this.result();

    let guard = 0;
    const guardLimit = Math.max(1000000, (dataEnd - dataOffset) * 64);

    while (true) {
      this.unpPtr &= this.mask;
      this.firstWinDone = this.firstWinDone || this.prevPtr > this.unpPtr;
      this.prevPtr = this.unpPtr;

      if (inp.inAddr > this.readBorder && !this.readBuf()) break;
      if (((this.wrPtr - this.unpPtr) & this.mask) < 270 && this.wrPtr !== this.unpPtr) {
        this.writeBuf();
        if (this.writtenFileSize > this.destUnpSize) return this.result();
      }

      if (++guard > guardLimit) break;

      const number = decodeNumber(inp, this.LD);
      if (number < 256) {
        this.window[this.unpPtr++] = number;
        continue;
      }
      if (number > 269) {
        let length = LDecode[number - 270] + 3;
        let bits = LBits[number - 270];
        if (bits > 0) {
          length += inp.getbits() >> (16 - bits);
          inp.addbits(bits);
        }

        const distNumber = decodeNumber(inp, this.DD);
        let distance = DDecode20[distNumber] + 1;
        bits = DBits20[distNumber];
        if (bits > 0) {
          distance += inp.getbits() >> (16 - bits);
          inp.addbits(bits);
        }

        if (distance >= 0x2000) {
          length += 1;
          if (distance >= 0x40000) length += 1;
        }

        this.lastDist = distance;
        this.oldDist[this.oldDistPtr++] = distance;
        this.oldDistPtr = this.oldDistPtr & 3;
        this.lastLength = length;
        this.copyString(length, distance);
        continue;
      }
      if (number === 269) {
        if (!this.readTables20()) break;
        continue;
      }
      if (number === 256) {
        this.copyString(this.lastLength, this.lastDist);
        continue;
      }
      if (number < 261) {
        const distance = this.oldDist[(this.oldDistPtr - (number - 256)) & 3];
        const lengthNumber = decodeNumber(inp, this.RD);
        let length = LDecode[lengthNumber] + 2;
        const bits = LBits[lengthNumber];
        if (bits > 0) {
          length += inp.getbits() >> (16 - bits);
          inp.addbits(bits);
        }
        if (distance >= 0x101) {
          length += 1;
          if (distance >= 0x2000) {
            length += 1;
            if (distance >= 0x40000) length += 1;
          }
        }
        this.lastDist = distance;
        this.oldDist[this.oldDistPtr++] = distance;
        this.oldDistPtr = this.oldDistPtr & 3;
        this.lastLength = length;
        this.copyString(length, distance);
        continue;
      }
      if (number < 270) {
        let distance = SDDecode[number - 261] + 1;
        const bits = SDBits[number - 261];
        if (bits > 0) {
          distance += inp.getbits() >> (16 - bits);
          inp.addbits(bits);
        }
        this.lastDist = distance;
        this.oldDist[this.oldDistPtr++] = distance;
        this.oldDistPtr = this.oldDistPtr & 3;
        this.lastLength = 2;
        this.copyString(2, distance);
      }
    }

    this.writeBuf();
    return this.result();
  }

  unpack29(dataOffset, dataEnd, unpSize, solid) {
    const inp = new BitInput(this.buf, dataOffset, dataEnd);
    this.inp = inp;
    this.readTop = dataEnd;
    this.destUnpSize = unpSize;
    this.resetFileState(solid);
    this.resetTableState(solid);

    if (!this.readBuf()) return this.result();
    if ((!solid || !this.tablesRead) && !this.readTables30()) return this.result();

    let guard = 0;
    const guardLimit = Math.max(1000000, (dataEnd - dataOffset) * 64);

    while (true) {
      this.unpPtr &= this.mask;
      this.firstWinDone = this.firstWinDone || this.prevPtr > this.unpPtr;
      this.prevPtr = this.unpPtr;

      if (inp.inAddr > this.readBorder && !this.readBuf()) break;
      if (((this.wrPtr - this.unpPtr) & this.mask) <= MAX3_INC_LZ_MATCH && this.wrPtr !== this.unpPtr) {
        this.writeBuf();
        if (this.writtenFileSize > this.destUnpSize) return this.result();
      }

      if (++guard > guardLimit) break;

      const number = decodeNumber(inp, this.LD);
      if (number < 256) {
        this.window[this.unpPtr++] = number;
        continue;
      }
      if (number >= 271) {
        const slot = number - 271;
        let length = LDecode[slot] + 3;
        let bits = LBits[slot];
        if (bits > 0) {
          length += inp.getbits() >> (16 - bits);
          inp.addbits(bits);
        }

        const distNumber = decodeNumber(inp, this.DD);
        let distance = DDecode30[distNumber] + 1;
        bits = DBits30[distNumber];
        if (bits > 0) {
          if (distNumber > 9) {
            if (bits > 4) {
              distance += ((inp.getbits() >> (20 - bits)) << 4);
              inp.addbits(bits - 4);
            }
            if (this.lowDistRepCount > 0) {
              this.lowDistRepCount -= 1;
              distance += this.prevLowDist;
            } else {
              const lowDist = decodeNumber(inp, this.LDD);
              if (lowDist === 16) {
                this.lowDistRepCount = LOW_DIST_REP_COUNT - 1;
                distance += this.prevLowDist;
              } else {
                distance += lowDist;
                this.prevLowDist = lowDist;
              }
            }
          } else {
            distance += inp.getbits() >> (16 - bits);
            inp.addbits(bits);
          }
        }

        if (distance >= 0x2000) {
          length += 1;
          if (distance >= 0x40000) length += 1;
        }

        this.insertOldDist(distance);
        this.lastLength = length;
        this.copyString(length, distance);
        continue;
      }
      if (number === 256) {
        if (!this.readEndOfBlock()) break;
        continue;
      }
      if (number === 257) {
        // RAR 3.x 的过滤器是一段需要在 RAR 虚拟机上执行的字节码程序
        // （x86 / delta / ARM 等）。不实现虚拟机就无法还原数据，
        // 这里直接报错而不是产出错误内容。
        throw new RarError('RAR filter (VM code) is not supported');
      }
      if (number === 258) {
        if (this.lastLength !== 0) this.copyString(this.lastLength, this.oldDist[0]);
        continue;
      }
      if (number < 263) {
        const distNum = number - 259;
        const distance = this.oldDist[distNum];
        for (let i = distNum; i > 0; i -= 1) this.oldDist[i] = this.oldDist[i - 1];
        this.oldDist[0] = distance;

        const lengthNumber = decodeNumber(inp, this.RD);
        let length = LDecode[lengthNumber] + 2;
        const bits = LBits[lengthNumber];
        if (bits > 0) {
          length += inp.getbits() >> (16 - bits);
          inp.addbits(bits);
        }
        this.lastLength = length;
        this.copyString(length, distance);
        continue;
      }
      if (number < 272) {
        const slot = number - 263;
        let distance = SDDecode[slot] + 1;
        const bits = SDBits[slot];
        if (bits > 0) {
          distance += inp.getbits() >> (16 - bits);
          inp.addbits(bits);
        }
        this.insertOldDist(distance);
        this.lastLength = 2;
        this.copyString(2, distance);
      }
    }

    this.writeBuf();
    return this.result();
  }

  unpack(dataOffset, dataEnd, unpSize, solid) {
    if (this.unpVer >= 29) return this.unpack29(dataOffset, dataEnd, unpSize, solid);
    if (this.unpVer === 20 || this.unpVer === 26) return this.unpack20(dataOffset, dataEnd, unpSize, solid);
    throw new RarError(`Unsupported RAR unpack version ${this.unpVer}`);
  }
}

/* --------------------------- RAR 5.0 解压器 --------------------------- */

class Unpacker5 extends UnpackerBase {
  constructor(winSize, extraDist) {
    super(winSize);
    this.extraDist = extraDist;
    this.filters = [];
    this.tablesRead = false;
    this.LD = null;
    this.DD = null;
    this.LDD = null;
    this.RD = null;
    this.BD = null;
    this.readTop = 0;
    this.readBorder = 0;
    this.inp = null;
    this.block = {
      headerSize: 0,
      blockStart: 0,
      blockSize: -1,
      blockBitSize: 0,
      lastBlockInFile: false,
      tablePresent: false
    };
  }

  resetTableState(solid) {
    if (!solid) this.tablesRead = false;
  }

  readFilterData() {
    const inp = this.inp;
    const byteCount = (inp.getbits() >> 14) + 1;
    inp.addbits(2);
    let data = 0;
    for (let i = 0; i < byteCount; i += 1) {
      data += ((inp.getbits() >> 8) & 0xff) << (i * 8);
      inp.addbits(8);
    }
    return data >>> 0;
  }

  readFilter() {
    const inp = this.inp;
    if (inp.inAddr > this.readTop - 16) this.readBuf();

    const blockStart = this.readFilterData();
    let blockLength = this.readFilterData();
    if (blockLength > MAX_FILTER_BLOCK_SIZE) blockLength = 0;

    const type = inp.getbits() >> 13;
    inp.addbits(3);

    let channels = 1;
    if (type === FILTER_DELTA) {
      channels = (inp.getbits() >> 11) + 1;
      inp.addbits(5);
    }
    return { blockStart, blockLength, type, channels, nextWindow: false };
  }

  addFilter(filter) {
    if (this.filters.length >= MAX_UNPACK_FILTERS) {
      this.writeBuf();
      if (this.filters.length >= MAX_UNPACK_FILTERS) this.filters.length = 0;
    }
    filter.nextWindow =
      this.wrPtr !== this.unpPtr &&
      ((this.wrPtr - this.unpPtr) & this.mask) <= filter.blockStart;
    filter.blockStart = (filter.blockStart + this.unpPtr) % this.winSize;
    this.filters.push(filter);
    return true;
  }

  applyFilter(data, flt) {
    switch (flt.type) {
      case FILTER_DELTA: {
        const channels = flt.channels;
        const dst = new Uint8Array(data.length);
        let srcPos = 0;
        for (let curChannel = 0; curChannel < channels; curChannel += 1) {
          let prevByte = 0;
          for (let destPos = curChannel; destPos < data.length; destPos += channels) {
            prevByte = (prevByte - data[srcPos]) & 0xff;
            dst[destPos] = prevByte;
            srcPos += 1;
          }
        }
        return dst;
      }
      case FILTER_E8:
      case FILTER_E8E9: {
        const fileOffset = this.writtenFileSize;
        const fileSize = 0x1000000;
        const cmpByte2 = flt.type === FILTER_E8E9 ? 0xe9 : 0xe8;
        for (let curPos = 0; curPos + 4 < data.length;) {
          const curByte = data[curPos];
          curPos += 1;
          if (curByte === 0xe8 || curByte === cmpByte2) {
            const offset = (curPos + fileOffset) % fileSize;
            let addr =
              (data[curPos] | (data[curPos + 1] << 8) | (data[curPos + 2] << 16) | (data[curPos + 3] << 24)) >>> 0;
            if ((addr & 0x80000000) !== 0) {
              if (((addr + offset) & 0x80000000) === 0) addr = (addr + fileSize) >>> 0;
            } else if ((((addr - fileSize) >>> 0) & 0x80000000) !== 0) {
              addr = (addr - offset) >>> 0;
            }
            data[curPos] = addr & 0xff;
            data[curPos + 1] = (addr >>> 8) & 0xff;
            data[curPos + 2] = (addr >>> 16) & 0xff;
            data[curPos + 3] = (addr >>> 24) & 0xff;
            curPos += 4;
          }
        }
        return data;
      }
      case FILTER_ARM: {
        for (let curPos = 0; curPos + 3 < data.length; curPos += 4) {
          if (data[curPos + 3] === 0xeb) {
            let offset = data[curPos] + data[curPos + 1] * 0x100 + data[curPos + 2] * 0x10000;
            offset -= Math.floor((this.writtenFileSize + curPos) / 4);
            data[curPos] = offset & 0xff;
            data[curPos + 1] = (offset >>> 8) & 0xff;
            data[curPos + 2] = (offset >>> 16) & 0xff;
          }
        }
        return data;
      }
      default:
        throw new RarError(`Unsupported RAR5 filter type ${flt.type}`);
    }
  }

  readBuf() {
    this.readBorder = this.readTop - 30;
    // BlockSize 为 -1 表示块大小尚未定义（对应 unrar 里的同一判断）
    if (this.block.blockSize !== -1) {
      this.readBorder = Math.min(
        this.readBorder,
        this.block.blockStart + this.block.blockSize - 1
      );
    }
    return true;
  }

  writeBuf() {
    let writtenBorder = this.wrPtr;
    const fullWriteSize = (this.unpPtr - writtenBorder) & this.mask;
    let writeSizeLeft = fullWriteSize;
    let notAllFiltersProcessed = false;

    for (let i = 0; i < this.filters.length; i += 1) {
      const flt = this.filters[i];
      if (flt.type === FILTER_NONE) continue;

      if (flt.nextWindow) {
        if (((flt.blockStart - this.wrPtr) & this.mask) <= fullWriteSize) flt.nextWindow = false;
        continue;
      }

      const blockStart = flt.blockStart;
      const blockLength = flt.blockLength;

      if (((blockStart - writtenBorder) & this.mask) < writeSizeLeft) {
        if (writtenBorder !== blockStart) {
          this.writeArea(writtenBorder, blockStart);
          writtenBorder = blockStart;
          writeSizeLeft = (this.unpPtr - writtenBorder) & this.mask;
        }
        if (blockLength <= writeSizeLeft) {
          if (blockLength > 0) {
            const blockEnd = (blockStart + blockLength) & this.mask;
            const mem = this.readWindow(blockStart, blockLength);
            const out = this.applyFilter(mem, flt);
            flt.type = FILTER_NONE;
            if (out) this.writeFiltered(out);
            writtenBorder = blockEnd;
            writeSizeLeft = (this.unpPtr - writtenBorder) & this.mask;
          }
        } else {
          // filter 跨越写入边界，留到下一轮处理
          for (let j = i; j < this.filters.length; j += 1) {
            if (this.filters[j].type !== FILTER_NONE) this.filters[j].nextWindow = false;
          }
          this.wrPtr = writtenBorder;
          notAllFiltersProcessed = true;
          break;
        }
      }
    }

    // 清理已处理的 filter
    let emptyCount = 0;
    for (let i = 0; i < this.filters.length; i += 1) {
      if (emptyCount > 0) this.filters[i - emptyCount] = this.filters[i];
      if (this.filters[i].type === FILTER_NONE) emptyCount += 1;
    }
    if (emptyCount > 0) this.filters.length = this.filters.length - emptyCount;

    if (!notAllFiltersProcessed) {
      this.writeArea(writtenBorder, this.unpPtr);
      this.wrPtr = this.unpPtr;
    }
  }

  slotToLength(inp, slot) {
    let lbits;
    let length = 2;
    if (slot < 8) {
      lbits = 0;
      length += slot;
    } else {
      lbits = Math.floor(slot / 4) - 1; // C 里是整数除法
      length += (4 | (slot & 3)) << lbits;
    }
    if (lbits > 0) {
      length += inp.getbits() >> (16 - lbits);
      inp.addbits(lbits);
    }
    return length;
  }

  readBlockHeader() {
    const inp = this.inp;
    if (inp.inAddr > this.readTop - 7) this.readBuf();
    inp.alignByte();

    const blockFlags = (inp.getbits() >> 8) & 0xff;
    inp.addbits(8);
    const byteCount = ((blockFlags >> 3) & 3) + 1;
    if (byteCount === 4) return false;

    const header = this.block;
    header.headerSize = 2 + byteCount;
    header.blockBitSize = (blockFlags & 7) + 1;

    const savedCheckSum = (inp.getbits() >> 8) & 0xff;
    inp.addbits(8);

    let blockSize = 0;
    for (let i = 0; i < byteCount; i += 1) {
      blockSize += ((inp.getbits() >> 8) & 0xff) << (i * 8);
      inp.addbits(8);
    }

    const checkSum =
      0x5a ^ blockFlags ^ blockSize ^ (blockSize >> 8) ^ (blockSize >> 16);
    if ((checkSum & 0xff) !== savedCheckSum) return false;

    header.blockSize = blockSize;
    header.blockStart = inp.inAddr;
    this.readBorder = Math.min(this.readBorder, header.blockStart + header.blockSize - 1);
    header.lastBlockInFile = (blockFlags & 0x40) !== 0;
    header.tablePresent = (blockFlags & 0x80) !== 0;
    return true;
  }

  readTables() {
    const header = this.block;
    const inp = this.inp;
    if (!header.tablePresent) return true;
    if (inp.inAddr > this.readTop - 25) this.readBuf();

    const bitLength = new Uint8Array(BC);
    for (let i = 0; i < BC; i += 1) {
      let length = inp.getbits() >> 12;
      inp.addbits(4);
      if (length === 15) {
        let zeroCount = inp.getbits() >> 12;
        inp.addbits(4);
        if (zeroCount === 0) {
          bitLength[i] = 15;
        } else {
          zeroCount += 2;
          while (zeroCount > 0 && i < bitLength.length) {
            bitLength[i] = 0;
            i += 1;
            zeroCount -= 1;
          }
          i -= 1;
        }
      } else {
        bitLength[i] = length;
      }
    }

    this.BD = makeDecodeTables(bitLength, BC);

    const tableSize = this.extraDist ? HUFF_TABLE_SIZEX : HUFF_TABLE_SIZEB;
    const table = new Uint8Array(HUFF_TABLE_SIZEX);
    for (let i = 0; i < tableSize;) {
      if (inp.inAddr > this.readTop - 5) this.readBuf();
      const number = decodeNumber(inp, this.BD);
      if (number < 16) {
        table[i] = number;
        i += 1;
      } else if (number < 18) {
        let n;
        if (number === 16) {
          n = (inp.getbits() >> 13) + 3;
          inp.addbits(3);
        } else {
          n = (inp.getbits() >> 9) + 11;
          inp.addbits(7);
        }
        if (i === 0) return false;
        while (n > 0 && i < tableSize) {
          table[i] = table[i - 1];
          i += 1;
          n -= 1;
        }
      } else {
        let n;
        if (number === 18) {
          n = (inp.getbits() >> 13) + 3;
          inp.addbits(3);
        } else {
          n = (inp.getbits() >> 9) + 11;
          inp.addbits(7);
        }
        while (n > 0 && i < tableSize) {
          table[i] = 0;
          i += 1;
          n -= 1;
        }
      }
    }

    this.tablesRead = true;
    const dcodes = this.extraDist ? DCX : DCB;
    this.LD = makeDecodeTables(table.subarray(0, NCR), NCR);
    this.DD = makeDecodeTables(table.subarray(NCR, NCR + dcodes), dcodes);
    this.LDD = makeDecodeTables(table.subarray(NCR + dcodes, NCR + dcodes + LDC), LDC);
    this.RD = makeDecodeTables(table.subarray(NCR + dcodes + LDC, NCR + dcodes + LDC + RCR), RCR);
    return true;
  }

  unpack(dataOffset, dataEnd, unpSize, solid) {
    const inp = new BitInput(this.buf, dataOffset, dataEnd);
    this.inp = inp;
    this.readTop = dataEnd;
    this.destUnpSize = unpSize;
    this.resetFileState(solid);
    this.resetTableState(solid);

    const header = this.block;
    header.blockSize = -1;

    // unrar 的顺序：先 UnpReadBuf() 建立 readTop/readBorder，再读块头
    if (!this.readBuf()) return this.result();

    if (
      !this.readBlockHeader() ||
      !this.readTables() ||
      !this.tablesRead
    ) {
      return this.result();
    }

    let guard = 0;
    const guardLimit = Math.max(1000000, (dataEnd - dataOffset) * 64);

    while (true) {
      this.unpPtr &= this.mask;
      this.firstWinDone = this.firstWinDone || this.prevPtr > this.unpPtr;
      this.prevPtr = this.unpPtr;

      if (inp.inAddr >= this.readBorder) {
        let fileDone = false;
        const blockEnd = header.blockStart + header.blockSize - 1;
        while (inp.inAddr > blockEnd || (inp.inAddr === blockEnd && inp.inBit >= header.blockBitSize)) {
          if (header.lastBlockInFile) {
            fileDone = true;
            break;
          }
          if (!this.readBlockHeader() || !this.readTables()) return this.result();
        }
        if (fileDone || !this.readBuf()) break;
      }

      if (
        ((this.wrPtr - this.unpPtr) & this.mask) <= MAX_INC_LZ_MATCH &&
        this.wrPtr !== this.unpPtr
      ) {
        this.writeBuf();
        if (this.writtenFileSize > this.destUnpSize) return this.result();
      }

      if (++guard > guardLimit) break;

      const mainSlot = decodeNumber(inp, this.LD);
      if (mainSlot < 256) {
        this.window[this.unpPtr++] = mainSlot;
        continue;
      }
      if (mainSlot >= 262) {
        let length = this.slotToLength(inp, mainSlot - 262);

        let distance = 1;
        const distSlot = decodeNumber(inp, this.DD);
        let dbits;
        if (distSlot < 4) {
          dbits = 0;
          distance += distSlot;
        } else {
          dbits = Math.floor(distSlot / 2) - 1; // C 里是整数除法
          distance += (2 | (distSlot & 1)) << dbits;
        }

        if (dbits > 0) {
          if (dbits >= 4) {
            if (dbits > 4) {
              const raw = dbits > 36
                ? Number((inp.getbits64() >> BigInt(68 - dbits)) << 4n)
                : ((inp.getbits32() >>> (36 - dbits)) << 4);
              distance += raw;
              inp.addbits(dbits - 4);
            }
            distance += decodeNumber(inp, this.LDD);
          } else {
            distance += inp.getbits() >> (16 - dbits);
            inp.addbits(dbits);
          }
        }

        if (distance > 0x100) {
          length += 1;
          if (distance > 0x2000) {
            length += 1;
            if (distance > 0x40000) length += 1;
          }
        }

        this.insertOldDist(distance);
        this.lastLength = length;
        this.copyString(length, distance);
        continue;
      }
      if (mainSlot === 256) {
        const filter = this.readFilter();
        if (!this.addFilter(filter)) return this.result();
        continue;
      }
      if (mainSlot === 257) {
        if (this.lastLength !== 0) this.copyString(this.lastLength, this.oldDist[0]);
        continue;
      }
      if (mainSlot < 262) {
        const distNum = mainSlot - 258;
        const distance = this.oldDist[distNum];
        for (let i = distNum; i > 0; i -= 1) this.oldDist[i] = this.oldDist[i - 1];
        this.oldDist[0] = distance;

        const length = this.slotToLength(inp, decodeNumber(inp, this.RD));
        this.lastLength = length;
        this.copyString(length, distance);
      }
    }

    this.writeBuf();
    return this.result();
  }
}

/* --------------------------- 归档结构解析 --------------------------- */

let rarCrcTable = null;
function rarCrc32(bytes) {
  if (!rarCrcTable) {
    rarCrcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      rarCrcTable[i] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = rarCrcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function isRarSignature(bytes) {
  return bytes.length >= 8 &&
    bytes[0] === 0x52 && bytes[1] === 0x61 && bytes[2] === 0x72 && bytes[3] === 0x21 &&
    bytes[4] === 0x1a && bytes[5] === 0x07;
}

function parseRar4(bytes, maxEntries) {
  let pos = 7;
  const entries = [];

  while (pos + 7 <= bytes.length) {
    const headType = bytes[pos + 2];
    const headFlags = readU16LE(bytes, pos + 3);
    let headSize = readU16LE(bytes, pos + 5);
    if (headSize < 7) break;
    const blockEnd = pos + headSize;

    // RAR 1.5 的 MAIN_HEAD 固定 13 字节，且用 4 字节 CRC 之类差异，这里只做兼容跳过
    if (headType === 0x73) {
      if (blockEnd > bytes.length) break;
      pos = blockEnd;
      continue;
    }

    if (headType === 0x7b || headType === 0x05) break; // ENDARC

    if (headType === 0x74) {
      if (entries.length >= maxEntries) throw new RarError('RAR archive contains too many entries');
      let p = pos + 7;
      const packSizeLow = readU32At(bytes, p); p += 4;
      let unpSize = readU32At(bytes, p); p += 4;
      p += 1; // hostOS
      const fileCrc = readU32At(bytes, p); p += 4;
      p += 4; // fileTime
      const unpVer = bytes[p]; p += 1;
      const method = bytes[p] - 0x30; p += 1;
      const nameSize = readU16LE(bytes, p); p += 2;
      const fileAttr = readU32At(bytes, p); p += 4;

      let highPack = 0;
      let highUnp = 0;
      if ((headFlags & 0x0100) !== 0) {
        highPack = readU32At(bytes, p); p += 4;
        highUnp = readU32At(bytes, p); p += 4;
      }
      const packSize = highPack * 0x100000000 + packSizeLow;
      if (highUnp) unpSize = highUnp * 0x100000000 + unpSize;

      const nameBytes = bytes.subarray(p, Math.min(p + nameSize, bytes.length));
      p += nameSize;
      if ((headFlags & 0x0400) !== 0) p += 8; // salt

      const isDir = ((headFlags & 0x00e0) === 0x00e0) || (unpVer < 20 && (fileAttr & 0x10) !== 0);
      const winSize = isDir ? 0 : 0x10000 << ((headFlags & 0x00e0) >> 5);

      entries.push({
        format: 4,
        name: normalizeRarPath(
          ((headFlags & 0x0200) !== 0 ? decodeRar4UnicodeName(nameBytes) : null) ||
          decodeRarName(nameBytes, false)
        ),
        packSize,
        unpSize,
        method,
        unpVer,
        crc: fileCrc,
        dir: isDir,
        encrypted: (headFlags & 0x0004) !== 0,
        solid: (headFlags & 0x0010) !== 0,
        splitBefore: (headFlags & 0x0001) !== 0,
        splitAfter: (headFlags & 0x0002) !== 0,
        winSize,
        dataOffset: blockEnd
      });

      pos = blockEnd + packSize;
      continue;
    }

    // HEAD_SERVICE：子块（如文件注释）自身也带 DataSize，需要一并跳过
    if (headType === 0x7a) {
      const subDataSize = readU32At(bytes, pos + 7);
      pos = blockEnd + subDataSize;
      continue;
    }

    // 其他未知块：只跳过头部
    pos = blockEnd;
  }

  return entries;
}

function parseRar5(bytes, maxEntries) {
  let pos = 8;
  const entries = [];

  while (pos + 5 <= bytes.length) {
    let p = pos + 4;
    const [headSize, afterSize] = readVint(bytes, p, bytes.length);
    const headStart = afterSize;
    const headEnd = headStart + headSize;
    if (headSize === 0 || headEnd > bytes.length) break;

    let q = headStart;
    let headType;
    let headFlags;
    [headType, q] = readVint(bytes, q, headEnd);
    [headFlags, q] = readVint(bytes, q, headEnd);

    let extraSize = 0;
    let dataSize = 0;
    if ((headFlags & 0x0001) !== 0) [extraSize, q] = readVint(bytes, q, headEnd);
    if ((headFlags & 0x0002) !== 0) [dataSize, q] = readVint(bytes, q, headEnd);

    if (headType === 5) break; // ENDARC

    if (headType === 2) {
      if (entries.length >= maxEntries) throw new RarError('RAR archive contains too many entries');
      let fileFlags;
      let unpSize;
      let fileAttr;
      [fileFlags, q] = readVint(bytes, q, headEnd);
      [unpSize, q] = readVint(bytes, q, headEnd);
      [fileAttr, q] = readVint(bytes, q, headEnd);
      let crc = 0;
      if ((fileFlags & 0x0002) !== 0) q += 4; // mtime
      if ((fileFlags & 0x0004) !== 0) {
        crc = readU32At(bytes, q); q += 4;
      }
      let compInfo;
      let hostOS;
      let nameSize;
      [compInfo, q] = readVint(bytes, q, headEnd);
      [hostOS, q] = readVint(bytes, q, headEnd);
      [nameSize, q] = readVint(bytes, q, headEnd);

      const nameBytes = bytes.subarray(q, Math.min(q + nameSize, headEnd));
      const method = (compInfo >> 7) & 7;
      const unpVerRaw = compInfo & 0x3f;
      const isDir = (fileFlags & 0x0001) !== 0;
      const winSize = isDir || unpVerRaw > 1
        ? 0
        : 0x20000 << ((compInfo >> 10) & (unpVerRaw === 0 ? 0x0f : 0x1f));

      entries.push({
        format: 5,
        name: normalizeRarPath(decodeRarName(nameBytes, true)),
        packSize: dataSize,
        unpSize,
        method,
        unpVer: unpVerRaw === 0 ? 50 : (unpVerRaw === 1 ? 70 : 0),
        crc,
        dir: isDir,
        encrypted: headType === 4,
        solid: (compInfo & 0x40) !== 0,
        splitBefore: (headFlags & 0x0008) !== 0,
        splitAfter: (headFlags & 0x0010) !== 0,
        winSize,
        dataOffset: headEnd
      });
    }

    pos = headEnd + dataSize;
    if (dataSize === 0 && headSize === 0) break;
  }

  return entries;
}

export function listRarEntries(bytes, maxEntries = 1000) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!isRarSignature(data)) throw new RarError('Not a RAR archive');
  // signature: Rar!\x1a\x07 + 版本字节；0x00 = RAR 1.5~4.x，0x01 = RAR 5.0+
  return data[6] === 0
    ? parseRar4(data, maxEntries)
    : parseRar5(data, maxEntries);
}

/* ------------------------------ 对外解压 ------------------------------ */

function resolveWindowSize(entries, index, startIndex) {
  let total = 0;
  for (let i = startIndex; i <= index; i += 1) total += entries[i].unpSize;

  const declared = entries[index].winSize || 0x10000;
  if (declared <= 0) throw new RarError('Invalid RAR dictionary size');
  if (declared > MAX_WINDOW_BYTES) {
    throw new RarError(`RAR dictionary is too large (${Math.round(declared / 1048576)}MB)`);
  }

  // 距离不可能超过已解压的数据量，因此小文件可以安全地用小窗口，省内存。
  const needed = Math.max(0x10000, nextPow2(Math.min(total + 1024, MAX_WINDOW_BYTES)));
  // 窗口用位掩码做环形寻址，这里强制取 2 的幂兜底
  return nextPow2(Math.min(declared, Math.max(needed, 0x10000)));
}

export function extractRarEntry(bytes, entries, index, options = {}) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const entry = entries[index];

  if (entry.encrypted) throw new RarError('Encrypted RAR entries are not supported');
  if (entry.dir) throw new RarError('Entry is a directory');
  if (entry.splitBefore || entry.splitAfter) {
    throw new RarError('Multi-volume RAR entries are not supported');
  }

  const maxSrtBytes = options.maxSrtBytes || 32 * 1024 * 1024;
  if (entry.unpSize > maxSrtBytes) throw new RarError('RAR entry is too large');

  // 定位 solid 链起点：向前找到第一个非 solid 的条目。
  let start = index;
  while (start > 0 && entries[start].solid) start -= 1;

  const winSize = resolveWindowSize(entries, index, start);

  let unpacker;
  if (entry.format === 5) {
    if (entry.unpVer !== 50) throw new RarError('Only RAR 5.0 compression is supported');
    unpacker = new Unpacker5(winSize, false);
  } else {
    if (entry.unpVer === 15) throw new RarError('RAR 1.5 compression is not supported');
    unpacker = new Unpacker4(winSize, entry.unpVer);
  }
  unpacker.buf = data;

  let out = null;
  for (let i = start; i <= index; i += 1) {
    const item = entries[i];
    const dataEnd = Math.min(item.dataOffset + item.packSize, data.length);

    if (item.method === 0) {
      // Storing
      const stored = data.subarray(item.dataOffset, Math.min(dataEnd, item.dataOffset + item.unpSize));
      if (i === index) {
        out = stored;
      } else {
        // solid 链中的前序文件：需要把内容灌进窗口，供后续条目引用
        for (let k = 0; k < stored.length; k += 1) {
          unpacker.window[unpacker.unpPtr] = stored[k];
          unpacker.unpPtr = (unpacker.unpPtr + 1) & unpacker.mask;
          unpacker.firstWinDone = unpacker.firstWinDone || unpacker.unpPtr === 0;
        }
        unpacker.wrPtr = unpacker.unpPtr;
      }
      continue;
    }

    const result = unpacker.unpack(item.dataOffset, dataEnd, item.unpSize, i > start);
    if (i === index) out = result;
  }

  if (!out) throw new RarError('Unable to extract RAR entry');

  // 校验 CRC：解压出任何偏差都直接报错，绝不返回损坏的字幕
  if (entry.crc && rarCrc32(out) !== entry.crc) {
    throw new RarError('RAR entry checksum mismatch');
  }

  return out;
}

async function extractFirstSrtFromRar(buffer, options = {}) {
  const maxEntries = options.maxEntries ?? MAX_ARCHIVE_ENTRIES;
  const maxSrtBytes = options.maxSrtBytes ?? MAX_SRT_BYTES;

  if (typeof options.rarExtractor === 'function') {
    return options.rarExtractor(buffer, options);
  }

  const entries = listRarEntries(buffer, maxEntries);
  const candidate = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => (
      !entry.dir &&
      !entry.encrypted &&
      isSafeArchivePath(entry.name) &&
      !entry.name.endsWith('/') &&
      entry.name.toLowerCase().endsWith('.srt')
    ))
    .sort((left, right) => left.entry.name.localeCompare(right.entry.name, 'en'))[0];

  if (!candidate) {
    throw new Error('Archive does not contain an SRT file');
  }

  try {
    const data = extractRarEntry(buffer, entries, candidate.index, { maxSrtBytes });
    return { name: candidate.entry.name, data };
  } catch (error) {
    if (error instanceof RarError) throw error;
    throw new Error(error.message || 'Unable to extract SRT from RAR');
  }
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

const MAX_SEARCH_PAGE = 100;

export function normalizeSearchPage(value) {
  if (value === undefined || value === null || value === '') return 1;

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
  if (currentPage > 1) url.searchParams.set('page', String(currentPage));
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
    const page = normalizeSearchPage(requestUrl.searchParams.get('page'));
    const results = await searchSubtitles(requestUrl.searchParams.get('q'), options, page);
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
