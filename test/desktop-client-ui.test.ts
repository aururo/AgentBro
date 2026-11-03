import { readFile } from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const projectRoot = path.resolve(import.meta.dirname, '..')

interface Registration {
  config: { name: string; id?: string; order?: number }
  component: (props: Record<string, unknown>) => unknown
}

describe('DSH Desktop client slot occupants', () => {
  it('registers one occupant per brand seat and keeps the official name mark-free', async () => {
    const source = await readFile(
      path.join(projectRoot, 'packages', 'dsh-desktop-client-ui', 'client.js'),
      'utf8'
    )
    let definition: {
      factory: (require: (id: string) => unknown) => {
        apply: (ctx: unknown) => void
        inject: string[]
      }
    } | undefined
    const appended: Array<{ textContent?: string }> = []
    const removeStyle = vi.fn()
    let disposeStyle: (() => void) | undefined
    const document = {
      getElementById: vi.fn(() => null),
      createElement: vi.fn(() => ({ id: '', dataset: {}, textContent: '', remove: removeStyle })),
      head: { appendChild: (node: { textContent?: string }) => appended.push(node) }
    }
    vm.runInNewContext(source, {
      document,
      navigator: { language: 'en-US' },
      window: {
        __ModuleLoader__: {
          load: (value: typeof definition) => {
            definition = value
          }
        }
      }
    })

    expect(definition).toBeDefined()
    const createElement = (
      type: unknown,
      props: Record<string, unknown> | null,
      ...children: unknown[]
    ): { type: unknown; props: Record<string, unknown> } => ({
      type,
      props: { ...props, children }
    })
    const plugin = definition!.factory((id) => {
      if (id === 'react') {
        return {
          createElement,
          useEffect: (effect: () => void | (() => void)) => effect(),
          useState: (initial: unknown) => [initial, vi.fn()]
        }
      }
      if (id === '@deepseek-ai/dsh-client-ui-primitives') {
        return {}
      }
      throw new Error(`Unexpected client dependency: ${id}`)
    })

    const registrations: Registration[] = []
    const slots = {
      inject: (_name: string, callback: () => unknown): unknown => {
        const result = callback()
        if (result && typeof result === 'object' && Symbol.iterator in result) {
          for (const _entry of result as Iterable<unknown>) void _entry
        }
        return result
      },
      register: (
        config: Registration['config'],
        component: Registration['component']
      ): (() => void) => {
        registrations.push({ config, component })
        return () => undefined
      }
    }
    plugin.apply({ slots, locale: { register: () => () => undefined, bind: () => (key: string) => key }, effect: (setup: () => (() => void) | undefined) => { disposeStyle = setup() } })

    expect(plugin.inject).toEqual(['locale', 'slots', 'remote.session', 'sessions', 'uiWorkspace'])
    expect(registrations.map(({ config }) => config.name)).toEqual([
      'settings.sidebar.footer',
      'sidebar.settings.action',
      'conversation.input.dock',
      'sidebar.brand.mark',
      'sidebar.brand.name',
      'conversation.hero.brand.mark',
      'sidebar.right.tab.document.unpreviewable',
      'sidebar.workspaces.session.menu.item',
      'sidebar.workspaces.session.menu.item',
      'sidebar.workspaces.session.menu.item'
    ])
    const enterprise = registrations.find(({ config }) => config.name === 'settings.sidebar.footer')
    expect(enterprise?.config.id).toBe('desktop-enterprise-entry')
    const entry = enterprise!.component({ t: () => '了解企业版' }) as { type: unknown; props: Record<string, unknown> }
    expect(entry.type).toBe('a')
    expect(entry.props.href).toBe('https://dshdesktop.com/zh/enterprise/')
    expect(entry.props.target).toBe('_blank')
    expect(entry.props.rel).toBe('noopener noreferrer')
    expect(entry.props.children).toContain('了解企业版')
    // Desktop toolbar styles have an owned lifetime; branding stays in currentColor.
    expect(appended).toHaveLength(1)
    expect(appended[0]?.textContent).toContain("[data-dsh-preset-search]")
    disposeStyle?.()
    expect(removeStyle).toHaveBeenCalledOnce()

    const sidebarName = registrations.find(
      ({ config }) => config.name === 'sidebar.brand.name'
    )!.component({}) as { type: unknown; props: Record<string, unknown> }
    // The upstream `BrandWordmark` is a hard-coded "DeepSeek" glyph path, so the
    // wordmark is drawn here from the outlines generated into
    // build/agentbro-wordmark.svg.
    expect(sidebarName.type).toBe('svg')
    expect(sidebarName.props.height).toBe(24)
    expect(sidebarName.props.width).toBeCloseTo(24 * 84.7 / 24, 5)
    expect(sidebarName.props.viewBox).toBe('0 0 84.7 24')
    const [namePath] = sidebarName.props.children as Array<{ type: unknown; props: Record<string, unknown> }>
    if (!namePath) throw new Error('Expected the sidebar wordmark SVG path')
    expect(namePath.type).toBe('path')
    expect(namePath.props.fill).toBe('currentColor')

    const sidebarMark = registrations.find(
      ({ config }) => config.name === 'sidebar.brand.mark'
    )!.component({ size: 24 }) as { type: unknown; props: Record<string, unknown> }
    expect(sidebarMark.type).toBe('svg')
    // The mark is portrait, so it is sized by height; 20 sits inside the seat's
    // 24px slot and keeps the optical weight the 17px-tall whale had.
    expect(sidebarMark.props.height).toBe(20)
    expect(sidebarMark.props.width).toBeCloseTo(20 * 600.75 / 729, 5)
    const [markPath] = sidebarMark.props.children as Array<{ type: unknown; props: Record<string, unknown> }>
    if (!markPath) throw new Error('Expected the sidebar brand SVG path')
    expect(markPath.type).toBe('path')
    expect(markPath.props.fill).toBe('currentColor')
    // The head frame and screen are carved with evenodd; the default nonzero
    // rule would fill the screen in and swallow the eyes.
    expect(markPath.props.fillRule).toBe('evenodd')

    const heroMark = registrations.find(
      ({ config }) => config.name === 'conversation.hero.brand.mark'
    )!.component({ size: 48 }) as { type: unknown; props: Record<string, unknown> }
    expect(heroMark.type).toBe('svg')
    // The seat passes `size` as a box; the mark fits inside it by height only.
    expect(heroMark.props.height).toBe(48)
    expect(heroMark.props.width).toBeCloseTo(48 * 600.75 / 729, 5)
    expect(heroMark.props.size).toBeUndefined()
  })

  it('inlines the wordmark that scripts/generate-wordmark.mjs produced', async () => {
    const [svg, client] = await Promise.all([
      readFile(path.join(projectRoot, 'build', 'agentbro-wordmark.svg'), 'utf8'),
      readFile(path.join(projectRoot, 'packages', 'dsh-desktop-client-ui', 'client.js'), 'utf8')
    ])
    const pathData = /<path d="([^"]+)"/u.exec(svg)?.[1]
    const viewBox = /viewBox="([^"]+)"/u.exec(svg)?.[1]
    expect(pathData).toBeTruthy()
    expect(viewBox).toBeTruthy()
    // The wordmark is generated into build/ and copied into the bundle by hand;
    // this keeps the two from drifting apart.
    expect(client).toContain(`const BRAND_WORDMARK_PATH = "${pathData}"`)
    expect(client).toContain('const BRAND_WORDMARK_VIEWBOX = { x: 0, y: 0, width: 84.7, height: 24 }')
  })
})
