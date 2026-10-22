import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import * as genui from '../src/index.js'

const defaults = { sectionOrder: 80, sectionName: 'genui:cards', promptEnabled: true }

function host() {
  const ctx = new Context()
  const sections = new Map<string, string>()
  ctx.provide('systemPrompt', {
    section({ name, text }: { name: string; text: string }) {
      sections.set(name, text)
      return () => { sections.delete(name) }
    },
  })
  ctx.provide('webServer', { register: () => () => {} })
  return { ctx, sections }
}

describe('global authoring configuration', () => {
  it('keeps authoring off before the optional settings service attaches', async () => {
    const { ctx, sections } = host()
    const plugin = ctx.plugin(genui, { ...defaults, promptEnabled: false })
    try {
      await plugin.await()
      expect(sections.size).toBe(0)

      const update = vi.fn(async () => {})
      const register = vi.fn(() => ({ get: () => ({ enabled: false }), update }))
      ctx.provide('settings', { register })
      await vi.waitFor(() => expect(register).toHaveBeenCalledOnce())
      expect(sections.size).toBe(0)
      expect(update).not.toHaveBeenCalled()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('applies one global setting on config updates and releases it on unload', async () => {
    const { ctx, sections } = host()
    const plugin = ctx.plugin(genui, defaults)
    try {
      await plugin.await()
      expect(sections.has('genui:cards')).toBe(true)

      await plugin.update({ ...defaults, promptEnabled: false })
      expect(sections.size).toBe(0)

      await plugin.update(defaults)
      expect(sections.size).toBe(1)
    } finally {
      await ctx.fiber.dispose()
    }
    expect(sections.size).toBe(0)
  })

  it('follows DSH 0.2 live config changes without a plugin restart or settings write', async () => {
    const { ctx, sections } = host()
    let enabled = false
    const liveValue = { get: () => enabled }
    const update = vi.fn(async () => {})
    ctx.provide('settings', { describe: () => [], update })
    const plugin = ctx.plugin({
      name: genui.name,
      inject: genui.inject,
      apply(child: Context) {
        genui.apply(child, { ...defaults, promptEnabled: liveValue as unknown as boolean })
      },
    })
    try {
      await plugin.await()
      expect(sections.size).toBe(0)

      enabled = true
      plugin.ctx.emit('loader/volatile-update', [['promptEnabled']])
      expect(sections.size).toBe(1)

      enabled = false
      plugin.ctx.emit('loader/volatile-update', [['promptEnabled']])
      expect(sections.size).toBe(0)
      expect(update).not.toHaveBeenCalled()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
