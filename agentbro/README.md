# AgentBro 上游关系与本机构建

`aururo/AgentBro` 是 `dataelement/dsh-desktop`（DSH Desktop，MIT 协议）的 GitHub fork，
与上游同处一个 fork network，因此上游提交可以直接合入，PR 也能直接提回上游。

## 两条同步路径

| 路径 | 操作 | 适用场景 |
| --- | --- | --- |
| GitHub 网页 | 仓库页 `Sync fork` | 上游改动小、不需要精细控制时最快 |
| 本地脚本 | `./agentbro/sync-upstream.ps1` | 想先看清领先/落后、想在本地解冲突、可选 rebase 时 |

网页 `Sync fork` 是一次整块 merge，不会告诉你冲突落在哪个文件；本地脚本会先打印
领先/落后计数再执行合并，冲突处理和推送时机都由自己控制。两者结果等价，按需选。

## remote

| remote | 地址 | 用途 |
| --- | --- | --- |
| `upstream` | `git@github.com:dataelement/dsh-desktop.git` | 上游基线，只读取新提交 |
| `origin` | `git@github.com:aururo/AgentBro.git` | 自己的 fork，推送与发布 |

## 分支模型

```
main                       纯上游镜像，与 upstream/main 完全一致（diff 为空），跟踪 upstream/main
└─ feature/agentbro-custom 定制主线，长期存在：agentbro 工具 + 全部业务定制
   └─ feature/<topic>       主题分支，从定制主线切出，做完合回定制主线
```

`main` 不写任何业务代码，它只是上游的实时投影：上游一提交，`main` 就能快进到同一位置，
`git diff upstream/main..main` 永远是空的。全部定制收敛在 `feature/agentbro-custom`，
`git diff upstream/main..feature/agentbro-custom` 就是 AgentBro 相对上游的完整差异。

```powershell
# 日常：同步上游到定制主线（合并 upstream/main → 定制主线）
./agentbro/sync-upstream.ps1 -Branch feature/agentbro-custom

# 从定制主线切一条主题分支（会先同步上游再切）
./agentbro/new-topic.ps1 -Name chat-panel

# 主题分支做完后合回定制主线
git switch feature/agentbro-custom
git merge --no-ff feature/chat-panel
```

`main` 的快进（上游更新后保持镜像）：

```powershell
git switch main
git pull                      # main 跟踪 upstream/main，直接快进
git push origin main          # 同步回 fork 的 main
```

GitHub 网页的 `Sync fork` 也可以用：它把上游合进 fork 的 `main`，之后本地
`git fetch origin` 再把 `origin/main` 合进定制主线即可，工具链会自动合 `upstream/main`，两者等价。

## 同步上游

```powershell
# 同步当前分支
./agentbro/sync-upstream.ps1

# 同步并推送
./agentbro/sync-upstream.ps1 -Push

# 未推送的 feature 分支保持线性历史
./agentbro/sync-upstream.ps1 -Branch feature/xxx -Rebase
```

脚本做三件事：`git fetch upstream --prune` → 打印领先/落后计数 → merge（或 rebase）`upstream/main`。
默认用 merge：共享分支 rebase 会改写已推送历史，只有尚未推送的 feature 分支才适合 `-Rebase`。

## 向上游提 PR

因为是真 fork，GitHub 网页 Compare & pull request 即可；命令行用跨仓方式：

```bash
git push origin feature/xxx
gh pr create --repo dataelement/dsh-desktop --base main --head aururo:feature/xxx
```

## 本机构建

### 环境准备

```powershell
Set-ExecutionPolicy -Scope Process Bypass
. .\agentbro\env.ps1          # 载入 Electron 镜像与缓存位置
npm ci                        # 依赖安装
npm run typecheck             # tsc --noEmit -p tsconfig.node.json
npm run build                 # office:prepare + ppt:build + electron-vite build
npm run package:win           # verify-target + build + electron-builder（Windows x64）
```

本地未签名的开发包用 `npm run package:dev:win`（`electron-builder.dev.cjs`）。
正式发布产物由上游的 tag workflow 签名发布，本地构建不算正式发布凭据。

### 本机网络适配

本机到 `github.com` 的 SSH 22 端口不可达，`objects.githubusercontent.com` 与
`release-assets.githubusercontent.com` 也连不上，但 `ssh.github.com:443`、
`api.github.com`、`gh-proxy.com`、`npmmirror.com` 可达。由此有三处适配：

| 环节 | 问题 | 处理 |
| --- | --- | --- |
| git fetch/push | `github.com:22` 不通 | `~/.ssh/config` 把 `github.com` 映射到 `ssh.github.com:443` |
| Electron 二进制 | GitHub releases 302 落到被墙的 CDN | `ELECTRON_MIRROR` 指向 npmmirror；`electron_config_cache` 需小写变量 |
| builder 工具包 | NSIS / winCodeSign / 7zip 也从 GitHub releases 拉 | `ELECTRON_BUILDER_BINARIES_MIRROR` 指向 npmmirror 的 `electron-builder-binaries` |
| Office Python 运行时 | `release-assets.githubusercontent.com` 超时 | 先跑 `seed-office-runtime.ps1` 把发行包按 sha256 预置进 `.build/office-downloads/`，上游脚本命中缓存后不再走网络 |

`agentbro/env.ps1` 负责前三项的环境变量，`agentbro/seed-office-runtime.ps1`
负责第四项（幂等，校验 sha256 后写入缓存）。所有缓存落在 `E:\temp` 下，
避开只剩 4GB 的 C 盘。

### 必须关闭 CRLF 转换（Windows）

仓库级配置已经设好 `core.autocrlf=false`。原因：Office / PPT 运行时按**输入字节**
做指纹校验，`OFL.txt` 的期望 sha256 是 `9ff5bb56…`，而 CRLF 版本是 `c606a29c…`，
不一致时 `check-templates.py` 会报
`OFL license does not match the approved notice font`（报错文案与字体无关，实为哈希失配）。

上游 CI 在 Windows 上也是 checkout 之前先 `git config --global core.autocrlf false`。
如果换机器或重新克隆后再次踩到，用下面这组命令把工作区刷回 LF：

```powershell
git config core.autocrlf false
git rm -r --cached . -q
git reset --hard
```

第二步不能省：只改配置不重建 index 的话，git 的 stat 缓存会把 CRLF 文件判成
"未变更"，重新检出不会真正改写字节。

其他：`api.github.com` 可直连，但 `gh` 的设备码登录走 `github.com` 会被阻断，
需要令牌时用 `gh auth login --with-token`（令牌只进本地凭据存储，不进聊天记录）。

## 已知耦合

品牌资产有三条生成脚本，它们裸用两个**没有写进 `devDependencies`** 的包。
这是有意为之：与上游保持同一套约定（上游 `scripts/generate-loader-gifs.mjs`
本身就裸用 `require('sharp')`，没声明过），改动面最小；代价是这两个包一旦从
依赖树里消失，资产生成会直接报错而不是降级。

| 包 | 用在哪 | 当前来源 | 缺失时的表现 |
| --- | --- | --- | --- |
| `sharp` | `scripts/generate-brand-assets.mjs`、`scripts/generate-app-icons.mjs`、`scripts/generate-loader-gifs.mjs` | 传递依赖：`@deepseek-ai/dsh-attachment-local` → `sharp@0.35.5`（另由本地 `dsh-image-generation` / `dsh-ppt` 复用同一份） | `npm run brand:generate` / `icons:generate` / `loader:generate` 抛 `Cannot find module 'sharp'` |
| `fontkit` | `scripts/generate-wordmark.mjs` | 传递依赖：`@deepseek-ai/dsh-skill-office` → `@deepseek-ai/libreoffice-kit` → `fontkit@2.0.4` | `npm run wordmark:generate` 抛 `Cannot find module 'fontkit'` |

两者的性质不同，值得分开看：

- `sharp` 是上游已经在用的（图标、loader GIF 生成），本仓库只是沿用。
- `fontkit` 是本仓库为了生成字标才引入的。如果哪天上游把 `dsh-skill-office`
  换掉，`fontkit` 会随之消失——此时把 `opentype.js` 提名为直接依赖，或直接
  保留已生成的 `build/agentbro-wordmark.svg`（它是入库资产，不影响运行），
  都能解掉。

`build/agentbro-wordmark.svg` 本身是**入库的静态资产**：字标已由
`scripts/generate-wordmark.mjs` 从 Inter SemiBold 转曲，运行期不需要字体文件，
也不需要 `fontkit`。生成脚本只用于改字重或改文案后重新出图。

字标字体随仓库附带在 `scripts/fonts/`：

| 文件 | 说明 |
| --- | --- |
| `inter-latin-600-normal.woff2` | Inter SemiBold 的 latin 子集，24 KB |
| `Inter-OFL.txt` | SIL Open Font License 1.1 全文 |

OFL 允许自由使用与再分发（包括嵌入到商业产品），条件是随附许可声明并保留
字体名称「Inter」。本仓库两者都满足：许可文件在 `scripts/fonts/Inter-OFL.txt`，
字标 SVG 的注释里写明了字体来源与名称。

