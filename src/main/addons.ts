// Builds the local plugins that add-ons load as. Each add-on's source repo is downloaded once, at
// its pinned commit, into <data>/addons/sources; each add-on then gets its own plugin folder in
// <data>/addons/plugins holding only its agent file or skill folder. Nothing here touches
// ~/.claude, so add-ons never load outside the sessions that pick them.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'

import { ADDON_SOURCES, addonById, type AddonDef } from '../shared/addons.ts'

const run = promisify(execFile)

export interface PreparedAddons {
  /** Local plugin folders, for the SDK's `plugins` option. */
  paths: string[]
  /** One line per add-on that couldn't be prepared. */
  errors: string[]
}

type SourceKey = keyof typeof ADDON_SOURCES

/** Folder names carry the commit, so a new pin builds fresh copies beside the old ones. */
export const sourceDirName = (key: SourceKey): string => `${key}-${ADDON_SOURCES[key].commit.slice(0, 8)}`
export const pluginDirName = (def: AddonDef): string => `${def.id}-${ADDON_SOURCES[def.source].commit.slice(0, 8)}`

export function pluginManifest(def: AddonDef): string {
  const src = ADDON_SOURCES[def.source]
  return JSON.stringify(
    {
      name: def.id,
      version: '1.0.0',
      description: `CamClaude add-on: ${def.label} (${def.kind}) from ${src.repo}@${src.commit.slice(0, 8)}.`,
      license: src.license,
      repository: `https://github.com/${src.repo}`,
    },
    null,
    2,
  )
}

/** Windows' own bsdtar, not Git's GNU tar, which reads `C:\…` as a remote host. */
const tarBinary = () =>
  process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'

export class AddonStore {
  private readonly root: string
  private readonly log: (line: string) => void
  /** In-flight work by folder, so two sessions starting together don't download twice. */
  private readonly jobs = new Map<string, Promise<string>>()

  constructor(root: string, log: (line: string) => void) {
    this.root = root
    this.log = log
  }

  /** Whether any of these add-ons still needs a download. */
  needsDownload(ids: readonly string[]): boolean {
    return ids.some(id => {
      const def = addonById(id)
      return def !== undefined && !existsSync(join(this.root, 'plugins', pluginDirName(def)))
    })
  }

  async prepare(ids: readonly string[]): Promise<PreparedAddons> {
    const out: PreparedAddons = { paths: [], errors: [] }
    for (const id of ids) {
      const def = addonById(id)
      if (!def) {
        out.errors.push(`${id}: not in the add-on list`)
        continue
      }
      try {
        out.paths.push(await this.once(join(this.root, 'plugins', pluginDirName(def)), dir => this.buildPlugin(def, dir)))
      } catch (err) {
        this.log(`add-on ${id}: ${String(err)}`)
        out.errors.push(`${def.label}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return out
  }

  /** Runs build into a temporary folder and renames it into place, so a half-built folder never counts. */
  private once(dir: string, build: (tmp: string) => Promise<void>): Promise<string> {
    if (existsSync(dir)) return Promise.resolve(dir)
    let job = this.jobs.get(dir)
    if (!job) {
      job = (async () => {
        const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`
        try {
          await mkdir(tmp, { recursive: true })
          await build(tmp)
          await rename(tmp, dir)
          return dir
        } catch (err) {
          await rm(tmp, { recursive: true, force: true }).catch(() => undefined)
          throw err
        } finally {
          this.jobs.delete(dir)
        }
      })()
      this.jobs.set(dir, job)
    }
    return job
  }

  private source(key: SourceKey): Promise<string> {
    return this.once(join(this.root, 'sources', sourceDirName(key)), async tmp => {
      const { repo, commit } = ADDON_SOURCES[key]
      const url = `https://codeload.github.com/${repo}/tar.gz/${commit}`
      this.log(`add-ons: downloading ${repo}@${commit.slice(0, 8)}`)
      const res = await fetch(url)
      if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`)
      const archive = `${tmp}.tar.gz`
      await writeFile(archive, Buffer.from(await res.arrayBuffer()))
      try {
        await run(tarBinary(), ['-xzf', archive, '-C', tmp, '--strip-components=1'], { windowsHide: true })
      } finally {
        await rm(archive, { force: true })
      }
    })
  }

  private async buildPlugin(def: AddonDef, tmp: string): Promise<void> {
    const from = join(await this.source(def.source), ...def.path.split('/'))
    if (!existsSync(from)) throw new Error(`${def.path} is missing from ${ADDON_SOURCES[def.source].repo}`)
    await mkdir(join(tmp, '.claude-plugin'), { recursive: true })
    await writeFile(join(tmp, '.claude-plugin', 'plugin.json'), pluginManifest(def))
    const sub = def.kind === 'agent' ? 'agents' : 'skills'
    await mkdir(join(tmp, sub), { recursive: true })
    await cp(from, join(tmp, sub, basename(from)), { recursive: true })
  }
}
