/**
 * dsh-llm-pi-ai-image-offload
 *
 * Restores request-image token pricing for adapter routes that declare none.
 *
 * Why this exists
 * ---------------
 * `LlmAdapter.imageRequestPricing()` returns `undefined` by default, meaning
 * "this route declares no image pricing". Only `dsh-llm-deepseek` overrides it,
 * so every route served by the generic `dsh-llm-pi-ai` adapter answers none.
 *
 * Two consumers need an answer:
 *
 *   1. `dsh-spill-policy` asks for it whenever a tool result carries images.
 *      When it is missing the plugin throws "the current model has no image
 *      token calculator" and its outer catch swallows that error, leaving the
 *      whole tool result inline. Over-large base64 images then reach the
 *      provider verbatim and fill the context window.
 *   2. `dsh-token-meter` falls back to a fixed structural heuristic instead of
 *      pricing the representation actually sent.
 *
 * What it patches
 * ---------------
 * It installs `imageRequestPricing` on adapter *instances* that do not already
 * answer real pricing. An adapter with its own implementation keeps it, so an
 * upstream fix retires this patch automatically.
 *
 * Zero dependencies on purpose
 * ----------------------------
 * This module imports nothing. `@deepseek-ai/dsh-llm` is a devDependency of the
 * shipped plugins and is not installed in a profile's `node_modules`, so a bare
 * import here could fail to resolve at load time and take the whole plugin down.
 * The two descriptor helpers below are therefore reproduced byte-for-byte from
 * the shipped implementation; `test/pricing.test.mjs` asserts the produced text
 * matches that implementation's shape.
 *
 * Pricing model
 * -------------
 * These routes publish no vision-token accounting, so each occurrence is priced
 * by the bytes actually transmitted for it: the request-version byte length,
 * clamped to the route's `maxBytes` target, expanded to base64 and divided by a
 * configurable character density. That is the same unit the harness uses to
 * decide a request is oversized, which is what lets `spill-policy` shed an
 * oversized image instead of keeping it inline. It deliberately over-estimates
 * routes whose upstream tokenizes as vision.
 *
 * @module dsh-llm-pi-ai-image-offload
 */

/** Cordis plugin identity. */
export const name = 'llm-pi-ai-image-offload'

/** The LLM service owns the adapter registry this plugin augments. */
export const inject = ['llm']

/** Marks an adapter instance this plugin has already augmented. */
const PATCHED = Symbol.for('dsh-llm-pi-ai-image-offload.patched')

const DEFAULTS = {
  enabled: true,
  charsPerToken: 4,
  maxVisualTokens: 400000,
  debug: false,
}

/**
 * Base64 character length of a raw byte count, including padding.
 * @param {number} bytes - raw representation length.
 * @returns {number} base64 length.
 */
function base64Length(bytes) {
  return Math.ceil(bytes / 3) * 4
}

/**
 * JSON-quote a value the way the shipped descriptor helpers do.
 * @param {string} value - raw text.
 * @returns {string} quoted text.
 */
function quoted(value) {
  return JSON.stringify(value)
}

/**
 * Stable per-attachment identity, matching the shipped `imageIdentity`.
 * @param {object} ref - durable attachment reference.
 * @returns {string} identity text.
 */
function imageIdentity(ref) {
  return ref.name === void 0 ? String(ref.attachmentId) : `${quoted(ref.name)} (${ref.attachmentId})`
}

/**
 * File extension for a supported image media type.
 * @param {string} mediaType - attachment media type.
 * @returns {string} dotted extension.
 */
function extension(mediaType) {
  switch (mediaType) {
    case 'image/png':
      return '.png'
    case 'image/jpeg':
      return '.jpg'
    case 'image/webp':
      return '.webp'
    case 'image/gif':
      return '.gif'
    default:
      // Unknown media types never reach here for normalized images; stay safe.
      return '.png'
  }
}

/**
 * Normalized-copy sentence, matching the shipped `normalizedAccessText`.
 * @param {object} ref - durable attachment reference.
 * @param {{readonlyPath: string}} access - resolved execution-world access.
 * @returns {string} access sentence.
 */
function normalizedAccessText(ref, access) {
  return ` Normalized copy (read-only; may be resized or re-encoded): ${quoted(access.readonlyPath)} (${ref.width}x${ref.height}px, ${ref.mediaType}). Source dimensions, format, and byte size may differ. Copy to a writable path ending in ${extension(ref.mediaType)} before editing.`
}

/**
 * Handle text for one exact request image, matching `requestImageHandleText`.
 * @param {object} ref - durable attachment reference.
 * @param {{width: number, height: number}} version - request-image dimensions.
 * @param {{readonlyPath: string} | undefined} access - resolved access, if any.
 * @returns {string} descriptor text.
 */
function requestImageHandleText(ref, version, access) {
  const preview = `Image ${imageIdentity(ref)}; request preview ${version.width}x${version.height}px.`
  return access === undefined
    ? `${preview} It may be resized or re-encoded; source dimensions, format, and byte size may differ.`
    : preview + normalizedAccessText(ref, access)
}

/**
 * Placeholder text for an image omitted from the request, matching
 * `offloadedImageText`.
 * @param {object} ref - durable attachment reference.
 * @param {{readonlyPath: string} | undefined} access - resolved access, if any.
 * @returns {string} placeholder text.
 */
function offloadedImageText(ref, access) {
  const identity = `image omitted to fit request image limits; ${imageIdentity(ref)}.`
  if (access === undefined) {
    return `[${identity} No local normalized image path is available; ask the user to attach it again if needed.]`
  }
  return `[${identity}${normalizedAccessText(ref, access)}]`
}

/**
 * Resolve options once, tolerating a missing or partial config.
 * @param {unknown} config - loader-provided configuration.
 * @returns {{enabled: boolean, charsPerToken: number, maxVisualTokens: number, debug: boolean, providers: readonly string[] | undefined}}
 */
function resolveOptions(config) {
  const source = config && typeof config === 'object' ? config : {}
  const positive = (value, fallback) =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
  const providers = Array.isArray(source.providers)
    ? source.providers.filter((entry) => typeof entry === 'string' && entry.length > 0)
    : undefined
  return {
    enabled: source.enabled !== false,
    charsPerToken: positive(source.charsPerToken, DEFAULTS.charsPerToken),
    maxVisualTokens: positive(source.maxVisualTokens, DEFAULTS.maxVisualTokens),
    debug: source.debug === true,
    providers: providers !== undefined && providers.length > 0 ? providers : undefined,
  }
}

/**
 * Resolve the execution-world path for one attachment, matching the path the
 * pi-ai serializer puts in the descriptor text.
 * @param {object} adapter - augmented adapter instance.
 * @param {unknown} ref - durable attachment reference.
 * @returns {{readonlyPath: string} | undefined} provider-resolved access.
 */
function accessOf(adapter, ref) {
  const attachments = adapter.config?.resolveAttachments?.()
  if (attachments === undefined) return undefined
  return adapter.config?.resolveImageAccess?.(attachments, ref)
}

/**
 * Build the pricing answer for one exact route.
 * @param {object} adapter - augmented adapter instance.
 * @param {string} provider - provider route being priced.
 * @param {string} model - exact model id being priced.
 * @param {{charsPerToken: number, maxVisualTokens: number}} options - resolved options.
 * @returns {{priceImages: (images: readonly any[]) => Array<{visualTokens: number, text: string}>}}
 */
function pricingFor(adapter, provider, model, options) {
  return {
    priceImages(images) {
      return images.map((block) => {
        const ref = block?.attachment
        const access = accessOf(adapter, ref)

        if (block?.offloaded === true) {
          // An offloaded occurrence contributes only its placeholder text.
          return { visualTokens: 0, text: offloadedImageText(ref, access) }
        }

        let target
        try {
          target = adapter.imageRequestTarget(provider, model, ref)
        } catch {
          // A route that cannot describe its own projection still needs a price;
          // fall back to the durable attachment facts.
          target = { width: ref?.width, height: ref?.height, maxBytes: ref?.bytes }
        }

        const sourceBytes = typeof ref?.bytes === 'number' ? ref.bytes : 0
        const cap =
          typeof target?.maxBytes === 'number' ? target.maxBytes : Number.POSITIVE_INFINITY
        const transmitted = Math.max(0, Math.min(sourceBytes, cap))
        const visualTokens = Math.min(
          options.maxVisualTokens,
          Math.ceil(base64Length(transmitted) / options.charsPerToken),
        )

        return { visualTokens, text: requestImageHandleText(ref, target, access) }
      })
    },
  }
}

/**
 * Decide whether one adapter still needs request-image pricing.
 *
 * The base class answer is `undefined`, so a behavioural probe is the reliable
 * test: it stays correct even if this plugin and the adapter resolve
 * `@deepseek-ai/dsh-llm` through different module instances.
 *
 * @param {object} adapter - one registered adapter instance.
 * @param {string} provider - provider route owning the adapter.
 * @returns {boolean} whether this plugin should supply the pricing.
 */
function needsPricing(adapter, provider) {
  if (adapter[PATCHED] === true) return false
  if (typeof adapter.imageRequestPricing !== 'function') return true
  try {
    const probe = adapter.imageRequestPricing(provider)
    return probe === undefined || probe === null
  } catch {
    // Throwing means a real implementation is present; never replace it.
    return false
  }
}

/**
 * Install pricing on one adapter when it does not answer it already.
 * @param {object} adapter - one registered adapter instance.
 * @param {string} provider - provider route owning the adapter.
 * @param {{charsPerToken: number, maxVisualTokens: number}} options - resolved options.
 * @returns {boolean} whether this call augmented the adapter.
 */
function patchAdapter(adapter, provider, options) {
  if (adapter === null || typeof adapter !== 'object') return false
  if (typeof adapter.imageRequestTarget !== 'function') return false
  if (!needsPricing(adapter, provider)) return false

  adapter.imageRequestPricing = function imageRequestPricing(routeProvider, routeModel) {
    return pricingFor(adapter, routeProvider, routeModel, options)
  }
  adapter[PATCHED] = true
  return true
}

/**
 * Augment every currently registered adapter that declares no pricing.
 * @param {import('@deepseek-ai/cordis').Context} ctx - owning context.
 * @param {{charsPerToken: number, maxVisualTokens: number, debug: boolean, providers: readonly string[] | undefined}} options - resolved options.
 * @returns {number} how many adapters were augmented.
 */
function patchAll(ctx, options) {
  const registry = ctx.get('llm')?.adapters
  if (!(registry instanceof Map)) {
    if (options.debug) {
      ctx.logger?.warn('llm-pi-ai-image-offload: adapter registry unavailable; nothing patched')
    }
    return 0
  }
  let patched = 0
  for (const [provider, registration] of registry) {
    if (options.providers !== undefined && !options.providers.includes(provider)) continue
    if (!patchAdapter(registration?.adapter, provider, options)) continue
    patched += 1
    if (options.debug) {
      ctx.logger?.warn(`llm-pi-ai-image-offload: installed request-image pricing for route "${provider}"`)
    }
  }
  return patched
}

/**
 * Mount request-image pricing for routes that declare none.
 * @param {import('@deepseek-ai/cordis').Context} ctx - owning context.
 * @param {unknown} config - loader-provided configuration.
 */
export function apply(ctx, config) {
  const options = resolveOptions(config)
  if (!options.enabled) return

  const install = () => {
    try {
      patchAll(ctx, options)
    } catch (error) {
      // Never let augmentation break dispatch; the unpatched behaviour (no
      // pricing) stays the safe fallback.
      ctx.logger?.warn(`llm-pi-ai-image-offload: ${String(error)}`)
    }
  }

  // A lazily created adapter appears only after its first routes commit, and a
  // profile edit replaces the route set, so re-apply on every registry change.
  ctx.on('llm/adapters-updated', install)
  install()
}
