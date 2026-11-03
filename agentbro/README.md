# AgentBro 上游关系

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

- `main` —— 产品主线，跟随 `origin/main`
- `feature/*` —— 二次开发分支，完成后合回 `main`

上游快照保持干净：`main` 与 `upstream/main` 的差异就是我们的全部定制，
`git diff upstream/main..main` 可以随时看清自己改了什么。

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

## 网络说明

本机到 `github.com` 的 HTTPS 与 SSH 22 端口不可达，但 `ssh.github.com:443` 可连通。
`~/.ssh/config` 已把 `github.com` 映射到 `ssh.github.com:443`，因此所有 git 操作走 SSH 443：

```
Host github.com
    HostName ssh.github.com
    Port 443
    User git
    IdentityFile ~/.ssh/id_rsa
```

GitHub API（`api.github.com`）可直连；`gh` 的设备码登录走 `github.com` 会被阻断，
需要令牌时用 `gh auth login --with-token`（令牌只进本地凭据存储，不进聊天记录）。
