# @deepseek-ai/dsh-session-title-first-prompt-llm

[English](README.md) | 中文

可选的 `ctx.sessionTitle` 提供方，通过 `ctx.llm` 总结符合条件的人类消息。它注册 `first-prompt` 节奏，只在全新非 fork 会话首次创建回退时自动运行，并且自动生成结果只使用第一条消息。显式调用 `ctx.sessionTitle.refresh()` 会使用会话当前经过 compaction 的 `deriveMessages()` 表层，并可附加用户说明；共享输入策略会在实际模型上下文窗口扣除预留后保留最新的完整消息后缀。

该插件使用完整且必填的[共享 LLM（大语言模型）配置](../session-title-llm/README.md#configuration)。同时省略 `provider` 与 `model` 时，会继承当前已记录主请求的确切路由；也可以同时设置二者，使标题生成使用独立路由。

## 模型体验

### 首消息标题请求

#### 模型看到的内容

自动标题调用会收到共享标题指令，以及一个只包含第一条符合条件人类消息的 JSON 数组。显式刷新最初选择当前 `deriveMessages()` 表层（包括 compaction 替换）及可选的 JSON 编码用户说明，随后在预留标题输出、系统提示词和 JSON／消息封装 token 后保留最大最新消息后缀。后续提示词与继承的 fork 历史不会触发再次自动调用。

#### Token 影响

全新会话最多自动发出一次辅助请求；每次显式刷新都会根据所选模型上下文窗口和 `maxOutputTokens` 发出另一次受限调用。主 agent（智能体）请求不会增加 token。

#### KV Cache 影响

不会使主请求的 KV Cache 失效。辅助请求使用已配置或已记录路由，其缓存行为由提供方决定。

## 已知限制与暂缓事项

- 对于长期会话，第一条消息可能不再具有代表性；需要显式按近期对话刷新时可运行 `/rename`，需要自动修订时则使用全提示词提供方。
- fork 会保留继承的标题，绝不会自动运行此提供方，即使其预置的首消息来自父会话。
