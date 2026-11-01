/**
 * Behavioural tests for dsh-llm-pi-ai-image-offload.
 *
 * The plugin imports nothing, so these tests need no stub package. The
 * `LlmAdapter` double below reproduces the shipped base class: a no-op
 * `imageRequestPricing` and a pass-through `imageRequestTarget`.
 */

import assert from 'node:assert/strict'
import { apply, inject, name } from '../lib/index.js'

const results = []
function test(label, fn) {
  try {
    fn()
    results.push(['PASS', label])
  } catch (error) {
    results.push(['FAIL', label, error?.message ?? String(error)])
  }
}

/** The shipped base class shape. */
class BaseAdapter {
  /** "This route declares no image pricing." */
  imageRequestPricing(_provider, _model) {}
  imageRequestTarget(_provider, _model, image) {
    return { width: image.width, height: image.height, maxBytes: image.bytes }
  }
}

/** A pi-ai-shaped adapter: base pricing, real target resolution. */
class FakePiAiAdapter extends BaseAdapter {
  constructor(profile = {}) {
    super()
    this.config = {
      resolveAttachments: () => ({}),
      resolveImageAccess: (_attachments, ref) => ({ readonlyPath: `/tmp/${ref.attachmentId}.png` }),
    }
    this.profile = { requestImagePixelBudget: 4194304, requestImageMaxBytes: 1048576, ...profile }
  }
  imageRequestTarget(_provider, _model, image) {
    const scale = Math.min(
      1,
      Math.sqrt(this.profile.requestImagePixelBudget / (image.width * image.height)),
    )
    return {
      width: Math.round(image.width * scale),
      height: Math.round(image.height * scale),
      maxBytes: this.profile.requestImageMaxBytes,
    }
  }
}

/** A deepseek-shaped adapter that answers real pricing of its own. */
class FakeDeepSeekAdapter extends BaseAdapter {
  imageRequestTarget() {
    return { width: 1, height: 1, maxBytes: 1 }
  }
  imageRequestPricing() {
    return { priceImages: (images) => images.map(() => ({ visualTokens: 7, text: 'REAL' })) }
  }
}

/** Build a context double with an adapter registry. */
function makeContext(entries) {
  const adapters = new Map(entries.map(([provider, adapter]) => [provider, { provider, adapter }]))
  const listeners = new Map()
  const warnings = []
  return {
    adapters,
    warnings,
    ctx: {
      get: (key) => (key === 'llm' ? { adapters } : undefined),
      logger: { warn: (m) => warnings.push(m) },
      on: (event, handler) => {
        const list = listeners.get(event) ?? []
        list.push(handler)
        listeners.set(event, list)
      },
    },
    emit: (event) => {
      for (const handler of listeners.get(event) ?? []) handler()
    },
  }
}

const IMAGE_2K = {
  attachmentId: 'sha256:' + 'a'.repeat(64),
  mediaType: 'image/jpeg',
  width: 2048,
  height: 2048,
  bytes: 1266320,
}

// 1 MiB route budget -> base64(1048576) = 1398104 chars -> 349526 tokens at 4 chars/token.
const PRICED_TOKENS = 349526

test('exports the expected cordis identity', () => {
  assert.equal(name, 'llm-pi-ai-image-offload')
  assert.deepEqual(inject, ['llm'])
})

test('installs pricing on a pi-ai style adapter', () => {
  const adapter = new FakePiAiAdapter()
  const box = makeContext([['fanfan-api', adapter]])
  apply(box.ctx, undefined)
  const pricing = adapter.imageRequestPricing('fanfan-api', 'deepseek-v4.1-flash')
  assert.ok(pricing, 'pricing must be defined for the route')
  assert.equal(typeof pricing.priceImages, 'function')
})

test('prices a 2048x2048 JPEG far above the 12500 inline cap', () => {
  const adapter = new FakePiAiAdapter()
  const box = makeContext([['fanfan-api', adapter]])
  apply(box.ctx, undefined)
  const [price] = adapter
    .imageRequestPricing('fanfan-api', 'm')
    .priceImages([{ type: 'image', attachment: IMAGE_2K }])
  assert.equal(price.visualTokens, PRICED_TOKENS)
  assert.ok(price.visualTokens > 12500, 'must exceed spill-policy maxInlineTokens')
})

test('clamps priced bytes to the route request budget', () => {
  const adapter = new FakePiAiAdapter()
  const box = makeContext([['fanfan-api', adapter]])
  apply(box.ctx, undefined)
  const huge = { ...IMAGE_2K, bytes: 9_000_000 }
  const [price] = adapter
    .imageRequestPricing('p', 'm')
    .priceImages([{ type: 'image', attachment: huge }])
  assert.equal(price.visualTokens, PRICED_TOKENS)
})

test('descriptor text matches the shipped serializer shape', () => {
  const adapter = new FakePiAiAdapter()
  const box = makeContext([['fanfan-api', adapter]])
  apply(box.ctx, undefined)
  const [price] = adapter
    .imageRequestPricing('p', 'm')
    .priceImages([{ type: 'image', attachment: IMAGE_2K }])
  // Byte-for-byte shape of the shipped `requestImageHandleText`.
  assert.equal(
    price.text,
    'Image sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; request preview 2048x2048px.' +
      ' Normalized copy (read-only; may be resized or re-encoded): "/tmp/sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png" (2048x2048px, image/jpeg).' +
      ' Source dimensions, format, and byte size may differ. Copy to a writable path ending in .jpg before editing.',
  )
})

test('descriptor text without access matches the shipped shape', () => {
  const adapter = new FakePiAiAdapter()
  adapter.config.resolveAttachments = () => undefined
  const box = makeContext([['fanfan-api', adapter]])
  apply(box.ctx, undefined)
  const [price] = adapter
    .imageRequestPricing('p', 'm')
    .priceImages([{ type: 'image', attachment: IMAGE_2K }])
  assert.equal(
    price.text,
    'Image sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; request preview 2048x2048px.' +
      ' It may be resized or re-encoded; source dimensions, format, and byte size may differ.',
  )
})

test('offloaded occurrences cost only their placeholder', () => {
  const adapter = new FakePiAiAdapter()
  const box = makeContext([['fanfan-api', adapter]])
  apply(box.ctx, undefined)
  const [price] = adapter
    .imageRequestPricing('p', 'm')
    .priceImages([{ type: 'image', attachment: IMAGE_2K, offloaded: true }])
  assert.equal(price.visualTokens, 0)
  assert.match(price.text, /image omitted to fit request image limits/)
  assert.match(price.text, /^\[image omitted/)
})

test('never overwrites an adapter with real pricing', () => {
  const adapter = new FakeDeepSeekAdapter()
  const box = makeContext([['deepseek', adapter]])
  apply(box.ctx, undefined)
  const pricing = adapter.imageRequestPricing('deepseek', 'm')
  assert.equal(pricing.priceImages([{}])[0].text, 'REAL')
})

test('detects a no-op pricing from a different module instance', () => {
  // A foreign copy of the base class returns undefined but is not our prototype.
  const adapter = new FakePiAiAdapter()
  adapter.imageRequestPricing = function foreignNoOp() {}
  const box = makeContext([['fanfan-api', adapter]])
  apply(box.ctx, undefined)
  const [price] = adapter
    .imageRequestPricing('p', 'm')
    .priceImages([{ type: 'image', attachment: IMAGE_2K }])
  assert.ok(price.visualTokens > 12500, 'a foreign no-op must still be augmented')
})

test('leaves a throwing implementation untouched', () => {
  const adapter = new FakePiAiAdapter()
  const original = function strictPricing() {
    throw new Error('route refuses pricing')
  }
  adapter.imageRequestPricing = original
  const box = makeContext([['fanfan-api', adapter]])
  apply(box.ctx, undefined)
  assert.equal(adapter.imageRequestPricing, original, 'a throwing impl must not be replaced')
})

test('honours an explicit providers allowlist', () => {
  const wanted = new FakePiAiAdapter()
  const other = new FakePiAiAdapter()
  const box = makeContext([
    ['fanfan-api', wanted],
    ['elsewhere', other],
  ])
  apply(box.ctx, { providers: ['fanfan-api'] })
  assert.ok(wanted.imageRequestPricing('fanfan-api', 'm'), 'allowlisted route must be patched')
  assert.equal(other.imageRequestPricing('elsewhere', 'm'), undefined, 'other route untouched')
})

test('answers one price per occurrence, in order', () => {
  const adapter = new FakePiAiAdapter()
  const box = makeContext([['fanfan-api', adapter]])
  apply(box.ctx, undefined)
  const images = [
    { type: 'image', attachment: { ...IMAGE_2K, attachmentId: 'sha256:' + 'b'.repeat(64), bytes: 100000 } },
    { type: 'image', attachment: { ...IMAGE_2K, attachmentId: 'sha256:' + 'c'.repeat(64), bytes: 4000000 }, offloaded: true },
    { type: 'image', attachment: IMAGE_2K },
  ]
  const prices = adapter.imageRequestPricing('p', 'm').priceImages(images)
  assert.equal(prices.length, images.length)
  // `offloaded` is read from the block, not from the attachment.
  assert.equal(prices[1].visualTokens, 0)
  assert.ok(prices[0].visualTokens > 0)
  assert.match(prices[1].text, /image omitted to fit request image limits/)
})

test('re-applies after the route set is replaced', () => {
  const box = makeContext([])
  apply(box.ctx, undefined)
  const adapter = new FakePiAiAdapter()
  box.adapters.set('fanfan-api', { provider: 'fanfan-api', adapter })
  box.emit('llm/adapters-updated')
  assert.ok(adapter.imageRequestPricing('p', 'm'), 'late-registered adapter must get pricing')
})

test('is idempotent across repeated updates', () => {
  const adapter = new FakePiAiAdapter()
  const box = makeContext([['fanfan-api', adapter]])
  apply(box.ctx, undefined)
  const first = adapter.imageRequestPricing
  box.emit('llm/adapters-updated')
  box.emit('llm/adapters-updated')
  assert.equal(adapter.imageRequestPricing, first, 'must not re-wrap its own patch')
})

test('honours enabled: false', () => {
  const adapter = new FakePiAiAdapter()
  const box = makeContext([['fanfan-api', adapter]])
  apply(box.ctx, { enabled: false })
  assert.equal(adapter.imageRequestPricing('p', 'm'), undefined)
})

test('degrades quietly when the registry is unavailable', () => {
  const box = makeContext([])
  box.ctx.get = () => undefined
  apply(box.ctx, { debug: true })
  assert.ok(box.warnings.some((w) => w.includes('adapter registry unavailable')))
})

test('survives a target resolver that throws', () => {
  const adapter = new FakePiAiAdapter()
  adapter.imageRequestTarget = () => {
    throw new Error('route cannot describe projection')
  }
  const box = makeContext([['fanfan-api', adapter]])
  apply(box.ctx, undefined)
  const [price] = adapter
    .imageRequestPricing('p', 'm')
    .priceImages([{ type: 'image', attachment: IMAGE_2K }])
  assert.ok(price.visualTokens > 12500)
  assert.equal(typeof price.text, 'string')
})

test('respects a custom charsPerToken', () => {
  const adapter = new FakePiAiAdapter()
  const box = makeContext([['fanfan-api', adapter]])
  apply(box.ctx, { charsPerToken: 8, maxVisualTokens: 1000000 })
  const [price] = adapter
    .imageRequestPricing('p', 'm')
    .priceImages([{ type: 'image', attachment: IMAGE_2K }])
  assert.equal(price.visualTokens, Math.ceil(1398104 / 8))
})

for (const [status, label, detail] of results) {
  console.log(`${status}  ${label}${detail ? `\n       ${detail}` : ''}`)
}
const failed = results.filter(([s]) => s === 'FAIL').length
console.log(`\n${results.length - failed}/${results.length} passed`)
if (failed > 0) process.exitCode = 1
