# @deepseek-ai/dsh-command-session-title

[English](README.md) | 中文

面向用户的 `/rename [instruction]`，由已注册的会话标题提供方执行。该命令针对接收命令的 agent（智能体）会话调用 `ctx.sessionTitle.refresh()`，因此所有已组合的命令适配器都会发现相同行为，随附的 Web 客户端无需主模型轮次即可执行它。

## 命令约定

| 输入 | 结果 |
|---|---|
| `/rename` | 根据会话当前经过 compaction 的派生消息表层重新生成标题。 |
| `/rename <instruction>` | 根据相同的派生消息表层重新生成，并将去除首尾空白的说明附加到标题模型请求。 |
| 在出现符合条件的提示词前使用任一形式，或未配置提供方 | 直接返回错误，不声称生成了模型标题。 |

成功结果会给出已接受的标题，并将 `session/title` 事件 seq 作为 `sourceEventSeq`。该命令设置 `recordInput: false`：精确的辅助 `session/title-llm-request` 消息负责保存任何实际到达模型的用户说明，`command/run` 与 `command/done` 则保留命令生命周期。只有空白的输入等价于不带说明。标题提供方预留输出、系统提示词和 JSON／消息封装 token 后，当前完整派生表层与可选说明必须能够放入剩余预算；否则命令会在模型分发前失败，并提示用户先 compact 会话或选择上下文窗口更大的标题模型。

该命令表示“再生成一个标题”。它不会调用 `SessionTitleService.rename(session, exactTitle)`；后者是另一项直接编辑 API，会记录用户来源的标题，并将其钉住以免被自动生成覆盖。

## 组合

该命令需要命令注册表与标题服务。由模型支持的部署还会挂载一个标题提供方：

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: session-title
  name: '@deepseek-ai/dsh-session-title'
- id: session-title-llm
  name: '@deepseek-ai/dsh-session-title-first-prompt-llm'
- id: command-session-title
  name: '@deepseek-ai/dsh-command-session-title'
```

随附的 base bundle 会挂载上述四项。该包也导出 `dsh.bundle` patch 层；由于 base 已拥有该行，该层会幂等地定位现有 id，而不会插入重复项。Web 命令目录从 Host 注册表发现 `/rename`；无需浏览器插件或命令专用 RPC。

## 模型体验

### 显式重新生成标题

#### 模型看到的内容

主对话模型不会看到命令生命周期或已接受的标题。独立的标题请求包含当前完整的 `session.deriveMessages()` 表层，因此会与主模型看到的 compaction 结果一致；提供说明时，还会收到跟在这些消息之后、经过 JSON 编码的说明。标题提供方会解析所选模型的 `contextWindow`，并预留标题输出、系统提示词和 JSON／消息封装 token；完整输入无法容纳时，它会在分发前拒绝，而不会丢弃或剪裁任何当前消息。

#### Token 影响

每次成功调用都会启动一次受所选模型上下文窗口和输出限制约束的辅助标题模型请求。主 agent 请求不会增加 token。

#### KV Cache 影响

不会使主请求失效。辅助缓存复用由提供方决定；后续提示词或不同说明会改变标题请求的用户消息。

## 已知限制与暂缓事项

- **说明并非确定性标题**：可选参数会引导提供方，但不强制生成确切文本；直接编辑标题仍是另一项 UI 与服务操作。
- **完整派生表层是标题输入**：显式 `/rename` 会包括主模型可见的、经过 compaction 的 assistant、user 和 tool 消息。
- **当前表层过大时拒绝调用**：完整派生表层无法容纳时，应先 compact 会话或配置上下文窗口更大的标题模型。
