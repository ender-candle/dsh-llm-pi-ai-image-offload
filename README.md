# dsh-llm-pi-ai-image-offload

**中文文档：[README.zh-CN.md](./README.zh-CN.md)**

Restores **request-image token pricing** for adapter routes that declare none
— in practice every route served by `@deepseek-ai/dsh-llm-pi-ai`.

Naming: the package is called `image-offload` after the capability it restores,
not after the method it patches. The patched method is `imageRequestPricing`,
whose job is to price an image in **tokens** so the budget checks can compare it
against `maxInlineTokens` and offload what does not fit. "Pricing" here is token
accounting, not billing.

## The bug this fixes

`LlmAdapter.imageRequestPricing()` returns `undefined` by default, meaning "this
route declares no image pricing". Only `dsh-llm-deepseek` overrides it. pi-ai
does not.

`@deepseek-ai/dsh-spill-policy` asks for that calculator whenever a tool result
carries images:

```js
const calculator = ctx.get("llm")?.imageRequestPricing(provider, model);
if (calculator === undefined) throw new Error("the current model has no image token calculator");
```

That throw is caught by the plugin's own outer `try`, which logs
`spill-policy: ...; keeping the inline content` and **returns nothing**. The tool
result therefore stays completely inline: a multi-megabyte base64 image goes to
the provider verbatim and consumes the context window.

`@deepseek-ai/dsh-token-meter` degrades the same way, falling back to a fixed
structural heuristic instead of pricing the bytes actually sent.

## What this plugin does

It installs `imageRequestPricing` on adapter **instances** that return no
pricing, and re-applies on every `llm/adapters-updated` event.
- An adapter that answers real pricing keeps it (an upstream fix retires this
  patch automatically).
- An adapter whose implementation *throws* is never replaced.
- Zero runtime dependencies, so it cannot fail to resolve host packages at load
  time. The descriptor helpers are reproduced byte-for-byte from the shipped
  implementation, and the integration test asserts that equality against the
  real `@deepseek-ai/dsh-llm`.

## Pricing model

These routes publish no vision-token accounting, so each occurrence is priced by
the bytes actually transmitted for it:

```
transmitted = min(attachment.bytes, imageRequestTarget(...).maxBytes)
visualTokens = ceil(base64Length(transmitted) / charsPerToken)
```

`base64Length(b) = ceil(b / 3) * 4`, matching the harness's own byte accounting.
This is the same unit `spill-policy` compares against `maxInlineTokens`, which is
what lets it shed an oversized image instead of keeping it inline.

For the reported failure case — a 2048×2048 JPEG at 1,266,320 bytes on a route
with a 1 MiB request budget — that is `base64(1048576) / 4 = 349,526` tokens,
comfortably above the default `maxInlineTokens: 12500`.

## Config

All fields optional.

| field | default | meaning |
| --- | --- | --- |
| `enabled` | `true` | turn the patch off entirely |
| `charsPerToken` | `4` | base64 character density per token |
| `maxVisualTokens` | `400000` | per-occurrence ceiling |
| `providers` | *(all)* | allowlist of provider route ids |
| `debug` | `false` | log each patched route to the harness logger |

Example profile patch:

```yaml
- id: llm-pi-ai-image-offload
  name: dsh-llm-pi-ai-image-offload
  config:
    debug: true
```

## What the model sees

Shedding does not delete the image from the session, and does not touch the
workspace file. The model receives `spill-policy`'s notice plus a path it can
re-read with `read_image`, so the image is recoverable rather than lost.

## Verifying it is active

The harness logger writes to an in-memory ring buffer that has no file sink, so a
warn is not observable after the fact. Use `debug: true` plus a large generated
image, and check the session log for `image/offload` events — before this patch
that signal never appears.

## Install

### From GitHub (recommended)

```
dsh plugin --profile <profile> add github:ender-candle/dsh-llm-pi-ai-image-offload
```

Pin a commit for a reproducible install:

```
dsh plugin --profile <profile> add github:ender-candle/dsh-llm-pi-ai-image-offload#<sha>
```

### From a local checkout

```
dsh plugin --profile <profile> add /absolute/path/to/dsh-llm-pi-ai-image-offload
```

### Then activate the bundle

Either install path puts the package in the profile's `node_modules`. Add the
name to `dsh.profile.bundles` in the profile `package.json`:

```json
{
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-llm-pi-ai-image-offload"]
    }
  }
}
```

The bundle's own `cordis.patch.yml` inserts the host row, so no manual patch
editing is needed. Restart the harness afterwards — bundles load at startup.

> `dsh plugin add` writes both `package.json` and `pnpm-lock.yaml`, so the
> install stays consistent with the profile's package manager state.

## Tests

```
node test/offload.test.mjs      # 18 unit checks, no dependencies
```

The plugin has zero runtime dependencies, so the unit test runs anywhere. A
separate integration check (not shipped) runs against host modules extracted
from `app.asar` and asserts the descriptor text is byte-identical to the
shipped `requestImageHandleText` / `offloadedImageText` serializers.

## Risks

- `LlmAdapter` instance fields are not a documented extension point. If the
  registry shape changes, the patch silently does nothing — by design, since a
  missing patch restores exactly the pre-existing behaviour.
- The estimate over-counts routes whose upstream tokenizes as vision. That is
  conservative on purpose: it triggers shedding earlier, never later. Provider
  `usage` remains the authoritative accounting anchor.
