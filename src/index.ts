/**
 * Host half: injects the GenUI card-authoring system-prompt section so the
 * model emits ```schemaJson fences alongside normal markdown.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { materialsMeta } from '@opentiny/genui-sdk-materials-vue-opentiny-vue/meta'
import { genPrompt } from '@opentiny/genui-sdk-core'
import {
  createGenuiPromptControl,
  createGenuiPromptControlHandler,
  createPersistedPromptControl,
  openPromptSettings,
  readPromptEnabled,
  type GenuiPromptControl,
  type GenuiPromptSettings,
  type PromptSettingsHost,
} from './prompt-control.ts'
import { adjustAuthoringPrompt } from './authoring-prompt.ts'
import { GENUI_PROMPT_CONTROL_URL } from './prompt-control-url.ts'
import {
  GENUI_RUNTIME_MAP_URL,
  GENUI_RUNTIME_URL,
  genuiRuntimeArtifactPaths,
  serveStaticFile,
} from './serve-genui-runtime.ts'

export const name = 'dsh-genui'
export const inject = ['systemPrompt', 'webServer']

declare module '@deepseek-ai/cordis' {
  interface Events {
    'loader/volatile-update'(paths: readonly (readonly string[])[]): void
  }
}

declare global {
  namespace Schemastery {
    interface Meta<T = any> {
      /** DSH 0.2 settings writes only fields marked volatile. */
      volatile?: boolean
    }
  }
}

interface WebServer {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** Tunables for the GenUI prompt section. */
export interface Config {
  /** Registry order among system-prompt sections (higher = later). */
  sectionOrder: number
  /** Stable section name in the prompt registry. */
  sectionName: string
  /** Enable authoring guidance for every conversation in this profile. */
  promptEnabled: boolean
}

export const Config: z<Config> = z.object({
  sectionOrder: z.number().default(80),
  sectionName: z.string().default('genui:cards'),
  promptEnabled: z.boolean().default(true)
    .description('全局启用 GenUI 生成提示词 / Enable GenUI authoring for all conversations')
    .extra('volatile', true),
})

/** Legacy DSH 0.1 settings schema for the global authoring preference. */
export const PromptSettings: z<GenuiPromptSettings> = z.object({
  enabled: z.boolean().default(true),
})

/**
 * Create the GenUI authoring guidance for the host system-prompt registry.
 * @returns The prompt text to register while global authoring is enabled.
 */
function genuiPromptText(): string {
  return adjustAuthoringPrompt(genPrompt('Vue', materialsMeta, {
    customActions: [
      {
        name: 'continueChat',
        description:
          'Continue the conversation (e.g. form submit). Pass a short message only; the host appends the card state (formData, etc.) automatically.',
        parameters: {
          type: 'object',
          properties: {
            message: {
              type: 'string',
              description: 'Short follow-up text (button label or summary). Do not put form fields here.',
            },
          },
          required: ['message'],
        },
      },
    ],
  }))
}

/**
 * Register the GenUI runtime and profile-wide authoring preference.
 * @param ctx - Cordis context with `systemPrompt` injected.
 * @param config - validated plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  // systemPrompt is provided by the web/base profile; typed loosely for out-of-tree builds.
  const systemPrompt = (ctx as Context & {
    systemPrompt: { section: (section: { name: string; order: number; text: string }) => () => void }
  }).systemPrompt
  const promptControl = createGenuiPromptControl({
    name: config.sectionName,
    order: config.sectionOrder,
    text: genuiPromptText(),
  }, systemPrompt)

  // The endpoint must read through this indirection because settings attach
  // asynchronously after the web route has already been registered.
  let currentControl: Pick<GenuiPromptControl, 'isEnabled' | 'set'> = promptControl
  let persistedAttached = false
  const endpointControl: Pick<GenuiPromptControl, 'isEnabled' | 'set'> & { persisted(): boolean } = {
    isEnabled: () => currentControl.isEnabled(),
    set: enabled => currentControl.set(enabled),
    persisted: () => persistedAttached,
  }

  // Honor the global config before optional settings attach, including on reload.
  // Disposal removes the section without persisting a new user preference.
  ctx.effect(() => {
    promptControl.set(readPromptEnabled(config.promptEnabled))
    return () => promptControl.set(false)
  }, 'dsh-genui: prompt toggle state')

  // DSH 0.2 updates volatile references in place without remounting the plugin.
  // Apply the saved global choice directly, without writing it back again.
  ctx.on('loader/volatile-update', paths => {
    if (paths.some(path => path.length === 0 || path[0] === 'promptEnabled')) {
      promptControl.set(readPromptEnabled(config.promptEnabled))
    }
  })

  ctx.inject(['settings'], (settingsCtx) => {
    const settings = (settingsCtx as Context & { settings: PromptSettingsHost }).settings
    const scope = openPromptSettings(settings, {
      configEnabled: readPromptEnabled(config.promptEnabled),
      schema: PromptSettings,
    })
    if (scope === undefined) {
      ctx.logger.warn('dsh-genui: prompt toggle will not persist')
      return
    }
    ctx.logger.debug('dsh-genui: settings service attached')
    settingsCtx.effect(() => {
      // Keep the global preference; never persist unload-time cleanup state.
      const persistedControl = createPersistedPromptControl(promptControl, scope, readPromptEnabled(config.promptEnabled), error => {
        ctx.logger.warn('dsh-genui: failed to persist prompt state', error)
      }, enabled => {
        ctx.logger.debug('dsh-genui: persisting prompt state enabled=%s', String(enabled))
      })
      currentControl = persistedControl
      persistedAttached = true
      return () => {
        currentControl = promptControl
        persistedAttached = false
      }
    }, 'dsh-genui: persisted prompt control')
  })

  const artifacts = genuiRuntimeArtifactPaths()
  const webServer = (ctx as Context & { webServer: WebServer }).webServer
  ctx.effect(
    () => webServer.register({
      kind: 'exact',
      path: GENUI_PROMPT_CONTROL_URL,
      handler: createGenuiPromptControlHandler(endpointControl),
    }),
    'dsh-genui: prompt toggle state endpoint',
  )
  ctx.effect(
    () => webServer.register({
      kind: 'exact',
      path: GENUI_RUNTIME_URL,
      handler: serveStaticFile(artifacts.js, 'text/javascript; charset=utf-8'),
    }),
    'dsh-genui: runtime.js',
  )
  ctx.effect(
    () => webServer.register({
      kind: 'exact',
      path: GENUI_RUNTIME_MAP_URL,
      handler: serveStaticFile(artifacts.map, 'application/json; charset=utf-8'),
    }),
    'dsh-genui: runtime.js.map',
  )
}
