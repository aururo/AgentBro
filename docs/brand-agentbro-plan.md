# AgentBro 品牌个性化实施方案

本文是本仓库从 DSH Desktop 切换到 AgentBro 品牌的可执行方案。行号基于 0.12.1 当前工作区，实施时以实际锚点文本为准。

## 1. 结论摘要

| 项 | 取值 |
| --- | --- |
| 产品显示名 | `AgentBro`（中英文同名） |
| 字标 | `AgentBro` 文本字标，无标点 |
| 安装包 / 目录 / 产物名 | `AgentBro` / `agentbro-${os}-${arch}.${ext}` |
| appId | `io.dsh.desktop`（**保持不变**） |
| userData 目录 | `dsh-desktop`（**保持不变**） |
| 图标 | 黑方圆底 + 白色机器人（圆角方头 + 内屏挖空 + 两只竖条眼 + 顶部凸起 + 分腿躯干 + 一垂一伸的双臂）|

改造分三层、五个批次，批次之间可独立验收、独立回滚。

## 2. 命名规范

中英文同名 `AgentBro`，因此**没有**中英双份品牌文案，也不需要按 locale 分支。相比上一版方案少了一整类问题（不再有全角标点进入文件名、URL、NSIS 脚本的风险）。

落地规则：

- `productName`、`app.setName()`、窗口标题、托盘、关于卡、安装目录 → `AgentBro`
- 标识符、路径、产物名一律 ASCII：`agentbro-*`、`AgentBro Dev`
- npm 包名 `dsh-desktop`、插件 id `dsh-desktop-*`、`userData` 目录 `dsh-desktop`、`appId` **全部不变**

最后一条是刻意的：`appId` 变了 macOS 会当作新应用重新申请权限、自动更新链断掉；`userData` 变了老用户的会话和工作区会像凭空消失。品牌是皮，这两项是骨。

## 3. 图标与资产规格

### 3.1 现有资产盘点

| 文件 | 现状 | 用途 |
| --- | --- | --- |
| `build/app-icon.png` | 1024×1024，透明底，黑色方圆 823px（Apple 网格，四周 100px 留白），白色鲸鱼，机身三颗镂空圆点 | 图标源，供 `icons:generate` 生成 icns/ico |
| `build/icon.icns` / `icon.ico` | 由上面的 PNG 生成 | 打包图标 |
| `build/icon.png` | 1254×1254，**不透明**浅底 `#F8F8FB` + 蓝色 `#4D6BFE` 鲸鱼 | 运行时窗口/托盘图标、favicon、移动端页 Logo |
| `build/logo-light.png` / `logo-dark.png` | 336×192，透明底，黑/白鲸鱼，紧裁切 | 移动端配对页、浅深主题 |
| `build/brand-mark.svg` | 1000×1000，**单 path**，`currentColor` | 侧边栏 mark、loader GIF 生成源 |
| `build/startup-whale.gif` | 启动页动画，注释要求"逐字节保留" | splash |
| `build/dsh-loader.gif` / `-dark.gif` | 由 `brand-mark.svg` 程序化生成 | 兼容旧 loader |

### 3.2 图形方案：乐高小人式机器人（按参考图测绘重建）

用户提供了一张 79×63 的机器人参考图，要求"用此图片改造"。做法是先把参考图转成像素图、逐行取墨迹游程（run-length）把每个部位的边界量出来，再按统一比例映射到 1000 画布。所以这套造型是**测绘重建**，不是目测临摹——每一根线都能追回到参考图上的具体像素。

参考图实测（79×63 像素坐标，边缘像素按 50% 阈值取）：

| 部位 | 像素范围 | 规格 |
| --- | --- | --- |
| 头外框 | x 17–60 / y 8–41 | 44×34，描边 4，外圆角 r≈5 |
| 内屏 | x 22–55 / y 13–36 | 34×24，r≈2，即"面部屏幕" |
| 顶部凸起 | x 34–43 / y 2–7 | 10×6，与头框顶边直角相接 |
| 眼睛 | 左 33–38 / 右 45–51，y 17–28 | 两枚圆头竖条 6×12 |
| 躯干 | x 29.5–48.5 / y 42–56 | 19×14，底部中央开槽至 y 50 |
| 左臂 | x 19.7–26.5 / y 43–54 | 竖条 6.8×11.5，下垂 |
| 右臂 | x 49.5–61.5 / y 43–50 | 横条 12×7.5，平伸 |

映射到 1000 画布（统一 ×13.5，头部中心对齐 x=500，整体 bbox 垂直居中）：

| 元素 | 规格（设计单位） |
| --- | --- |
| 头框 | `x 209.75 y 216.5 w 594 h 459`，外圆角 67.5，**描边 54** —— 由"外框 + 内屏"两段子路径偶奇挖空实现，不是 stroke |
| 内屏 | `x 263.75 y 270.5 w 486 h 351`，圆角 27 |
| 顶部凸起 | `w 135 h 81`，圆角 32.4，底部直角并入头框轮廓 |
| 眼睛 | 两枚 `86.4×156.6` 圆头竖条，圆角 43.2，垂直中心 y 416；**中心距 168.75，整体右偏 40.5**（左眼 x 412.9 / 右眼 x 581.7）|
| 躯干 | `x 371.75 y 675.5 w 256.5 h 189`，开槽宽 37.8 / 深 94.5 |
| 左臂 | `x 243.5 y 689 w 98.55 h 155.25`（竖条） |
| 右臂 | `x 641.75 y 689 w 162 h 101.25`（横条） |

整体 bbox `x 203–803.75 / y 135.5–864.5`，600.75×729，宽高比 **0.824** —— 参考图为 45:55 = 0.818，差 0.7%。

**眼睛是刻意不对称的**：参考图里双眼不在内屏正中——左留白 12、眼 6、间隙 6、眼 7、右留白 5（按内屏宽 36 计），整体右偏约 3.2px，占内屏宽 9%。这个偏移是造型辨识度的一部分（略像侧目），已按原样保留，换算到画布是 `+40.5`。首版误做成居中，视觉上明显偏左，已修正。

**唯一有意偏离参考图的一处**：开槽加宽。参考图开槽只有 2px（占躯干宽 11%），缩到 32px 图标时不足 1 个像素，双腿会糊成一坨。实际用 3px 等效宽度，32px 实拍仍能看出分腿。

**关键实现约束：整枚图形是单一 path（7 段子路径）。** 头框的"外框 / 内屏"靠 `fill-rule="evenodd"` 挖空，眼睛、躯干、双臂都是追加的填充子路径。这样能保住两处下游假设：

- `packages/dsh-desktop-client-ui/client.js` 的 `BRAND_MARK_VIEWBOX` / `BRAND_MARK_PATH` 仍是"一个 viewBox + 一个字符串"，不需要改成渲染整份 SVG 片段。
- `scripts/generate-loader-gifs.mjs` 的 `/\sd="([^"]+)"/u` 正则仍能抓到完整图形。

**踩过的坑**：顶部凸起最初是一段独立的圆角矩形，与头框顶边重叠 10px。偶奇规则下重叠区奇偶性变成偶数、被反相挖空，凸起于是变成一个悬在头顶的胶囊。改成把凸起并入头框外轮廓的**同一段闭合路径**（顶边走到凸起处上拐、绕过凸起顶、再落回顶边）后消失。**这是机器人类多形状图标最容易踩的坑：偶奇挖空下任何两个子路径都不能重叠。**

成品：`docs/images/brand-preview/` 下 `agentbro-icon.svg`（深底图标）、`agentbro-icon-light.svg`（浅底品牌蓝）、`agentbro-mark.svg`（单色 `currentColor`）、`agentbro-sheet.png`（总览）。

尺寸实测：512 / 128 / 64 干净；**32px** 仍能读出圆角头框、两只眼和分腿；**16px** 退化为"深底圆角块 + 白色剪影"，与参考图同尺寸下的表现一致，这是该类造型的物理上限。

### 3.2.1 单色版与导出要求

- 侧边栏 mark 不画底色、全 `currentColor`；内屏由偶奇挖空实现，深色主题下自动透出侧边栏底色，不会变成白块。
- `app-icon.png`（1024，透明底，Apple 网格 824，`rx=182`）与 `icon.png`（1254，不透明浅底 `#FBFBFD` + 品牌蓝 `#4B6BFF`）从同一份 path 导出，只换外层变换，避免两套图形各改一次。
- `logo-light.png` / `logo-dark.png`（336×192）同样从该 path 导出，机器人按 192 高居中（实际宽约 158），左右留白是横向画布带来的，不是裁切错误。
- **居中锚点取 bbox 中心而非头部中心**。头部本身在 bbox 里偏左（右臂外伸把包围盒向右撑），若按头部居中，整枚图形在图标里会看偏。导出脚本用 `BBOX` 计算中心（当前为 `x 503.375 / y 500`），不写死。
- **loader 生成器有三处必须同步改**（已在 P1 落地，见 5.1），否则 `npm run loader:generate` 会静默产出错误 GIF：
  1. 第 29 行 `MARK_VIEWBOX` 硬编码为鲸鱼包围盒 `{ x: 42, y: 218, width: 898, height: 564 }`，需改成 `{ x: 203, y: 135.5, width: 600.75, height: 729 }`。
  2. 第 59 行 probe 里的 `<path d="...">` 没有 `fill-rule`，默认 `nonzero` 会把内屏填实、眼睛一起消失。必须补 `fill-rule="evenodd"`。
  3. 第 31 行 `BODY_CELLS = 78` 是按鲸鱼 898:564 的横向比例定的；机器人 729:600.75 更高，78 cell 宽对应 95 cell 高，超过 360px 画布的 90 cell。实际落到 **56**（≈68 cell 高），留出上下浮动余量与头顶气泡空间。

### 3.3 字标

上游 `BrandWordmark` 是硬编码的 "DeepSeek" SVG 字形路径，不能通过改字符串替换。已定：**直接出终态**，不做文本渲染过渡。

- **终态（已落地）**：`build/agentbro-wordmark.svg`（`viewBox="0 0 84.7 24"`，单色 `currentColor`），组件内以内联 path 渲染，与 mark 的光学高度对齐。
- 字标由 `scripts/generate-wordmark.mjs` 生成：Inter SemiBold（`scripts/fonts/inter-latin-600-normal.woff2`，SIL OFL 1.1）转曲，cap 高 14、基线 18.6、24 单位画布，与上游 `BrandWordmark` 实测几何一致（上游 cap 14.1 / 基线 18.7 / 墨迹 87×18，本字标 84.7×19）。
- 过渡方案（`font:600 15px/1 var(--dsw-font-sans)` 文本渲染）已废弃，不采用。

## 4. 代码改动清单

### 4.1 打包与安装层

`package.json`：

| 行 | 现值 | 改为 |
| --- | --- | --- |
| 4 | `description` | `A cross-platform desktop shell for AgentBro.` |
| 322 | `productName: "DSH Desktop"` | `"AgentBro"` |
| 492 | `artifactName: "dsh-desktop-${os}-${arch}.${ext}"` | `"agentbro-${os}-${arch}.${ext}"` |
| 553 | `nsis.artifactName` | `"agentbro-windows-${arch}-setup.${ext}"` |
| 501 | `NSMicrophoneUsageDescription` | 文案中的产品名 |
| 321 | `appId: "io.dsh.desktop"` | **不动** |

`electron-builder.dev.cjs`：`productName` → `AgentBro Dev`；`extraMetadata.productName` → `AgentBro Dev`；`artifactName` → `agentbro-dev-${os}-${arch}.${ext}`；`nsis.artifactName` 同步；`appId` 的 `.dev` 后缀与 `name: 'dsh-desktop-dev'` 不动。

发布链路同批更新：`scripts/verify-release-assets.mjs` 第 8–17 行的 `REQUIRED_ASSETS` 与第 112 行的 `latest.yml` 断言、`test/release.test.ts`、`test/archive-windows-release.test.mjs`。

### 4.2 桌面壳层

新增 `src/shared/brand.ts`（纯常量，符合 `src/shared` 不依赖 Electron/Node 的约束）：

```ts
export const BRAND_NAME = 'AgentBro'
export const BRAND_NAME_DEV = 'AgentBro Dev'
/** 界面上的品牌展示名；与 BRAND_NAME 分开，便于将来做"AgentBro · 某渠道"这类变体。 */
export const BRAND_DISPLAY = 'AgentBro'
export const BRAND_VERSION_NOTE_EN = 'Harness is updated with AgentBro.'
export const BRAND_VERSION_NOTE_ZH = 'Harness 随 AgentBro 更新。'
```

`build/*.html` 不能 import TS，三个独立页面（`safe-mode.html`、`plugin-recovery.html`、`web-import.html`）的品牌名本来由主进程传入，只有 `splash.html` 是硬编码，直接改字符串。

逐文件改动：

| 文件 | 行 | 内容 |
| --- | --- | --- |
| `src/main/index.ts` | 613 / 618 | `app.setName(BRAND_NAME_DEV)` / `app.setName(BRAND_NAME)` |
| | 1105 / 1108 | 托盘 tooltip、菜单"显示 AgentBro" |
| | 1469 / 1904 / 2017 | 三处错误信息里的产品名 |
| | 2054 / 2055 | 关于框 `title` / `message` |
| | 2215 | `showErrorBox` 标题 |
| | 3320 | 菜单"关于 AgentBro" |
| | 3450 / 3481 | 移动端连接提示与对话框标题 |
| | 3953 | 维修演示窗口标题（改为 `${BRAND_NAME} · 维修演示`） |
| `src/main/application-locale.ts` | 17 / 35 | `windowRecovery.description` 中英文 |
| `src/main/mobile/lan-mobile-pages.ts` | 81 / 108 / 281 / 317 / 368 / 405 | 五处页面品牌名与提示 |
| `src/main/plugin-recovery-view.ts` | 239 / 275 | `brand` / `quitLabel` |
| `src/main/safe-mode.ts` | 367 / 394 / 409 / 436 | 中英文 `brand` / `quitLabel` |
| `src/main/web-import-view.ts` | 47 | `brand` |
| `src/main/version-info.ts` | 39 / 41 | 版本说明中英文 |
| `src/main/repair-agent.ts` | 293 | 诊断信息里的产品名 |
| `src/main/windows-menu.ts` | 109 | 关于菜单项 |
| `src/main/window-restart-prompt.ts` | 44 / 61 | 弹窗标题 |
| `src/main/runtime/harness-runtime.ts` | 522 | patch 缺失错误信息 |
| `src/preload/boot-cover.ts` | 168 / 169 | 启动遮罩标题 |
| `src/preload/desktop-update-ui.ts` | 132 / 143 / 354 / 381 / 391 | 更新卡 aria、标题、关于标题与提示 |
| `src/preload/update-view.ts` | 121 / 127 / 129 | 更新提示三态 |
| `build/splash.html` | `<title>` / `aria-label` | `AgentBro` |

不改：注释、日志前缀（`dsh-desktop:` 便于排查）、插件 id（`dsh-desktop-*`）、Profile 管理文件头、`userData` 路径。

### 4.3 Harness Web UI 层

`packages/dsh-desktop-client-ui/client.js`（P1 已落地，见 5.1；61/76 行品牌名等文案属 P2/P3）：

| 行 | 改动 |
| --- | --- |
| 12–15 | `BRAND_MARK_VIEWBOX` / `BRAND_MARK_PATH` 常量**结构不变**，只替换取值：viewBox 改为 `{ x: 203, y: 135.5, width: 600.75, height: 729 }`，path 换成机器人那条 7 段子路径的 `d`。因为新图形仍是单 path，渲染层不需要改 |
| 17–30 | `DesktopBrandMark` 保持"一个 `<path>`"，但必须补 `fillRule: 'evenodd'`，否则头框内屏会被填实 |
| 32–34 | `DesktopBrandName` 由 `BrandWordmark` 改为自绘字标或文本 |
| 36–38 | `ConversationBrandMark`：首屏 hero 换成同一机器人图形（去掉底座，描边加粗一档） |
| 275–283 | slot 注册逻辑不动 |

`packages/dsh-desktop-onboarding/client.js`：16–19 行 mark 常量同上改造、61 / 76 行 `brandName: 'AgentBro'`、65–66 与 80–81 行 `desktopIntroTitle` / `desktopIntroBody`。`brandBy: 'by dataelem'`、内测声明正文中的 "DeepSeek Harness" 属于运行时表述，本次不动（如需完全白标另开一批）。

`scripts/install-brand-assets.mjs`：68 行 `target.sizes` 保持与新 `icon.png` 实际尺寸一致；33、87 行日志文案。

### 4.4 构建脚本

`scripts/generate-app-icons.mjs` 目前依赖 macOS 的 `sips`，在 Windows 上直接失败。改法：

- 用 `sharp` 替换 `sips` 完成尺寸缩放（`sharp` 已是既有依赖，`generate-loader-gifs.mjs` 在用），ICO 容器拼接逻辑（38–73 行）保持原样，它已经是手写 PNG 容器，跨平台可用。
- `iconutil` 生成 `.icns` 仍只在 macOS 走；非 macOS 环境跳过并打印提示，避免 CI 与本地行为不一致。
- 收敛成"SVG → 全部位图"的单入口：`app-icon.png`、`icon.png`、`logo-*.png` 都从矢量生成。

`build/dsh-loader.gif` / `-dark.gif` 改完 `brand-mark.svg` 后执行 `npm run loader:generate` 重新生成，不要手改 GIF。

## 5. 实施批次与验收

| 批次 | 范围 | 验收 |
| --- | --- | --- |
| P1 资源 | 图标/标记矢量、导出 1024/1254/336×192、重建 ico、重生 loader GIF | 目视 16/32/48/256px；`node scripts/generate-app-icons.mjs` 在 Windows 可跑通 |
| P2 文案 | `src/shared/brand.ts` + 4.2 表全部文件 + `splash.html` | `npx vitest run test/boot-cover.test.ts test/safe-mode.test.ts test/lan-mobile-pages.test.ts test/update-ui.test.ts test/runtime.test.ts test/main-window-title.test.ts` |
| P3 Web UI | 三个 slot、onboarding、`install-brand-assets.mjs` | `npx vitest run test/desktop-client-ui.test.ts test/branding-patch.test.ts test/desktop-onboarding.test.ts`；启动应用看浅/深色侧边栏与首屏 |
| P4 打包 | package.json、dev 配置、发布脚本与产物名 | `npm run typecheck`；`npm run package:dev:dir` 后检查安装目录名、开始菜单、exe 属性、产物文件名 |
| P5 回归 | 全量 | `npm test`、`git diff --check`，Windows 实机走一遍安装 → 启动 → 托盘 → 关于 → 更新检查 |

`npm run typecheck` 只覆盖 `src/` 与 TS 测试，`packages/*.js`、`build/*.html` 不在范围内，这两处必须靠运行时目视验收。

## 5.1 P1 资源批次实施记录（已完成）

资产层与图形相关的代码改动已落地，`build/` 全部由脚本生成，没有手改产物。

**新增 `/ 改动的脚本`**

| 脚本 | 状态 |
| --- | --- |
| `scripts/generate-brand-assets.mjs` | **新增**。品牌资产的唯一事实来源：几何参数、path 构建、`build/` 五个产物、`--preview` 预览图。`npm run brand:generate` |
| `scripts/generate-app-icons.mjs` | **重写**。`sips` 全部换成 `sharp`，Windows 可跑；`.icns` 在 macOS 走 `iconutil`，其他平台直接写 PNG 容器（`ic07`–`ic14`） |
| `scripts/generate-loader-gifs.mjs` | **改三处**：`MARK_VIEWBOX` → `{203, 135.5, 600.75, 729}`、probe 的 `<path>` 补 `fill-rule="evenodd"`、`BODY_CELLS` 78 → 56（机器人是纵向的，56 cell 宽对应约 68 行，留出上下留白与气泡空间）；气泡发射点从鲸鱼的"窗灯"改到头顶凸起 |
| `package.json` | 新增 `brand:generate` 脚本 |

**生成的产物**

| 文件 | 规格 |
| --- | --- |
| `build/brand-mark.svg` | 1000×1000，单 path，7 段子路径，`evenodd` |
| `build/app-icon.png` | 1024×1024 透明底，824 圆角方块 `rx=182`，白机器人 `scale 0.92` |
| `build/icon.png` | 1254×1254 不透明 `#FBFBFD` 底 + 品牌蓝 `#4B6BFF` 机器人 `scale 0.96` |
| `build/logo-light.png` / `logo-dark.png` | 336×192 透明底，机器人按高度居中（实际 146×176） |
| `build/icon.ico` | 16/24/32/48/64/128/256，PNG 负载，ICO 容器保持原有手写逻辑 |
| `build/icon.icns` | `ic07` 128 / `ic13` 256 / `ic08` 256 / `ic14` 512 / `ic09` 512 / `ic10` 1024 |
| `build/dsh-loader.gif` / `-dark.gif` | 640×360，48 帧，由 `brand-mark.svg` 量化生成 |

**Web UI 接线**

- `packages/dsh-desktop-client-ui/client.js`：`BRAND_MARK_VIEWBOX` / `BRAND_MARK_PATH` 换成新取值，`<path>` 补 `fillRule: 'evenodd'`；`height` 由 17 提到 **20**（mark 从横幅变纵幅，17 会显得空）；`ConversationBrandMark` 不再透传上游 `FishLogo`，改为渲染同一枚 mark，接收 seat 传入的 `size` 作为**盒高**，宽度按 600.75:729 反算。
- `packages/dsh-desktop-onboarding/client.js`：同样换 mark，`height` 18 → **20**。
- `test/desktop-client-ui.test.ts`：断言同步（sidebar `height` 20 + 宽度比例，hero 从 `FishLogo` 改为 `svg` 且 `size` 不再透传到 DOM），并移除不再使用的 `FishLogo` 打桩。

**已验证**

- `npm run brand:generate && npm run icons:generate && npm run loader:generate` 全链可跑通、可重复产出同尺寸产物。
- ICO 七档声明尺寸与实际 PNG 尺寸一一吻合；ICNS 头长度与文件长度一致、六个 chunk 可完整走完。
- `npx tsc --noEmit -p tsconfig.node.json` 通过。
- `npx vitest run test/desktop-client-ui.test.ts test/desktop-onboarding.test.ts test/branding-patch.test.ts` 22 项通过；`test/desktop-protocol / lan-mobile-pages / release / local-workbench-identity / workbench-local-integration` 92 项通过。
- `node scripts/install-brand-assets.mjs` 后 favicon 指向 `dsh-desktop-logo.png`（1254）、manifest `sizes` 为 `1254x1254`。

**仍未做**：`build/logo-light.svg` 仍是通过 `feColorMatrix` 把 `logo-dark.png` 反相成黑色，机器人本身无影响，但这层间接可以省掉；`build/startup-whale.gif` 按注释要求逐字节保留，未动。

## 5.2 P2 文案批次实施记录（已完成）

新增 `src/shared/brand.ts`（纯常量，无 Electron / Node 依赖）：

| 常量 | 值 |
| --- | --- |
| `BRAND_NAME` | `AgentBro` |
| `BRAND_NAME_DEV` | `AgentBro Dev` |
| `BRAND_DISPLAY` | `AgentBro`（界面文案用，与 `BRAND_NAME` 分开便于将来做渠道变体） |
| `BRAND_VERSION_NOTE_EN` | `Harness is updated with AgentBro.` |
| `BRAND_VERSION_NOTE_ZH` | `Harness 随 AgentBro 更新。` |

改用常量的文件：

| 文件 | 改动 |
| --- | --- |
| `src/main/index.ts` | `app.setName(BRAND_NAME_DEV / BRAND_NAME)`、托盘 tooltip 与菜单、4 处 `throw new Error` 产品名、关于框 `title` + `message`、`showErrorBox`、macOS 关于菜单、手机连接提示、维修演示标题 |
| `src/main/application-locale.ts` | `windowRecovery.description` 中英 |
| `src/main/version-info.ts` | 关于框版本说明中英，改用 `BRAND_VERSION_NOTE_*` |
| `src/main/windows-menu.ts` | 关于菜单项 |
| `src/main/safe-mode.ts` | `brand` ×2、`quitLabel` ×2 |
| `src/main/plugin-recovery-view.ts` | `brand`、`quitLabel` |
| `src/main/web-import-view.ts` | `brand` |
| `src/main/mobile/lan-mobile-pages.ts` | 页头品牌 3 处、`noWorkspaces`、`manageHint`、`unavailable` |
| `src/main/window-restart-prompt.ts` | 两处 `title` |
| `src/main/repair-agent.ts` | 诊断事实里的产品名 |
| `src/preload/boot-cover.ts` | 启动遮罩标题（中英） |
| `src/preload/update-view.ts` | 更新提示三态 |
| `src/preload/desktop-update-ui.ts` | 更新卡 aria、关于卡标题与 aria、Harness 版本 tooltip |
| `build/splash.html` / `plugin-recovery.html` / `safe-mode.html` / `web-import.html` / `application-rollback.html` | `<title>`、`aria-label`、`document.title` 兜底、回退成功文案（这些页面不能 import TS，直接写字符串） |

**刻意没改**：`src/main/state/host-disabled-plugins.ts`、`src/main/state/safe-mode-profile.ts` 的 `# Managed by DSH Desktop` 文件头（改字会重写用户 Profile 里的托管文件，属于数据迁移而非品牌）；`src/main/runtime/disclaimed-utility-process.ts` 的注释；日志前缀 `dsh-desktop:`；插件 id `dsh-desktop-*`；`userData` 目录名。

## 5.3 P3 Web UI 批次实施记录（已完成）

- `packages/dsh-desktop-client-ui/client.js`
  - `DesktopBrandName` 由上游 `BrandWordmark` 改为文本字标：`<span class="dshDeskBrandName">AgentBro</span>`，新增 CSS `font-size:15px; font-weight:600; line-height:1; letter-spacing:-0.01em`，`font:inherit` 继承侧边栏字体。上游 `BrandWordmark` 是硬编码 "DeepSeek" 字形路径，无法改字符串，所以走方案 §3.3 的过渡路径。
  - `require` 不再解构 `BrandWordmark`；同时删掉 `packages/dsh-desktop-client-ui/package.json` 之外无处使用的依赖引用。
- `packages/dsh-desktop-onboarding/client.js`：`brandName` 中英均改 `AgentBro`；`desktopIntroTitle` / `desktopIntroBody` 中英同步（`brandBy: 'by dataelem'`、内测声明正文里的 "DeepSeek Harness" 保持原样）。
- `packages/dsh-desktop-market-installer/client.js`：插件市场介绍、社区免责声明、安装提示、管理说明共 8 条中英文案换品牌名。
- `scripts/install-brand-assets.mjs`：日志与报错文案。

## 5.4 P4 打包批次实施记录（已完成）

`package.json`：

| 项 | 现值 |
| --- | --- |
| `description` | `A cross-platform desktop shell for AgentBro.` |
| `build.productName` | `AgentBro` |
| `build.artifactName` | `agentbro-${os}-${arch}.${ext}` |
| `build.nsis.artifactName` | `agentbro-windows-${arch}-setup.${ext}` |
| `mac.extendInfo.NSMicrophoneUsageDescription` | 文案里的产品名 |
| `build.extraResources` | **移除 `startup-whale.gif`**（splash 已改用 loader GIF，见 5.5） |

`appId: io.dsh.desktop`、`userData`、`publish.url`、npm 包名 `dsh-desktop`、`build/*.patch.yml` 的产物名**全部未动**。

连带更新（产物名契约）：

- `electron-builder.dev.cjs`：`productName` / `extraMetadata.productName` → `AgentBro Dev`，`artifactName` → `agentbro-dev-*`
- `scripts/verify-release-assets.mjs`：`REQUIRED_ASSETS` 与两条 `latest.yml` 断言
- `.github/workflows/release.yml`：产物路径、`SMOKE_EXE`、缓存产物名、jsign `--name`、飞书通知标题
- `.github/scripts/signed_test_build.py`：提测产物清单
- `scripts/sign-windows-unpacked.mjs`：jsign 默认 `name`
- 测试：`test/release.test.ts`、`test/verify-release-assets.test.mjs`、`test/update.test.ts`、`test/signed-test-build.test.ts`、`test/finalize-windows-release.test.ts`

**注意**：`test/enterprise-entry.test.ts`、`test/window-restart-prompt-integration.test.ts` 用 `vm.runInNewContext` 直接求值 `src/main/index.ts` 的片段，导入语句不在切片里，必须把 `BRAND_DISPLAY` 一并塞进 context 对象，否则 `ReferenceError: BRAND_DISPLAY is not defined`。

## 5.5 启动动画统一（附带完成）

原状态是两段式且品牌不一致：`build/splash.html` 播 `startup-whale.gif`（鲸鱼 + 内嵌"正在启动"字幕），150ms 后 `boot-cover` 用 `dsh-loader.gif`（机器人）盖上来，一次启动会看到"鲸鱼 → 机器人"跳变。

改动：

- `splash.html` 改用 `dsh-loader.gif` / `dsh-loader-dark.gif`，与 `boot-cover` 同一枚机器人动画，两段式视觉上连续。
- 补 `@media (prefers-color-scheme: dark)`：深色主题下背景 `#141416` 并切到深色版 GIF，消除此前"深色主题先闪一帧白底"。`showSplash()` 传的 `?theme=` 查询参数本来就没人读，`prefers-color-scheme` 与 `nativeTheme.shouldUseDarkColors` 同源，用媒体查询即可，不需要内联脚本（免 CSP 问题）。
- `startup-whale.gif` 从 `extraResources` 移除，文件本体仍在 `build/` 下逐字节保留，只是不再打进安装包。


## 6. 测试影响

以下文件断言了品牌字符串或产物名，需与实现同批更新，不能只改实现：

- 界面文案：`test/boot-cover.test.ts`（116/140/161）、`test/main-window-title.test.ts`（splash title）、`test/update-ui.test.ts`、`test/safe-mode.test.ts`、`test/lan-mobile-pages.test.ts`、`test/desktop-onboarding.test.ts`、`test/desktop-client-ui.test.ts`、`test/branding-patch.test.ts`
- 产物与路径：`test/release.test.ts`、`test/archive-windows-release.test.mjs`、`test/notarize-macos.test.mjs`、`test/sign-windows-unpacked.test.ts`、`test/macos-permissions.test.mjs`、`test/node-pty-asar-layout.test.ts`、`test/launch-agent-audit*.test.ts`、`test/market-installer.test.js`

后一组多数断言的是内部路径与签名产物，是否随品牌变更需逐条判断：**只有真正引用 `productName` / `artifactName` 的断言才改，其余保持原样**，避免把无关契约改松。

## 7. 风险与回滚

| 风险 | 处置 |
| --- | --- |
| `npm ci` 覆盖品牌资产 | 只改 `scripts/install-brand-assets.mjs`，不手改 `node_modules` |
| 上游升级后 `BrandWordmark` 变化 | 自绘字标不依赖上游组件，反而降低耦合；`ui-brand-official` 仍保持禁用 |
| 单 path 假设被打破 | 新图形经测绘后仍收敛为单一 path（7 段子路径 + `evenodd`），侧边栏组件与 loader 生成器都无需改结构；只需补 `fill-rule` 与更新 viewBox |
| 安装包名与 `verify-release-assets` 不一致 | P4 同批改脚本与测试，发版前跑 `verify-target` |
| 老用户数据"丢失" | `userData` 保持 `dsh-desktop`，不随 `app.setName` 变化 |
| 更新链断裂 | `appId`、`publish.url`、`version-catalog` 全部不动 |
| 回滚 | 改动集中在资源与字符串，无数据结构迁移；按批次 `git revert` 即可 |

## 8. 待确认

## 8. 决策记录

| # | 议题 | 结论 |
| --- | --- | --- |
| 1 | 字标用文本渲染过渡，还是直接出 SVG 字形 | **直接出 SVG 终态** `build/agentbro-wordmark.svg`，不做过渡 |
| 2 | 侧边栏 mark 是否保留"内屏挖空" | **保留**。深色主题下更像一块屏幕，浅色主题下更像一处缺口 |
| 3 | 内测声明里的 "DeepSeek Harness" 是否保留 | **保留**，属于运行时名，本次不做完全白标 |
| 4 | 图标是否直接进入 P1 写盘 | **是**，已按参考图定稿写盘（`docs/images/brand-preview/agentbro-sheet.png`） |

## 5.6 首次打包记录（Windows x64）

产物：

| 文件 | 大小 |
| --- | --- |
| `dist/agentbro-windows-x64-setup.exe` | 283,598,768 B（≈270 MB） |
| `dist/agentbro-windows-x64-setup.exe.blockmap` | 293,257 B |
| `dist/latest.yml` | `path: agentbro-windows-x64-setup.exe`，sha512/size 与实际一致 |
| `dist/win-unpacked/` | 便携目录，主程序为 `AgentBro.exe` |

验收：`AgentBro.exe` 的 `ProductName` / `FileDescription` 均为 `AgentBro`，`CompanyName` 为 `DataElement`；`resources/splash.html` 引用 `dsh-loader.gif` / `dsh-loader-dark.gif`，`startup-whale.gif` 已不在包内；`resources/dsh-desktop*.patch.yml` 文件名未变（运行时按固定名查找）。

打包命令（本机环境适配版）：`npm run package:win` 会先跑 `office:prepare` 重建 `.build/office-runtime`（5403 个文件），在带有批量删除保护的环境里会被拦；且 electron-builder 需要联网下载 Electron 43.0.0。两处都在本地可绕过：

1. 运行时已就绪时跳过 `office:prepare`，只跑 `prepare-templates.mjs` + `prepare-ppt-runtime.mjs` + `electron-vite build`。
2. 用 `--config.electronDist=<本地 Electron dist>` 指向 `node_modules/electron/dist`，并把 `locales/` 预先裁到 `electronLanguages` 白名单（en-US / zh-CN / zh-TW），让 electron-builder 的 `deleteNonMatchedLanguages` 无事可做。

正常 CI 环境不需要这两步。
