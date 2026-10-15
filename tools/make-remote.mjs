// Generate an installable remote plugin after the user chooses a hosting URL.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = process.argv[2];
let base;
try {
  base = new URL(arg);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash ||
      /[\s"`\\]/.test(arg)) throw new Error();
} catch (_) {
  console.error("用法：node tools/make-remote.mjs https://你的静态托管地址/目录/");
  process.exit(1);
}
if (!base.pathname.endsWith("/")) base.pathname += "/";
const source = fs.readFileSync(path.join(root, "BTR-Loon.plugin"), "utf8");
const scriptURL = new URL("btr-loon.js", base);
scriptURL.searchParams.set("v", JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version);
const plugin = source.replace(/script\("btr-loon\.js"/g, 'script("' + scriptURL.href + '"')
  .replace("须另行导入本地脚本 btr-loon.js。", "");
fs.writeFileSync(path.join(root, "BTR-Loon.remote.plugin"), plugin);
console.log("已生成 BTR-Loon.remote.plugin。上传它和 btr-loon.js 到上述目录后，再导入插件URL。");
