# dsh-llm-pi-ai-image-offload

给「不声明图片计价的适配器路由」补上 **request-image token 计量**。实践中，
就是所有由 `@deepseek-ai/dsh-llm-pi-ai` 服务的路由。

## 为什么叫 image-offload 而不是 pricing

这个包按它**恢复的能力**命名，而不是按它**补的方法**命名。

被补的方法是 `imageRequestPricing`，它的职责是把一张图折算成 **token 数**，
好让预算检查能拿它跟 `maxInlineTokens` 比，把放不下的内容挪出请求。
这里的 "pricing" 指 **token 计量，不是计费**。

> 补上 `imageRequestPricing` → 图片有了 token 价 → `spill-policy` 才能判断
> 「这张图太大放不下」→ 触发 image offload。名字取的是终点，不是起点。

## 它修的是什么问题

`LlmAdapter.imageRequestPricing()` 基类默认返回 `undefined`，含义是「本路由不声明
图片计价」。整包里只有 `dsh-llm-deepseek` 覆盖了它，**`dsh-llm-pi-ai` 没有**。

`@deepseek-ai/dsh-spill-policy` 只要遇到带图的工具结果，就会去要这个计算器：

```js
const calculator = ctx.get("llm")?.imageRequestPricing(provider, model);
if (calculator === undefined) throw new Error("the current model has no image token calculator");
```

这个 `throw` 被 `spill-policy` 自己的外层 `try` 捕获，记一条
`spill-policy: ...; keeping the inline content` 的 warn，然后 **直接 return**，
什么也不改。

结果就是：**整个工具结果原样内联**。几 MB 的 base64 图片一字不差地发给
provider，把上下文窗口吃掉。

`@deepseek-ai/dsh-token-meter` 受同样影响，退化成固定结构估算，而不是按实际
发送的字节计价。

### 实测症状

一张 2048×2048、1,266,320 字节的 JPEG，base64 后约 169 万字符，约 **42 万 token**。
如果上下文窗口是 262,144，单个工具结果就能直接打爆——表现为
`CONTEXT_WINDOW_EXCEEDED`。

## 这个插件做了什么

它给**实例**上补 `imageRequestPricing`，只补那些不返回计价的实例，并在每次
`llm/adapters-updated` 事件时重新应用。

三条自我约束：

- **已有真实实现的不碰**。上游一旦自己实现，这个补丁自动退场。
- **实现会抛异常的不替换**。抛异常说明有真实现，不能覆盖。
- **零运行时依赖**。因此不存在加载期解析不到宿主包的风险。描述文本用到的两个
  helper 是照官方实现逐字节复刻的，集成测试会对着真实的 `@deepseek-ai/dsh-llm`
  断言两者完全相等。

## 计价模型

这些路由不公布 vision token 的账法，所以按**实际传输的字节**计价：

```
transmitted  = min(attachment.bytes, imageRequestTarget(...).maxBytes)
visualTokens = ceil(base64Length(transmitted) / charsPerToken)
```

其中 `base64Length(b) = ceil(b / 3) * 4`，与平台自己的字节账法一致。

**关键点**：这跟 `spill-policy` 拿来比 `maxInlineTokens` 的是**同一个单位**，
所以才能真的触发「把过大的图挪出去」。

前述那台机器上的案例：2048×2048 / 1,266,320 字节、路由请求预算 1 MiB，算下来是
`base64(1048576) / 4 = 349,526` token，远高于默认的 `maxInlineTokens: 12500`。

## 配置

全部可选。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 完全关闭此补丁 |
| `charsPerToken` | `4` | 每个 token 对应多少 base64 字符 |
| `maxVisualTokens` | `400000` | 单次出现（occurrence）的上限 |
| `providers` | *(全部)* | provider 路由 id 白名单 |
| `debug` | `false` | 把每条被打补丁的路由写进 logger |

配置示例（写进 profile 的 patch）：

```yaml
- id: llm-pi-ai-image-offload
  name: dsh-llm-pi-ai-image-offload
  config:
    debug: true
```

## 移出请求之后，模型还能看到图吗

能。**offload 不等于删除**：

- 不会从会话里删掉图片块
- 不会动工作区里的原图文件
- 模型收到的是 `spill-policy` 的通知，外加一个可以再用 `read_image` 读回来的路径

所以图是可恢复的，不是丢失的。

## 如何确认它生效了

**别去看日志。** 平台 logger 只有内存环形缓冲（1000 条），没有文件 sink，重启即丢，
事后翻不到那条 warn。

可行的验证方式：

1. 配置里开 `debug: true`
2. 生成一张大图
3. 查会话日志（`session.v4.jsonl.zstd`）里有没有 **`image/offload`** 事件

改动之前，这个信号**从没出现过**（本机 40 个会话里 0 次），比看 warn 可靠。

## 安装

### 从 GitHub 安装（推荐）

```
dsh plugin --profile <profile> add github:ender-candle/dsh-llm-pi-ai-image-offload
```

固定到某个 commit 更稳（可复现）：

```
dsh plugin --profile <profile> add github:ender-candle/dsh-llm-pi-ai-image-offload#<sha>
```

### 从本地目录安装

```
dsh plugin --profile <profile> add /插件目录的绝对路径/dsh-llm-pi-ai-image-offload
```

### 然后激活 bundle

以上两种方式都会把包装进 profile 的 `node_modules`。接着把包名加进 profile
`package.json` 的 `dsh.profile.bundles`：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-llm-pi-ai-image-offload"]
    }
  }
}
```

bundle 自带的 `cordis.patch.yml` 会插入 host 行，**不需要手改 patch**。
之后**重启** harness——bundle 只在启动时加载。

> `dsh plugin add` 会同时写 `package.json` 和 `pnpm-lock.yaml`，
> 所以安装状态与 profile 的包管理器一致，不会出现 lockfile 与清单不匹配的问题。

## 测试

```
node test/offload.test.mjs      # 18 项单测，无需安装任何依赖
```

插件零运行时依赖，所以单测在任何机器上都能直接跑。

另有一份**不随包发布**的集成测试：它从 `app.asar` 里提取真实的宿主模块，
断言本插件产出的描述文本与官方 `requestImageHandleText` / `offloadedImageText`
**逐字节相同**。

## 风险

- **`LlmAdapter` 的实例字段不是官方扩展点。** 如果日后 registry 结构变了，
  这个补丁会**静默失效**——这是刻意设计：不生效就等于回到打补丁前的行为，
  不会变得更糟。
- **估算偏保守。** 对上游按 vision token 计价的路由会高估。这是有意的：
  只会更早触发移出请求，不会更晚。provider 返回的 `usage` 仍然是权威账本。
- **这不是根治。** 真正的修法是让 pi-ai 自己实现 `imageRequestPricing`。
  那一天到来时，本插件会自动退场。

## 兼容性

- 三种 wire 协议已实测表现一致：`openai-completions`、`openai-responses`、
  `anthropic-messages`。换 `api:` 不需要重打补丁——三个协议共用同一个
  `PiAiAdapter` 实例，且图片预算（`requestImagePixelBudget` /
  `requestImageMaxBytes`）是 **provider 级**字段，与协议无关。
- 前提是模型声明了 `input: [text, image]`。否则图片在更早阶段就被换成文字占位，
  `spill-policy` 根本不会看到它。
- 插件只保证**本地不把超大 base64 塞进上下文**，不会让不支持视觉的上游网关
  突然支持图片。上游能否收图是另一回事。
