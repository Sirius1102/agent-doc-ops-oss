# Skill 安装器（install-skill.js）

把本仓的 `skills/agent-doc-ops/` 装进 agent 的技能目录，一条命令完成：

```bat
node install-skill.js            # 自动探测技能目录并安装
node install-skill.js --list     # 只列出探测到的目录，不写
node install-skill.js --dir C:\Users\me\.codex\skills   # 显式指定目标
```

安装内容：把 `skills/agent-doc-ops/` 原样拷到 `<目标>/agent-doc-ops/`（已存在则先备份为
`agent-doc-ops.bak-<时间戳>` 再覆盖）。安装器只写技能目录，不碰其它任何位置。

探测顺序（第一个存在的生效，也可用 `--dir` 覆盖）：

| 环境 | 目录 |
|---|---|
| Codex | `%USERPROFILE%\.codex\skills` |
| Claude | `%USERPROFILE%\.claude\skills` |
| DSH | `%USERPROFILE%\.dsh\skills` |
| OpenCode | `%USERPROFILE%\.opencode\skills` |
| 通用 fallback | `%USERPROFILE%\.agent\skills` |

装完后验证：技能列表里出现 `agent-doc-ops`，或直接跑
`node <REPO>\dockit.js doctor` 确认装置可用（`ok=true`）。
