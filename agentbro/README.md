# AgentBro 上游关系

本仓库基于 `dataelement/dsh-desktop`（DSH Desktop，MIT 协议）二次开发，名称为 `aururo/AgentBro`。

## 为什么是独立仓库而不是 fork

上游 fork 通道在本机不可用（GitHub 网页端 fork 表单持续返回 `Something went wrong!`，
且 `aururo` 账号在该仓库的 fork network 中不存在），因此改用「独立仓库 + upstream remote」：

- 优势：不受 GitHub fork network 的命名与数量限制，仓库名、可见性、分支结构完全自控。
- 代价：没有 GitHub 平台层的 fork 关系，因此没有 Sync fork 按钮、看不到 ahead/behind 计数，
  向上游提 PR 需要用跨仓方式（见下）。

## remote 说明

| remote | 地址 | 用途 |
| --- | --- | --- |
| `upstream` | `git@github.com:dataelement/dsh-desktop.git` | 上游基线，只读取新提交 |
| `origin` | `git@github.com:aururo/AgentBro.git` | 自己的仓库，推送与发布 |

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

## 向上游提 PR

因为没有 fork 关系，需要跨仓提：

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

GitHub API（`api.github.com`）可直连，`gh` 的设备码登录走 `github.com` 会被阻断，
需要令牌时用 `gh auth login --with-token`（令牌只进本地凭据存储，不进聊天记录）。
