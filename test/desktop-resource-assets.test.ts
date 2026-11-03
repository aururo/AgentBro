import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const projectRoot = path.resolve(import.meta.dirname, '..')

/**
 * `dsh-desktop://desktop/<name>` is served out of the packaged resources
 * directory, so every name the host asks for has to be in `extraResources`.
 *
 * The boot cover regressed once because the splash moved to the loader GIFs
 * while the cover kept requesting an asset that was no longer packaged: the
 * request answered 404 and the cover painted a broken image. Nothing caught
 * it, because the cover test only asserted that the URL constant matched
 * itself. This file closes that gap.
 */
async function collectSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...await collectSourceFiles(full))
    else if (entry.name.endsWith('.ts')) files.push(full)
  }
  return files
}

async function readSourceText(): Promise<string> {
  const files = await collectSourceFiles(path.join(projectRoot, 'src'))
  const parts = await Promise.all(files.map((file) => readFile(file, 'utf8')))
  return parts.join('\n')
}

const DESKTOP_URL = /dsh-desktop:\/\/desktop\/([A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*)/g
const RESOURCE_CALL = /desktopResourceUrl\(\s*(?:'([^']+)'|([A-Z][A-Z0-9_]*))/g
const STRING_CONSTANT = /export const ([A-Z][A-Z0-9_]*) = '([^']+)'/g

async function referencedResourceNames(): Promise<string[]> {
  const source = await readSourceText()
  const constants = new Map<string, string>()
  for (const match of source.matchAll(STRING_CONSTANT)) {
    const name = match[1]
    const value = match[2]
    if (name && value) constants.set(name, value)
  }
  const names = new Set<string>()
  for (const match of source.matchAll(DESKTOP_URL)) {
    const name = match[1]
    if (name) names.add(name)
  }
  for (const match of source.matchAll(RESOURCE_CALL)) {
    const literal = match[1]
    const constant = match[2]
    if (literal) names.add(literal)
    else if (constant) {
      const value = constants.get(constant)
      // An unresolvable constant means the guard cannot see the request at
      // all, so fail loudly instead of silently passing.
      if (value === undefined) throw new Error(`desktopResourceUrl(${constant}) has no string constant to resolve`)
      names.add(value)
    }
  }
  return [...names].sort()
}

async function packagedResourceNames(): Promise<Set<string>> {
  const packageJson = JSON.parse(
    await readFile(path.join(projectRoot, 'package.json'), 'utf8')
  ) as { build: { extraResources: Array<{ from: string; to: string }> } }
  return new Set(packageJson.build.extraResources.map((entry) => entry.to))
}

describe('desktop protocol resources', () => {
  it('packages every resource the host asks the desktop protocol for', async () => {
    const referenced = await referencedResourceNames()
    const packaged = await packagedResourceNames()
    expect(referenced.length).toBeGreaterThan(0)
    const missing = referenced.filter((name) => !packaged.has(name))
    expect(missing).toEqual([])
  })

  it('keeps the boot cover and the startup page on the same animation assets', async () => {
    const referenced = await referencedResourceNames()
    const animations = referenced.filter((name) => name.endsWith('.gif'))
    expect(animations.length).toBeGreaterThan(0)
    const splash = await readFile(path.join(projectRoot, 'build', 'splash.html'), 'utf8')
    const splashAssets = new Set(
      [...splash.matchAll(/src="([^"]+)"/g)].flatMap((match) => {
        const name = match[1]
        return name ? [name] : []
      })
    )
    expect(animations.filter((name) => !splashAssets.has(name))).toEqual([])
  })
})
