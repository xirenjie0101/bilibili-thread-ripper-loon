/*
 * BTR Loon Experimental 0.1.1
 * Range parsing/splitting and CDN choices adapted from Bilibili-thread-ripper
 * https://github.com/MrTangLuyao/Bilibili-thread-ripper
 * Commit: 0302b345cdfe367ac599b52dc6874e3f7967e220
 * Copyright (c) 2026 Bilibili-thread-ripper contributors
 * Copyright (c) 2026 BTR Loon contributors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
(function (root) {
  "use strict";

  const VERSION = "0.1.1";
  const PREFIX = "BTR-Loon-v1";
  const CHECK_HOST = "upos-sz-mirrorali.bilivideo.com";
  const CHECK_PATH = "/btr-loon-self-test.m4s";
  const INTERNAL = "x-btr-loon-internal";
  const KiB = 1024;
  const MiB = 1024 * KiB;
  const HOST = /^(?:[a-z0-9-]+\.)*bilivideo\.(?:com|cn|net)$|^upos-hz-mirrorakam\.akamaized\.net$/i;
  const POOLS = {
    original: [],
    auto: ["upos-sz-mirrorali.bilivideo.com", "upos-sz-mirroraliov.bilivideo.com"],
    mainland: ["upos-sz-mirrorali.bilivideo.com", "upos-sz-mirrorhw.bilivideo.com"],
    overseas: ["upos-sz-mirroraliov.bilivideo.com", "upos-sz-mirrorcosov.bilivideo.com"]
  };

  function header(headers, name) {
    const key = Object.keys(headers || {}).find(k => k.toLowerCase() === name.toLowerCase());
    return key === undefined ? "" : String(headers[key]);
  }

  // Loon's JavaScript environment need not provide the browser URL API. Keep
  // signed path/query bytes verbatim; do not parse/re-encode the query string.
  function mediaURL(raw) {
    if (typeof raw !== "string" || /[\s\\]/.test(raw)) return null;
    const m = /^https:\/\/([a-z0-9.-]+)(?::443)?(\/[^?#]*)(\?[^#]*)?$/i.exec(raw);
    if (!m || !HOST.test(m[1]) || !/\.(?:m4s|mp4)$/i.test(m[2])) return null;
    return { host: m[1].toLowerCase(), path: m[2], query: m[3] || "", raw };
  }

  function parseRange(value) {
    const m = /^bytes=(\d+)-(\d*)$/i.exec(String(value).trim());
    if (!m) return null;
    const start = Number(m[1]);
    const end = m[2] ? Number(m[2]) : null;
    if (!Number.isSafeInteger(start) || start < 0 ||
        (end !== null && (!Number.isSafeInteger(end) || end < start || !Number.isSafeInteger(end - start + 1)))) return null;
    return { start, end, length: end === null ? null : end - start + 1 };
  }

  function contentRange(value) {
    const m = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(String(value).trim());
    if (!m) return null;
    const start = Number(m[1]), end = Number(m[2]), total = Number(m[3]);
    if (![start, end, total].every(Number.isSafeInteger) || start < 0 || end < start || total <= end) return null;
    return { start, end, total, length: end - start + 1 };
  }

  function splitRange(start, end, count) {
    const length = end - start + 1;
    count = Math.max(1, Math.min(count, Math.floor(length / (128 * KiB))));
    const base = Math.floor(length / count), remainder = length % count, pieces = [];
    let cursor = start;
    for (let i = 0; i < count; i++) {
      const size = base + (i < remainder ? 1 : 0);
      pieces.push({ start: cursor, end: cursor + size - 1, length: size });
      cursor += size;
    }
    return pieces;
  }

  function integer(value, fallback, min, max) {
    if (value === null || value === undefined || value === "") return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback;
  }

  function settings(argument) {
    let a = argument || {};
    if (typeof a === "string") {
      try { a = JSON.parse(a); } catch (_) { a = {}; }
    }
    if (!a || typeof a !== "object") a = {};
    return {
      mode: Object.prototype.hasOwnProperty.call(POOLS, a.mode) ? a.mode : "auto",
      concurrency: integer(a.concurrency, 3, 2, 4),
      maxBytes: integer(a.max_mib, 2, 1, 4) * MiB,
      parallel: a.parallel !== false && a.parallel !== "false",
      route: a.route !== false && a.route !== "false",
      debug: a.debug === true || a.debug === "true"
    };
  }

  function candidates(parsed, mode) {
    return [parsed.raw].concat(POOLS[mode].map(host => "https://" + host + parsed.path + parsed.query))
      .filter((url, i, urls) => urls.indexOf(url) === i);
  }

  function cleanHeaders(source) {
    const out = {};
    const connectionTokens = header(source, "connection").toLowerCase().split(",").map(s => s.trim());
    Object.keys(source || {}).forEach(key => {
      const lower = key.toLowerCase();
      if (key[0] === ":" || connectionTokens.includes(lower) ||
          /^(host|connection|keep-alive|proxy-connection|proxy-authorization|transfer-encoding|te|trailer|upgrade|content-length|x-btr-loon-internal)$/i.test(key)) return;
      out[key] = source[key];
    });
    return out;
  }

  function downloadHeaders(source, range, etag) {
    const headers = cleanHeaders(source);
    Object.keys(headers).forEach(k => {
      if (/^(range|accept-encoding|if-.+|cookie|authorization)$/i.test(k)) delete headers[k];
    });
    headers.Range = "bytes=" + range.start + "-" + range.end;
    headers["Accept-Encoding"] = "identity";
    headers[INTERNAL] = "1";
    if (etag) headers["If-Range"] = etag;
    return headers;
  }

  function strongETag(headers) {
    const value = header(headers, "etag");
    return /^"[^"\r\n]+"$/.test(value) ? value : "";
  }

  function sameBytes(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function validate(reply, range, expected, allowEOF) {
    if (!reply || reply.error || !reply.response || Number(reply.response.status) !== 206 ||
        !(reply.data instanceof Uint8Array)) return null;
    const headers = reply.response.headers || {};
    const cr = contentRange(header(headers, "content-range"));
    const encoding = header(headers, "content-encoding").toLowerCase();
    const type = header(headers, "content-type").toLowerCase();
    const length = header(headers, "content-length");
    if (!cr || (encoding && encoding !== "identity") ||
        !/^(?:video\/|audio\/|application\/octet-stream(?:;|$))/.test(type) ||
        cr.start !== range.start || cr.end !== (allowEOF ? Math.min(range.end, cr.total - 1) : range.end) ||
        reply.data.length !== cr.length || (length && (!/^\d+$/.test(length) || Number(length) !== cr.length))) return null;
    const etag = strongETag(headers);
    if (expected && (cr.total !== expected.total || !etag || etag !== expected.etag)) return null;
    return { url: reply.url, data: reply.data, headers, total: cr.total, etag, elapsed: reply.elapsed };
  }

  function responseHeaders(anchor, range) {
    const headers = {
      "Content-Type": header(anchor.headers, "content-type"),
      "Content-Range": "bytes " + range.start + "-" + range.end + "/" + anchor.total,
      "Content-Length": String(range.length),
      "Accept-Ranges": "bytes",
      "ETag": anchor.etag
    };
    ["cache-control", "last-modified", "expires", "access-control-allow-origin"].forEach(key => {
      const value = header(anchor.headers, key);
      if (value) headers[key] = value;
    });
    return headers;
  }

  function safeLog(env, text) {
    try { env.log("[BTR-Loon] " + text); } catch (_) {}
  }

  function save(env, key, value) {
    try {
      if (env.write(PREFIX + "." + key, value) !== false) return true;
    } catch (_) {}
    safeLog(env, "记录保存失败（" + key + "），没有记录不能作为未触发的证据。");
    return false;
  }

  function diagnostics(env) {
    const read = (key, empty) => {
      try { return env.read(PREFIX + "." + key) || empty; }
      catch (_) { return "读取失败；不能据此判断是否触发。"; }
    };
    // Use a separate key. Self-tests must never count as video or acceleration hits.
    const token = String(env.now()) + ":" + String(Math.random());
    const stored = save(env, "storage-check", token);
    const storageOK = stored && read("storage-check", "") === token;
    return [
      "BTR Loon " + VERSION,
      "运行环境：" + (env.runtime || "未提供"),
      "本次存储读写自检：" + (storageOK ? "通过" : "失败；请求记录可能无法保存或读取"),
      "最近 HTTP 自检：" + read("selftest-http", "无"),
      "最近 HTTPS 自检：" + read("selftest-https", "无"),
      "最近进入媒体脚本：" + read("entered", "未读到记录（不代表你没有播放）"),
      "最近处理结果：" + read("last", "未读到记录"),
      "最近加速成功：" + read("success", "尚无加速命中"),
      "请结合时间判断；手动诊断和网页自检都不算加速成功。"
    ].join("\n\n");
  }

  function selfTestProtocol(request) {
    if (!request || String(request.method || "GET").toUpperCase() !== "GET") return null;
    const url = String(request.url || "");
    for (const protocol of ["http", "https"]) {
      const base = protocol + "://" + CHECK_HOST + CHECK_PATH;
      // A small optional version query is for browser cache busting only.
      if (url === base || (url.startsWith(base) && /^\?v=[0-9.]+$/.test(url.slice(base.length)))) return protocol;
    }
    return null;
  }

  function diagnosticHTML(report, protocol) {
    const escape = text => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const title = protocol === "https" ? "HTTPS 媒体规则已触发" : "HTTP 自检规则已触发";
    return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>BTR Loon 自检</title><style>body{font:17px system-ui;line-height:1.6;max-width:680px;margin:32px auto;padding:0 20px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f5f7;padding:16px;border-radius:12px}a{display:block;margin:16px 0}</style>' +
      '<h1>' + title + '</h1><p>这是 Loon 在你的设备上生成的页面。此自检没有下载视频，也不表示 B 站 App 已经加速。</p>' +
      (protocol === "http" ? '<p>下一步测试 HTTPS。只有 HTTPS 自检成功，才能确认测试域名的解密及媒体请求规则可用。</p>' : '<p>若此页正常而播放仍没有记录，需要查看 App 实际使用的媒体域名、协议和端口。</p>') +
      '<a href="https://' + CHECK_HOST + CHECK_PATH + '?v=' + VERSION + '">打开 HTTPS 自检</a>' +
      '<pre>' + escape(report) + '</pre></html>';
  }

  async function run(env) {
    const cfg = settings(env.argument), started = env.now();
    let closed = false;
    function record(kind, reason, extra) {
      const event = Object.assign({ version: VERSION, time: new Date(env.now()).toISOString(), kind, reason }, extra || {});
      // Never persist or log signed URLs, video IDs, cookies or server errors.
      save(env, "last", JSON.stringify(event));
      if (kind === "parallel" || kind === "route") save(env, "success", JSON.stringify(event));
      if (cfg.debug || kind === "parallel" || kind === "route") {
        try { env.log("[BTR-Loon] " + JSON.stringify(event)); } catch (_) {}
      }
    }
    function finish(result, kind, reason, extra) {
      if (closed) return;
      closed = true;
      if (kind) record(kind, reason, extra);
      env.done(result);
    }
    const pass = reason => finish({}, "pass", reason);
    if (!env.request) {
      const report = diagnostics(env);
      safeLog(env, report);
      try { env.notify("BTR Loon " + VERSION, "触发与存储诊断", report); } catch (_) {}
      finish({ title: "BTR Loon " + VERSION + " 诊断", content: report });
      return;
    }
    const checkProtocol = selfTestProtocol(env.request);
    if (checkProtocol) {
      save(env, "selftest-" + checkProtocol, JSON.stringify({ version: VERSION, time: new Date(env.now()).toISOString() }));
      const report = diagnostics(env);
      safeLog(env, checkProtocol.toUpperCase() + " 自检规则已触发");
      finish({ response: { status: 200, headers: {
        "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store, max-age=0",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
        "X-Content-Type-Options": "nosniff"
      }, body: diagnosticHTML(report, checkProtocol) } });
      return;
    }
    const request = env.request, headers = request.headers || {};
    // Defensive loop guard if this Loon build also processes script-originated HTTP.
    if (header(headers, INTERNAL)) {
      const cleaned = Object.assign({}, headers);
      Object.keys(cleaned).forEach(k => { if (k.toLowerCase() === INTERNAL) delete cleaned[k]; });
      finish({ headers: cleaned });
      return;
    }
    const parsed = mediaURL(request.url);
    if (!parsed || String(request.method || "GET").toUpperCase() !== "GET") return pass("unsupported-request");
    save(env, "entered", JSON.stringify({ version: VERSION, time: new Date(env.now()).toISOString(), host: parsed.host }));
    if (cfg.debug) safeLog(env, "已进入媒体脚本：" + parsed.host);
    if (header(headers, "authorization") || header(headers, "cookie") ||
        Object.keys(headers).some(k => /^if-/i.test(k))) return pass("credential-or-conditional-request");
    const rangeHeader = header(headers, "range");
    const range = rangeHeader ? parseRange(rangeHeader) : { start: 0, end: null, length: null };
    if (!range) return pass("unsupported-range");
    if (range.length !== null && range.length < 256 * KiB) return pass("small-range");
    const canParallel = cfg.parallel && range.end !== null && range.length <= cfg.maxBytes;
    if (!canParallel && (!cfg.route || cfg.mode === "original")) return pass("stream-or-large-range");

    // Loon receives the completed buffers, not a writable response stream.
    // Stop before the plugin's 15-second runtime limit; never truncate an open range.
    env.timer(() => pass("deadline"), 12000);
    function get(url, part, etag, timeout) {
      return new Promise(resolve => {
        let settled = false;
        const t0 = env.now();
        const settle = (error, response, data) => {
          if (settled) return;
          settled = true;
          resolve({ url, error, response, data, elapsed: Math.max(1, env.now() - t0) });
        };
        env.timer(() => settle(true), timeout + 100);
        try {
          env.get({ url, headers: downloadHeaders(headers, part, etag), timeout,
            "binary-mode": true, "auto-redirect": false, "auto-cookie": false,
            insecure: false, alpn: "h1" }, settle);
        } catch (_) { settle(true); }
      });
    }

    try {
      const probe = { start: range.start, end: range.start + 16 * KiB - 1 };
      if (!Number.isSafeInteger(probe.end)) return pass("range-overflow");
      const urls = candidates(parsed, cfg.mode);
      const probes = await Promise.all(urls.map(url => get(url, probe, "", 1800)));
      if (closed) return;
      const origin = validate(probes[0], probe, null, true);
      // The original signed URL must work. A rejected original is never replaced
      // with another origin to work around an access/region/signature restriction.
      if (!origin) return pass("origin-probe-failed");
      if (!origin.etag) return pass("no-strong-etag");
      const eligible = [origin];
      probes.slice(1).forEach(reply => {
        const candidate = validate(reply, probe, origin, true);
        if (candidate && sameBytes(candidate.data, origin.data)) eligible.push(candidate);
      });
      eligible.sort((a, b) => a.elapsed - b.elapsed);

      if (!canParallel) {
        const best = eligible[0];
        // Small probes estimate response latency, not sustained throughput.
        if (best.url === parsed.raw || origin.elapsed - best.elapsed < 50 || best.elapsed > origin.elapsed * 0.8) {
          return pass("original-route-kept");
        }
        return finish({ url: best.url, headers: cleanHeaders(headers) }, "route", "validated-lower-latency-cdn", {
          host: mediaURL(best.url).host, ms: env.now() - started
        });
      }

      const wanted = { start: range.start, end: Math.min(range.end, origin.total - 1) };
      wanted.length = wanted.end - wanted.start + 1;
      if (wanted.length < 256 * KiB) return pass("small-file-tail");
      const parts = splitRange(wanted.start, wanted.end, cfg.concurrency);
      const downloaded = await Promise.all(parts.map(async (part, index) => {
        let result = null;
        const preferred = eligible[index % eligible.length].url;
        for (let attempt = 0; attempt < 2; attempt++) {
          if (closed || env.now() - started > 8500) break;
          const reply = await get(attempt === 0 ? preferred : parsed.raw, part, origin.etag, 3500);
          if (closed) break;
          result = validate(reply, part, origin, false);
          if (result) break;
        }
        return result;
      }));
      if (closed) return;
      if (downloaded.some(part => !part)) return pass("chunk-failed-original-resumes");
      const body = new Uint8Array(wanted.length);
      downloaded.forEach((part, index) => body.set(part.data, parts[index].start - wanted.start));
      finish({ response: { status: 206, headers: responseHeaders(origin, wanted), body } }, "parallel", "validated", {
        bytes: body.length, connections: parts.length,
        hosts: [...new Set(downloaded.map(part => mediaURL(part.url).host))], ms: env.now() - started
      });
    } catch (_) { pass("internal-error-original-resumes"); }
  }

  const api = { VERSION, header, mediaURL, parseRange, contentRange, splitRange, settings, selfTestProtocol,
    candidates, cleanHeaders, downloadHeaders, strongETag, validate, responseHeaders, run };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (typeof $done === "function") {
    let completed = false;
    const done = value => { if (!completed) { completed = true; $done(value); } };
    run({
      request: typeof $request === "object" ? $request : null,
      runtime: typeof $loon === "string" ? $loon : "未提供",
      argument: typeof $argument !== "undefined" ? $argument : null,
      now: () => Date.now(), timer: (fn, ms) => setTimeout(fn, ms),
      get: (options, callback) => $httpClient.get(options, callback),
      done, log: value => console.log(value),
      read: key => $persistentStore.read(key),
      write: (key, value) => $persistentStore.write(value, key),
      notify: (title, subtitle, content) => $notification.post(title, subtitle, content)
    }).catch(() => {
      try { console.log("[BTR-Loon] 脚本运行异常；当前请求保持原样。请查看诊断中的进入记录。"); } catch (_) {}
      done({});
    });
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
