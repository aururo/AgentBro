# WikiHub 性能测试模块 · 实施规范 v1.9

> 依据：`docs/wikihub-perf-module-plan.md` v0.1（决策记录）+ 本规范的端到端审核
> 审核方式：真机实测 k6 v2.2.0（`D:\k6\k6.exe`）+ 两个仓库源码核对（AgentBro / xgents-desktop）
> 性质：**规范**（normative）。第 3–8 章是契约，实施与评审都以它为准；与方案稿冲突时以本文件为准。
> 条款编号：**只追加、不复用**。被引用的条款号一经发布不再改号，新条款以小数序号插入（如 `C5.0`）。
> 状态：**v1.9（2026-11-09，P0–P3 已实施）**。三项产品决策已定（见 §12），可直接开工。

## 变更摘要

### v1.9（P3 转换实施，三处链路修正）

P3 用**真实录制的 HAR**（`test/fixtures/perf/har-sample.json`，login + 列表 + 数值路径 + 重复 POST + 第三方像素）做输入，生成的脚本用**真实 `k6 inspect`** 验证通过。三个问题都出在"阶段之间"：

- **F-26**：P2 的脱敏把 `Authorization` 整个值替换成 `<redacted:len=N>`，**转换器因此看不出它是 Bearer**，生成的脚本把占位符当字面量发出去——永远登录不上。改为"保留结构、只抹秘密"：`Bearer <redacted:len=N>`、`sid=<redacted:len=N>; Path=/`。
- **F-27**：登录请求体里的 `"password":"<redacted>"` 若原样保留，脚本同样登不进。改为渲染成 `${__ENV.PERF_PASSWORD}`——既不上盘明文，也给了明确的注入点。
- **F-28**：`res.json('token')` 对 `{data:{token}}` 返回 null（xgents 的写法）。改为在响应 JSON 里走路径找 token，发出 `res.json('data.token')`，否则 setup 会静默给出 undefined 令牌，所有 check 失败且原因不可见。

### v1.8（P2 录制实施，三处实测修正）

P2 用**真实 Edge**跑通了端到端抓包（headless 仅用于冒烟，产品路径仍有头），期间抓到三个只有真机才会暴露的问题：

- **F-23**：CDP 的 `responseReceivedExtraInfo` **先于** `responseReceived` 到达，而后者为安全省略 `set-cookie`。原实现无条件用后者覆盖头，**登录 Cookie 直接丢失**——下游关联全断。改为"收到 ExtraInfo 后不再用 responseReceived 覆盖头"。
- **F-24**：`Page.navigate` 返回时导航**只是开始**，`Target.getTargetInfo` 仍报 `about:blank`。pageUrl 必须在 `Page.frameNavigated`（主帧）里更新，否则每条录制的元数据都写着 about:blank。
- **F-25**：Windows 上浏览器进程未退出时删 profile 会失败，而 `rm` 的错误被吞 → **每次录制都留下一个 GB 级 profile**。改为关闭后等待 `exited`（≤3s）再删。

实测证据（本机）：Document + Fetch 各 1 条；`authorization` → `<redacted:len=23>`；请求体 `password` → `<redacted>`；响应 `set-cookie` → `<redacted:len=15>`；`pageUrl` 正确；profile 已删除。测试 626/626。

### v1.7（P0/P1 实施，含两处实测修正）

实施 P0（契约层）与 P1（骨架）时又抓到两条外部事实，已回写契约：

- **F-21**：Windows 的 `k6 version` 输出是 `k6.exe v2.2.0`（带扩展名），规范示例与直觉写法的 `k6 v2.2.0` 解析失败——探测因此把"装了 k6"判成"未找到"。C5.0 补解析规则。
- **F-22**：`PATH` 上的 k6 不能只交给 spawn 的裸名解析，否则面板显示 `k6.exe`，用户看不出它来自哪。改为展开 `PATH` 得到绝对路径。

P1 实测量化：`client.js` 725,697 → **739,474（+13,777 B）**，预算 60,000 B，余量 79,726 B。测试 597/597。

### v1.6（评审追问：多场景怎么录）

C10.7 定义了混合场景怎么**跑**，但没定义它怎么**产出脚本**。三处会直接卡死：

- **在 mix 页点录制会被拒绝**（它没有自己的业务流程），但原文没写，实现时可能真去开浏览器；
- **合并由谁触发、用哪版子脚本**没定义，而 `POST /perf/script` 现在强制要 `recId`——mix 页根本没有 recId；
- **k6 只允许一个 `setup()`**，多个子脚本合并必然撞车，规则必须先定（合并登录、指标重编号、每场景独立 base）。

补 C10.8 + 改 C10.3/C10/C10.4/C16，加 T13/A15。

### v1.5（需求变更：支持 mixed scenario）

产品要求纳入多场景按比例混合。**已用真机把三个关键假设全部验证**（附录 B），据此补 C10.7 + C1/§6.1/§10/§11：

- 多 `exec` 场景可用，两个 `constant-arrival-rate` 并行时速率互不干扰（实测 10/s → 10.17/s，5/s → 5.25/s）。
- **自定义 Trend 可挂阈值**，且违反时同样 exit 99 —— 每场景 SLA 不需要新机制。
- **`dropped_iterations` 只有全局值**（实测 247 条），无法定位到场景 → 每场景达成率必须由生成的脚本自己计数（`scn_<n>_iters`），全局值只作交叉证据。
- 由此引入第三个结论状态 **`INVALID`**：负载没打上去 ≠ 服务端不达标，不能判 FAIL。

### v1.4（评审追问：混合页面场景）

规范没有定义**采集范围**（哪些 resourceType 进 HAR），也没声明**多场景混合**的边界，导致"能不能压混合页面"只能靠猜。补 C10.6 + 非目标一条：

- 采集范围默认值成文：Document / XHR / Fetch 采，静态资源不采，WebSocket 只检出。并定义 Document 条目在转换时的特殊处理（独立"页面打开"步骤，不参与参数绑定）。
- §1 非目标显式加入"多业务场景按比例混合（mixed scenario）"，并写清将来要做的形状与前置条件，避免反复讨论。

### v1.3（评审追问：录制浏览器）

规范只写了"Chrome/Edge + 独立 profile"，没写**用哪一个、能不能接管已开的浏览器、profile 什么时候删**。补 C10.5 一条契约 + meta 两个字段：

- 选择顺序（显式配置 → Chrome → Edge）、禁止 attach 模式及其三条理由、端口取用规则（为什么不用 9333/9222、为什么冲突可重试而 k6 不可）。
- profile 生命周期：正常停止即删、失败回滚删、`keepProfile` 调试开关保留 7 天、崩溃后随启动清扫删除。
- `meta.json` 增 `browser.product`（CDP `/json/version` 的 Browser 字段）与 `browser.profileKept`，报告边界章据此写明录制环境。

### v1.2（评审追问补漏）

评审追问「录制开始如何触发」，暴露规范只定义了接口与并发、**没有定义启动时序**。补 3 条契约、1 条路由、1 条验收引用：

- **C10.3 录制启动序列**：三个触发入口、5 项前置条件、8 步时序（含「先挂事件再导航」硬约束）、失败回滚、幂等。
- **C4.1 `record/meta.json` 契约**：C3 早已引用"见 C4"，但 C4 只定义了 run 的两个文件——悬空引用，现补齐。
- **C10.4 分段标注与 `groups` 回写**：`perf-spec.groups` 与 `txn_<idx>_duration` 依赖分段标注，但"标注怎么来、怎么落进 groups"原本没有条款，R5 的修复其实是断链的。
- C10 路由表新增 `POST /perf/record/label`；A2 改为引用 C10.3 的时序。

### v1.1（评审修订）

评审共提 11 项意见，全部处置，逐条见 §0.3。改动分布：9 处契约（C4 / C5.0 / C10 / C10.1 / C12 / C13 / C16 / §6.1 / §8）、1 处结构（§6.1 归位）、1 处跨文档（决策记录里的否决标注）。

最重的两项：

1. **k6 版本策略**（C5.0）——原定 `>=0.49.0` 硬门槛是拍的数字，只在 v2.2.0 实测过。改为**能力优先**：版本只作建议（`minVersion` + `verifiedUpTo`），拦截交给 `k6 inspect`、exit 106、summary 形状探测。
2. **报告章节契约**（§6.1）——原文只在 P5/A6/A7 里提到"7 章"，没有章节定义。现补齐每章的数据来源、缺失时的降级文案，以及 `verdict` 判定规则。

**未改动的部分**：产品决策（§12）、外部工具实测结论（§0.1 R1–R7）、模块边界与文件预算（§3）、验收条目 A1–A11（仅 A11 措辞对齐 C14）。
**证据**：无实现代码改动；包测试 544/544 通过；4 份 summary fixture 的形状与 `thresholds` 语义终检通过。

---

## 0. 审核结论

本轮把方案稿里**依赖外部工具行为的假设**逐条拿真机验证了一遍。7 处不成立，其中 3 处会导致报告出反的结论或空表，必须在写代码前定死。

### 0.1 修正项

| ID | 方案原文 | 实测证据 | 判定 |
|---|---|---|---|
| R1 | 报告读 `metrics.<name>.values` | `--summary-export` 的指标字段是**扁平**的：`http_req_duration` 的键直接是 `min/max/avg/med/p(90)/p(95)/thresholds`，**没有 `values` 层** | 方案错误。改用归一化层（§5.3），同时兼容旧版的 `values` 嵌套 |
| R2 | 把 `thresholds` 的布尔值当「是否通过」 | 全部达标时 `{"p(95)<1000": false}`，超阈值（exit 99）时 `{"p(95)<0.001": true}` | **布尔是 `true` = 已被突破（失败）**。按直觉写会**把每条判定反过来** |
| R3 | 未提 `--new-machine-readable-summary` | 加该 flag 后顶层变成 `{version, metadata, config, results}`，`metrics` 消失 | 默认**不启用**；启用需独立解析分支。老版本 k6 不认此 flag 会启动失败 |
| R4 | 实时指标「K6Stats 轮询 REST」或「ndjson 采样」 | REST `/v1/metrics` 一次 3,112 B 返回 18 个指标，每个带 `sample`；`--out json` 跑 2 秒产生 **150,406 行** | 定稿：**只轮询 REST**。ndjson 在本项目禁用于采样 |
| R5 | 报告「事务明细」= 按 k6 group 切片出每接口 p95 | `root_group` 里**只有 checks**（passes/fails），没有任何分组耗时；`group_duration` 只有全局一个 trend | 方案不可实现。改为**生成脚本时每事务声明一个 Trend**（实测出现在 summary 里且 p95 由 k6 计算） |
| R6 | 失败率可由 `passes/fails` 推 | 0% 失败时：`"http_req_failed":{"passes":0,"fails":16010,"value":0}` | `passes/fails` 语义与直觉相反，**只能读 `value`** |
| R7 | 优雅停止「超时才 kill」 | REST `PATCH stopped:true` → exit **103**，且 `--summary-export` **仍写出**（4,408 B） | 明确映射：103/105 → `stopped`，且报告可正常生成 |

### 0.2 审核确认成立（不改）

- 人控录制 + 独立临时 profile（干净录制环境；不复用 browser-hub 实例）。
- 冒烟门放在服务端，不只是按钮置灰。
- 场景进库、产物不进库（HAR 含凭据，不能进会被搜索/导出的目录）。
- 不静态依赖 `dsh-browser-hub`（未安装时不能白屏）。
- `client.js` 预算复核：当前 **725,697 B / 上限 819,200 B**，余量 **93,503 B**。

### 0.3 评审意见处置表（v1.1）

| # | 评审意见（问题） | 处置 | 落点 |
|---|---|---|---|
| F-01 | §1 写「agent 侧 5 个工具」，C12 实际列 6 个 | 统一为 6 个 | §1 |
| F-02 | C12 引用 `lib/tools.js:959-973`，实际 `ask` 返回在 971 | 改 `955-971`，并写明该段三步（suppressed 检查 / grant / 返回 ask） | C12 |
| F-03 | C16 称「缺一语言 `i18n.test.js` 会失败」，**读源码后不成立**（该测试只验证缺键回显键名） | 措辞改正，并新增 parity 测试条目（新增规则，不是既有规则） | C16、§10 T10 |
| F-04 | C5.0 的 `>=0.49.0` 门槛无实测依据，按版本号硬拦会误伤旧版 | 改为能力优先：版本为建议值，`env` 增 `minVersion`/`verifiedUpTo`；P0 增「旧版形状验证（能借到就做）」 | C5.0、C10、§9 P0 |
| F-05 | 报告 7 章没有章节定义，P5/A6/A7 引用悬空 | 新增章节契约：每章数据来源 + 缺失降级 + `verdict` 规则 | §6.1 |
| F-06 | 录制与压测可跨类并行，HAR 与指标会互相污染；原文只写了同类单飞 | 保留并行但要求双向 `warn` 事件 + 面板黄条 | C10.1 |
| F-07 | `/perf/report` 在报告未生成时返回什么未定义 | 明确 `{ready:false}` 200，面板继续轮询 | C10 |
| F-08 | 「导出到库」的脚本副本可能含固定值凭据（TODO=固定值） | 导出副本必须替换为环境变量引用并列清单；原脚本留在 `script/` 不清理 | §8、C10 |
| F-09 | `state.json` 只有示例值，没有 status 枚举 | 补 6 个状态并指向 C6 映射 | C4 |
| F-10 | 路由带 `site` 参数，但没有归属校验规则 | 补 `E_SITE_MISMATCH`（沿用既有码，不新造） | C13 |
| F-11 | §6.1 被插到「§7 客户端契约」内部；决策记录里仍有「改名」「随包分发」等与冻结决策矛盾的措辞 | 6.1 归位到 §6 末尾；决策记录补「已否决」标注 | 结构、plan §5 D2/D7 |
| F-12 | **录制如何触发没有条款**：只有 `POST /perf/record` 与单飞规则，没有"点了按钮之后按什么顺序做什么"，"先开抓包再导航"这条踩过坑的硬约束只存在于验收项 A2 | 新增 C10.3：3 个入口、5 项前置、8 步时序、失败回滚、幂等 | C10.3、A2 |
| F-13 | C3 写「`record/<recId>/meta.json` 见 C4」，但 C4 只有 run 的 state/events | 新增 C4.1：录制元数据完整 schema（含 operator/startedBy/flowLabels/stats） | C4.1 |
| F-14 | R5 的修复依赖「每事务一个 Trend」，而 groups 来自分段标注；但标注 API 与「标注→`perf-spec.groups`」的回写规则都不存在，链条断开 | 新增 C10.4 + `POST /perf/record/label`；明确幂等回写与未标注退化 | C10.4、C10 |
| F-15 | **录制用哪个浏览器没定义**：只写「Chrome/Edge + 独立 profile」。四件事悬空：两者都在时用谁、能否接管用户已开的浏览器、浏览器调试端口怎么取、profile 何时删（原文只在失败回滚里说"删"）。本机 Chrome 默认路径不存在、只有 Edge，这条不定就会导致"开发机能录、用户机器不能录" | 新增 C10.5：选择顺序 + 禁止 attach + 端口规则 + profile 生命周期；`meta.json` 增 `browser.product`/`profileKept` | C10.5、C4.1 |
| F-16 | **采集范围没有契约**：只有 `captureBodies` 一个布尔，没说 Document / 静态资源 / WebSocket 收不收。直接决定"混合页面"能不能成立——页面导航若不被采集，脚本里就无法回放"打开页面"这一步 | 新增 C10.6：resourceType 默认表、排除规则、Document 的转换差异、第三方主机过滤与计数 | C10.6、C10 |
| F-21 | Windows 的版本横幅是 `k6.exe v2.2.0`，规范示例只写 `k6 v2.2.0`；按示例实现导致本机装了 k6 仍判"未找到" | C5.0 写明两种横幅都要接受；测试补真实 Windows 串 | C5.0 |
| F-23 | CDP 事件顺序：ExtraInfo 先到且带完整头，`responseReceived` 后到且省略 set-cookie；无条件覆盖会丢掉登录 Cookie | 收到 ExtraInfo 后不再用 responseReceived 覆盖响应头；测试补"真实到达顺序"用例 | C10.6 |
| F-24 | `Page.navigate` 返回时导航未提交，此时读目标 URL 得到 `about:blank` | pageUrl 改由 `Page.frameNavigated` 主帧事件更新，`getTargetInfo` 仅作兜底 | C4.1 |
| F-26 | 脱敏抹掉了 Authorization 的方案标识，转换器无法识别 Bearer，脚本发出占位符 | 脱敏保留方案与 cookie 名（`Bearer <redacted:N>`、`sid=<redacted:N>`），只丢秘密 | §8、C10.6 |
| F-27 | 登录体里的 `<redacted>` 会让脚本无法登录 | 渲染为 `${__ENV.PERF_<FIELD>}`，并在 TODO 里点名 | C10.6 |
| F-28 | `res.json('token')` 在 `{data:{token}}` 上返回 null（照抄 xgents 的写法） | 走 JSON 路径找 token，产出 `res.json('data.token')` | C10.6 |
| F-25 | Windows 上进程未退出时删 profile 失败且被吞，每次录制残留 GB 级目录 | 关闭后等待 `exited`（≤3s）+ 120ms 宽限再删；回滚与 abort 路径同样处理 | C10.5 |
| F-22 | `PATH` 命中后若把裸名交给 spawn，面板会显示 `k6.exe`，无从判断来源 | 展开 `PATH` 为绝对路径候选（顺序仍 config→env→PATH→安装目录） | C5.0 |
| F-20 | **实现 P0 时发现规范漏了一条外部事实**：`--new-machine-readable-summary` 的输出**不含 thresholds**，键名也从 `p(95)` 变成 `p95`。C7 原文只写了"顶层不同"，没说这两点，报告会显示"0 项被突破" | C7 补两条实测差异 + 第 3 章的降级文案；归一化层做键名改写与 `checks` 合成 | C7、§6.1 |
| F-19 | **多场景怎么录没有链路**：C10.7 只定义怎么跑。在 mix 页点录制会被真去开浏览器（没有"禁止录制"的前置检查）；`POST /perf/script` 强制要 `recId`，而 mix 页没有；多份子脚本各带 `setup()`，k6 只允许一个，合并规则缺失 | 新增 C10.8（5 步工作流 + 7 条合并规则 + 当前脚本指针）+ C10.3 加禁止项 + 路由 `recId` 可选 + C10.4/C16 同步；加 T13/A15 | C10.8、C10.3、C10、C16 |
| F-18 | **需求变更**：产品要求支持 mixed scenario（v1.4 曾列为不做） | 纳入范围并补 C10.7：速率语义、脚本形状、指标命名、VU 推导、达成率检测、`INVALID` 状态；真机验证 3 个假设（附录 B） | C10.7、C1、§6.1、§10 T12、A14 |
| F-17 | 「是否支持混合场景」无答案：§1 非目标没列 mixed scenario，实现凭空决定 | §1 显式列为不做，并写清将来形状（`mix[]` + 多 exec + 每场景 Trend）；同时禁止用多进程并行冒充混合 | §1、C10.1 |

**处置原则**（本版新增，供后续评审沿用）：

- **能实测就不猜**：涉及外部工具的结论必须有真机证据（附录 A）；无证据的数字降级为"建议值"并写明验证缺口。
- **不新造机制**：错误码、页面类型、日志格式、单飞语义一律复用仓库既有约定；新增只在既有约定表达不了时发生。
- **诚实降级优先于漂亮输出**：数据缺失时渲染"未采集 / 缺失说明"，禁止输出 0 或空表。

---

## 1. 范围

**做**：录制（人控）→ 转换（HAR→k6 脚本 + TODO 确认）→ 执行（冒烟 + 阶梯压测 + 实时指标 + 急停）→ 报告（Markdown + 判定 + 边界声明）；面板四段视图 + 一个 rail 入口；agent 侧 6 个工具；**多场景按比例混合（mixed scenario，v1.5 起）**。

**不做**：分布式压测、WebSocket/SSE 压测脚本、账号池、跨轮趋势图、浏览器级回放（TruClient）、接口级延迟明细（理由见 R4 实测：ndjson 体量不可接受）。

**混合场景的边界**：支持"多业务流程按比例混合成一次运行"，但只支持**一次运行内混**——不支持跨机分布式、不支持把混合场景再嵌套混合（子场景必须是单一流程）。实现形状与判定规则见 C10.7；比例未真正达成的运行会判 `INVALID` 而不是 `FAIL`（详见 §6.1 的 verdict 规则）。

**明确不做（决策约束）**：
- **不下载、不安装、不分发 k6**。模块只探测本机已有可执行文件，并把"没装"讲清楚（§12 决策 2）。
- **不新建工作台包**。功能落在 WikiHub 面板内（§12 决策 1）。
- **不改 `app.title`**，工具栏仍显示「知识库」；分类靠 rail 分隔线承担（§12 决策 3）。

---

## 2. 术语

| 词 | 含义 |
|---|---|
| 场景（scene） | 库内一张 `perf/` 页面，含 `perf-spec` fence |
| 录制（recording） | 一次人控操作产出的 HAR + 元数据 |
| 脚本（script） | 由录制转换出的 k6 脚本 + 关联/TODO 清单 |
| 运行（run） | 一次 k6 进程执行，产出 `state.json` / `events.jsonl` / `summary.json` |
| 事务（transaction） | 按录制分段标注切出的 `group`，报告里一行 |
| 接口（endpoint） | 脚本里的单个请求（`name` 标签）。v1 只在脚本里可见，报告不单列 |

---

## 3. 文件布局与预算

### 3.1 新增服务端文件（`packages/dsh-desktop-wikihub/lib/perf/`）

| 文件 | 职责 | 纯函数 | 行数上限 |
|---|---|---|---|
| `yaml.js` | 受限 YAML 子集解析（嵌套映射 / 块序列 / 内联 `[a,b]` `{k:v}` / 注释），**不引解析依赖** | ✅ | 180 |
| `spec.js` | `perf-spec` fence 抽取 + 校验（照 `lib/testSpec.js` 的风格） | ✅ | 200 |
| `env.js` | k6 / 浏览器探测、版本解析、路径校验（C5.0） | ❌（跑 `k6 version`） | 160 |
| `paths.js` | 产物目录解析与越界校验（复用 `contract.js` 的 `isWithin`） | ✅ | 90 |
| `recorder.js` | 起浏览器 + CDP 抓包 → HAR（移植 xgents `har-capture.ts`） | ❌（有进程） | 480 |
| `harToScript.js` | 9 阶段流水线 | ✅ | 620 |
| `mix.js` | 权重→速率、指标命名、VU 推导、达成率计算（C10.7） | ✅ | 220 |
| `summary.js` | summary 归一化（§5.3） | ✅ | 200 |
| `exitCodes.js` | 退出码表 + `classifyExit` | ✅ | 60 |
| `report.js` | summary + meta → Markdown | ✅ | 400 |
| `runner.js` | spawn k6 + REST 轮询 + 优雅停止 + 状态机 | ❌（有进程） | 520 |
| `store.js` | 产物读写、7 天清理、pid 台账 | ❌（有 IO） | 240 |
| `service.js` | 编排层：录/转/跑/报 的用例函数（HTTP 与工具共用） | ❌ | 300 |

**硬规则**：`lib/perf/*` 之间只允许通过函数调用耦合；`node:child_process` 只允许出现在 `env.js`（跑 `k6 version`）、`recorder.js`（起浏览器）、`runner.js`（起 k6）三个文件里。这条靠单测断言（§10 T7）。

### 3.2 新增客户端文件（`packages/dsh-desktop-wikihub/src/`）

| 文件 | 职责 |
|---|---|
| `components/Perf.js` | 面板根（四段视图 + 轮询 + ErrorBoundary 内层） |
| `components/PerfSide.js` | 左栏场景列表（替代本视图的 Tree） |
| `lib/perfApi.js` | 全部 perf 网络调用（沿用 `api.js` 的错误归一化） |
| `lib/perfChart.js` | 三个手写 SVG 图（VU 曲线 / 趋势线 / 排序条），无依赖 |

### 3.3 包体预算（两级，别混）

**两个数字不同，报数时必须说清是哪一个**（v1.9 曾把两者混为一谈）：

| | 值 | 含义 |
|---|---|---|
| 构建硬上限 | `800 × 1024 = 819,200 B` | `scripts/build.mjs` 的 `maxClientBytes`，超了直接构建失败 |
| 基线（未做 perf） | 725,697 B | 十个既有视图 + markdown 渲染 + 图谱 + 430 条 i18n + 55 KB CSS |
| **硬上限余量** | 基线时 93,503 B → 当前 **64,781 B** | 这是"还能往包里放多少" |
| **本模块自定额度** | ≤ 60,000 B | 防止一个模块吃掉全部余量，留空间给后续需求 |
| 本模块已用 | 28,722 B（P1 13,777 / P2 6,700 / P3 8,245） | 剩余额度 31,278 B |

- 报"余量"一律带上下文：**要么说"距构建上限还有 64,781 B"，要么说"自定额度还剩 31,278 B"**。只写"只剩 31 KB"会被读成即将构建失败，而实际不是。
- 禁止引入任何图表/状态/日期库。一次误引（如 Chart.js ~200 KB）就吃掉三倍额度。
- `styles.css` 新增 ≤ 220 行（当前 perf 段 3,620 B / 约 130 行），全部 `--dsw-alias-*` token，全部以 `.dsh-wikihub-root` 起头。
- 参考：`client.js` 原始 754,419 B，gzip 196,489 B / brotli 162,753 B。上限约束的是**原始字节**，不是传输体积。

---

## 4. 数据契约

### C1 · `perf-spec` fence

页面 `perf/<场景名>.md` 的正文必须含一个 ```yaml 围栏，围栏内含 `perf-spec:` 键（与 `test-spec` / `env-spec` 同风格，便于 lint 与检索）。

```yaml
perf-spec:
  version: 1
  target: test                  # test | staging | prod
  baseUrl: https://test.example.com
  envRef: perf/环境-测试          # 可选；与 baseUrl 二选一（都填以 baseUrl 为准）
  flowRef: flows/下单主流程       # 可选，指向业务流程页
  caseRefs: [cases/ORDER/TC-ORDER-03]
  loadModel:
    mode: stages                # stages | constant | mix
    stages: [{ duration: 1m, target: 10 }, { duration: 3m, target: 50 }, { duration: 1m, target: 0 }]
    vus: 50                     # mode=constant 时用
    duration: 5m
    # --- mode=mix 时改用下面三组（与上面互斥）---
    # mix:
    #   - { sceneRef: perf/浏览商品, weight: 60 }
    #   - { sceneRef: perf/下单主流程, weight: 30 }
    #   - { sceneRef: perf/搜索, weight: 10 }
    # iterationsPerSec: 15      # 总目标迭代速率（不是 VU 数）
    # ramp: { up: 1m, hold: 3m, down: 1m }   # 可选；有则用 ramping-arrival-rate
    # maxVus: 200               # 可选，默认由 C10.7 的公式推导
  thresholds:                     # 全局阈值（跨场景）
    http_req_duration: ['p(95)<500']
    http_req_failed: ['rate<0.01']
  # mixThresholds:                # 可选，mode=mix 时的每场景阈值
  #   - { sceneRef: perf/下单主流程, expr: 'p(95)<800' }
  thinkTime: normalized         # recorded | normalized | none
  groups:
    - { id: 1, label: 登录 }
    - { id: 2, label: 提交订单 }
  confirmPhrase: ORDER-PROD-OK  # target=prod 时必填
  notes: 单机负载发生器，未测分布式
```

**校验规则（`spec.js` 必须全实现，返回 `{ok, errors[]}`）**

| 规则 | 失败表现 |
|---|---|
| `version` 必须为 `1` | `unsupported spec version` |
| `target` 必须是三个枚举之一 | `unknown target` |
| `target: prod` 时 `confirmPhrase` 必填且 ≥ 8 字符 | `prod requires confirmPhrase` |
| `baseUrl` 若存在必须是 `http(s)://` | `baseUrl must be http(s)` |
| `mode=mix` 时 `baseUrl` 可省略（各子场景自带） | — |
| `loadModel.mode=stages` 时 `stages` 非空、≤ 6 段 | `stages must be 1..6` |
| 任意 `duration` 合计 ≤ 30m | `total duration exceeds 30m` |
| `target` 峰值 ≤ 200 | `vus exceeds 200` |
| `mode=mix` 时：`mix` 2–6 项、`weight` 均为正整数且合计 > 0 | `mix needs 2..6 entries` |
| 每个 `mix[].sceneRef` 页面存在，且其 `perf-spec.loadModel.mode !== 'mix'` | `mix scene must be a single flow`（禁嵌套） |
| `mode=mix` 且 `iterationsPerSec` ∉ [1,1000] | `iterationsPerSec out of range` |
| `mode=mix` 时不能同时给 `stages` / `vus` | `loadModel is ambiguous` |
| `thresholds` 条目 ≤ 8 | `too many thresholds` |
| `mixThresholds` 条目 ≤ 8，`sceneRef` 必须是 `mix` 里出现过的 | `unknown mix scene in mixThresholds` |
| 正文出现 `password:` 后跟引号字面量 | `credentials must be pointers, not literals`（照 `lib/testSpec.js:60` 的既有规则） |

### C2 · 页面类型

`lib/pageKinds.js` 新增：

```js
'perf-scenario': ['目标与场景', '业务路径', '负载模型', 'SLA 阈值', '数据与账号', '边界'],
```

必填章节缺失时由既有 lint 报出，不新增机制。

### C3 · 产物目录

```
<root>/.llm-wiki/perf/<siteId>/
├── record/<recId>/har.json          # HAR 1.2（已脱敏）
├── record/<recId>/meta.json         # 录制元数据（见 C4）
├── script/<sceneSlug>/<scriptId>.js
├── script/<sceneSlug>/<scriptId>.meta.json
├── run/<runId>/state.json
├── run/<runId>/events.jsonl
├── run/<runId>/summary.json
└── run/<runId>/report.md
```

- `recId = rec_<yyyyMMddTHHmmss>_<4hex>`；`runId = r_<yyyyMMddTHHmmss>_<4hex>`；`scriptId = 脚本内容 sha256 前 7 位`。
- 所有路径经 `paths.js` 解析并做包含性校验，`..` 一律 `E_OUTSIDE`。
- `record/` 与 `run/` 采用**懒清理**：任何一次录制开始前、任何一次运行开始前，删掉 `mtime` 超过 7 天的同级目录；不装定时器（宿主可能长期不退出，定时器更费）。

### C4 · `state.json` / `events.jsonl`

```json
{
  "runId": "r_20261108T2140_3f9a",   // status 枚举：queued | running | finished | failed | stopped | interrupted（映射见 C6）
  "site": "ecommerce-test",
  "sceneId": "perf/下单主流程",
  "scriptId": "3f9a1c2",
  "mode": "smoke",
  "status": "running",
  "pid": 21344,
  "restPort": 51234,
  "argv": ["run", "..."],
  "startedAt": 1762600000000,
  "finishedAt": null,
  "exitCode": null,
  "degraded": false,
  "error": null,
  "mix": [
    { "n": 1, "sceneId": "perf/浏览商品", "label": "浏览", "weight": 60, "rate": 9,
      "expectedIters": 2700, "actualIters": 2681, "delivery": 0.993 }
  ]
}
```

`events.jsonl` 每行：`{ "seq": 1, "at": 1762600000123, "phase": "run.sample", "level": "info", "message": "…", "data": { … } }`

| phase | 何时 | data |
|---|---|---|
| `run.start` | 进程已起 | `{pid, restPort}` |
| `run.sample` | 每 1s | `{tps, p95, failedRate, vus, count}`（取自 `/v1/metrics`） |
| `run.threshold` | 结束时 | `{breached: ['p(95)<500']}` |
| `run.stop.request` | 用户/工具要求停 | `{via:'rest'|'signal'}` |
| `run.exit` | 进程退出 | `{exitCode, outcome}` |
| `report.written` | 报告落盘 | `{bytes}` |

`seq` 单调递增；面板轮询用 `since` 游标（与 `lib/ingest.js` 的读法一致，含 `nextSeq`）。

### C4.1 `record/<recId>/meta.json`

C3 的目录里引用了这个文件，但此前只有名字没有形状。契约如下（`recorder.js` 写、`harToScript.js` 读，两边都不得增删字段前不改本节）：

```json
{
  "recId": "rec_20261108T2150_ab12",
  "site": "ecommerce-test",
  "sceneId": "perf/下单主流程",
  "operator": "human",
  "startedBy": { "kind": "panel", "sessionId": null },
  "startedAt": 1762600200000,
  "stoppedAt": 1762600452000,
  "baseUrl": "https://test.example.com",
  "browser": { "kind": "edge", "path": "<abs>", "product": "Edg/131.0.2903.112", "pid": 21344, "port": 9321, "profileKept": false },
  "capture": { "bodies": true, "maxReqBody": 131072, "maxRespBody": 262144 },
  "redacted": true,
  "flowLabels": [{ "at": 1762600238000, "label": "登录" }],
  "stats": {
    "entries": 218,
    "xhr": 204,
    "documents": 14,
    "excluded": 26,
    "topHosts": [{ "host": "test.example.com", "count": 204 }]
  }
}
```

| 字段 | 语义 | 谁写 |
|---|---|---|
| `operator` | 固定 `'human'`——录制语义就是人操作，写死可让报告与审计一眼区分"人录"和"agent 代走" | recorder |
| `startedBy.kind` | `panel` / `tool` / `http`，对应 C10.3 的三个入口；`sessionId` 仅 `tool` 有 | router |
| `flowLabels[].at` | 标注时刻（ms），**与 HAR entry 的 `startedDateTime` 同一时间基准**，转换时按它切段 | label 路由 |
| `browser.product` | CDP `/json/version` 的 `Browser` 原值；报告边界章用它说明录制环境（C10.5） | recorder |
| `browser.profileKept` | 调试开关 `keepProfile` 是否生效；为 `true` 时停止响应要回传 profile 路径 | recorder |
| `stats` | 停止时算出，用于面板摘要卡与报告边界章；`excluded` 是命中排除规则被丢弃的条数（C10.6），不静默消失 | recorder |
| `redacted` | 是否做了凭据脱敏；为 `false` 时导出到库必须拒绝并提示先脱敏 | recorder |

---

## 5. k6 外部契约（实测固定）

### C5.0 · k6 可执行探测（决策 2：只探测本机）

**顺序固定，命中即止**：

1. 配置值 `config.json` 的 `perf.k6Path`（用户在「环境」里手填）
2. 环境变量 `PERF_K6_PATH`（仅测试与高级用户；生产代码不得依赖它写默认值）
3. `PATH` 里的 `k6` / `k6.exe`
4. 常见安装目录：`D:\k6\k6.exe`、`%LOCALAPPDATA%\k6\k6.exe`、`%ProgramFiles%\k6\k6.exe`、`~/.k6/k6`、`/usr/local/bin/k6`

**校验**：命中后跑 `<path> version`，解析首版横幅。**Windows 上输出是 `k6.exe v2.2.0`（带扩展名），macOS/Linux 是 `k6 v2.2.0`**——解析必须同时接受两种，否则装了 k6 也会被判未找到（实测踩过）。解析失败视为**未找到**（把错误路径当成可用路径，会让后面每一步都报"启动失败"，非常难查）。

**版本策略（修正）**：**按能力判断，不按版本号硬拦**。本规范只实测过 v2.2.0；任何"最低版本"数字都未在旧版上验证过。因此：
- `/perf/env` 返回 `minVersion:'0.49.0'`（**建议值**）与 `verifiedUpTo:'2.2.0'`（唯一实测值），面板据此提示"建议使用 2.x"，**不阻断**；
- 真正的拦截来自能力探测：`k6 inspect` 失败、`-a` 端口起不来（exit 106）、summary 形状不可识别（C7 → 报告降级并明示）。失败信息必须指向具体能力，而不是"版本太低"。
- 若 P0 能借到 0.4x–1.x 的二进制，补一次形状实测并把结论写回本节；借不到就维持现状（提示不拦截）。

**浏览器侧同理**：`config.json` 的 `perf.browserPath` 与 `PERF_BROWSER_PATH`（测试/高级用户）优先于自动探测；探测结果同样不缓存。

**写入**：手填路径经 `POST /api/wikihub/perf/env` 校验通过后才写入 `config.json`（`writeConfig` 已做一层合并，`perf` 作为新 section）。写入前必须做一次真实 `version` 调用，校验失败不落盘。

**禁写**：不得把探测结果缓存进 `config.json`（机器换了、用户删了 k6，缓存会让面板说"已就绪"然后失败）。每次 `/perf/env` 都重新探测，探测本身 < 200 ms。

### C5 · 命令行

```
<k6.exe> run <script.js>
  --summary-export <abs>/summary.json
  --quiet
  -a 127.0.0.1:<port>
  [--stage <dur>:<target> ...]        # 有 stages 时；逐段重复
  [--vus N --duration <dur>]          # mode=constant 时
  [--iterations N]
  [-e KEY=VALUE ...]
```

实测确认：

- `--stage 1s:3 --stage 1s:0` **覆盖**脚本内 `options`（观测 `vus_max=3`，进程约 2 s 收尾）。
- `--vus 2 --duration 1s` 同样覆盖（观测 `vus_max=2`）。
- `--quiet` 只关进度条，**不关**文本摘要；禁止使用 `--no-summary`（报告兜底要用它）。
- `-a` 端口冲突时 k6 退出码 **106**（`CannotStartRESTAPI`）→ 向上映射为 `E_PERF_BUSY`，不重试换端口（安静换端口会让"急停打到别的进程"）。

**端口分配**：由 runner 在 `bind(0)` 拿一个空闲端口后立刻释放再交给 k6（存在极小竞态，捕获 106 即报忙）。禁止使用固定 6565。

### C6 · 退出码 → 状态

| exit | 名称 | status | 是否生成报告 |
|---|---|---|---|
| 0 | Success | `finished` | 是 |
| 99 | ThresholdsHaveFailed | `finished` + `degraded=false`，报告结论 `FAIL` | 是 |
| 103 | ScriptStoppedFromRESTAPI | `stopped` | 是（实测有 summary） |
| 105 | ExternalAbort | `stopped` | 是（有则用，无则标缺失） |
| 100 / 101 / 102 | setup / teardown / 整体超时 | `failed` | 若 summary 存在则生成，否则不生成 |
| 106 | CannotStartRESTAPI | `failed` + `E_PERF_BUSY` | 否 |
| 107 / 108 | 脚本异常 / 中止 | `failed` | 否 |
| 110 | MarkedAsFailed | `failed` | 是 |

**99 与 103 都不是"工具失败"**：不得写成 `failed`，不得弹错误提示，不得让报告缺失。

### C7 · summary 归一化（`summary.js`）

输入可能是三种形状，**先探测再归一**，报告层只见归一化结果：

| 形状 | 判别 | 顶层 |
|---|---|---|
| A 扁平（v2.x 默认） | `raw.metrics` 且指标对象里有 `avg`/`p(95)` | `{ root_group, metrics }` |
| B 嵌套（旧版 / xgents 假设） | `raw.metrics` 且指标对象里有 `values` | `{ root_group, metrics }` |
| C 新机器可读 | `raw.results` 存在 | `{ version, metadata, config, results }` |

归一化目标：

```js
{ shape: 'flat'|'nested'|'new', k6Version: string|null,
  metrics: { [name]: { type:'trend'|'counter'|'rate'|'gauge',
                        stats: { [key:string]: number },   // 原样键名，含 'p(95)'
                        breached: { [expr:string]: boolean } } },
  groups: Array<{ name, path, checks: {passes, fails} }>,
  notes: string[] }
```

字段映射（形状 A 实测）：

| 指标类型 | stats 键 | 备注 |
|---|---|---|
| trend | `min, max, avg, med, p(90), p(95)` … | **无 count**；总数取 `http_reqs.count` |
| counter | `count, rate` | `http_reqs.rate` 即全程平均 TPS |
| rate | `value` | `passes/fails` **禁止使用**（语义反直觉，见 R6） |
| gauge | `value`（`vus`）、`value`（`vus_max`） | |

形状 C 的字段与 A/B 不同，实测 `results.metrics[]` 每项是 `{contains, name, type, values}`：

| 形状 C 字段 | 映射到 |
|---|---|
| `results.metrics[].name` | 指标名 |
| `results.metrics[].type` | 类型 |
| `results.metrics[].values` | 统计值；`http_req_failed.values = {matches, rate, total}`，失败率取 **`rate`**；trend 的 `values` 直接用；counter 取 `count`/`rate` |

**形状 C 的两个实测差异**（v1.6 补）：① 统计键是 `p90`/`p95`（无括号），归一化时改写为 `p(90)`/`p(95)`；② **不含任何 threshold 结果**——`breached` 为空，报告第 3 章必须显示「阈值明细不可用（以 exit code 判定）」，而不是"0 项被突破"。counter 在该形状里也只有 `count`、没有 `rate`。

**失败降级**：识别不出形状时，`shape='unknown'`，`notes` 追加 `指标源格式不可识别（k6 <version>）`；报告对应章节渲染该说明，**不得输出 0**。

**已固化的 fixture**（本轮实测直接落库，T1 用它）：

```
packages/dsh-desktop-wikihub/test/fixtures/perf/
├── summary-flat.json               # 形状 A，阈值全部达标（thresholds:*: false）
├── summary-new.json                # 形状 C
├── summary-threshold-failed.json   # 形状 A，阈值被突破（thresholds:*: true，真实 exit 99）
└── summary-aborted.json            # 形状 A，REST 急停（真实 exit 103，summary 仍写出）
```

### C8 · REST 契约（实测）

| 调用 | 观测结果 |
|---|---|
| `GET /v1/status` | `{"data":{"type":"status","id":"default","attributes":{"status":7,"paused":false,"vus":2,"vus-max":2,"stopped":false,"running":true,"tainted":false}}}` |
| `PATCH /v1/status`，body `{"data":{"type":"status","id":"default","attributes":{"stopped":true}}}`，`content-type: application/vnd.api+json` | `200`，随后进程退出码 **103**，summary 正常写出 |
| `GET /v1/metrics` | `data` 数组，18 项，每项 `{id, type, attributes:{type,contains,sample}}`；`http_reqs.sample={count,rate}`、`http_req_duration.sample={avg,max,med,min,'p(90)','p(95)'}`、`http_req_failed.sample={rate}`、`vus.sample={value}` |

**停止流程（强制顺序）**：`PATCH stopped:true` → 最多等 **10 s** → 未退出则 `child.kill()` → 再等 5 s → 仍未退出记 `failed` 并保留 pid 供后续清理。任何情况下都要记录用的是哪条路径（`events.jsonl` 的 `run.stop.request.data.via`）。

### C9 · 实时采样

- 频率：**1 s**，只在 `status=running` 时。
- 来源：`GET /v1/metrics`（3 KB/次），**禁止** `--out json`（实测 2 s 生成 150,406 行，长跑会写出数 GB）。
- 落点：`events.jsonl` 的 `run.sample`；同时维护内存里最近 300 个采样点供面板一次取回。
- 采样失败（REST 未就绪/连接失败）：静默跳过该轮，连续 5 次失败记一条 `run.sample.degraded`（level=warn），不影响主流程。

---

## 6. 服务端契约

### C10 · HTTP 路由

全部注册在 `lib/http.js` 的 `route()`（一 path 一注册，按 method 分发）。所有响应 `cache-control: no-store`。

| 方法 | 路径 | 入参 | 成功 | 主要失败 |
|---|---|---|---|---|
| GET | `/api/wikihub/perf/env` | — | `{k6:{found,path,version,source,reason?,minVersion,verifiedUpTo}, browser:{found,kind,path}, limits:{maxVus,maxDurationMs,retentionDays}}` | — |
| POST | `/api/wikihub/perf/env` | `{k6Path}` | `{k6:{...}}`（校验通过才写 `config.json`） | `E_PERF_NO_K6`(503) 路径不可用 |
| GET | `/api/wikihub/perf/scenes` | `?site=` | `{scenes:[{id,title,updatedAt,target,lastRun:{runId,status,verdict,at}\|null}]}` | `E_NO_SITE` |
| POST | `/api/wikihub/perf/record` | `{site, sceneId, options?:{captureBodies,redact,resourceTypes?,excludeUrlPatterns?}}` | `202` `{recId, browser:{kind,port}, startedAt}` | `E_PERF_NO_BROWSER`(503)、`E_PERF_BUSY`(409) |
| GET | `/api/wikihub/perf/record` | `?site=` | `{active, recId, entries, elapsedMs, topHosts:[{host,count}], bodyCount}` | — |
| POST | `/api/wikihub/perf/record/stop` | `{site,recId}` | `{recId, harPath, entries, durationMs, topHosts, redacted:true}` | `E_PERF_RECORD_IDLE`(409) |
| POST | `/api/wikihub/perf/record/label` | `{site,recId,label}` | `{labels:[{at,label}]}`（追加到 meta.json，C10.4） | `E_PERF_RECORD_IDLE`(409)、`E_INVALID`（空/重名） |
| POST | `/api/wikihub/perf/script` | `{site, sceneId, recId?, options?:{thinkTime,groupBy,loginMode}}`（`recId` 仅普通页必填；mix 页由 `mix[]` 决定输入） | `{scriptId, stats, correlations[], todos[], warnings[], preview}`；mix 页额外 `{mixed:true, members:[{n,sceneId,scriptId}]}` | `E_PERF_RECORD_IDLE`、`E_INVALID`、`E_PERF_SCRIPT_INVALID`（子场景缺脚本，C10.8） |
| GET | `/api/wikihub/perf/script` | `?site=&sceneId=` | `{scriptId, source, meta:{correlations,todos,warnings}}` | `E_NOT_FOUND` |
| POST | `/api/wikihub/perf/script/confirm` | `{site,sceneId,scriptId,resolutions:[{key,action,binding?}]}` | `{scriptId, remainingTodos}` | `E_INVALID`（未识别的 key/action） |
| POST | `/api/wikihub/perf/validate` | `{site,sceneId}` | `{ok, errors[]}`（`k6 inspect` 结果归一化） | `E_PERF_NO_K6` |
| POST | `/api/wikihub/perf/run` | `{site,sceneId,mode:'smoke'\|'load', overrides?:{stages?,vus?,duration?}}` | `202` `{runId, restPort, mix?:[{n,sceneId,weight,rate,expectedIters}]}`（仅 mix 场景） | `E_PERF_BUSY`(409)、`E_PERF_PROD_BLOCKED`(403)、`E_PERF_SMOKE_REQUIRED`(409)、`E_PERF_SCRIPT_INVALID`(422) |
| GET | `/api/wikihub/perf/run` | `?site=&runId=` | `{run:{...state}, live:{tps,p95,failedRate,vus,count,series:[...]}, events:{rows,nextSeq}}` | `E_NOT_FOUND` |
| POST | `/api/wikihub/perf/run/stop` | `{site,runId}` | `{requested:true, via}` | `E_NOT_FOUND` |
| GET | `/api/wikihub/perf/runs` | `?site=&limit=` | `{runs:[{runId,sceneId,mode,status,verdict,startedAt,finishedAt}]}` | — |
| GET | `/api/wikihub/perf/report` | `?site=&runId=` | `{ready:true, markdown, chapters:{overview,metrics,thresholds,transactions,smoke,events,boundary}, degraded, notes[]}`；尚未生成时 `{ready:false}`（200，面板继续轮询） | `E_NOT_FOUND`（runId 不存在） |
| POST | `/api/wikihub/perf/report/export` | `{site,runId}` | `{path}`（写进库的 `perf/报告-<runId>.md`：报告 + **脱敏脚本副本**） | `E_READONLY` |

**并发规则（C10.1）**：全局**单飞** —— 同一时刻最多 1 个录制 + 1 个运行；同类第二个请求返回 `E_PERF_BUSY` 并带 `current:{kind,id}`。理由：同一台机器上并行压测，两个负载发生器互相抢 CPU，数字本身没有意义（这一条比"支持并发"重要）。

**跨类并行（录制 + 压测同时进行）**：允许，但**必须双向警告**——压测打目标系统时录制的 HAR 反映的是"被压状态下的系统"，反之录制流量也会混进压测数字。服务端在两边各写一条 `level:warn` 事件（`record.overlap` / `run.overlap`），面板在两段视图顶部各显示一条黄条；不阻止（用户可能刻意想录"高负载下的表现"）。

**冒烟门（C10.2）**：`mode:'load'` 时服务端检查该场景最近一次 `mode:'smoke'` 的运行：
- 不存在 → `E_PERF_SMOKE_REQUIRED`；
- 存在但 `status!=='finished'` 或 `verdict!=='PASS'` → `E_PERF_SMOKE_REQUIRED`；
- 脚本 `scriptId` 与冒烟时不同 → `E_PERF_SMOKE_REQUIRED`（改了脚本必须重冒烟）。
面板置灰只是提示，判定在服务端。

### C10.3 · 录制启动序列（F-12）

**三个入口，同一执行核**（都进 `service.startRecording`，不允许各自实现规则）：

| 入口 | 形式 | 说明 |
|---|---|---|
| 面板 | 录制段「开始录制」按钮 | 主路径。浏览器缺失时禁用；**k6 缺失不禁用**（录制不需要 k6） |
| agent | `wikihub_perf_record {sceneId, action:'start'}` | 对话里驱动 |
| HTTP | `POST /api/wikihub/perf/record` | 调试与脚本直调 |

**前置条件（任一失败即拒绝，不做部分启动）**

| 条件 | 失败 |
|---|---|
| 场景页存在且 `perf-spec` 校验通过（C1） | `E_INVALID` + `errors[]` |
| 能解析出起始 URL：`baseUrl` 优先，否则 `envRef` 指向的环境页；两者皆无 | `E_INVALID: scene has no baseUrl` |
| 浏览器可探测（Chrome/Edge） | `E_PERF_NO_BROWSER`(503) |
| 当前无进行中的录制 | `E_PERF_BUSY`(409) + `current:{kind:'record',id}` |
| 场景的 `loadModel.mode !== 'mix'` | `E_INVALID: mixed scene has no own flow`（混合场景只做合并，不录制，C10.8） |
| 不需要 k6 | —（最常见的误判） |

**时序（顺序是硬约束：第 3–6 步颠倒会丢登录请求，即决策记录 R2 的事故）**

| # | 动作 | 失败处理 |
|---|---|---|
| 1 | 懒清理超期目录（C3） | 忽略——清理失败不该挡住录制 |
| 2 | 生成 `recId`、建目录、写初始 `meta.json`（C4.1） | 中止并返回 `E_NOSPACE` / `E_INTERNAL` |
| 3 | 选浏览器并 `spawn`（选择顺序、端口、profile 路径见 C10.5）：有头、`--remote-debugging-port=<port>`、`--user-data-dir=<tmp>/perf-rec-<recId>`、**起始页 `about:blank`** | 回滚：删目录 |
| 4 | 轮询 `/json/version` 等 CDP 就绪（≤ 10 s） | 回滚：kill 进程 + 删 profile + 删目录 → `E_PERF_NO_BROWSER` |
| 5 | `Target.attachToTarget` → `Network.enable` | 回滚：同 4 |
| 6 | **挂 5 个 `Network.*` 处理器之后才导航**到起始 URL（不自动登录、不填表） | 回滚：同 4 |
| 7 | 写状态（`active=true`、`browser.pid`、`port`）→ 返回 `202 {recId, browser, startedAt}` | — |
| 8 | 面板开始 1 s 轮询 `GET /perf/record`；`active !== true` 时停表（C15.2） | — |

**为什么第 3 步必须是 `about:blank`**：浏览器恢复会话、首页跳转或预连接都会在第 6 步之前发出请求；那批请求要么丢失、要么记在"还没开始录"的状态里。让它先停在空白页，是唯一能保证"第一发请求也被录到"的做法。

**幂等与并发**：并发 start 用**一把内存锁**判定（不是"先查后建"——那是竞态的经典写法）；重复 start → `E_PERF_BUSY` 且**不新建 recId**；同一 `recId` 重复 stop → 第二次 `E_PERF_RECORD_IDLE`。

**回滚语义（强约束）**：第 3–6 步任一失败，磁盘上不得留下 `record/<recId>/`，也不得留下浏览器进程与临时 profile。测法见 §10 T11。

### C10.4 · 分段标注与 `groups` 回写（F-14）

录制产出的是一条连续时间轴，事务划分靠人点标注——这条链此前是断的（`perf-spec.groups` 与 `txn_<idx>_duration` 都依赖它，却没人负责生成）。

**录制中**：`POST /perf/record/label {site, recId, label}`（面板「分段标注」按钮）。服务端把 `{at: Date.now(), label}` **追加**到 `meta.json.flowLabels` 并返回全部标注。`label` 为空、或与上一条同名 → `E_INVALID`（同名会直接生成重复 group）。

**转换时**（`harToScript`）：按 `flowLabels[].at` 把 HAR entries 切成连续段，一段一个 group。

| 情形 | 行为 |
|---|---|
| 场景页 `perf-spec.groups` 为空 | **回写**：label 文本作 `name`，`id` 从 1 递增；`flowLabels` 保留在 meta 里供审计 |
| 已有 groups 且与本次标注不一致 | **不覆盖**，返回 `warning: groups-mismatch` 并列出差异，由人决定（同一场景可能分次录不同分支） |
| 没有任何标注 | 退化为整段一个 group（`txn_1_1_duration`，name 用场景标题），`warnings` 明确写「未分段，事务表只有一行」——不假装有事务划分 |

**mix 页不标注**：混合场景页没有自己的录制，它的 `groups` 由各子场景聚合而来（`子场景label · 事务label`，C10.8），不接受 `POST /perf/record/label`。

**脚本生成**：每 group 一个 `group('<label>', …)` 块 + 一个 `Trend('txn_<n>_<m>_duration')`（单场景 `n=1`，见 C10.7 命名表），直接对接 §6.1 的事务明细；指标名用序号而非中文 label（k6 指标名的字符集限制，且中文名在导出 JSON 里做键更容易踩坑）。

### C10.5 · 录制浏览器与 profile 生命周期（F-15）

**用哪个**：只起**专用实例**，顺序固定、命中即止——

| # | 来源 | 备注 |
|---|---|---|
| 1 | `config.json` 的 `perf.browserPath` | 用户在「环境」里手填，经 `version`/启动校验才落盘 |
| 2 | `PERF_BROWSER_PATH` | 测试与高级用户；T11 用它注入假浏览器 |
| 3 | **Chrome**（按探测表逐个路径试） | 优先：CDP 参考实现，协议行为最贴文档 |
| 4 | **Edge** | 兜底：同为 Chromium，CDP 完全一致；Windows 上几乎必然存在 |
| — | 都没有 | `E_PERF_NO_BROWSER`(503)，文案要写清"装一个 Chrome 或 Edge" |

**明确不支持 attach 模式**（接管用户已经开着的浏览器）。这不是"暂未实现"，是三条硬理由：
1. 调试端口常开是持续暴露面，用户不会为了一次压测去改启动参数；
2. 真实 Cookie / 登录态会混进 HAR，"测试凭据"的前提被破坏，脱敏责任说不清；
3. 用户 profile 里的扩展、缓存、企业策略都会改变请求序列，录出来的脚本不可复现。

需要复用自己的登录态时，正确做法是在专用实例里手动登录一次——录制的整个过程本来就是这个动作。

**窗口模式**：必须有头（`headless: false`）。不提供无头录制：本项目是"人操作、工具录"，无头等于把这件事变成 agent 代走（方案文档明确不选 C 模式）。因此 P2 的验收只能在有图形界面的机器上做，CI 只能跑 T11 的假浏览器。

**调试端口**：`bind(0)` 取一个空闲端口后立即释放再交给浏览器。**不用 9333**（browser-hub 固定占用，撞上会让 agent 的浏览器会话和录制互相抢），**不用 9222**（xgents-desktop 保留）。与 k6 不同：浏览器端口冲突只是"起不来"，重试换端口**是安全的**（不会像 k6 的 REST 端口那样导致"急停打到别的进程"），所以允许换端口重试一次；k6 侧仍按 C5 直接报 `E_PERF_BUSY`。

**profile 生命周期**（`--user-data-dir=<tmp>/perf-rec-<recId>`）：

| 时点 | 行为 |
|---|---|
| 正常 stop | **删除**。产物是 HAR，profile 没有复用价值，留着会累积数 GB Cookie 与缓存 |
| 第 3–6 步失败 | 删除（C10.3 的回滚语义） |
| 宿主崩溃/退出 | 启动清扫：扫 `<tmp>/perf-rec-*` 中无对应 `active` 状态的目录并删除，与 run 的 pid 清扫同批做 |
| 调试开关 `options.keepProfile: true` | 保留，交 C3 的 7 天懒清理回收；`meta.browser.profileKept=true` 并在停止响应里提示路径 |

**记录环境事实**：CDP 就绪后读 `/json/version` 的 `Browser` 字段（如 `Edg/131.0.2903.112`）写入 `meta.browser.product`。报告第 7 章「边界声明」引用它——同一份脚本在 Chrome 与 Edge 上录制的差异，事后要能查到。

### C10.6 · 采集范围与「混合页面」的转换差异（F-16）

**录什么**（逐条按 CDP `Network.requestWillBeSent.type` 判定）：

| resourceType | 默认 | 转换产物 | 理由 |
|---|---|---|---|
| `Document` | ✅ 采 | 独立的「页面打开」步骤：`http.get(url)` + `check(status < 400)`；**不参与** body 差异检测、不生成参数绑定 | 页面导航是用户旅程的一步；不采就无法回放"打开某页" |
| `XHR` / `Fetch` | ✅ 采 | 走完整 9 阶段（模板化 / 去重 / 关联 / TODO） | 业务接口的主战场 |
| `Script` `Stylesheet` `Image` `Font` `Media` `Manifest` | ❌ 不采 | —（若手动放宽，只生成 `GET` 且标注"静态资源，通常不该压"） | 静态资源走 CDN；采了脚本里 90% 会是图片 |
| `WebSocket` / `EventSource` | 👁 只检出 | 不生成代码 | 压测脚本不支持 ws（§1 非目标），但**必须**在报告第 7 章写「检出 N 条 WS/SSE 连接，脚本未覆盖」 |
| `data:` / `blob:` | ❌ 丢弃 | — | 无网络语义 |

**排除规则**：URL 正则 `excludeUrlPatterns`，默认覆盖埋点与心跳（`beacon`、`collect`、`heartbeat`、`/ping`、`1x1.gif`）。被排除的条目计入 `meta.stats.excluded`，不静默消失。

**主 host 过滤**：转换阶段按 `baseUrl` 的 host 做白名单；第三方主机（CDN、字体、统计）**过滤但计数**，写进 `warnings`：「过滤掉 N 条第三方主机请求」。不提示就等于隐瞒了"录制里其实有跨域调用"。

**为什么 Document 要特殊处理**：把它当普通 XHR 会让三件事出错——① body 差异检测会把两次页面 HTML 的细微差别当成"动态字段"，生成一堆假参数；② 参数绑定会试图从 HTML 里找 JSON 路径；③ 去重逻辑会把同一个页面（内容不同）当成重复请求。所以 Document 只做"打开 + 状态断言"。

**混合页面的实际支持程度**（一句话结论）：

| 你说的「混合」 | 支持？ | 说明 |
|---|---|---|
| 一次录制走多个页面、每页有各自接口 | ✅ 支持 | 页面打开 = 独立步骤，接口 = 事务；脚本里是一个连续旅程 |
| 同一流程里接口 + 页面 + 静态资源混压 | ⚠️ 部分 | 接口与页面都压；**静态资源默认不压**（可手动放宽，但不建议——那是 CDN 的压测对象） |
| 多个业务流程按比例混合（mixed scenario） | ❌ 不支持 | 见 §1 的边界声明与将来的 `mix[]` 形状 |
| WebSocket / SSE 流量 | ❌ 只检出 | 脚本不生成，报告必须写明未覆盖 |

### C10.7 · 混合场景（mixed scenario）（v1.5 新增）

#### 语义：按**迭代速率**分配，不按 VU 份额

`weight` 分配的是"每秒发起多少次迭代"，不是"占多少个 VU"。原因很实在：50 个 VU 跑 200 ms 的浏览流程 ≈ 250 次/秒，同样 50 个 VU 跑 2 s 的下单流程只有 25 次/秒——按 VU 份额分，配比会偏离到十倍级。

```
rate_n = iterationsPerSec × weight_n / Σweight      （保留两位小数，下限 0.1）
```

执行器（实测可用）：

| 有无 `ramp` | executor | 说明 |
|---|---|---|
| 无 | `constant-arrival-rate` | `rate`、`timeUnit:'1s'`、`duration` |
| 有 | `ramping-arrival-rate` | `stages:[{target, duration}]`，`target` 是**速率**不是 VU |

#### 生成的脚本形状

单文件、多 `exec`，一个 `options.scenarios` 里每场景一项：

```js
import http from 'k6/http'
import { group } from 'k6'
import { Trend, Counter, Rate } from 'k6/metrics'

const BASE_1 = __ENV.BASE_1          // 每场景独立 base（C10.8），不用单一 BASE_URL
const BASE_2 = __ENV.BASE_2
// 每场景一组指标：n 与 perf-spec.mix 的下标 +1 对应
const S1 = { dur: new Trend('scn_1_duration', true), iters: new Counter('scn_1_iters'),
             reqs: new Counter('scn_1_reqs'), fail: new Rate('scn_1_fail') }
const S2 = { dur: new Trend('scn_2_duration', true), iters: new Counter('scn_2_iters'),
             reqs: new Counter('scn_2_reqs'), fail: new Rate('scn_2_fail') }

function step(S, m, base) {                // m = 事务指标组, base = 该场景的 base
  S.iters.add(1)
  const r = http.get(base + '/...')
  S.reqs.add(1)
  S.fail.add(r.status >= 400)
  m.dur.add(r.timings.duration)
}

export const options = {
  scenarios: {
    s1: { executor: 'constant-arrival-rate', exec: 's1', rate: 9, timeUnit: '1s',
          duration: '5m', preAllocatedVUs: 24, maxVUs: 72 },
    s2: { executor: 'constant-arrival-rate', exec: 's2', rate: 4.5, timeUnit: '1s',
          duration: '5m', preAllocatedVUs: 40, maxVUs: 120 },
  },
  thresholds: {
    http_req_duration: ['p(95)<500'],       // 全局
    scn_2_duration: ['p(95)<800'],          // 每场景（来自 mixThresholds）
  },
}

export function s1() { group('浏览', () => step(S1, T11, BASE_1)) }
export function s2() { group('下单', () => step(S2, T21, BASE_2)) }
```

#### 指标命名（报告解析依赖，不可随意改）

| 指标 | 类型 | 含义 |
|---|---|---|
| `scn_<n>_duration` | Trend(ms) | 场景 n 的单次迭代耗时 |
| `scn_<n>_iters` | Counter | 场景 n **实际完成**的迭代数（达成率的分子） |
| `scn_<n>_reqs` | Counter | 场景 n 发出的请求数 |
| `scn_<n>_fail` | Rate | 场景 n 的失败率（`status >= 400`） |
| `txn_<n>_<m>_duration` | Trend(ms) | 场景 n 的第 m 个事务（与 C10.4 的 group 对齐） |

单场景模式也用 `txn_1_<m>_duration`（`n` 固定为 1），保证报告解析只有一套规则。`n → label/sceneId` 的映射写进 script meta 与 `state.json.mixMap`。

#### VU 预分配（配比能不能达标的关键）

```
preAllocatedVUs_n = ceil(rate_n × p95_iterMs / 1000 × 1.5)
maxVUs_n          = max(preAllocatedVUs_n × 3, preAllocatedVUs_n + 5)
```

- `p95_iterMs` 取**最近一次冒烟**的 `iteration_duration` p95。没有冒烟值（例如首次直接跑 load，会被冒烟门挡住）就用 2000 ms 占位，并在报告里写「VU 预分配基于占位值，可能不足」。
- 用户给了 `loadModel.maxVus` 时，把它按权重拆到各场景并向上取整，作为 `maxVUs_n` 的上限。
- **预分配不足的后果是静默的**：k6 只打一条 `level=warning "Insufficient VUs…"`，仍然跑完，只是没打到目标速率。这是本设计里最需要防的失败模式。

#### 配比达成检测（强制）

```
expected_n = 目标迭代数（无 ramp：rate_n × duration_s；有 ramp：逐段梯形面积求和）
actual_n   = summary.metrics['scn_<n>_iters'].count
达成率_n   = actual_n / expected_n
```

- 任一场景 `达成率 < 0.95` → 该场景标 `underDelivered`，并在 `state.mix[].delivery` 里记录实际值与目标值；
- **run 的 `verdict` 置 `INVALID`**（不是 `FAIL`）——服务端可能完全没问题，是负载没打上去，判 FAIL 会冤枉被测系统；
- 全局 `dropped_iterations > 0` 作为交叉证据写进报告第 6 章（它只有全局值，无法定位到场景，实测 247 条时也无场景归属）；
- 冒烟模式跳过达成率检查（每场景 1 次迭代，分子恒为 1）。

#### 冒烟形状

mix 模式的冒烟用 `per-vu-iterations`，**每场景 `vus:1, iterations:1`**、`maxDuration:'30s'`：一次跑通所有 `exec`，验证的是「每个场景至少能走完一次」，不是性能。

#### scriptId 与冒烟门

合并脚本整体算一个 `scriptId`（内容 hash）。任一子场景的脚本变化都会改变合并脚本 → `scriptId` 变 → C10.2 的冒烟门自动失效、必须重冒烟。这条不需要额外机制，是 hash 的自然结果。

#### 限制（写进报告边界章）

- **全局 `http_req_duration` 是混合分布**，混合负载下它的 p95 只表示"整体 SLO"，不能用来判断某个业务；报告第 2 章必须标「混合全局」，第 4 章才是可解读的分场景数据。
- 禁止嵌套 mix（子场景必须是单一流程，C1 已在校验层拦截）。
- 禁止用多个 k6 进程并行冒充混合（C10.1 单飞）。

### C10.8 · 混合场景的录制与合并（v1.6 新增）

**结论先说：混合场景不"一次录完"，而是"分别录制 → 合并"。** 录制是人在浏览器里走一条业务流程；混合是把几条已录好的流程按比例拼成一次运行。把两个动作压成一次录制，等于让人在同一个窗口里"按 60/30/10 的比例来回走"，既不可执行也不可复现。

#### 工作流（5 步，全部在面板里完成）

| 步 | 在哪做 | 动作 | 产出 |
|---|---|---|---|
| 1 | 子场景页 A/B/C | 各自写好 `perf-spec`（各自的 `baseUrl`、`flowRef`、`groups`） | 3 个场景页 |
| 2 | 子场景页 A/B/C | 各录制一次（**各自独立浏览器实例**，C10.3） | 3 份 HAR + 3 份 meta |
| 3 | 子场景页 A/B/C | 各自转换、清 TODO、各自冒烟 | 3 份脚本，各带自己的 `setup()` 与 `txn_1_<m>` 指标 |
| 4 | 新建「混合场景页」 | 写 `perf-spec.loadModel.mode: mix` + `mix[]`（引用上面 3 个页面）+ `iterationsPerSec` | **不录制**，只声明配比 |
| 5 | 混合场景页 | 点「生成脚本」→ 合并 → 冒烟 → 加压 | 1 份合并脚本 + 1 次运行 |

**步 4 的页面不允许录制**（C10.3 的入口检查会拒绝）：`mode: mix` 的页面没有自己的业务流程，`E_INVALID: mixed scene has no own flow`。面板在这种页面上把「开始录制」换成「由 N 个子场景组成」，并列出每个子场景的脚本状态。

#### 合并规则（`mix.js` 负责，纯函数）

合并输入：`mix[]` 顺序已确定的子场景 `{ n, sceneId, scriptSource, scriptId, baseUrl, groups }`。输出：单文件脚本 + `mixMap`。

| 规则 | 说明 |
|---|---|
| **一个 `setup()`** | k6 只允许一个。把各子脚本的 `setup()` 体按顺序内联进同一个 `export function setup()`，各自的登录结果收进唯一返回对象：`{ auth1: {...}, auth2: {...} }`；各 `exec` 从 `data.auth<n>` 取用。原来子脚本里对 `setup()` 返回值的解构要同步改写成 `data.auth<n>` |
| **指标重编号** | 子脚本的 `txn_1_<m>_duration` 一律重写为 `txn_<n>_<m>_duration`；`n` 是 `mix[]` 的下标 +1。**不做前缀拼接**（如 `scn2_txn_1_m`），否则报告解析要写第二套规则 |
| **每场景独立 base** | 生成 `const BASE_<n> = __ENV.BASE_<n>`，不用单一 `BASE_URL`。允许子场景指向不同 host（跨域名压测），但报告边界章必须逐场景列出 host |
| **think time 保留在各 exec 内** | `sleep()` 不提取到公共处，否则会串味 |
| **`Trend` 实例只声明一次** | 每个 `txn_<n>_<m>_duration` 在文件顶部统一 `new Trend(...)`，exec 内引用；重复 `new` 同名指标会导致 k6 指标冲突 |
| **`groups` 聚合** | 合并脚本的 group 名用 `子场景label · 事务label`，避免两个子场景都有"登录"时 group 重名（重名会让 `root_group.groups` 互相覆盖） |
| **禁止嵌套** | 子场景的 `loadModel.mode` 不得为 `mix`（C1 已在校验层拦） |

#### 「当前脚本」的解析规则

合并读的是每个子场景的**当前生效脚本**，定义为一个指针文件：

```
script/<sceneSlug>/current.json   →   { "scriptId": "3f9a1c2", "updatedAt": 1762600000000 }
```

- 每次 `POST /perf/script` 成功产出新脚本时原子覆盖该指针；
- 合并时按指针取脚本；指针缺失或指向不存在的文件 → `E_PERF_SCRIPT_INVALID`，错误信息要指明**是哪个子场景**没有脚本；
- 任何子场景重录 → 指针变 → 合并脚本内容变 → `scriptId` 变 → 冒烟门自动失效（C10.7 的 hash 机制，无需额外处理）。

#### 接口变化

- `POST /perf/script` 的 `recId` 改为**可选**：普通页必填；`mode: mix` 页不需要（传了也忽略），由 `mix[]` 决定输入。
- 合并成功返回额外字段：`{ scriptId, mixed: true, members: [{n, sceneId, scriptId}], warnings: [] }`。
- mix 页的 `GET /perf/script` 返回合并后的脚本与 `mixMap`，面板据此把「脚本」段渲染成"合并自 N 个场景"的说明 + 每成员的脚本版本。

#### 面板上的操作顺序提示

混合场景页的「脚本」段在没有齐全子脚本时，列出缺哪几个（带跳转链接），并禁用「生成脚本」。这是**唯一**需要跨页面导航的交互，必须给出直达链接——否则用户要在左栏来回找三个页面。

### C11 · 错误码

新增进 `lib/contract.js` 的 `CODE`，并在 `lib/http.js` 的 `STATUS` 表里逐条登记（该表是唯一状态码来源）：

| 码 | HTTP | 含义 |
|---|---|---|
| `E_PERF_NO_K6` | 503 | 未找到 k6 可执行 |
| `E_PERF_NO_BROWSER` | 503 | 未找到 Chrome/Edge |
| `E_PERF_BUSY` | 409 | 已有录制/运行在跑，或 REST 端口被占 |
| `E_PERF_PROD_BLOCKED` | 403 | 目标是 prod 且未确认 |
| `E_PERF_SMOKE_REQUIRED` | 409 | 未通过冒烟（或脚本已变） |
| `E_PERF_SCRIPT_INVALID` | 422 | 脚本 `k6 inspect` 不通过 / 存在未解决的阻断型 TODO |
| `E_PERF_RECORD_IDLE` | 409 | 没有进行中的录制 |

### C12 · agent 工具

| 工具 | 参数 | 审批 | 返回 |
|---|---|---|---|
| `wikihub_perf_env` | — | 否 | 同 `/perf/env` |
| `wikihub_perf_scene` | `{sceneId, action:'read'\|'list'}` | 否 | 场景 + spec 校验结果 |
| `wikihub_perf_record` | `{sceneId, action:'start'\|'status'\|'stop'}` | 否 | 同 HTTP |
| `wikihub_perf_script` | `{sceneId, recId?, resolutions?}` | 否 | 脚本 + TODO |
| `wikihub_perf_run` | `{sceneId, mode, overrides?, allowProduction?}` | **是** | `{runId, status}` |
| `wikihub_perf_report` | `{sceneId, runId?}` | 否 | `{markdown, verdict}` |

**审批实现（必须两条都做）**：
1. `tools/pre-execute` 瀑布里只拦 `wikihub_perf_run`，返回 `{kind:'ask', reason, displayReason:{en,zh}}`（照 `lib/tools.js:955-971` 的写法——`approvalSuppressed` 检查、`approvals.grant(exec.callId)`、返回 `{kind:'ask', reason, displayReason}`，`{prepend:true}`）。
2. 工具自身再查一次 `requiresConfirm`：无开放 turn / 未组合 ApprovalService / `ctx.approval.overrideOf(session)==='never'` 三种情况下**本地 deny**，理由写进返回文案。只依赖 `ask` 会出现"面板能跑、agent 跑不了"或"静默放行"。

`prod` 目标：工具入口 `allowProduction !== true` 直接 deny（不进审批）；`allowProduction===true` 时仍需 `confirmPhrase` 与场景页一致。

### C13 · 单一执行核

HTTP 与工具都调 `lib/perf/service.js`，不得各自实现规则。以下规则只允许存在于 service：
- 冒烟门（C10.2）
- 单飞（C10.1）
- prod 拦截
- 未解决 TODO 阻断（`todos.some(t => t.severity==='block' && !t.resolved)` → `E_PERF_SCRIPT_INVALID`）
- **site 归属校验**：场景 / 录制 / 脚本 / 运行的 `siteId` 与请求的 `site` 不一致时返回 `E_SITE_MISMATCH`（沿用 0.6.16 事故定下的既有码——写错库不是校验瑕疵）

---

### 6.1 报告章节契约（P5 / A6 / A7 的判定依据）

报告共 7 章，每章的数据来源固定如下（`report.js` 逐章生成，缺数据时该章渲染"缺失说明"，禁止输出 0）：

| 章 | 内容 | 数据来源 | 缺失时 |
|---|---|---|---|
| 1 执行概览 | 结论徽标 / 目标 / 脚本指纹 / 起止与时长 / 峰值 VU / 总请求 / 总迭代 / 执行方式 | `state.json` + `metrics.http_reqs.count` + `vus_max.value` + `iterations.count` | — |
| 2 核心指标 | TPS、p95/p99、失败率、传输量（标 trend/counter/rate 口径） | 归一化 `metrics`（C7） | 该行标 `n/a` |
| 3 阈值判定 | 全局阈值 + **每场景阈值**（mix 模式）分两组列出 | `metrics.*.breached`（**true=被突破**，R2）；每场景用 `scn_<n>_duration.breached` | — |
| 4 事务明细 | **mix 模式按场景分组**，每组内列事务；单场景退化为一张表。列：请求数、p95、失败率、check 通过率，按 p95 降序 | `scn_<n>_*`（场景级）+ `txn_<n>_<m>_duration`（事务级）+ `root_group.groups[name].checks` | 该层 Trend 缺失 → 标"未采集"，不聚合到上一层 |
| 5 冒烟对照 | 冒烟 p95/失败率 vs 本轮，劣化比；**mix 模式下逐场景对比**，并注明冒烟只有 1 次迭代，只作可用性参考、不作性能基线 | 上一次 `mode:'smoke'` 的 `summary.json` | 无冒烟记录 → 标"未冒烟"（且本不该出现：冒烟门拦截） |
| 6 过程事件 | 停止路径、中途采样表、异常退出码 | `events.jsonl` | — |
| 7 边界声明 | 按本次实际自动填充（单机/优雅停止/WS 检出/脚本指纹） | `state.json` + recorder 元数据 | — |

**verdict 规则**：

| 值 | 条件 |
|---|---|
| `INVALID` | summary 形状不可识别（C7）；或 mix 模式任一场景达成率 < 0.95（C10.7）；或换场景跑完但脚本指纹与冒烟不一致（正常被门挡住，属兜底） |
| `FAIL` | 任一 `breached[expr]===true`（含每场景阈值）或 exit 99 |
| `PASS` | 其余，且 exit ∈ {0} |
| 不参与判定 | exit `103` / `105`（主动停止）；`INVALID` 时不判 PASS/FAIL——负载没打上去，判定没有意义 |

---

## 7. 客户端契约


### C14 · 导航与组件（决策 1：rail 内）

**最终 rail 顺序（11 项，不新增第二个入口）**：

```
wiki  search  graph  sources  lint  review
────────────── .whRailDivider（新增，20×1，--dsw-alias-border-l2）──────────────
logs  perf  skills  overview            [spacer]            settings
```

- `perf` 插在 `logs` 与 `skills` 之间；`IconGauge` 24 网格、stroke 1.6、`currentColor`、17px，与既有 10 项同规格。
- 分隔线只加**一条**（`review` 与 `logs` 之间），把「阅读类」与「执行类」分开。这是不成立「改标题」时的替代手段：既不迁就旧名，也不改动既有 10 项的位置。
- **不新增 `data-dsh-workbench-toolbar` 类元素**；`app.title` 保持「知识库」（§12 决策 3），本视图不出现「工作台」字样。
- `view === 'perf'` 时左栏渲染 `PerfSide`，其余视图仍渲染 `Tree`；左栏宽度/折叠/拖拽行为**不变**。
- 面板结构：场景头（标题 + 路径 + 状态徽标 + 主操作）→ 阶段切换条（复用 `.whTabs`）→ 分段内容。
- 阶段切换条状态：`1 录制 / 2 脚本 / 3 运行 / 4 报告`，完成的段显示 `✓`（`data-done="true"`）。未满足前置条件的段可点但内容为引导态。

**rail 高度校验**：11 项 × (36 + 2 gap) + 16 padding ≈ 434 px。分隔线占 9 px。工作台可视高度 < 460 px 时允许 rail 内部纵向滚动（`.whRail { overflow-y: auto }`），不得压缩按钮尺寸——`styles.css` 的注释已写明"按钮不缩，标题让位"。

### C15 · hook 与生命周期（照本仓事故约束）

1. 所有 hooks 在 `Perf.js` 顶部，`if/else` 只出现在 `return` 前的数据装配层（`App.js:559-566` 的事故记录）。
2. 轮询条件：`active === true` **且** 该段可见 **且** 有活动录制/运行。停止时 `clearInterval` + `AbortController.abort()`。
3. 同一时刻只允许一个 in-flight 请求（用 ref 记 `inFlight`），窗口切换必须 abort。
4. 面板根包 `ErrorBoundary`；渲染异常写 `render-error` 到 `client-report.jsonl`（沿用现有通道）。
5. 不新增 `data-dsh-workbench-toolbar`（全屏只能一个，`client-structure.test.js:35` 已断言）。
6. 数字显示统一 `font-variant-numeric: tabular-nums`，避免指标跳动时列宽抖动。

### C16 · 样式与文案

- 新增 class（仅这 6 组，其余复用）：
  - `.perfItem` `.perfGroup`（左栏列表）
  - `.perfHead` `.perfHeadTitle` `.perfHeadPath`（场景头）
  - `.whTabStep`（tab 内 16px 圆底数字/勾）
  - `.perfCard` `.perfDuo` `.perfBar*`（卡片与宽度条）
  - `.perfTodo`（TODO 行）
  - `.perfTable` `.perfBadge`（报告表格与判定徽标）
- 复用：`.whBtn/.whBtnPrimary/.whSeg/.whGrid/.whStat/.whLogRow/.whBanner/.whCenter/.whInput/.whDot`。
- 图表：`<svg viewBox="0 0 380 96">` 手写折线/阶梯；`color-mix` **不得**用于 SVG 呈现属性（实测不生效），用 `fill-opacity`。
- i18n：`zh` 与 `en` 同时加，键前缀 `perf.`；`nav.perf`（zh「性能测试」/ en「Performance」）。注意：**现有 `i18n.test.js` 并不校验双语键齐平**（缺键只是渲染成键名），所以新增 T10 强制 parity——这是本规范新增的规则，不是既有规则。
- **`app.title` 不动**（仍「知识库」，§12 决策 3）；`perf.` 命名空间内也不得出现「工作台」字样，避免同一面板两种自称。
- **mix 页的录制段**：不显示「开始录制」，改为「由 N 个子场景组成」+ 成员列表（场景名 / 当前脚本版本 / 状态：未录制 / 待重录 / 就绪），每行可点击跳转到该子场景（C10.8）。
- **mix 参数区**（运行段）：模式选 `mix` 时，参数表单换成「场景 · 权重 · 占比条」三列表格（2–6 行），底部显示推导出的每场景速率（如 9 / 4.5 / 1.5 次/秒）与预计 VU 分配；权重改动即时重算，不调服务端。运行中该区显示**每场景达成率**（< 95% 标黄并附「负载未打满」）。
- 注：`docs/wikihub-perf-ui-preview.html` **未包含** mix 参数区（v1.5 追加需求，预览暂未重绘），P4 落地时补一张；预览里的单场景运行段仍然有效。
- 文案纪律：环境缺失时说清缺什么 + 可复制命令；报告结论只说 `PASS/FAIL`；`99` 不叫"失败"而叫"阈值未达标"。

### C17 · 包体验收

P1 结束时记录 `client.js` 字节数并与基线 725,697 求差；> 60,000 B 时先删减（合并组件、抽公共渲染），**不得**上调 `maxClientBytes`。

---

## 8. 安全契约

| 项 | 规则 |
|---|---|
| 凭据 | HAR 写出前默认脱敏：`authorization`、`cookie`、`set-cookie` 值 → `<redacted:len=N>`；`captureBodies` 默认 true，但请求体里的 `password`/`code`/`token` 字段值同样脱敏 |
| 目录 | 录制目录权限 `0700`（POSIX）；Windows 用默认 ACL + 目录名不可猜（含 4 位随机） |
| 脚本凭据 | 脚本里的固定值凭据（TODO resolution=固定值）**允许存在**（运行需要），但「导出到库」的脚本副本必须把这些字面量替换为 `${__ENV.XXX}` 引用并在导出的 md 里列清单；不导出的原脚本保留在 `script/`（不清理，它是可复用资产，见 C3） |
| 入库 | 仅当用户点「导出到库」，且只导出**脚本 + 报告**；HAR 永不入库 |
| 目标 | `target: prod` 需 `confirmPhrase`；工具入口还需 `allowProduction:true` |
| 泄露面 | 工具/HTTP 响应里不回传 HAR 正文；`preview` 只回脚本前 200 行 |
| 日志 | `events.jsonl` 不写 URL 查询串里的 `token=`；写 URL 前做一次 `redactUrl()` |
| 保留 | 录制与运行目录 7 天懒清理（C3） |

---

## 9. 实施阶段与 DoD

| 阶段 | 交付 | DoD（可验证） |
|---|---|---|
| **P0 契约固化** | `fixtures/perf/*.json`（**已落库**）+ `har-sample.json`（待录）+ 旧版 k6 形状验证（能借到就做，借不到记录结论） | 四份 summary 能在 `summary.js` 里被正确判别（`shape` 为 `flat`/`new`/`flat`/`flat`）；`thresholds` 判定与 exit code 一致 |
| **P1 骨架** ✅ | rail 第 11 项 + 分隔线、`Perf`/`PerfSide`、`/perf/env`（GET+POST）、`/perf/scenes`、spec 校验（已含 P0） | 已达成：k6 缺失时给出安装命令与手填入口、浏览器缺失才禁用录制；`client.js` 增量 **+13,777 B**（预算 60,000） |
| **P2 录制** | `recorder.js`（移植）+ 状态轮询 + 脱敏 + 懒清理 | 真实流程走完，HAR 含登录 POST；`authorization` 已脱敏；`meta.browser.product` 有值；条数与 Top 主机正确 |
| **P3 转换** ✅ | `harToScript.js` + TODO 确认 + `k6 inspect` | 已达成：真实 HAR → 4 事务（打开页面/登录/查询订单/提交订单）、登录进 `setup()` 且取 `data.token`、阻断型 TODO 2 项、真实 `k6 inspect` 通过；`confirmScript` 变更指纹后旧指纹返回 `E_STALE` |
| **P4 执行** | `runner.js` + 冒烟门 + 实时指标 + 急停 + **mix 执行器与达成率检测** | 冒烟 1VU/30s 全绿；50VU 阶梯能看实时曲线；急停后 `status=stopped` 且**有** `summary.json` 与报告；3 场景 mix 跑完后每场景达成率 >= 95%，不足时判 `INVALID` |
| **P5 报告** | `report.js` + 面板渲染 + 导出 | 报告数字与 `summary.json` 逐项相等；`thresholds` 布尔按 R2 取反后才判 PASS/FAIL；`99` 场景判 `FAIL` 且不报错 |
| **P6 工具** | 6 个 `wikihub_perf_*` + 审批 + 技能说明 | 无 turn 时 `wikihub_perf_run` 本地 deny；有 turn 时弹审批；拒绝后 `state.json` 无新增 run |

---

## 10. 测试矩阵

| # | 文件 | 断言 | 阴性对照（必须红） |
|---|---|---|---|
| T1 | `test/perf-summary.test.js` | 三种形状 → 同一归一化结构；`thresholds` 语义（true=突破）；缺字段不产生 0 | 把 `true` 当通过 → 断言失败 |
| T2 | `test/perf-report.test.js` | 每个数字与 fixture 相等；`99` → FAIL；`103` → `stopped` 且报告存在 | 用 `passes/fails` 算失败率 → 断言失败 |
| T3 | `test/perf-har-to-script.test.js` | 登录进 `setup()`；路径参数模板化；一次性凭据进 TODO；每事务生成一个 `Trend` | 不生成 Trend → 事务表为空断言失败 |
| T4 | `test/perf-spec.test.js` | 9 条校验规则逐条；`prod` 无 `confirmPhrase` 报错；凭据字面量报错 | 放宽 `prod` 校验 → 断言失败 |
| T5 | `test/perf-runner.test.js` | 用**假 k6**（`PERF_K6_PATH` 指向 `test/fixtures/perf/fake-k6.mjs`）覆盖：exit 0/99/103/106/107、超时、僵尸恢复 | 把 103 当 failed → 断言失败 |
| T6 | `test/perf-http.test.js` | 新路由的状态码映射（403/409/422/503）、单飞、冒烟门 | 允许 `load` 无冒烟 → 断言失败 |
| T7 | `test/perf-boundaries.test.js` | `node:child_process` 只允许出现在 `env.js` / `recorder.js` / `runner.js`；全目录不得出现 `--out json`；`harToScript.js`/`summary.js`/`report.js` 不得 import `node:fs` | 在 `report.js` 里 spawn 或读文件 → 断言失败 |
| T8 | `test/mount.test.js` 扩展 | 数据到达后第二帧（空态→有数据）不崩；轮询在 `active:false` 时停 | 条件调用 hook → 断言失败 |
| T9 | `test/client-structure.test.js` 扩展 | 无第二个 toolbar 标记；`railItems` 含 `perf` 且顺序在 logs 后；分隔线只有一条；`app.title` 未被改动 | 插入两个 perf 入口 / 改了 app.title → 断言失败 |
| T10 | `test/i18n-parity.test.js`（**新增**） | `zh` 与 `en` 的键集合完全相等（含 `nav.perf` 与全部 `perf.*`） | 只往 `zh` 加 `perf.x` 不加 `en` → 断言失败 |
| T12 | `test/perf-mix.test.js`（**新增**） | 权重→rate 分配（60/30/10 于 15/s → 9/4.5/1.5）；ramp 时梯形面积算 expected；达成率边界（0.949 → `underDelivered`，0.95 → 通过）；指标名生成稳定；禁嵌套 mix 报错 | 把 rate 算法改成 VU 份额 → 断言失败；把 0.95 改成 0.5 → under-delivered 用例漏报，断言失败 |
| T13 | `test/perf-mix-merge.test.js`（**新增**） | 合并器：多 `setup()` 合成一个并返回 `{auth1,auth2}`；`txn_1_m` 重编号为 `txn_<n>_m`；每场景独立 `BASE_<n>`；group 名加子场景前缀；子脚本缺 `current.json` 时报错并指明场景 | 输出两个 `setup` → k6 语法错误，断言失败；指标不重编号 → 同名 `txn_1_*` 冲突，断言失败 |
| T11 | `test/perf-recorder.test.js`（**新增**） | 用**假浏览器 + 假 CDP 服务**（`PERF_BROWSER_PATH` 指向测试脚本）覆盖 C10.3 的 8 步：正常启动、CDP 就绪超时（第 4 步）、第 6 步顺序（导航必须发生在事件挂载之后）、并发 start 只成功一个、失败后无残留目录/进程 | 把「挂事件」移到「导航」之后 → HAR 缺登录请求，断言失败；把锁去掉 → 并发用例出现两个 recId，断言失败 |

既有测试需同步的：`test/http.test.js`（新路由）、`test/i18n.test.js`（新键，注意它**不**负责 parity——parity 由 T10 负责）、`test/frontend-backend-parity.test.js`（`limits.js` 与 `lib/perf/*` 的上限同源）。

**假 k6 说明**：CI 不装 k6。`fake-k6.mjs` 读环境变量决定行为（`FAKE_EXIT=99`、`FAKE_SLEEP=2000`、`FAKE_SUMMARY=<path>`），并可写出一份预设 summary。`PERF_K6_PATH` 是唯一 k6 注入点；浏览器对应 `PERF_BROWSER_PATH`。两个变量之外，生产代码不得出现测试分支。

---

## 11. 验收清单

- [ ] **A1** 未装 k6 时面板禁用 + 安装命令，不出现"点了没反应"
- [ ] **A2** 人控录制：按 C10.3 的时序（先挂事件再导航、起始页 about:blank），HAR 含登录 POST 与业务 XHR；`authorization` 已脱敏
- [x] **A3** 转换：登录进 `setup()`（`res.json('data.token')`）；TODO 含一次性凭据与路径参数；阻断项未解时 `validate` 返回 `ok:false`（实测：2 项阻断）
- [ ] **A4** 冒烟全绿（无 TLS 错、check 全过），服务端拒绝无冒烟加压
- [ ] **A5** 50 VU 阶梯压测：实时 TPS/p95/失败率/VU 每秒更新；急停后 `status=stopped`
- [ ] **A6** 报告：7 章齐全；`thresholds` 判定与 exit code 一致；`99` 判 FAIL 但不报错；`103` 仍出报告
- [ ] **A7** 数字一致性：报告里的 TPS/p95/失败率/总请求与 `summary.json` 逐项相等
- [ ] **A8** 单飞：录制中再点运行 → `E_PERF_BUSY`，UI 显示"已有录制在跑"
- [ ] **A9** 包体：`client.js` 增量 ≤ 60,000 B，`npm run build` 通过
- [ ] **A10** 工具：`wikihub_perf_run` 在无 turn 时 deny、有 turn 时弹审批、拒绝后无副作用
- [ ] **A11** 导航：rail 共 11 项、顺序为 `…资料/检查/审阅 ─ / 运行日志 / 性能测试 / 技能 / 概览`，分隔线只有一条；工具栏仍显示「知识库」
- [ ] **A12** 浏览器兜底：**只有 Edge、没有 Chrome** 的机器能正常录制（本机即此情况），且 `meta.browser.product` 以 `Edg/` 开头；两个都没有时按钮禁用并提示"装 Chrome 或 Edge"
- [ ] **A13** 混合页面：一次录制含 2 个页面导航 + 4 个接口 + 若干静态资源 → 脚本里页面打开是独立步骤且有状态断言、接口正常模板化、静态资源不在脚本里；若检出 WS，报告第 7 章有"未覆盖"说明
- [ ] **A14** 混合场景：3 场景 60/30/10、总 15 次/秒 → 跑完报告的每场景达成率 ≥ 95%、每场景 p95 可独立读出；把 `maxVus` 调到明显不足时判 `INVALID` 而非 `FAIL`，且报告写明哪几个场景没达到目标速率
- [ ] **A15** 多场景录制链路：3 个子场景分别录制并各自冒烟 → 建 mix 页（权重 60/30/10）→ 生成合并脚本（一个 `setup`、`txn_<n>_m` 指标、每场景 `BASE_<n>`）→ 冒烟通过 → 加压出报告；期间在 mix 页点录制被拒绝并提示"由 N 个子场景组成"

---

## 12. 产品决策记录（2026-11-08 冻结；2026-11-09 增补决策 4）

| # | 决策 | 结论 | 落到哪 |
|---|---|---|---|
| 1 | 入口位置 | **WikiHub rail 内**（第 11 项）。不做独立工作台包，宿主左侧工作台列表不新增条目 | C14 |
| 2 | k6 分发 | **只探测本机**。不随包分发、不自动下载、不自动安装 | C5.0、§1 |
| 3 | 工具栏标题 | **不改**，仍为「知识库」。分类语义由 rail 分隔线承担 | C14、C16 |
| 4 | 混合场景（2026-11-09 追加） | **支持**。语义为按迭代速率分配，比例未达成判 `INVALID` | C10.7 |

**连带影响（已并入上文契约，实施时不要再问）**：
- 页面/文档里不再出现"另开 perfhub 包"的分支；`docs/wikihub-perf-module-plan.md` §5 D7 的备选方案作废。
- 空态文案只能说"请先安装 k6 并点重新检测"，**不得**出现"点击安装"按钮（我们不会装）。可给可复制的 `winget install k6` 命令，但不得调用它。
- `perf/` 场景页、报告页都在知识库语境里，措辞用「知识库」而非「工作台」。

**仍按推荐默认执行、可随时回退的两项**（改动面小，不阻塞）：
- 场景绑定已有 flow / case / environment 页面（D5）：若你想完全独立，只需把 `perf-spec` 的 `flowRef`/`caseRefs` 当可选注释字段，其它不变。
- HAR 采集归属：由 wikihub 承接（browser-hub 二期池的 `start_capture` 标注为已承接），见 §8.5。

---

## 附录 A · 本轮实测记录（可复现）

环境：Windows / k6 v2.2.0（`D:\k6\k6.exe`）/ Node 22.22.2 / 本地 http 服务 127.0.0.1:18081。

| 命令 | 观测 |
|---|---|
| `k6 run --summary-export s-legacy.json script.js` | 顶层 `{root_group, metrics}`；`http_req_duration` 扁平含 `avg/med/p(95)/max/min`，无 `values` |
| `k6 run --summary-export s-new.json --new-machine-readable-summary script.js` | 顶层 `{version, metadata, config, results}`；`results.metrics` 为数组 |
| `k6 run --summary-export s-pass.json pass.js`（阈值达标） | `thresholds:{"p(95)<1000":false}`、`{"rate<0.01":false}`，exit **0** |
| `k6 run --summary-export s-fail2.json fail2.js`（`p(95)<0.001`） | `thresholds:{"p(95)<0.001":true}`，exit **99** |
| `k6 run -a 127.0.0.1:6567 …` + `PATCH stopped:true` | `GET /v1/status` 返回 JSON:API；PATCH 200；exit **103**；summary **4,408 B 仍写出** |
| `GET /v1/metrics`（运行中） | 3,112 B / 18 项；`http_reqs.sample={count,rate}`、`http_req_failed.sample={rate}`、`vus.sample={value}` |
| `k6 run --out json=m.ndjson`（2 s） | **150,406 行** → 长跑不可用 |
| `k6 run --stage 1s:3 --stage 1s:0` | 覆盖脚本 options，`vus_max=3` |
| 事务 Trend 方案 | 脚本内 `new Trend('txn_1_duration')` → summary 出现 `txn_1_duration` 且 `p(95)` 由 k6 计算 |
| `root_group` 内容 | 只有 `checks{passes,fails}`；`group_duration` 仅全局一条 |


---

## 附录 B · 混合场景实测记录（v1.5，可复现）

环境同上（k6 v2.2.0 / 本地 HTTP 服务 / 每请求人为延迟 40 ms）。

| 验证项 | 命令要点 | 观测 |
|---|---|---|
| 多 `exec` 场景并行 | 两个 `constant-arrival-rate`：`rate:10` 与 `rate:5`，各 3 s | `scn_1_reqs=31`（10.17/s）、`scn_2_reqs=16`（5.25/s）——**两场景速率互不干扰**，配比可精确控制 |
| 自定义指标进 summary | 每场景 `Trend`/`Counter`/`Rate` 各一 | `scn_1_duration`、`scn_1_reqs`、`scn_1_fail`、`scn_2_*` 全部出现在 `--summary-export`，数值正确 |
| 自定义 Trend 挂阈值 | `thresholds: { scn_2_duration: ['p(95)<30'] }` | 文本摘要显示 `scn_2_duration ✗ p(95)=56.35ms`，**exit 99** → 每场景 SLA 复用同一套阈值机制，无需新造 |
| VU 不足的检测 | `rate:100` 但 `preAllocatedVUs:1, maxVUs:1` | summary 出现 `dropped_iterations=247`（**只有全局值，无场景归属**）；stderr 一条 `level=warning "Insufficient VUs…" scenario=s1`；进程仍正常结束（exit 0） |

**这三条观测直接决定了 C10.7 的三个设计选择**：

1. 既然自定义 Trend 能挂阈值且触发 exit 99 → 每场景 SLA 直接写进 `options.thresholds`，不新增判定通道。
2. 既然 `dropped_iterations` 无法定位到场景 → 必须由生成的脚本自记 `scn_<n>_iters`，用「实际/目标」算达成率；全局值只作交叉证据。
3. 既然 VU 不足时进程仍 exit 0、只是没打到目标速率 → 必须有 `INVALID` 这个结论状态，否则这种运行会被报告成 `PASS`，属于最危险的一类假绿。
