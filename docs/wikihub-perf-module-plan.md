# WikiHub 性能测试模块方案（评审稿）

> 版本 v0.1 · 2026-11-08
> 输入：《参考 LoadRunner 录制思路的接口采集 + k6 压测 + 报告生成 完整方案》v1.0（2026-11-07）
> 落点：`packages/dsh-desktop-wikihub`（工作台面板 + 服务端）
> 状态：**待评审**，第 12 节有 5 个需要你拍板的分叉
>
> ⚠ **本文件已被端到端审核过，7 处外部工具假设不成立**（summary 字段形状、thresholds 布尔语义、
> 分组 p95 不可得、ndjson 体量、退出码映射等）。**实施以实现规范为准**：
> `docs/wikihub-perf-implementation-spec.md` §0.1 列出了每条修正的实测证据。本文件保留为决策记录。

---

## 0. 结论速览

方案文档解决的是「怎么录、怎么转、怎么压、怎么出报告」，缺的是**它长在哪里**。本方案把它落到 WikiHub，形态是：

**一个 rail 入口（性能测试）+ 四个阶段视图（录制 / 脚本 / 运行 / 报告）+ 一个与面板同源的服务端执行核**，
并且刻意复用了 WikiHub 已有的两块基建：**测试用例库的页面契约**（`test-spec` / `env-spec` / 页面类型表）和**长任务的事件日志 + 任务表模式**（ingest 那套 `records + jsonl log + 轮询`）。

需要你评审的 5 个决策，先给结论：

| # | 决策 | 推荐 | 代价 |
|---|---|---|---|
| D1 | 录制用的浏览器由谁启动 | WikiHub 自带录制器，**HAR 逻辑整份移植 xgents**（不依赖 browser-hub 一定装上） | 与 browser-hub 的浏览器探测表重复约 80 行（这是有意换掉装配失败风险） |
| D2 | k6 从哪来 | 探测本机 + 在「性能测试 → 环境」里可改路径，缺失时给安装引导 | 首次使用需要用户自己装一次 k6 |
| D3 | 数据放哪 | **场景定义进知识库（md 页面）**，**录制/脚本/运行产物进 `.llm-wiki/perf/`** | 产物不参与搜索与图谱（这是刻意的） |
| D4 | 谁触发压测 | 面板按钮（二次确认）+ agent 工具（走审批门） | 两套入口要共用同一个执行核 |
| D5 | 左侧边栏入口指哪个 | WikiHub 内 48px 图标栏（本方案默认）；宿主工作台列表=另开一个包（备选） | 若你要的是后者，形态完全不同，见 §5.7 |

另有三组**取证结论会影响实现细节**，已在 §8 记录：

1. 本机 k6 是 **v2.2.0**，`--summary-export` 还在，但多了 `--new-machine-readable-summary` 会改变导出 JSON 的形状 —— 报告生成器不能假设一种形状。
2. `client.js` 当前 **725,697 字节**，构建硬预算 **819,200 字节**，只剩 **~91 KB**。这是加面板的真实约束，不是理论风险。
3. **browser-hub 提供了传输，但没有 HAR 语义**（只有 `{url, method, status}` 诊断日志）；真正的 HAR 采集与 k6 执行语义在 xgents 里，已写好且踩过坑。本方案的选择是「不复用代码、但整份移植规则」，并对齐范围做了三档划分（§8.4 / §8.5）。

---

## 1. 现状取证

### 1.1 方案文档要求做的事，拆成四段

| 阶段 | 输入 | 输出 | 谁执行 |
|---|---|---|---|
| 录制 | 人在专用浏览器里操作 | HAR 1.2 | 插件（起浏览器 + CDP 抓包） |
| 转换 | HAR + 元数据 | k6 脚本 + 关联清单 + TODO 清单 | 插件（纯函数流水线） |
| 执行 | 脚本 + 场景参数（VU/阶段/阈值） | summary.json + 实时指标 | 插件（spawn k6） |
| 报告 | summary + 录制元数据 + 冒烟结果 | Markdown 报告 | 插件（纯函数） |

四段里三段是纯函数，只有「起浏览器」和「spawn k6」需要进程权限。

### 1.2 WikiHub 已有、可直接复用的

| 资产 | 位置 | 怎么用 |
|---|---|---|
| 48px 图标栏导航 | `src/App.js:692-703`（`railItems` 数组） | 加一行 `['perf', t('nav.perf'), IconGauge]` |
| 视图分发 | `src/App.js:744-802`（`if/else` 链） | 加一个 `else if (view === 'perf')` |
| HTTP 装配 | `lib/http.js:68-88`（`route(path, handlers)`） | 一个 path 只能注册一次，按 method 分发 |
| 长任务记法 | `lib/records.js` + `lib/ingest.js` 的 jsonl 日志 + `Logs.js` 的游标轮询 | 运行事件流照抄这套，不发明新机制 |
| 测试页面契约 | `lib/testSpec.js:8-9`（`CASE_ACTIONS`）、`lib/testSpec.js:60`（凭据必须是指针）、`lib/pageKinds.js:7-14` | 性能场景页沿用同一套 fence 风格与必填章节 |
| 错误契约 | `lib/contract.js` 的 `CODE` + `lib/http.js:21-33` 的 `STATUS` | 新增错误码必须进这张表，禁止路由自己编状态码 |
| Markdown 渲染 | `src/lib/markdown.js` | 报告在面板里就是渲染后的 md，不做第二套渲染 |
| 限额共享 | `src/lib/limits.js` + `test/frontend-backend-parity.test.js` | VU/时长/体积上限必须两端同源 |

### 1.3 硬约束（写代码前必须认的）

| 约束 | 证据 | 对本方案的影响 |
|---|---|---|
| 服务端模块级只能 import `node:` 内置和**已声明 dependencies** | `scripts/build.mjs` 的自检段；`@deepseek-ai/*` 只能在函数内动态 import | 录制器不能直接 `import 'ws'`，除非新增依赖 |
| 客户端包体 ≤ 800 KB，当前 708 KB | `scripts/build.mjs:maxClientBytes`；`client.js` 实测 725,697 B | **不能引图表库**，曲线用 SVG/CSS 手绘 |
| `data-dsh-workbench-toolbar` 全屏只能出现一次 | `src/App.js:6-10` 的注释（历史故障） | 性能视图不能自带第二个 sticky 工具条 |
| `active !== true` 必须停表 | `src/App.js:121-123`、`panelActive` | 录制计数与运行轮询都要受这个开关控制 |
| hook 必须在唯一顶层 `return` 之前 | `src/App.js:559-566`（#310 事故） | 面板内新增 hooks 一律放函数顶部 |
| 事务/进程类能力不属于 browser-hub | `docs/browser-hub-migration-spec.md:72`（test 域明确 out of scope） | 不能把压测塞进 browser-hub，UI 也就没地方挂 |

### 1.4 环境实测（本机，2026-11-08）

| 项 | 结果 | 说明 |
|---|---|---|
| k6 | `D:\k6\k6.exe` → **v2.2.0** | 不在 PATH，必须做路径探测与手填 |
| `--summary-export` | 仍存在 | 导出形状受 `--new-machine-readable-summary` 影响 |
| `-a/--address`（REST API） | 仍存在（默认关闭） | 实时指标与**优雅停止**都靠它 |
| Chrome | 默认安装路径**不存在** | 探测表要能落到 Edge |
| Edge | `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` | Windows 上的主用目标 |
| 宿主 Node | 24.x | 有全局 `WebSocket`，录制器可零依赖 |

---

## 2. 需求映射：LoadRunner 三段式 → 面板四段

| LoadRunner | 方案文档 | 本方案的面板位置 |
|---|---|---|
| VuGen 录制 | CDP → HAR | 场景详情 → **① 录制** 卡片 |
| 关联 / 参数化 | HAR → k6 + TODOs | 场景详情 → **② 脚本** 卡片（含 TODO 确认表单） |
| Controller 场景 | stages / VU / 阈值 | 场景详情 → **③ 运行** 卡片（场景参数 + 实时指标） |
| Analysis 报告 | summary → md | 场景详情 → **④ 报告** 卡片 |

**关键取舍**：不做四个独立 rail 入口。理由——录制、脚本、运行、报告是**同一个场景的四步**，拆成四个入口会让「我上次压的是哪个脚本」变成翻页游戏；而 WikiHub 的 rail 已经有 10 个入口，第 11 个之后每加一个都在降低可发现性。

---

## 3. 总体架构

```
┌──────────────── 面板（client） ────────────────┐
│ rail: 性能测试 → PerfPanel                      │
│  左栏（本视图切换为场景列表）                     │
│  主区：场景详情 = 录制 / 脚本 / 运行 / 报告       │
└───────────────┬────────────────────────────────┘
                │ HTTP (轮询 1–2s，受 active 控制)
┌───────────────▼────────────────────────────────┐
│ lib/perf/*  ← 唯一执行核（纯函数 + 一个 Runner）  │
│  recorder.js   起 Edge/Chrome + CDP → HAR       │
│  harToScript.js  9 阶段纯函数流水线             │
│  runner.js     spawn k6 + 事件落盘 + 优雅停止    │
│  report.js     summary → Markdown               │
│  spec.js       perf-spec fence 的解析与校验      │
│  store.js      .llm-wiki/perf/<site>/... 读写    │
└───────────────┬────────────────────────────────┘
                │ 同一批函数
┌───────────────▼────────────────────────────────┐
│ lib/tools.js 新增 wikihub_perf_*  → agent 侧入口 │
│  （压测类工具挂 tools/pre-execute 审批门）        │
└─────────────────────────────────────────────────┘
外部依赖：Edge/Chrome（CDP）、k6 可执行（本机）
```

**分层原则**（沿用本仓现有做法）：

- `lib/perf/*` 里凡是不碰进程、不碰磁盘的，一律写成纯函数并单测（HAR→脚本、脚本→报告、spec 校验）。
- `index.js` 只负责装配，不写规则。
- `lib/http.js` 只做参数解析与错误映射。
- 面板只认 HTTP 契约，不复制业务判断（例如「冒烟没绿不许加压」这条规则必须在服务端，不能只在按钮的 `disabled` 上）。

---

## 4. 数据模型与目录

### 4.1 库内（知识库页面，参与搜索/图谱/评审）

```
<sites>/<site>/perf/<场景名>.md
```

页面 `frontmatter.type = 'perf-scenario'`，正文里一个 `perf-spec` fence：

```yaml
perf-spec:
  version: 1
  target: test            # test | staging | prod —— prod 需要额外确认
  baseUrlRef: env:web-test # 只放指针，不放明文（与 env-spec 的凭据规则一致）
  flowRef: flows/下单主流程  # 对应现有 flow 页面
  caseRefs: [cases/ORDER/TC-ORDER-03]
  loadModel:
    stages: [{ duration: 1m, target: 10 }, { duration: 3m, target: 50 }, { duration: 1m, target: 0 }]
  thresholds:
    - http_req_duration: ['p(95)<500']
    - http_req_failed: ['rate<0.01']
  thinkTime: normalized   # recorded | normalized | none
  notes: 单机负载发生器，未测分布式
```

**为什么要进库**：场景是可评审的资产——谁定的 VU 曲线、SLA 凭什么、这条流程漏了哪个分支，都该能被 `[[wikilink]]` 引到 flow / case 页面，被 lint 检查、被搜索命中。这正好复用 `pageKinds.js` 里已有的机制（新增 `'perf-scenario': ['目标与场景', '业务路径', '负载模型', 'SLA 阈值', '数据与账号', '边界']`）。

### 4.2 机器侧（产物，含凭据，不进库）

```
<root>/.llm-wiki/perf/<siteId>/
├── record/<recId>/har.json          # HAR 1.2（默认 7 天清理）
├── record/<recId>/meta.json         # 录制人、起止、操作员标注、Top 主机
├── script/<场景名>/<scriptId>.js     # 生成的 k6 脚本
├── script/<场景名>/<scriptId>.meta.json  # correlations / todos / warnings / 生成参数
└── run/<runId>/
    ├── state.json                   # 状态机、pid、参数、开始/结束时间
    ├── events.jsonl                 # 阶段事件（面板轮询读这个）
    ├── summary.json                 # k6 导出（权威指标源）
    └── report.md                    # 报告产物
```

### 4.3 为什么不把产物放库目录

知识库目录是用户自己的文件夹，可能是一个 git 仓库、可能被导出分享。HAR 里有 `Authorization` 头和登录报文——放进库里等于把凭据写进一个「会被搜索、被引用、被导出」的地方。方案文档 §6 也要求 `.gitignore` 覆盖 `recordings/`；在 WikiHub 里更彻底的做法是**产物根本不在库里**，需要归档时走显式的「导出到库（先脱敏）」动作。

---

## 5. 关键决策（每条给推荐 + 代价 + 备选）

### D1 录制用的浏览器由谁启动 —— 推荐：WikiHub 自带录制器，但**代码整份移植 xgents**

| 备选 | 说明 | 问题 |
|---|---|---|
| **A（推荐）** | `lib/perf/recorder.js` 用 `node:child_process` + 全局 `WebSocket` 起 `msedge/chrome --remote-debugging-port --user-data-dir=<tmp>`，订阅 5 个 `Network.*` 事件；HAR 映射**移植** xgents `har-capture.ts` | 与 browser-hub 的浏览器探测表重复（约 80 行） |
| B | 复用 `dsh-browser-hub` 的 `CdpClient` / `BrowserLauncher` | 跨插件 import 无正式通道；且 browser-hub 未装时性能模块会**静默残缺**——这正是本仓反复吃亏的失败模式 |
| C | 让 agent 用 browser_hub 走流程再导出 | 违背方案文档「人控」定位，且 agent 代走会耗 token、有截图事故史 |

**为什么不选 B**：两个插件各自打包、各自安装，`dsh-browser-hub` 是 `private` 包。WikiHub 静态依赖它 → 装配期失败 → 整个知识库工作台消失（`index.js:6-11` 记录的正是这个故障）。重复 80 行探测代码，换掉一个「用户少装一个插件就白屏」的风险，值。

**关键补充：不复用代码 ≠ 重新发明。** 录制能力可以拆成三层，各层的复用结论不同（依据 `E:\github\xgents-desktop\packages\main\src\agent\tools\browser\` 与 AgentBro `packages/dsh-browser-hub/src/` 实读）：

| 层 | xgents | AgentBro browser-hub | 本方案 |
|---|---|---|---|
| 浏览器探测与启动 | `browser-launcher.ts`（315） | `launcher.js`（330，已移植，端口改 9333） | 照 browser-hub 的探测表写，约 80 行 |
| CDP 传输 | `cdp-client.ts`（144） | `cdp-client.js`（173，含 AbortSignal 改造） | 用全局 `WebSocket` 重写同一接口（`send`/`on`/`connect`） |
| **HAR 数据模型与采集时机** | `har-capture.ts`（393，`HarCaptureManager`，构造函数只吃 `getCdp: () => CdpClient`） | **不存在**——`actions.js:120` 只收集 `{url, method, status}` 做诊断面板，没有 header / body / timing / cookie | **整份移植**（去掉 TS 类型 + 换 CdpClient 接口），不自己重新发明 |

换句话说：browser-hub 提供了**传输**，xgents 提供了**HAR 语义**，两者不是同一件事。方案复用的是前者那套思路，真正需要「对齐」的是后者的映射表——见 §8.4。

**做法**：`recorder.js` 只依赖 `node:child_process`、`node:fs`、全局 `WebSocket`。若宿主 Node < 22（无全局 WebSocket），才在 `dependencies` 声明 `ws` 并走动态 import——`scripts/build.mjs` 已证明 `dependencies` 会被真实安装。

### D2 k6 从哪来 —— 推荐：探测本机 + 可手填路径

| 备选 | 代价 |
|---|---|
| **A（推荐）** 探测 `PATH` → 常见安装目录（`D:\k6`、`%LOCALAPPDATA%\k6`、`~/.k6`）→ 用户手填 | 首次使用需用户自己装一次；面板必须把「没装」讲清楚 |
| B 随包分发 k6 | 每平台 30–60 MB，安装包膨胀 + 签名/公证成本 —— **已否决**（§12 决策 2） |
| C 首次使用时下载 | 需要外网、校验、可能的代理失败 —— **已否决**（§12 决策 2） |

**推荐 A 的理由**：本机 k6 已经在 `D:\k6\k6.exe`，说明用户是「有 k6 的人」；而把 60 MB 塞进安装包，会让所有不用压测的用户一起付体积代价。

**解析顺序直接照抄 xgents `k6/installer.ts`**（已验证过的一条链，不要自己另排）：`显式配置 → 环境变量 → PATH → 本模块安装目录`，且**取版本最高的候选**，这样用户升级自己的 k6 立即生效。该文件还实现了「从 GitHub release 下载 + SHA256 校验 + 解到固定 per-user 目录」，如果将来要做一键安装，应当移植它而不是新写（注意其注释里已记录：`undici` 的 fetch 忽略 `HTTP(S)_PROXY`，代理用户需手装并指路径——这条限制会直接成为我们面板的文案）。

**必须做好的部分**：`GET /api/wikihub/perf/env` 返回 `{ k6: { found, path, version, source: 'config'|'env'|'path'|'installed' }, browser: { found, kind, path } }`，面板在环境不满足时**禁用「开始录制/开始压测」并给出可复制的安装命令**，而不是等用户点了才报错。

### D3 数据放哪 —— 推荐：场景进库、产物进机器目录

见 §4。代价：产物不参与搜索/图谱；需要「导出到库」这个显式动作才能长期归档。

### D4 谁触发压测 —— 推荐：双入口、一个执行核

- **面板入口**：按钮 → 二次确认弹窗（显示目标 host、峰值 VU、时长、阈值）→ 执行。人已经点了按钮，不再弹系统审批。
- **agent 入口**：`wikihub_perf_run` 工具，挂 `tools/pre-execute` 瀑布返回 `{kind:'ask'}`（`lib/tools.js:912-927` 已有这套挂法）。**并且**在本地再做一次 `requiresConfirm` 兜底——因为 `ask` 在「无开放 turn / agent-less 执行 / 未组合 ApprovalService」三种情况下 fail-closed 为 deny（本仓已记录），只靠 `ask` 会出现「面板能跑、agent 跑不了」的割裂。
- **对生产系统**：`perf-spec.target: prod` 时，面板需要输入目标 host 名前 8 个字符做确认；工具入口直接 deny 除非显式传 `allowProduction: true` 且审批通过。

### D5 场景与测试用例库的关系 —— 推荐：挂上去，不另起体系

WikiHub 已经有 flow / module / case / environment 四类页面和 `env-spec`（环境入口 + 凭据指针）。性能场景**引用**它们，而不是复制：`flowRef` 指向被压的业务流程页，`baseUrlRef` 指向环境页，`caseRefs` 记录这份脚本覆盖了哪些功能用例。

好处：报告第 4 节「事务明细」里的每个接口，能顺着 `flowRef` 回到业务流程说明；压测发现某个接口 p95 涨了，能直接看到它对应用例的预期。这是 WikiHub 相对裸 k6 的唯一独特价值，不做就等于只是套了个壳。

### D6 敏感数据 —— 推荐：默认脱敏 + 短保留 + 禁止入库

1. HAR 写出前默认把 `authorization` / `cookie` / `set-cookie` 值替换为 `<redacted:len=NNN>`（方案文档建议默认关，这里建议**默认开**：本模块的 HAR 不会被共享，脱敏不损失能力，因为测试凭据本来就是固定值）。
2. `record/` 目录 7 天清理，与方案文档一致。
3. 「导出到库」强制走脱敏版，且导出的是**脚本 + 报告**，不是 HAR。
4. 工具返回文案永远带一行「凭据只用于测试环境」的提醒。

### D7 入口位置 —— 已定：WikiHub 内 48px rail；标题不改（决策记录见 §12）

~~这是需要你确认的第一件事~~（**已确认**：rail 内；标题保持「知识库」）。当时列的两个选项：

| 位置 | 含义 | 本方案 |
|---|---|---|
| **WikiHub 面板内的 48px 图标栏** | 和「知识库 / 搜索 / 图谱 / 审阅」并列 | ✅ 默认按这个做 |
| **宿主窗口左侧的工作台列表** | 和「知识库」「浏览器」并列，每个是独立 workbench | ❌ 那是另开一个 `dsh-desktop-perfhub` 包，与 WikiHub 无 UI 关系 |

如果是后者，§3 的 UI 部分全部作废、只剩服务端那套可以搬——请明确。

**语义问题的最终处置（决策 3）**：标题不改，仍为「知识库」；语义分类由 rail 分隔线承担（`review` 与 `logs` 之间加一条 `.whRailDivider`，见规范 C14）。

---

## 6. 接口契约

### 6.1 HTTP 路由（全部在 `lib/http.js` 注册，一 path 一注册）

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/wikihub/perf/env` | k6 / 浏览器探测结果 + 上限 |
| GET | `/api/wikihub/perf/scenarios` | 库内 `perf/` 页面列表（id/title/updated/最近一次结论） |
| POST | `/api/wikihub/perf/record` | `{ sceneId }` 启动录制（起浏览器 + 开抓包） |
| GET | `/api/wikihub/perf/record` | 录制状态：`{ active, count, topHosts, elapsed, browserPid }` |
| POST | `/api/wikihub/perf/record/stop` | 停止 → `{ recId, harPath, entries, duration, topHosts }` |
| POST | `/api/wikihub/perf/script` | `{ recId, sceneId, options }` → 生成脚本 + correlations + todos |
| GET | `/api/wikihub/perf/script` | 读脚本正文 + 待确认 TODO 清单 |
| POST | `/api/wikihub/perf/script/confirm` | 提交 TODO 确认结果 → 重写脚本 |
| POST | `/api/wikihub/perf/validate` | 语法校验（`k6 inspect` / 简易静态检查） |
| POST | `/api/wikihub/perf/run` | `{ sceneId, mode: 'smoke'|'load', overrides }` → `{ runId }` |
| GET | `/api/wikihub/perf/run` | 运行状态 + 指标快照（面板 1–2 s 轮询） |
| POST | `/api/wikihub/perf/run/stop` | 优雅停止（先 REST，后进程兜底） |
| GET | `/api/wikihub/perf/report` | 报告 Markdown + 指标结构化数据 |
| GET | `/api/wikihub/perf/events` | 事件流（`since` 游标，与 ingest log 同形） |

新增错误码（必须同时进 `CODE` 与 `STATUS`）：`E_PERF_NO_K6`(503)、`E_PERF_NO_BROWSER`(503)、`E_PERF_BUSY`(409，单录制/单运行互斥)、`E_PERF_PROD_BLOCKED`(403)。

### 6.2 agent 侧工具（`lib/tools.js`）

`wikihub_perf_env` / `wikihub_perf_record`（start/status/stop）/ `wikihub_perf_script` / `wikihub_perf_run` / `wikihub_perf_report`。
**只有 `wikihub_perf_run` 挂审批门**——录制和转换不改用户数据，压测会打真实服务。

### 6.3 状态机

```
scene:  draft → (record) → recorded → (script) → scripted → (smoke ok) → ready
                              ↓ 失败                        ↓ 冒烟红
                            recorded                     scripted
run:    queued → running → finished | failed | stopped | interrupted
```

`interrupted` 是必须有的状态：压测跑到一半宿主退出，`state.json` 里留着 `pid` 和已写出的 `summary.json`，重启后由启动清扫把 `running` 改成 `interrupted`（照 `records.sweepZombies` 的做法），报告仍可基于已有 summary 生成。

**退出码映射直接照 xgents `k6/exit-codes.ts`**，其中两条最容易写错、写错后果最重：

| exit | 含义 | 本项目状态 |
|---|---|---|
| 0 | Success | `finished` |
| 99 | ThresholdsHaveFailed | `finished` + 报告 `FAIL`（**不是工具失败**，不要弹错误） |
| 103 | ScriptStoppedFromRESTAPI | `stopped`（我们主动停的） |
| 105 | ExternalAbort | `stopped` |
| 100/101/102 | setup/teardown/整体超时 | `failed` |
| 107/108 | 脚本异常/中止 | `failed`（需修脚本，可重试） |

把 103/105 当失败，会让用户每次「急停」都看到一个红色错误，还会诱导模型进入无意义的「修脚本」循环——xgents 的注释里已明确记录了这一点。

---

## 7. 面板设计

> 可视稿：`docs/wikihub-perf-ui-preview.html`（6 组视图 + rail 特写，尺度直接取自 `src/styles.css`）。
> 里面已经把「新增 6 组、其余全复用」标出来了，评审时以它为准讨论界面，不再靠文字想象。

### 7.1 入口与视图

```
rail 新增：['perf', t('nav.perf'), IconGauge]   // 放在 logs 之后、skills 之前
```

「录制 / 执行」类入口放在中间偏下，与「知识阅读类」（wiki/search/graph）分开——rail 本身就是靠位置传达分类的。

### 7.2 四个阶段视图（同一面板内的分段卡片）

| 段 | 内容 | 关键交互 |
|---|---|---|
| ① 录制 | 环境检查条、开始/停止按钮、实时条数 + Top 主机、操作提示（「先在浏览器里登录并走完业务流程」） | 单录制互斥；停止后出 HAR 摘要卡 |
| ② 脚本 | 脚本只读预览（可切原文/结构化关联表）、TODO 清单逐条确认（固定值 / 绑定到某前置响应 / 删除该请求） | 未清 TODO 时「下一步」置灰 |
| ③ 运行 | 场景参数表单（stages 表格、阈值、thinkTime）、冒烟按钮、运行中实时指标（TPS / p95 / 失败率 / VU）、急停 | 冒烟未绿不许加压（服务端也拦） |
| ④ 报告 | 渲染后的报告 md + 指标表 + 阈值判定徽标 + 「导出到库」 | 报告未生成时显示 summary 原始指标 |

### 7.3 图表怎么办（包体预算的正面回答）

不引图表库。三个可视化用手写 SVG，都在 200 行内：

- **VU 曲线**：stages 数组直接画阶梯折线（预览就是配置的一部分，不需要 Chart.js）。
- **吞吐/延迟趋势**：从 `events.jsonl` 的采样点画 polyline。
- **接口 p95 排序**：CSS 宽度条（`width: calc(...)`），和现有 lint 面板的分布条同款。

这三样加起来约 6 KB，留得下。

### 7.4 宿主约束清单（写完必须自检的 6 条）

1. 面板根包在 `ErrorBoundary` 里（`src/components/ErrorBoundary.js`），渲染异常变成可见错误 + 重试，不是白板。
2. 所有 hooks 在组件顶部，`if/else` 只出现在 `return` 之前的数据装配层。
3. `active !== true` 时，录制计数轮询、运行指标轮询全部停表。
4. 不新增 `data-dsh-workbench-toolbar`。
5. 指标轮询去抖：同一时刻只有一个 in-flight 请求，切视图要 abort。
6. 空态可操作：没 k6 → 「检测」+ 安装命令；没浏览器 → 说明；没场景 → 「录制第一个场景」。

### 7.5 左栏（需要顺手改的一处）

`App.js` 里左栏是写死的 `Tree`。性能视图下场景列表才是导航对象，建议：

```js
view === 'perf' ? h(PerfSide, {...}) : h(Tree, {...})
```

代价：`test/client-structure.test.js` 与 `test/render.test.js` 需要同步更新断言。保守回退方案：左栏不动，性能面板内部做「列表 + 详情」两栏（窄屏自动叠成一栏），零回归风险但界面更挤。

---

## 8. 从方案文档到代码：移植清单、必须修正的三处、与 xgents 的对齐

### 8.1 直接照搬的部分

| 方案文档资产 | 落到 | 形态 |
|---|---|---|
| `har-capture.ts`（393 行） | `lib/perf/recorder.js` | **整份移植**（`HarCaptureManager` 的构造函数只吃 `getCdp: () => CdpClient`，依赖面很窄）：5 个 `Network.*` 事件 + 守卫 + 截断 + OPTIONS 去重 + 重定向拍平，去 TS 类型、传输层换成全局 WebSocket |
| `har-to-script.ts`（598 行，9 阶段） | `lib/perf/harToScript.js` | 纯函数流水线，签名 `(har, options) => { script, stats, correlations, todos, warnings }`。**注意**：源件只处理 XHR/Fetch，本模块默认还采 `Document`，须按规范 C10.6 增加「页面打开步骤」分支，否则 Document 会进参数绑定、产出假参数 |
| `summary-reader.ts` + `ndjson-parser.ts` | `lib/perf/summary.js` | 只读 summary，不重算百分位；ndjson 只喂实时计数 |
| `installer.ts`（183 行，仅当要做一键安装） | `lib/perf/installer.js` | 解析顺序 + SHA256 校验 + per-user 安装目录 |
| `exit-codes.ts`（113 行） | `lib/perf/exitCodes.js` | 常量表 + `classifyExit`，见 §6.3 |
| `k6-report.ts`（待新建 300–400 行） | `lib/perf/report.js` | 纯函数，输入 summary + meta，输出 Markdown |

**移植 vs 重写的判断线**：凡是「踩过坑才定下来的规则」（事件映射、退出码语义、解析顺序、REST 停止优先），一律移植并保留原始注释里的原因；凡是「与本仓契约相关」（错误码、路径、并发上限、面板文案）一律按本仓规则重写。

### 8.2 必须修正的三处

**① `--summary-export` 的形状不是常量。**
→ **已被实测修正**：见实现规范 §5.3（C7）。三件事与原判断不同：① 指标字段是扁平的不是 `values` 嵌套；② `--new-machine-readable-summary` 会换成完全不同的顶层结构；③ `thresholds` 的布尔值是「已突破」而不是「通过」。报告生成器必须走形状归一化层，见规范 §5.3。

**② 实时指标与优雅停止都依赖 REST API，但它在 Windows 上没有信号替代。**
`-a/--address` 在 v2.2.0 仍可开启。Windows 上 `child.kill()` 拿不到 `SIGINT` 语义，直接杀进程会丢掉 `--summary-export`。
→ **做法**：优先 `PATCH /v1/status { stopped: true }` 让 k6 自己收尾并写 summary；超时未退出才 kill，并在报告里标「非优雅停止，指标可能不完整」。
→ **xgents 已把这条路走通**（`k6/driver.ts` 顶部注释与实现），三条结论直接照抄：① REST 监听**由 driver 分配** 127.0.0.1 端口，不占默认 6565；② 优雅停止优先 REST `stopped:true`，Windows 的 SIGINT 仅作兜底；③ 后台句柄并发上限 2。
→ **P0 探针**：验证 v2.2.0 的 REST 路径与 PATCH 语义，记录 `/v1/status` 与 `/v1/metrics` 的真实返回。

**③ 报告第 6 节的「压测过程事件」不能只靠 REST 快照。**
长压测中途面板可能关掉、宿主可能忙。指标采样由**服务端**定时写 `events.jsonl`（1 s 一行），面板只读不采——否则「关掉面板就没有曲线」，而用户恰恰会在压测时切走。

### 8.3 报告章节（沿用方案文档 §5.5，补两处）

在原有 7 章基础上补：

- 第 1 章「执行概览卡」加一行 **脚本指纹**（脚本内容 hash + 生成时间），否则两轮报告无法判断是不是同一份脚本。
- 第 7 章「边界声明」自动填充本次实际情况（VU/时长/是否单机/是否检出 WS/是否优雅停止），而不是打印一段固定文案——固定文案会被读者当装饰跳过。

### 8.4 与 xgents-desktop 的对齐：对齐语义，不对齐 action 数量

xgents 的浏览器能力比 AgentBro 多 12 个文件（约 2250 行），k6 套件 16 个文件（约 3340 行）。**"要不要对齐"不是二选一**，按「会不会导致两台机器行为不一致」分三档：

**Tier 1 · 必须对齐**（同一台机器上，xgents 与 AgentBro 给出的结论必须一致，否则用户不知道该信谁）

| 项 | 源文件 | 抄什么 |
|---|---|---|
| HAR 采集映射 | `browser/har-capture.ts` | 5 个事件的职责分工、真实状态码取 `responseReceivedExtraInfo`、body 在 `loadingFinished` 抓、req 128KB / resp 256KB 截断、OPTIONS 只留首条、重定向拍平 `_redirectCount` |
| k6 执行语义 | `k6/driver.ts` | REST 端口由 driver 分配、优雅停止优先 REST、后台句柄并发上限 2、ndjson 只喂实时计数 |
| 退出码分类 | `k6/exit-codes.ts` | 103/105 = 主动停止（不是失败）；其余按 Go 常量表，**不要凭记忆写** |
| k6 解析顺序 | `k6/installer.ts` | 显式配置 → env → PATH → 安装目录，取最高版本 |

**Tier 2 · 建议跟进但本模块不依赖**：`performance_metrics`（页面级指标）、`coverage-collector`、`browser-profiler`、`diff-url` / `browser-diff`、`snapshot-script`、`playbook-engine`。它们在 AgentBro 的二期池里，与压测无关，不要借这次一起做。

**Tier 3 · 明确不对齐**：`webcontents-cdp-client`（Electron webview 承载，AgentBro 需要宿主 IPC 桥，spec 已列二期）、vision/captcha、`meta.agent_config`（spec 永久裁剪）。这些是**能力本体的差异**，不是欠账。

一句话：这次要对齐的是 **4 个文件里的规则**，不是 102 个 action。

### 8.5 与 dsh-browser-hub 的边界：一处需要同步修改的结论

现状取证：

- `dsh-browser-hub` 的浏览器层是 xgents 的移植，`launcher.js`（330 行）与 `cdp-client.js`（173 行）都在，端口约定改成 9333。
- 但 `har-capture.ts` **没有移植**——`actions.js:120` 起的 `Network.enable` 只收集 `{url, method, status}` 给诊断面板用，没有 header / body / timing / cookie。
- `docs/browser-hub-migration-spec.md:601` 的二期池里明确列着「**har 采集（start/stop_capture）**」与 `performance_metrics / coverage_* / profiler_* / recording_*`。也就是说：**这不是"要不要对齐"的新问题，而是既定的二期项被性能模块提前触发了。**

因此本方案落地时，必须同步一个结论，否则会变成两份实现：

> **AgentBro 侧的 HAR 采集只做一份。** 由 wikihub 性能模块先落地 `lib/perf/recorder.js`，同时把 browser-hub 二期池里的 `start_capture/stop_capture` 标注为「已由 wikihub 承接」；如果将来 browser-hub 也需要给 agent 用这套能力，**复用同一份事件映射规则与 conformance fixture**（同一份 CDP 事件序列 → 期望 HAR），而不是再写一遍。

反过来，**不建议**为了这个模块去把 browser-hub 从 71 个 action 补到 102 个：那 31 个里与本模块相关的只有 har 采集一项，其余是 diff / profiler / coverage / playbook / emulate 系列，属于另一条产品线。

当「录制」真的成为两个产品共用能力时（触发条件：browser-hub 也要对 agent 暴露 `start_capture`），才值得抽一个共享纯函数包；现在抽包要额外发布一个包、多一个版本单元，为 393 行代码不划算。

---

## 9. 分阶段落地

| 阶段 | 范围 | 产出 | 验收 | 量级 |
|---|---|---|---|---|
| **P0 探针** | 不开 UI，先确定外部契约 | k6 summary 两种形状 fixture、REST 语义记录、Edge CDP 抓包最小闭环（一次真实 HAR） | 三份证据进 `docs/` | 0.5 天 |
| **P1 骨架** | rail 入口、`PerfPanel` 空态、`/perf/env`、`perf-spec` 解析与 lint | 能看到「性能测试」并知道环境是否就绪 | 无 k6 时禁用按钮并给命令；有 k6 时显示版本 | 1 天 |
| **P2 录制** | 移植 `har-capture.ts` 的映射 + 录制状态轮询 + HAR 落盘 + 脱敏 + 7 天清理 | 点开始 → 在 Edge 里登录下单 → 停止 → HAR 条数与 Top 主机正确 | 人工走一遍真实流程，HAR 含登录 POST；与 xgents 同一份事件序列产出同结构 HAR（conformance fixture） | 1.5 天 |
| **P3 转换** | 9 阶段流水线 + TODO 确认 UI + `k6 inspect` 校验 | 从 HAR 得到可读脚本 + 待确认清单 | 生成的脚本 `k6 inspect` 通过；TODO 清单包含一次性凭据与路径参数 | 2 天 |
| **P4 执行** | runner + 冒烟门 + 场景参数 + 实时指标 + 急停 | 冒烟 1VU/30s 全绿；加压到 50VU 能看实时曲线并能停 | 冒烟未绿时服务端拒绝 load 模式 | 1.5 天 |
| **P5 报告** | summary → md + 面板渲染 + 导出到库 + 归档 | 报告 7 章齐全，数字与 summary 一致 | 用 fixture summary 断言每个数字 | 1 天 |
| **P6 工具** | `wikihub_perf_*` + 审批门 + 技能说明 | agent 能独立走完「录→转→压→报」 | 工具入口在无 turn 时 deny、有 turn 时弹审批 | 1 天 |

合计约 **8.5 人日**（不含真实环境联调与返工）。

**建议的裁剪**：如果只想先看到东西，P0+P1+P5 可以先做——用一份已录好的 HAR（手工放进去）把「转换 → 报告」跑通，录制器押后。这条路能把最大的不确定性（k6 summary 形状、报告可信度）提前暴露。

---

## 10. 测试方案

| 层 | 文件 | 断言什么 |
|---|---|---|
| 纯函数 | `test/perf-har-to-script.test.js` | 用 fixture HAR 断言：登录进 `setup()`、`${param}` 模板化、一次性凭据进 TODO、thinkTime clamp、`parse(stringify(x))` 稳定 |
| 纯函数 | `test/perf-report.test.js` | 用 fixture summary 断言每个数字、阈值 PASS/FAIL、形状探测失败时的降级文案 |
| 纯函数 | `test/perf-spec.test.js` | fence 解析、必填章节校验、`prod` 目标识别、凭据字面量拒绝（照 `lintEnvSpec` 的做法） |
| 对齐 | `test/perf-har-conformance.test.js` | 同一份 CDP 事件序列（从 xgents 录制样本裁剪而来）→ 与 xgents `har-capture` 同结构的 HAR；让「两份实现是否等价」可验证，而不是靠读代码 |
| 执行 | `test/perf-runner.test.js` | 用**假 k6**（一个 node 脚本，打印预设 JSON 并可选延迟退出）覆盖：正常结束、阈值失败(exit 99)、超时、优雅停止、中断恢复 |
| 契约 | `test/http.test.js` 扩展 | 新路由的 401/403/409/503 映射 |
| 面板 | `test/mount.test.js` 扩展 | 数据到达后的**第二帧**（空态→有数据）不崩 |
| 结构 | `test/client-structure.test.js` 扩展 | hooks 全在顶层、无第二个 toolbar 标记、`active:false` 时无定时器 |

**假 k6 是这套测试的关键**：CI 上不能装 k6，而 runner 的失败路径（exit 99、超时、僵尸）恰恰是真实故障最集中的地方。做法是 `PERF_K6_PATH` 可注入，测试指向 `test/fixtures/perf/fake-k6.mjs`。

---

## 11. 风险登记

| 风险 | 影响 | 处置 |
|---|---|---|
| **`client.js` 只剩 ~91 KB 预算** | 面板写大一点就构建失败 | 不引图表/状态库；`maxClientBytes` 若要提必须单独评审并给出 gzip 后数字 |
| k6 不在 CI、用户机器版本不一 | 报告数字不可比 | 报告头部写 k6 版本；`summary.js` 形状探测；显式最低版本 |
| Windows 无 SIGINT | 非优雅停止丢 summary | REST PATCH 优先 + 超时 kill + 报告标注 |
| 录制中用户操作了目标站以外的页面 | HAR 混入无关域 | 转换阶段 host-normalize + 主 host 白名单；录制停止时把「Top 主机」摆在用户面前让他确认 |
| 宿主中途退出，浏览器与 k6 变孤儿 | 残留进程、残留 tmp profile | `state.json` 记 pid；启动清扫；profile 目录用 `browser-hub-profile-*` 前缀可被统一清理 |
| 包职责扩张（知识库 → 知识库 + 压测） | 后续维护与文档漂移 | 明确本模块边界写进 README；不把 k6 生态（分布式、Operator）引进来 |
| 单机负载发生器打满压测机 | 把「压测机瓶颈」误判成「服务端瓶颈」 | 报告边界章固定写；P4 之后可选加本机 CPU 采样到 `events.jsonl` |

**本期明确不做**（与方案文档一致，避免评审时被追问）：分布式压测、WebSocket/SSE 压测脚本生成、账号池、跨轮趋势对比图、TruClient 式浏览器级回放。

---

## 12. 决策记录（2026-11-08 已定）

| # | 问题 | 决策 | 影响 |
|---|---|---|---|
| 1 | 入口位置 | **WikiHub rail 内**（第 11 项） | 否决"宿主工作台列表=新包"分支；§5 D7 的两个备选只剩一个 |
| 2 | k6 分发 | **只探测本机**（含手填路径） | 否决随包分发与自动下载；`installer.ts` 的下载逻辑**不移植**，只借它的解析顺序 |
| 3 | 数据落点 | 按推荐：场景进库、产物进 `.llm-wiki/perf/` | 无改动 |
| 4 | 复用程度 | 按推荐：绑定 flow / case / environment | 无改动 |
| 5 | 命名 | **不改**，仍为「知识库」 | 否决改名；语义分类改由 rail 分隔线承担（详见规范 C14） |
| 6 | HAR 采集归属 | 按推荐：wikihub 承接，browser-hub 二期项标注已承接 | 无改动 |

第 1、2、5 条已写进实施规范（`docs/wikihub-perf-implementation-spec.md` §12 与 C5.0 / C14），**实施阶段不再讨论**。
