"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { core, URL0, TOTAL, bytes, reply, simulate } = require("./helpers.cjs");

test("signed URL bytes and duplicate parameters survive host changes", () => {
  const source = core.mediaURL(URL0);
  const urls = core.candidates(source, "auto");
  assert.equal(urls[0], URL0);
  for (const url of urls) assert.equal(core.mediaURL(url).query, source.query);
  assert.ok(urls.every(url => !url.includes(":443")));
});

test("strict media allowlist excludes lookalikes, other Akamai users and non-media", () => {
  for (const url of [
    "http://x.bilivideo.com/a.mp4", "https://x.bilivideo.com.evil.test/a.mp4",
    "https://evilbilivideo.com/a.mp4", "https://user@x.bilivideo.com/a.mp4",
    "https://x.bilivideo.com:4483/a.mp4", "https://x.bilivideo.com/a.mp4#frag",
    "https://unrelated.akamaized.net/a.mp4", "https://api.bilibili.com/playurl",
    "https://x.bilivideo.com/a.m3u8", "https://x.bilivideo.com/a.flv",
    "https://x.bilivideo.com\\@evil.test/a.mp4"
  ]) assert.equal(core.mediaURL(url), null, url);
  assert.ok(core.mediaURL("https://upos-hz-mirrorakam.akamaized.net/a.m4s?x=%2f"));
  assert.ok(core.mediaURL("https://x.bilivideo.cn/a.mp4"));
});

test("Range parsing keeps 64-bit offsets and rejects suffix, multi-range and overflow", () => {
  assert.deepEqual(core.parseRange("bytes=4294967296-4296015871"), { start: 4294967296, end: 4296015871, length: 1048576 });
  assert.deepEqual(core.parseRange("bytes=1024-"), { start: 1024, end: null, length: null });
  for (const value of ["bytes=-10", "bytes=10-9", "bytes=0-1,3-4", "bytes=0-9007199254740991", "bytes=9007199254740992-", "units=0-1"]) {
    assert.equal(core.parseRange(value), null, value);
  }
  assert.equal(core.contentRange("bytes 0-10/10"), null);
  assert.equal(core.contentRange("bytes 0-10/*"), null);
});

test("2000 varied splits cover the original range without gaps or overlaps", () => {
  let seed = 123456789;
  for (let i = 0; i < 2000; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const length = 1 + seed % (4 * 1024 * 1024), start = seed * 3;
    const parts = core.splitRange(start, start + length - 1, 2 + i % 3);
    assert.equal(parts[0].start, start);
    assert.equal(parts.at(-1).end, start + length - 1);
    assert.equal(parts.reduce((sum, p) => sum + p.length, 0), length);
    parts.slice(1).forEach((p, n) => assert.equal(p.start, parts[n].end + 1));
  }
});

test("config clamps resources and honors explicit false", () => {
  assert.equal(core.settings({ concurrency: 999, max_mib: 99 }).concurrency, 4);
  assert.equal(core.settings({ max_mib: 99 }).maxBytes, 4 * 1024 * 1024);
  assert.equal(core.settings({ mode: "__proto__" }).mode, "auto");
  assert.equal(core.settings('{"parallel":false,"route":false}').parallel, false);
  assert.equal(core.settings("bad JSON").mode, "auto");
});

test("parallel downloads complete out of order and reassemble exact bytes", async () => {
  const state = await simulate({ plan(options) {
    const r = reply(options);
    r.delay = core.header(options.headers, "if-range") ? 300 - Math.floor(core.parseRange(options.headers.Range).start / 10000) : 20;
    return r;
  } });
  assert.equal(state.result.response.status, 206);
  assert.deepEqual(state.result.response.body, bytes(0, 1048576));
  assert.equal(state.result.response.headers["Content-Range"], `bytes 0-1048575/${TOTAL}`);
  assert.equal(state.event.kind, "parallel");
  assert.equal(state.event.connections, 3);
  assert.equal(state.maxActive, 3);
  assert.equal(state.done.length, 1);
  assert.ok(state.calls.every(c => c["binary-mode"] && c.insecure === false && c["auto-redirect"] === false && c["auto-cookie"] === false));
  assert.equal(core.header(state.result.response.headers, "set-cookie"), "");
  assert.equal(core.header(state.result.response.headers, "alt-svc"), "");
  assert.ok(!JSON.stringify([...state.store.values(), ...state.logs]).includes("DO_NOT_LOG"));
});

test("same-origin mode still downloads multiple ranges", async () => {
  const state = await simulate({ argument: { mode: "original" } });
  assert.equal(state.event.kind, "parallel");
  assert.equal(state.calls.length, 4);
  assert.ok(state.calls.every(c => c.url === URL0));
});

test("audio ranges are returned with their original MIME type", async () => {
  const state = await simulate({ plan(options) {
    const r = reply(options); r.response.headers["content-type"] = "audio/mp4"; return r;
  } });
  assert.equal(state.result.response.headers["Content-Type"], "audio/mp4");
});

test("finite request past EOF is clamped to actual EOF without inventing bytes", async () => {
  const total = 700000;
  const state = await simulate({ plan: o => reply(o, { total }) });
  assert.equal(state.result.response.headers["Content-Range"], `bytes 0-${total - 1}/${total}`);
  assert.deepEqual(state.result.response.body, bytes(0, total));
});

for (const [name, headers] of [
  ["small init range", { Range: "bytes=0-1023" }],
  ["suffix range", { Range: "bytes=-500000" }],
  ["multipart range", { Range: "bytes=0-1,2-5" }],
  ["conditional request", { Range: "bytes=0-1048575", "If-Range": '"v1"' }],
  ["cookie request", { Range: "bytes=0-1048575", Cookie: "SESSDATA=private" }],
  ["authorization request", { Range: "bytes=0-1048575", Authorization: "Bearer private" }]
]) test(`${name} is forwarded untouched without probe traffic`, async () => {
  const state = await simulate({ request: { url: URL0, method: "GET", headers } });
  assert.deepEqual(state.result, {});
  assert.equal(state.calls.length, 0);
  assert.equal(state.done.length, 1);
});

test("internal recursion guard removes only its marker and does no downloads", async () => {
  const state = await simulate({ request: { url: URL0, method: "GET", headers: {
    "X-BTR-Loon-Internal": "1", Range: "bytes=0-1048575", "If-Range": '"etag"'
  } } });
  assert.deepEqual(state.result, { headers: { Range: "bytes=0-1048575", "If-Range": '"etag"' } });
  assert.equal(state.calls.length, 0);
});

test("HEAD requests are never changed", async () => {
  const state = await simulate({ request: { url: URL0, method: "HEAD", headers: {} } });
  assert.deepEqual(state.result, {}); assert.equal(state.calls.length, 0);
});

for (const [name, range] of [["open-ended", "bytes=0-"], ["large", "bytes=0-7340031"], ["whole-file", null]]) {
  test(`${name} request keeps its Range semantics and only selects a validated CDN`, async () => {
    const headers = { Host: "old.example", "Accept-Encoding": "identity" };
    if (range) headers.Range = range;
    const state = await simulate({ request: { url: URL0, method: "GET", headers }, plan(o) {
      const r = reply(o); r.delay = o.url === URL0 ? 200 : 20; return r;
    } });
    assert.equal(state.event.kind, "route");
    assert.equal(state.calls.length, 3);
    assert.equal(state.result.headers.Range, range || undefined);
    assert.equal(core.header(state.result.headers, "host"), "");
    assert.ok(!state.result.response);
  });
}

test("no significant CDN latency gain leaves open range untouched", async () => {
  const state = await simulate({ request: { url: URL0, headers: { Range: "bytes=0-" } } });
  assert.deepEqual(state.result, {});
  assert.equal(state.event.reason, "original-route-kept");
});

test("disabling both features avoids all network work", async () => {
  const state = await simulate({ argument: { parallel: false, route: false } });
  assert.deepEqual(state.result, {}); assert.equal(state.calls.length, 0);
});

test("a rejected original never yields an alternate synthesized response", async () => {
  const state = await simulate({ plan(o) {
    const r = reply(o); if (o.url === URL0) r.response.status = 403; return r;
  } });
  assert.deepEqual(state.result, {}); assert.equal(state.event.reason, "origin-probe-failed");
});

for (const kind of ["different-bytes", "different-etag", "different-total", "403", "redirect"]) {
  test(`alternate CDN ${kind} is excluded before assembling media`, async () => {
    const state = await simulate({ plan(o) {
      const r = reply(o);
      if (o.url !== URL0) {
        if (kind === "different-bytes") r.data[0] ^= 255;
        if (kind === "different-etag") r.response.headers.etag = '"other"';
        if (kind === "different-total") r.response.headers["content-range"] = "bytes 0-16383/9999999";
        if (kind === "403") r.response.status = 403;
        if (kind === "redirect") r.response.status = 302;
      }
      return r;
    } });
    assert.equal(state.event.kind, "parallel");
    assert.ok(state.calls.filter(c => core.header(c.headers, "if-range")).every(c => c.url === URL0));
  });
}

for (const kind of ["missing", "weak"]) test(`${kind} ETag disables unsafe assembly`, async () => {
  const state = await simulate({ plan(o) { const r = reply(o); r.response.headers.etag = kind === "weak" ? 'W/"v1"' : ""; return r; } });
  assert.deepEqual(state.result, {}); assert.equal(state.event.reason, "no-strong-etag");
});

for (const failure of ["wrong-range", "wrong-total", "truncated", "wrong-length", "changed-etag", "200", "403", "416", "gzip", "html", "string", "transport", "timeout"]) {
  test(`chunk ${failure}: fail open, never return corrupt or partial bytes`, async () => {
    const state = await simulate({ plan(o) {
      const r = reply(o);
      if (core.header(o.headers, "if-range")) {
        if (failure === "wrong-range") r.response.headers["content-range"] = `bytes 1-10/${TOTAL}`;
        if (failure === "wrong-total") r.response.headers["content-range"] = r.response.headers["content-range"].replace(String(TOTAL), String(TOTAL + 1));
        if (failure === "truncated") r.data = r.data.slice(1);
        if (failure === "wrong-length") r.response.headers["content-length"] = "7";
        if (failure === "changed-etag") r.response.headers.etag = '"v2"';
        if (["200", "403", "416"].includes(failure)) r.response.status = Number(failure);
        if (failure === "gzip") r.response.headers["content-encoding"] = "gzip";
        if (failure === "html") r.response.headers["content-type"] = "text/html";
        if (failure === "string") r.data = "not binary";
        if (failure === "transport") r.error = "private signature here";
        if (failure === "timeout") return null;
      }
      return r;
    } });
    assert.deepEqual(state.result, {});
    assert.equal(state.done.length, 1);
    assert.equal(state.event.reason, "chunk-failed-original-resumes");
    assert.ok(!JSON.stringify(state.logs).includes("private signature"));
  });
}

test("one failed chunk retries once on the original host and recovers", async () => {
  let failed = false;
  const state = await simulate({ plan(o) {
    const r = reply(o);
    if (core.header(o.headers, "if-range") && !failed) { failed = true; r.error = true; }
    return r;
  } });
  assert.equal(state.event.kind, "parallel");
  assert.equal(state.calls.length, 7);
  assert.equal(state.calls.at(-1).url, URL0);
  assert.deepEqual(state.result.response.body, bytes(0, 1048576));
});

test("missing callbacks and synchronous HTTP exceptions still call done once", async () => {
  for (const plan of [() => null, () => ({ throw: true })]) {
    const state = await simulate({ plan });
    assert.equal(state.done.length, 1); assert.deepEqual(state.result, {});
  }
});

test("callbacks arriving after software timeout cannot generate a second response", async () => {
  const state = await simulate({ plan(o) { const r = reply(o); r.delay = 20000; return r; } });
  assert.equal(state.done.length, 1); assert.deepEqual(state.result, {});
});

test("generic diagnostics reads only this plugin's keys", async () => {
  const store = new Map([["unrelated", "do not touch"]]);
  const state = await simulate({ request: null, store });
  assert.equal(state.done.length, 1); assert.equal(state.calls.length, 0);
  assert.equal(store.get("unrelated"), "do not touch");
});
