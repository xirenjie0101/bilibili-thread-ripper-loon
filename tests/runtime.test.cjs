"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const http = require("node:http");
const { core, URL0, TOTAL, bytes } = require("./helpers.cjs");
const source = fs.readFileSync(path.join(__dirname, "..", "btr-loon.js"), "utf8");

test("Loon-like globals without browser APIs execute passthrough and exactly one done", async () => {
  const done = [], logs = [], values = new Map();
  const context = vm.createContext({
    $request: { url: URL0, method: "GET", headers: { Range: "bytes=0-1000" } },
    $argument: { debug: true }, $done: value => done.push(value),
    $httpClient: { get() { throw Error("should not request small ranges"); } },
    $persistentStore: { read: key => values.get(key), write: (v, k) => values.set(k, v) },
    console: { log: text => logs.push(text) }, setTimeout,
    $notification: { post() {} }
  });
  vm.runInContext(source, context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(done.length, 1);
  assert.deepEqual(Object.keys(done[0]), []);
  assert.equal(JSON.parse(values.get("BTR-Loon-v1.last")).reason, "small-range");
  assert.equal(vm.runInContext("typeof URL", context), "undefined");
});

test("unexpected diagnostic runtime failure still releases the Loon request", async () => {
  const done = [];
  vm.runInNewContext(source, {
    $done: v => done.push(v), console: { log() { throw Error("logger unavailable"); } },
    $persistentStore: { read() { return null; } }, setTimeout
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(done.length, 1);
});

test("HTTP integration: real sockets, delayed chunks, exact body and origin retry", async t => {
  let active = 0, maxActive = 0, failed = false;
  const received = [], timers = [], store = new Map();
  const server = http.createServer((req, res) => {
    received.push({ range: req.headers.range, etag: req.headers["if-range"] });
    const r = core.parseRange(req.headers.range);
    if (req.headers["if-range"] && !failed) {
      failed = true; res.writeHead(503); res.end(); return;
    }
    active++; maxActive = Math.max(active, maxActive);
    const data = bytes(r.start, r.end - r.start + 1);
    res.writeHead(206, { "Content-Type": "video/mp4", "Content-Range": `bytes ${r.start}-${r.end}/${TOTAL}`,
      "Content-Length": data.length, ETag: '"asset-v1"' });
    const middle = Math.floor(data.length / 2);
    res.write(data.subarray(0, middle));
    setTimeout(() => { active--; res.end(data.subarray(middle)); }, req.headers["if-range"] ? 20 : 1);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { timers.forEach(clearTimeout); server.close(); server.closeAllConnections(); });
  let result;
  await core.run({
    request: { url: URL0, method: "GET", headers: { Range: "bytes=100000-1148575" } },
    argument: { mode: "original" }, now: () => Date.now(),
    timer: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); timers.push(timer); },
    get(options, cb) {
      const req = http.get({ host: "127.0.0.1", port: server.address().port, path: "/fixture", headers: options.headers,
        agent: false, timeout: options.timeout }, res => {
        const chunks = [];
        res.on("data", chunk => chunks.push(chunk));
        res.on("end", () => cb(null, { status: res.statusCode, headers: res.headers }, new Uint8Array(Buffer.concat(chunks))));
        res.on("error", error => cb(error));
      });
      req.on("error", error => cb(error)); req.on("timeout", () => req.destroy(Error("timeout")));
    },
    done: value => { assert.equal(result, undefined); result = value; },
    log() {}, notify() {}, read: key => store.get(key), write: (key, value) => store.set(key, value)
  });
  assert.equal(result.response.status, 206);
  assert.deepEqual(result.response.body, bytes(100000, 1048576));
  assert.ok(maxActive >= 2, "downloads actually overlapped on real sockets");
  assert.equal(received.filter(r => r.etag).length, 4);
});

test("plugin bindings, local assets and media coverage agree with documented syntax", () => {
  const plugin = fs.readFileSync(path.join(__dirname, "..", "BTR-Loon.plugin"), "utf8");
  assert.match(plugin, /\$\{request\.method\} == "GET"/);
  assert.ok(!plugin.includes("${method}"));
  const declared = [...plugin.matchAll(/^(\w+) = (?:select|switch|input),/gm)].map(m => m[1]);
  const bindings = [...plugin.matchAll(/\$\{(\w+)\}/g)].map(m => m[1]).filter(x => x !== "url");
  assert.ok(bindings.every(x => declared.includes(x)));
  const rx = plugin.match(/\$\{url\} ~= \/(.+)\/i &&/)[1];
  const regex = new RegExp(rx, "i");
  for (const url of [URL0, URL0.replace(".com", ".cn"), "https://upos-hz-mirrorakam.akamaized.net/abc.mp4"]) {
    assert.ok(regex.test(url)); assert.ok(core.mediaURL(url));
  }
  for (const name of [...plugin.matchAll(/script\("([^"]+)"/g)].map(m => m[1])) {
    assert.ok(fs.existsSync(path.join(__dirname, "..", name)));
  }
  assert.ok(!plugin.includes("*.akamaized.net"));
  // This is a static contract check, not execution by Loon's native parser.
});
