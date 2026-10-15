"use strict";
const core = require("../btr-loon.js");
const URL0 = "https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/10/20/100/100-1-30080.m4s?deadline=9999999999&sign=DO_NOT_LOG%2Bsecret&x=1&x=2";
const TOTAL = 8 * 1024 * 1024;
function bytes(start, length) {
  const data = new Uint8Array(length);
  for (let i = 0; i < length; i++) data[i] = ((start + i) * 17 + Math.floor((start + i) / 251)) % 256;
  return data;
}
function reply(options, overrides = {}) {
  const range = core.parseRange(options.headers.Range), total = overrides.total || TOTAL;
  const end = Math.min(range.end, total - 1);
  return {
    response: { status: 206, headers: {
      "content-range": `bytes ${range.start}-${end}/${total}`,
      "content-length": String(end - range.start + 1),
      "content-type": "video/mp4", etag: '"asset-v1"',
      "set-cookie": "never-return-this=1", "alt-svc": 'h3=":443"',
      ...(overrides.headers || {})
    } },
    data: bytes(range.start, Math.max(0, end - range.start + 1)),
    delay: 40, ...overrides
  };
}
async function simulate({ request, argument, plan, store } = {}) {
  let clock = 1000000, sequence = 0, active = 0, maxActive = 0, result;
  const jobs = [], calls = [], done = [], logs = [];
  store = store || new Map();
  const timer = (fn, ms) => jobs.push({ fn, at: clock + ms, id: sequence++ });
  const running = core.run({
    request: request === undefined ? { url: URL0, method: "GET", headers: { Range: "bytes=0-1048575", "User-Agent": "Bili-Test", Referer: "https://www.bilibili.com/" } } : request,
    argument, now: () => clock, timer,
    get(options, callback) {
      calls.push(options); active++; maxActive = Math.max(active, maxActive);
      const response = plan ? plan(options, calls.length) : reply(options);
      if (response && response.throw) { active--; throw new Error("private transport details"); }
      if (!response) return;
      timer(() => { active--; callback(response.error || null, response.response, response.data); }, response.delay || 0);
    },
    done(value) { result = value; done.push(value); },
    log: value => logs.push(value), notify: (...args) => logs.push(args.join(" ")),
    read: key => store.get(key), write: (key, value) => store.set(key, value)
  });
  // Advance a deterministic clock including callbacks arriving after $done.
  for (let step = 0; step < 500; step++) {
    for (let n = 0; n < 12; n++) await Promise.resolve();
    if (!jobs.length) break;
    jobs.sort((a, b) => a.at - b.at || a.id - b.id);
    const job = jobs.shift(); clock = job.at; job.fn();
  }
  await running;
  return { result, calls, done, logs, store, maxActive,
    event: JSON.parse(store.get("BTR-Loon-v1.last") || "null") };
}
module.exports = { core, URL0, TOTAL, bytes, reply, simulate };
