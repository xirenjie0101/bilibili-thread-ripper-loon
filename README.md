# BTR Loon 实验版 0.1.1

针对在美国使用 iPhone / iPad 观看 B 站视频的场景开发，参考 Bilibili-thread-ripper **2026.10.8.1**。目标客户端为国内版哔哩哔哩，以及 **bilibili - Anime · Video HD**（App Store ID `1517062289`，此前使用白色图标的海外版条目）。

**当前交付是可安装测试的实验版本，不是已验证与桌面版等效的成品。** 已完成代码、配置、自动测试和本地 HTTP 集成验证；尚未在 iPhone、Loon 原生运行时、上述两个 App 和美国到 B 站的实际播放链路上验证。测试数量和范围见 `TEST-RESULTS.txt`。

## 直接添加到 Loon

在 Loon 的插件列表中添加下面的 URL，脚本会从同一仓库自动下载：

```text
https://raw.githubusercontent.com/xirenjie0101/bilibili-thread-ripper-loon/main/BTR-Loon.remote.plugin
```

[打开插件原文](https://raw.githubusercontent.com/xirenjie0101/bilibili-thread-ripper-loon/main/BTR-Loon.remote.plugin) · [查看脚本](https://github.com/xirenjie0101/bilibili-thread-ripper-loon/blob/main/btr-loon.js)

随后启用脚本和 MitM，并安装/信任你自己的 Loon CA 证书。默认 3 路并发、最大合并 2 MiB。播放后运行“BTR Loon 查看诊断”确认是否命中。具体安装与验收方法见下文。

## 实现了什么

| 请求情况 | 插件行为 |
| --- | --- |
| 256 KiB 至 2 MiB、起止明确的单个 Range | 默认拆成 3 路并行下载，完成校验后合并返回 |
| `bytes=0-` 等开放 Range、超过 2 MiB 的 Range、无 Range 的整文件请求 | 尝试选择经过验证且短探测响应更快的 CDN，然后交还 App 持续下载 |
| 小于 256 KiB 的初始化/小片段请求 | 直接放行，避免增加启动开销 |
| 原地址不可访问、分片错误、超时、缺少强 ETag | 恢复原请求，由 App 与原服务器继续处理 |

候选 CDN 来自上游项目的大陆/海外列表。每次最多探测原地址加两个候选，每个请求约 16 KiB。候选必须与原地址具有相同的强 ETag、总长度及探测字节，才会参与下载。每个分片再次验证 HTTP 206、Content-Range、长度、ETag、二进制类型及内容编码。

探测衡量的是短请求响应时间，**不代表持续下载速度**。并发可能改善单连接慢的问题，也可能因为握手、缓冲或线路拥堵而变慢；实际效果要用同一视频对照测试。

## 与桌面版的差别

Loon 的公开脚本接口交付完整响应缓冲区，没有桌面浏览器播放器的持续写入接口。因此这个版本：

- 可以对合适的有限范围做真实并发，但必须等该范围下载完整才交给播放器。
- 对常见的开放 Range 只做 CDN 优选；不会把 `bytes=0-` 偷换成短响应。
- 无法复制桌面版的播放器接管、45 秒预缓冲、全局自适应线程调度、断点续传调度和直播预取。
- 无法保证 4K、8K 或杜比流畅；App 现有的账号权限、清晰度、区域限制继续生效。

如果两个 App 主要发送开放范围，或没有强 ETag，这一版本可能只能切换 CDN，甚至完全保持原样。若要求这类请求也获得持续的多线程流式加速，需要额外的流式代理服务，或修改播放器客户端；这超出纯 Loon 插件的范围。

## 客户端和流量范围

| 客户端 | 本版本的适配方法 | 验证状态 |
| --- | --- | --- |
| [国内版哔哩哔哩](https://apps.apple.com/us/app/id736536022) | 处理下表中的媒体下载请求 | 待 iPhone 实测 |
| [bilibili - Anime · Video HD](https://apps.apple.com/us/app/id1517062289) | 使用相同媒体规则，不依赖播放 API 的 JSON/gRPC 格式 | 待 iPhone 实测 |
| 原先安装的旧白色图标版 | 满足相同请求条件时可触发 | 未确认具体旧版本，待实测 |

只处理 HTTPS、标准 443 端口、以 `.m4s` 或 `.mp4` 结尾的路径，以及以下主机：

- `bilivideo.com`、`bilivideo.cn`、`bilivideo.net` 及其子域名。
- 精确的 `upos-hz-mirrorakam.akamaized.net`。

本版本不处理 HTTP 明文媒体、非标准端口 PCDN、IP 直连、其他 Akamai 租户、HLS/直播、FLV、DRM 接口、API 响应修改和证书固定绕过。带 Cookie、Authorization、If-Range 等条件头的请求保持原样。**识别到商店名称不等于已验证该 App 当前版本的全部媒体域名。**

## 安装

需要 **Loon 3.5.1 build 983 或更高版本**，使用新版 Script 配置语法。先保存现有配置的副本。

### 本地安装

1. 解压完整包。`BTR-Loon.plugin` 与 `btr-loon.js` 都需要，ZIP 本身不是订阅地址。
2. 在 Loon 中导入/创建本地脚本，将 `btr-loon.js` 的完整内容保存为同名脚本。插件引用的是 **Loon 的本地脚本路径**，不会自动读取“文件”App 中 ZIP 所在文件夹。
3. 将 `BTR-Loon.plugin` 作为本地插件导入并启用。如果你的 Loon 界面只提供 URL 导入，使用下方的远程安装方法。
4. 启用 Loon 的脚本与 HTTPS 解密（MitM）。在 Loon 中生成并安装自己的 CA 证书，按 iOS 提示安装描述文件，并在“设置 → 通用 → 关于本机 → 证书信任设置”中信任它。
5. 使用规则分流模式，暂时关闭其他修改同一媒体请求的插件。开启 Loon 后彻底退出两个 B 站 App，再重新打开播放。
6. 保留默认参数。播放时，在 Loon 中手动运行 **BTR Loon 查看诊断**，检查是否出现 `parallel` 或 `route`。

插件的 MitM 范围仅包含列出的媒体主机。不要将 `*.akamaized.net` 或全站 `*` 加进去。若某个 App 在开启解密后直接报 TLS 错误，先停用本插件；这种情况不能靠调大线程数修复。

### 远程安装 / 发布到自己的仓库

本仓库的现成安装地址见上方“直接添加到 Loon”。若 Fork 到其他账号或更换托管目录，需要重新生成远程插件，避免继续引用原仓库脚本。可以选择 HTTPS 静态托管目录，例如自己的 GitHub Raw 目录：

```text
https://raw.githubusercontent.com/你的账号/你的仓库/main/loon/
```

在本包目录运行：

```sh
node tools/make-remote.mjs https://你的HTTPS静态托管目录/loon/
```

工具会生成 `BTR-Loon.remote.plugin`，把其中的本地脚本引用替换为真实远程地址。将它和 `btr-loon.js` 上传到该目录，然后在 Loon 插件列表里添加 `BTR-Loon.remote.plugin` 的完整 URL。不要填写 GitHub 的网页 `blob` 地址；应使用返回文件原文的 Raw 地址。首次导入时确认脚本下载成功。

### 美国网络与 QUIC

插件保留现有路由，不提供代理节点，也不强制媒体走某个国家。先使用你当前可正常播放的路线作基准，再对照美国本地直连或已有节点的效果。仅切换 CDN 不会改变所在地或账号播放权限。

插件包含针对上述媒体域名的 QUIC 拒绝规则，使支持回退的 App 尝试 HTTPS/TCP。Loon 的**本地规则优先于插件规则**。若请求记录依旧显示 QUIC，检查更早的本地直连/代理规则；必要时把插件 `[Rule]` 中的四条规则复制到本地规则前面。无需屏蔽全设备 UDP。若 App 不回退到 TCP，此方法不适用，应停用插件。

## 参数

| 参数 | 默认值 | 用法 |
| --- | --- | --- |
| `mode` | `auto` | 原地址＋大陆阿里＋海外阿里；`original` 仅原节点；`mainland` 大陆候选；`overseas` 海外候选 |
| `concurrency` | `3` | 每个媒体请求 2–4 路；不是整台手机的全局上限 |
| `max_mib` | `2` | 单次合并限制 1、2 或 4 MiB；不改变 App 请求的实际范围 |
| `parallel` | `true` | 开关有限范围的并发下载 |
| `route` | `true` | 开关长请求的 CDN 优选 |
| `debug` | `false` | 打开后记录跳过原因；成功事件默认也记录 |

不要把桌面版的 32/64 线程照搬到这里。音频、视频和预加载请求可同时运行，会叠加连接与内存。2 MiB 合并请求通常至少涉及分片与合并缓冲两份数据，另有 TLS 和运行时开销。若 CDN 无视 Range 返回整个文件，Loon 只能在下载回调后检查，脚本无法保证其传输期间的硬内存上限。因此目前保持实验状态；出现 Loon 断连或明显发热时先停用本插件。

## 如何判断生效

“查看诊断”会显示运行版本、本次存储读写检查、最近进入媒体脚本的记录、最近处理结果及最近一次成功事件。最近成功可能来自此前的视频，应结合时间判断。手动诊断本身不会启动加速。

### 一直没有请求记录时（0.1.1 新增）

1. 更新插件和远程脚本，手动运行诊断，确认标题显示 **0.1.1**。
2. 保持 Loon 开启，在 iPhone 的 Safari 打开 [HTTPS 自检](https://upos-sz-mirrorali.bilivideo.com/btr-loon-self-test.m4s?v=0.1.1)。这个固定测试地址通过现有媒体请求规则进入脚本，脚本在设备上返回诊断页面，不向 CDN 下载视频。
3. 页面显示 **“HTTPS 媒体规则已触发”**，说明测试域名的 HTTPS 请求已经进入媒体脚本；这不等于两个 App 已经加速。随后播放视频，检查“最近进入媒体脚本”和“最近处理结果”的时间是否更新。
4. 如果 HTTPS 自检失败，再试 [HTTP 自检](http://upos-sz-mirrorali.bilivideo.com/btr-loon-self-test.m4s?v=0.1.1)。HTTP 成功而 HTTPS 失败时，优先检查 MitM、证书信任及 HTTPS 流量处理。若浏览器自动升级 HTTP，以页面实际显示的协议为准。
5. 两个自检都无法显示本插件页面时，检查插件是否启用、脚本是否下载、规则解析错误及流量是否经过 Loon；仅凭打开失败不能认定具体是哪一个原因。
6. HTTPS 自检成功而播放没有记录时，需要查看 App 实际媒体请求的域名、协议、端口及命中规则。当前版本仍只加速前述 HTTPS 443 媒体；HTTP、非标准端口、其他域名或 QUIC 流量可能不命中。

自检仅对上面两个固定 URL 生效。未被 Loon 拦截时，浏览器可能显示 CDN 错误页或连接错误；只有带本插件版本及诊断结果的页面才算自检成功。自检不写入视频触发或加速成功记录，也不能验证持续下载速度。存储检查使用独立的插件键，不清理其他脚本数据。网页内容只在设备上生成，没有上传诊断的代码。上述入口尚待 iPhone/Loon 原生实测。

| 日志 | 含义 |
| --- | --- |
| `kind: parallel` | 该次请求已完成分块并发、校验、合并 |
| `kind: route` | 仅切换到验证通过且探测响应更快的 CDN |
| `small-range` | 小请求保持原样，这是预期行为 |
| `no-strong-etag` | 缺少可靠文件版本标识，未执行并发/换源 |
| `origin-probe-failed` | 原地址探测被拒绝、超时或不符合 Range 协议，恢复原请求 |
| `credential-or-conditional-request` | 请求含凭据或条件头，保持原样 |
| `original-route-kept` | 没有验证出明显更快的候选，保持原地址 |
| `chunk-failed-original-resumes` | 分片重试仍失败，恢复原请求 |
| 一直没有记录 | 脚本未加载、请求不在适配范围、QUIC、其他规则抢先命中或 MitM 未成功 |

只要显示 `pass`，就不能算作并发加速成功。原请求恢复可能带来额外等待和重复流量，不能保证无感回退。

## iPhone 验收步骤

分别在国内版和 Anime · Video HD 中执行：

1. 选择一个你有权播放且在美国容易卡顿的视频，固定清晰度与 Wi-Fi。
2. 关闭插件，从未缓存的位置播放 2 分钟，记录首播等待和卡顿次数。
3. 开启插件，用另一个未缓存的位置或另一条相近码率的视频重复；随后交换开关顺序，避免缓存让结果偏向第二次。
4. 测试拖动到尚未缓冲的位置、切换清晰度、音画同步、进入后台再返回。
5. 记录两个 App 的具体版本、iOS/Loon build、是否有 `parallel`、`route` 或跳过原因，以及前后等待/卡顿情况。

如需后续适配，只提供上述脱敏信息，以及媒体主机名、Range 形态、HTTP 状态和是否有 ETag 即可。不要分享 Cookie、完整签名媒体 URL、Loon CA 私钥或整个未脱敏配置。

## 测试与开发

Node.js 18+，无第三方依赖：

```sh
npm test
```

58 项测试包括：2000 组分块覆盖检查、乱序拼接、真实本地 HTTP 重试与并发、错误 Range/长度/ETag/内容编码、200/403/416、超时与迟到回调、凭据请求放行、开放范围完整保留、签名参数不改写、存储失败与诊断脱敏、自检不产生加速记录、HTML 转义，以及模拟 Loon 全局对象。配置检查仅为静态验证，不能替代 Loon 原生解析器验收。

另尝试通过公开 B 站 API 读取一个公开视频，当前开发环境收到 HTTP 412，因此没有取得可用于真实 CDN 测试的播放地址；未把该尝试算作测试通过或提速证据。

## 来源与许可

- [上游仓库](https://github.com/MrTangLuyao/Bilibili-thread-ripper)，基线版本 `2026.10.8.1`，提交 `0302b345cdfe367ac599b52dc6874e3f7967e220`。Range 解析/分块思路与 CDN 候选来自其中的 `src/range-core.js`、`src/cdn-resolver.js`，Loon 适配与测试为本项目新增。
- [Loon Script API](https://nsloon.app/docs/Script/script_api/)、[Script 配置语法](https://nsloon.app/docs/Script/script_v2/)、[插件格式](https://nsloon.app/docs/Plugin/)、[规则优先级](https://nsloon.app/docs/Rule/)、[MitM](https://nsloon.app/docs/MitM/)。
- MIT 许可证见 `LICENSE`，保留上游版权。本项目不是上游作者或 Loon 官方发布的插件。

停用方式：关闭并删除本插件；若手工复制过 QUIC 规则，删除相应四条。无需修改或卸载 B 站 App。
