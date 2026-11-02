/**
 * Prompt Forge — a Host plugin that adds a self-evolving prompt-strengthening
 * loop to any Harness profile: rewrite, critiqued repair, failure mining, a
 * benchmark-gated upgrade, and a self-check.
 *
 * Nothing here depends on a particular Harness version beyond the `tools`
 * service, the `llm` service and the Loader's schema library.
 * @module dsh-prompt-forge
 */

import { Config, resolveConfig } from './lib/config.js'
import { createForge } from './lib/forge.js'
import { registerForgeRoute } from './lib/route.js'
import { installEvidenceRules } from './lib/rules.js'
import { createAuditTool, createControlTool, createEnhanceTool } from './lib/tools.js'

/** Cordis plugin name; must match the id used in the bundle patch. */
export const name = 'prompt-forge'

/**
 * The two services the plugin cannot degrade without: it registers tools, and
 * every operation is a model call.
 */
export const inject = ['tools', 'llm']

export { Config }

/**
 * Mount the plugin.
 * @param {object} ctx - the plugin context.
 * @param {unknown} config - Loader-validated configuration (defaults applied).
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  const runtime = { evidenceSection: false }
  const forge = createForge({ ctx, config: resolved, runtime })

  // All three registrations are effects on this plugin's context: unloading
  // the plugin (or an HMR replacement of it) removes the tools with it.
  ctx.effect(() => ctx.tools.register(createEnhanceTool(forge)))
  ctx.effect(() => ctx.tools.register(createControlTool(forge)))
  ctx.effect(() => ctx.tools.register(createAuditTool(forge)))

  // The browser half's single seam. Optional: a profile without a web server
  // keeps the tools and simply has no composer star to click.
  registerForgeRoute(ctx, forge)

  // The one part that needs no invocation: an evidence-discipline section that
  // rides along with every session while this plugin is enabled.
  installEvidenceRules(ctx, resolved, runtime)
}
