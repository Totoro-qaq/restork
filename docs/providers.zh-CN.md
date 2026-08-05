<p align="center">
  <a href="./providers.md">English</a> · <strong>简体中文</strong>
</p>

# 模型供应商与思考强度

Restork 把模型选择保存在版本化的 Provider Profile 中。一次运行会冻结供应商、精确的端点来源、
模型 ID、思考策略与原生密钥引用。修改 Profile 会生成新修订，不会暗中改变已经开始的工作。

## 已支持的供应商

| 供应商 | 端点规则 | Restork 会显示的思考选项 |
|---|---|---|
| DeepSeek | 仅官方端点 | 自动、关闭、高、最大 |
| GLM | 仅官方端点 | 自动、关闭、高、最大 |
| Kimi | 仅官方端点 | 自动、关闭 |
| Qwen | 仅官方端点 | 自动、关闭、最少、低、中、高、超高、最大；可选 Token 预算 |
| Ollama | 仅本机 loopback | 自动、关闭、低、中、高 |
| OpenRouter | 仅官方端点 | 自动、关闭、最少、低、中、高、超高、最大；可选 Token 预算 |
| OpenAI-compatible | 用户填写的公网 HTTPS 端点 | 仅自动；通用适配器不会猜测供应商专有字段 |

这张列表由能力注册表生成。在**设置 → 模型供应商**中切换供应商后，不支持的档位会直接消失。
保存时 Core 还会再次校验；不支持的值会明确失败，不会被四舍五入、静默忽略或转发给其他供应商。

“自动”保留模型自己的默认思考行为；“关闭”会使用该供应商公开支持的方式关闭思考模式；其余档位
是供应商范围内的强度提示，不能把不同厂商的“高”当成同一个性能单位。强度升高通常会增加延迟和
费用，而且部分模型 ID 即使所在协议支持档位，也可能忽略它。选好模型后请运行连接测试。

Restork 只记录所选策略、持久阶段、最终回答与汇总用量；不会为了展示而索取私有思维链，也不会把
思维链保存成运行轨迹。

## 在 Dashboard 中配置

1. 打开**设置 → 模型供应商**。
2. 选择供应商，填写精确模型 ID，再选择这个供应商支持的思考强度。
3. 云端模型通过原生凭据流程保存 Key；界面里只填写引用，例如
   `keychain:restork/provider/deepseek`。
4. 保存 Provider Profile，再把它绑定到一个受控 Work Profile。
5. 在保存后的 Provider Profile 卡片上运行**测试模型**。它会使用刚才保存的供应商与精确模型；
   只有你选择 DeepSeek Profile 时才会走 DeepSeek。

首页的**模型中心**会同步显示这些 Profile。选择器会展示精确模型，诊断请求会携带所选 Profile
ID，终端配置命令也会随供应商变化。尚未保存的条目只是配置入口，不是可用的模型回退，因此
测试按钮会保持禁用。

## 在对话中切换模型

打开**对话 → 换一个模型继续**，即可选择另一个已配置 Profile。这个快速选择入口借鉴了 Hermes
Agent：显示精确供应商/模型，把供应商接入留在设置页。但 Restork 的信任语义不同——它不会在
原地改写当前对话已经冻结的 Profile。

Core 会创建一个独立对话分支：最多复制最近 24 条消息与 120 KB，移除旧请求、供应商和工具
元数据，逐条检查目标 Profile 的数据分类上限，并在源对话已变化时原子拒绝。原对话与审计链保持
不变。因此 public-only 云端 Profile 不能继承 personal 或 confidential 消息；请选择边界足够的
Profile，或者从空白对话开始。

API Key 不会进入 Dashboard JavaScript。从源码使用时，原生配置命令按供应商区分；省略类型时
仍默认配置 DeepSeek：

```bash
cargo run --manifest-path rust/Cargo.toml -p restorkd -- provider configure
cargo run --manifest-path rust/Cargo.toml -p restorkd -- provider configure qwen
cargo run --manifest-path rust/Cargo.toml -p restorkd -- provider configure kimi
```

可配置 `deepseek`、`glm`、`kimi`、`qwen`、`openrouter` 与 `open_ai_compatible`。命令会打印
一个不含 Key 的原生引用，把它填入对应 Provider Profile 即可；本地 Ollama 不需要密钥。

## DeepSeek 模型分工与连接测试

一个 DeepSeek API Key 可以调用多个 DeepSeek 模型 ID，Restork 不会要求你重复保存同一密钥。
内置分工是显式路由，不是失败后的静默回退：

| 用途 | 模型 | API | Dashboard / CLI 测试 |
|---|---|---|---|
| 主要对话与综合 | `deepseek-v4-pro` | `/chat/completions` | **测试 V4 Pro** / `restorkd doctor --smoke` |
| 有界联网研究 | `deepseek-v4-flash` | `/responses`，强制服务端 `web_search` | **测试 V4 Flash 联网** / `restorkd doctor --web-search` |

**检查 Key 与模型**（或 `restorkd doctor --connect`）只验证鉴权与模型发现，不生成回答。模型
短句测试必须单独执行，因为 `/models` 成功不代表推理或联网工具一定可用。诊断不会偷偷切到另一个
模型；Flash 的付费联网请求也不会自动重试，避免超时后重复计费。

## 本地 Ollama

先自行启动 Ollama，再选择 **Ollama**，端点保持为 `http://127.0.0.1:11434` 这类精确 loopback
来源。Restork 会拒绝凭据、远程主机、URL 用户信息与路径绕过；模型列表从本地 tags 接口读取。

## 回退策略

默认不回退。模型出错时，Restork 不会擅自把本地请求移到云端，也不会从一个厂商切到另一个厂商。
显式配置的备用供应商仍是独立的数据目的地，切换前必须确认。

## 增加新供应商

新增一个经过审查的注册表定义和供应商专属请求适配器，不要在共享传输层按模型名或主机名猜行为。
在设置中开放前，需要补齐确定性请求形状、端点策略、脱敏、取消、异常响应与能力校验测试。
