import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import iconv from 'iconv-lite';
import {
  createApp,
  decodeSubtitle,
  downloadSubtitle,
  extractDownloadUrl,
  extractFirstSrt,
  parseSearchResults,
  searchSubtitles
} from './main.js';

function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const [filename, value] of entries) {
    const name = Buffer.from(filename, 'utf8');
    const data = Buffer.from(value);
    const checksum = crc32(data);
    const localHeader = Buffer.alloc(30);

    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localParts.push(localHeader, name, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, name);

    localOffset += localHeader.length + name.length + data.length;
  }

  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(localOffset, 16);

  return Buffer.concat([...localParts, central, end]);
}

function renameRar4Entry(buffer, oldName, newName) {
  assert.equal(Buffer.byteLength(oldName), Buffer.byteLength(newName));
  const nameOffset = buffer.indexOf(oldName);
  assert.notEqual(nameOffset, -1);
  const headerOffset = nameOffset - 32;

  Buffer.from(newName).copy(buffer, nameOffset);
  buffer.writeUInt16LE(
    crc32(buffer.subarray(headerOffset + 2, headerOffset + 46)) & 0xffff,
    headerOffset
  );
  return buffer;
}

test('仅返回格式为 Subrip(srt) 的有效搜索结果', () => {
  const html = `
    <section class="resultcard">
      <div class="subitem" id="top-banner">广告</div>
      <div class="subitem">
        <a href="/sub/646205/the-universe-works"><strong>How the Universe Works S07E03</strong></a>
        <p>版本：高清版 <span>格式： Subrip(srt)</span> 语种：简体中文</p>
        <p class="sub-date">2026-09-25</p>
      </div>
      <div class="subitem">
        <a href="/sub/646206/ass-format"><strong>ASS 格式结果</strong></a>
        <p>版本：高清版 格式： Advanced SubStation Alpha 语种：简体中文</p>
      </div>
      <div class="subitem">
        <a href="/sub/646207/srt-format"><strong>另一个 SRT 结果</strong></a>
        <p>版本：普通版 格式：Subrip(srt) 语种：英文</p>
      </div>
      <div class="subitem" id="bottom-banner">广告</div>
    </section>`;

  assert.deepEqual(parseSearchResults(html), [
    {
      id: '646205',
      title: 'How the Universe Works S07E03',
      version: '高清版',
      format: 'Subrip(srt)',
      language: '简体中文',
      date: '2026-09-25',
      detailUrl: 'https://assrt.net/sub/646205/the-universe-works'
    },
    {
      id: '646207',
      title: '另一个 SRT 结果',
      version: '普通版',
      format: 'Subrip(srt)',
      language: '英文',
      date: null,
      detailUrl: 'https://assrt.net/sub/646207/srt-format'
    }
  ]);
});

test('兼容 ASSRT 页面使用的语言标签和相对日期', () => {
  const html = `
    <div class="resultcard">
      <div class="subitem">
        <a href="/sub/646208/example.html">示例字幕</a>
        <p>版本：高清版 格式： Subrip(srt)语言：简 繁来源：转载 日期： 14小时前</p>
      </div>
    </div>`;

  assert.deepEqual(parseSearchResults(html), [{
    id: '646208',
    title: '示例字幕',
    version: '高清版',
    format: 'Subrip(srt)',
    language: '简 繁',
    date: '14小时前',
    detailUrl: 'https://assrt.net/sub/646208/example.html'
  }]);
});

test('兼容 ASSRT 镜像域名和字幕文件名标签', () => {
  const html = `
    <div class="resultcard"><div class="subitem">
      <a href="//2.assrt.net/sub/123456/example.html">示例标题</a>
      <p>格式： Subrip(srt) 字幕文件名：example.srt 日期： 2周前</p>
    </div></div>
  `;
  assert.deepEqual(parseSearchResults(html), [{
    id: '123456',
    title: '示例标题',
    version: null,
    format: 'Subrip(srt)',
    language: null,
    date: '2周前',
    detailUrl: 'https://2.assrt.net/sub/123456/example.html'
  }]);
});

test('解析 ASSRT XML 详情链接和相对 SRT 下载地址', () => {
  const searchHtml = `
    <div class="resultcard"><div class="subitem">
      <a class="introtitle" title="Iron.Man.2008" href="/xml/sub/678/678767.xml">Iron.Man.2008</a>
      <span>版本：高清版</span>
      <span>格式： Subrip(srt)</span>
      <span>语言：英 简</span>
      <span>日期： 2022-08-14 20:44:58</span>
    </div></div>
  `;
  assert.deepEqual(parseSearchResults(searchHtml), [{
    id: '678767',
    title: 'Iron.Man.2008',
    version: '高清版',
    format: 'Subrip(srt)',
    language: '英 简',
    date: '2022-08-14 20:44:58',
    detailUrl: 'https://assrt.net/xml/sub/678/678767.xml'
  }]);
  assert.equal(
    extractDownloadUrl(
      '<a href="/download/678767/movie.srt">下载字幕</a>',
      'https://assrt.net/xml/sub/678/678767.xml'
    ),
    'https://assrt.net/download/678767/movie.srt'
  );
  assert.equal(
    extractDownloadUrl(
      '<a href="#" onclick="location.href=\'/download/678767/movie.zip\'">下载</a>',
      'https://assrt.net/xml/sub/678/678767.xml'
    ),
    'https://assrt.net/download/678767/movie.zip'
  );
});

test('从真实搜索页结构中提取版本和日期字段', () => {
  const searchHtml = `
    <div class="resultcard"><div class="subitem">
      <a class="introtitle" title="Iron.Man.2008" href="/xml/sub/678/678767.xml">Iron.Man.2008</a>
      <div id="meta_top">
        <span>版本：<b>Iron.Man.2008.2160p.US.BluRay.REMUX.HEVC.DTS-HD.MA.TrueHD.7.1.Atmos-FGT</b></span><span><svg viewBox="0 0 48 48"></svg>人人影视YYeTs</span>
      </div>
      <span>格式： Subrip(srt)</span>
      <span>语言：英 繁 双语</span><span>来源：原创翻译</span>
      <span>日期： 2022-08-14 20:44:58</span>
      <span>查阅次数：4569次</span>
      <span>下载次数：1968次</span>
      <span>翻译质量： (1人评分)</span>
      <a href="#" onclick="location.href='/download/678767/movie.srt'">下载</a>
    </div></div>
  `;
  const [result] = parseSearchResults(searchHtml);
  assert.equal(result.id, '678767');
  assert.equal(result.version, 'Iron.Man.2008.2160p.US.BluRay.REMUX.HEVC.DTS-HD.MA.TrueHD.7.1.Atmos-FGT');
  assert.equal(result.language, '英 繁 双语');
  assert.equal(result.date, '2022-08-14 20:44:58');
});

test('搜索请求只访问 ASSRT 搜索首页', async () => {
  const requested = [];
  const html = '<div class="resultcard"><div class="subitem"><a href="/sub/646205/a.html">示例</a><p>格式： Subrip(srt)语言：简</p></div></div>';
  const fetchImpl = async (url) => {
    requested.push(String(url));
    return new Response(html, { status: 200 });
  };

  assert.deepEqual(await searchSubtitles('钢铁侠', { fetchImpl }), [{
    id: '646205',
    title: '示例',
    version: null,
    format: 'Subrip(srt)',
    language: '简',
    date: null,
    detailUrl: 'https://assrt.net/sub/646205/a.html'
  }]);
  assert.deepEqual(requested, ['https://assrt.net/sub/?searchword=%E9%92%A2%E9%93%81%E4%BE%A0']);
});

test('默认请求使用环境代理调度器', async () => {
  const previousHttpProxy = process.env.http_proxy;
  const previousHttpsProxy = process.env.https_proxy;
  process.env.http_proxy = 'http://127.0.0.1:20171';
  process.env.https_proxy = 'http://127.0.0.1:20171';
  let requestOptions;

  try {
    await searchSubtitles('代理', {
      fetchImpl: async (_url, options) => {
        requestOptions = options;
        return new Response('<div class="resultcard"></div>');
      }
    });
    assert.ok(requestOptions.dispatcher);
  } finally {
    if (previousHttpProxy === undefined) {
      delete process.env.http_proxy;
    } else {
      process.env.http_proxy = previousHttpProxy;
    }
    if (previousHttpsProxy === undefined) {
      delete process.env.https_proxy;
    } else {
      process.env.https_proxy = previousHttpsProxy;
    }
  }
});

test('下载详情页中的压缩包并复用磁盘缓存', async () => {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'assrt-api-'));
  const archive = createZip([['subtitle.srt', '1\n00:00:01,000 --> 00:00:02,000\n你好\n']]);
  const calls = [];
  const fetchImpl = async (value) => {
    const url = new URL(String(value));
    calls.push(url.toString());
    if (url.hostname === 'assrt.net') {
      return new Response(
        '<a href="https://file0.assrt.net/download/646205/subtitle.zip?token=abc">下载</a>',
        { status: 200 }
      );
    }
    return new Response(archive, { status: 200 });
  };

  try {
    const options = { fetchImpl, cacheDir, ttlMs: 60_000 };
    assert.equal(
      (await downloadSubtitle('646205', options)).toString(),
      '1\n00:00:01,000 --> 00:00:02,000\n你好\n'
    );
    assert.equal(
      (await downloadSubtitle('646205', options)).toString(),
      '1\n00:00:01,000 --> 00:00:02,000\n你好\n'
    );
    assert.equal(calls.length, 2);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test('HTTP API 提供搜索和字幕下载路由', async () => {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'assrt-http-'));
  const archive = createZip([['subtitle.srt', '1\nhello\n']]);
  const searchHtml = '<div class="resultcard"><div class="subitem"><a href="/sub/646205/a.html">示例</a><p>格式： Subrip(srt)语言：简</p></div></div>';
  const fetchImpl = async (value) => {
    const url = new URL(String(value));
    if (url.pathname === '/sub/646205/a.html') {
      return new Response('<a href="https://file0.assrt.net/download/646205/a.zip">下载</a>');
    }
    if (url.hostname === 'file0.assrt.net') {
      return new Response(archive);
    }
    return new Response(searchHtml);
  };
  const server = createApp({ fetchImpl, cacheDir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const searchResponse = await fetch(`${baseUrl}/search?q=${encodeURIComponent('钢铁侠')}`);
    assert.equal(searchResponse.status, 200);
    assert.equal((await searchResponse.json())[0].id, '646205');

    const downloadResponse = await fetch(`${baseUrl}/download/646205`);
    assert.equal(downloadResponse.status, 200);
    assert.match(downloadResponse.headers.get('content-type'), /application\/x-subrip/);
    assert.equal(await downloadResponse.text(), '1\nhello\n');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test('未预热搜索时按 ID 推导 XML 详情地址', async () => {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'assrt-derive-'));
  const requested = [];
  const fetchImpl = async (value) => {
    const url = new URL(String(value));
    requested.push(url.pathname);
    if (url.pathname === '/xml/sub/695/695516.xml') {
      return new Response('<a href="/download/695516/movie.srt">下载字幕</a>');
    }
    if (url.pathname === '/download/695516/movie.srt') {
      return new Response('1\n00:00:01,000 --> 00:00:02,000\nhello\n');
    }
    return new Response('not found', { status: 404 });
  };

  try {
    const subtitle = await downloadSubtitle('695516', { fetchImpl, cacheDir });
    assert.equal(subtitle.toString('utf8'), '1\n00:00:01,000 --> 00:00:02,000\nhello\n');
    assert.deepEqual(requested, ['/xml/sub/695/695516.xml', '/download/695516/movie.srt']);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test('缓存超过 TTL 后重新下载', async () => {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'assrt-expiry-'));
  const archive = createZip([['subtitle.srt', 'fresh']]);
  let calls = 0;
  const fetchImpl = async (value) => {
    const url = new URL(String(value));
    calls += 1;
    if (url.hostname === 'assrt.net') {
      return new Response('<a href="https://file0.assrt.net/download/646205/a.zip">下载</a>');
    }
    return new Response(archive);
  };

  try {
    const options = { fetchImpl, cacheDir, ttlMs: 60_000 };
    await downloadSubtitle('646205', options);
    assert.equal(calls, 2);
    await utimes(path.join(cacheDir, '646205.srt'), new Date(0), new Date(0));
    await downloadSubtitle('646205', options);
    assert.equal(calls, 4);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test('并发下载同一字幕时只发起一次上游请求', async () => {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'assrt-concurrent-'));
  const archive = createZip([['subtitle.srt', 'concurrent']]);
  let detailCalls = 0;
  let archiveCalls = 0;
  const fetchImpl = async (value) => {
    const url = new URL(String(value));
    if (url.hostname === 'assrt.net') {
      detailCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response('<a href="https://file0.assrt.net/download/646205/a.zip">下载</a>');
    }
    archiveCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return new Response(archive);
  };

  try {
    const [first, second] = await Promise.all([
      downloadSubtitle('646205', { fetchImpl, cacheDir }),
      downloadSubtitle('646205', { fetchImpl, cacheDir })
    ]);
    assert.equal(first.toString(), 'concurrent');
    assert.equal(second.toString(), 'concurrent');
    assert.equal(detailCalls, 1);
    assert.equal(archiveCalls, 1);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test('下载压缩包时跟随受允许的 ASSRT 重定向', async () => {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'assrt-redirect-'));
  const archive = createZip([['subtitle.srt', 'redirected']]);
  const fetchImpl = async (value) => {
    const url = new URL(String(value));
    if (url.hostname === 'assrt.net') {
      return new Response('<a href="https://file0.assrt.net/download/646205/a.zip">下载</a>');
    }
    if (url.hostname === 'file0.assrt.net') {
      return new Response(null, {
        status: 302,
        headers: { location: 'https://file1.assrt.net/download/646205/a.zip' }
      });
    }
    return new Response(archive);
  };

  try {
    assert.equal(
      (await downloadSubtitle('646205', { fetchImpl, cacheDir })).toString(),
      'redirected'
    );
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test('下载路由接受 .srt 后缀并保留旧格式', async () => {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'assrt-suffix-'));
  const server = createApp({
    cacheDir,
    fetchImpl: async (value) => {
      const url = new URL(String(value));
      if (url.pathname === '/xml/sub/665/665025.xml') {
        return new Response('<a href="/download/665025/movie.srt">下载字幕</a>');
      }
      if (url.pathname === '/download/665025/movie.srt') {
        return new Response('1\n00:00:01,000 --> 00:00:02,000\nhi\n');
      }
      return new Response('not found', { status: 404 });
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const srt = await fetch(`${baseUrl}/download/665025.srt`);
    assert.equal(srt.status, 200);
    assert.match(srt.headers.get('content-type'), /application\/x-subrip/);
    assert.equal(srt.headers.get('content-disposition'), 'attachment; filename="665025.srt"');
    assert.equal(await srt.text(), '1\n00:00:01,000 --> 00:00:02,000\nhi\n');

    const legacy = await fetch(`${baseUrl}/download/665025`);
    assert.equal(legacy.status, 200);
    assert.equal(await legacy.text(), '1\n00:00:01,000 --> 00:00:02,000\nhi\n');

    const badSuffix = await fetch(`${baseUrl}/download/665025.zip`);
    assert.equal(badSuffix.status, 400);
    assert.equal((await badSuffix.json()).error, 'INVALID_ID');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test('HTTP API 返回参数和上游错误状态', async () => {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'assrt-errors-'));
  const server = createApp({
    cacheDir,
    fetchImpl: async () => new Response('upstream', { status: 500 })
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const invalid = await fetch(`${baseUrl}/search`);
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error, 'INVALID_QUERY');

    const upstream = await fetch(`${baseUrl}/search?q=abc`);
    assert.equal(upstream.status, 502);
    assert.equal((await upstream.json()).error, 'UPSTREAM_ERROR');

    const missing = await fetch(`${baseUrl}/missing`);
    assert.equal(missing.status, 404);

    const invalidId = await fetch(`${baseUrl}/download/not-a-number`);
    assert.equal(invalidId.status, 400);
    assert.equal((await invalidId.json()).error, 'INVALID_ID');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test('从详情页提取 ASSRT 字幕压缩包地址', () => {
  const downloadUrl = 'https://file0.assrt.net/download/646205/subtitle.zip?token=abc';
  const html = `
    <a href="https://example.com/download/646205/fake.zip">外部链接</a>
    <a href="${downloadUrl}">下载字幕</a>`;

  assert.equal(
    extractDownloadUrl(html, 'https://assrt.net/sub/646205/subtitle.html'),
    downloadUrl
  );
  assert.equal(
    extractDownloadUrl('<a href="https://2.assrt.net/download/646205/subtitle.rar">下载</a>'),
    'https://2.assrt.net/download/646205/subtitle.rar'
  );
  assert.equal(
    extractDownloadUrl('<a href="https://example.com/download/646205/fake.zip">外部链接</a>'),
    null
  );
  assert.equal(
    extractDownloadUrl('<a href="http://file0.assrt.net/download/646205/subtitle.zip">下载</a>'),
    'http://file0.assrt.net/download/646205/subtitle.zip'
  );
});

test('从 ZIP 中按文件名顺序选择第一个 SRT', async () => {
  const archive = createZip([
    ['z-last.srt', 'last'],
    ['nested/a-first.srt', 'first'],
    ['../outside.srt', 'outside']
  ]);

  assert.deepEqual(await extractFirstSrt(archive), {
    name: 'nested/a-first.srt',
    data: Buffer.from('first')
  });
});

test('从 RAR 中按文件名顺序选择第一个 SRT', async () => {
  const archive = Buffer.from(
    'UmFyIRoHAM+QcwAADQAAAAAAAABM+HQgkC4ABQAAAAUAAAACGSCKVxahg0odMAkAIAAAADFGaWxlLnR4dADwkOgEMUZpbGXcMHQkljwAIAAAAA8AAAACWwPYnCmhg0odMw8AIAAAADI/Py50eHQAThsyLYdlAiaSyWh4aKAhAPAmEhjfoJzHB5cWF7CjVyDJLLQscUep4830hwRH/3ogjuHVEcKUdCSUNQAQAAAABQAAAAJKlGwtVZ+DSh0zCAAgAAAAM1NlYy50eHT5pxtn2Ow6MACwWMggPeh+dGs0RwexfVSgel2k3cQ9ewBABwA=',
    'base64'
  );
  renameRar4Entry(archive, '1File.txt', '1File.srt');

  assert.deepEqual(await extractFirstSrt(archive), {
    name: '1File.srt',
    data: Buffer.from('1File')
  });
});

test('直接下载的 SRT 文件不再走压缩包解压', async () => {
  const srt = '1\n00:00:01,000 --> 00:00:02,000\n你好\n';
  const extracted = await extractFirstSrt(Buffer.from(srt, 'utf8'));
  assert.equal(extracted.name, 'subtitle.srt');
  assert.equal(extracted.data.toString('utf8'), srt);
});

test('限制归档条目数和解压后的 SRT 大小', async () => {
  await assert.rejects(
    extractFirstSrt(createZip([['a.srt', '12345'], ['b.txt', 'x']]), { maxEntries: 1 }),
    /too many entries/u
  );
  await assert.rejects(
    extractFirstSrt(createZip([['a.srt', '12345']]), { maxSrtBytes: 4 }),
    /too large/u
  );
});

test('将常见中文 SRT 编码转换为 UTF-8', () => {
  const source = '1\n00:00:01,000 --> 00:00:02,000\n你好，世界\n';
  assert.equal(decodeSubtitle(iconv.encode(source, 'gb18030')), source);
});
