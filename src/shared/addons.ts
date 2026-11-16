// Add-ons: third-party agents and skills a session can opt in to when it's created. None is on
// by default. Each one loads as its own small local plugin for that session only (and its
// successors), so day-to-day sessions don't pay for their descriptions or their subagent runs.

export type AddonKind = 'agent' | 'skill'
export type AddonGroup = 'frontend' | 'backend' | 'fullstack' | 'design'

export interface AddonSource {
  /** GitHub owner/repo. */
  repo: string
  /** Pinned commit, so a session gets the files that were reviewed, not whatever is pushed later. */
  commit: string
  license: string
}

export interface AddonDef {
  /** Also the local plugin's name, so Claude Code lists the agent as `<id>:<name>`. */
  id: string
  label: string
  kind: AddonKind
  group: AddonGroup
  source: keyof typeof ADDON_SOURCES
  /** Path inside the source repo: an agent's .md file, or a skill's folder. */
  path: string
  summary: string
  /** The model an agent's frontmatter asks for; 'opus' costs the most per run. */
  model?: 'inherit' | 'sonnet' | 'opus'
}

export const ADDON_SOURCES = {
  'fullstack-dev': { repo: 'runxgalee/fullstack-dev', commit: '687717f8e7eaca6015785102b0f7a58b7190ebc4', license: 'MIT' },
  'taste-skill': { repo: 'Leonxlnx/taste-skill', commit: 'f6b76575f949707b4e3c37cd86cb44b0b98643e8', license: 'MIT' },
} as const satisfies Record<string, AddonSource>

export const ADDON_GROUPS: { id: AddonGroup; label: string }[] = [
  { id: 'frontend', label: 'Frontend' },
  { id: 'backend', label: 'Backend' },
  { id: 'fullstack', label: 'Full stack' },
  { id: 'design', label: 'Design and planning' },
]

const FD = 'fullstack-dev'
export const ADDONS: readonly AddonDef[] = [
  { id: 'react-specialist', label: 'React specialist', kind: 'agent', group: 'frontend', source: FD, path: 'plugins/frontend/agents/react-specialist.md', model: 'inherit', summary: 'React 19 and Next.js components, state, and styling.' },
  { id: 'typescript-specialist', label: 'TypeScript specialist', kind: 'agent', group: 'frontend', source: FD, path: 'plugins/frontend/agents/typescript-specialist.md', model: 'sonnet', summary: 'Types, generics, and strict-mode TypeScript.' },
  { id: 'react-project', label: 'React project', kind: 'skill', group: 'frontend', source: FD, path: 'plugins/onboarding/skills/react-project', summary: 'Sets up a new React project with a standard layout.' },
  { id: 'backend-architect', label: 'Backend architect', kind: 'agent', group: 'backend', source: FD, path: 'plugins/backend/agents/backend-architect.md', model: 'opus', summary: 'API and service design, scaling, and data flow.' },
  { id: 'go-specialist', label: 'Go specialist', kind: 'agent', group: 'backend', source: FD, path: 'plugins/backend/agents/go-specialist.md', model: 'inherit', summary: 'Idiomatic Go, concurrency, and testing.' },
  { id: 'grpc-specialist', label: 'gRPC specialist', kind: 'agent', group: 'backend', source: FD, path: 'plugins/backend/agents/grpc-specialist.md', model: 'sonnet', summary: 'Protocol Buffers and gRPC services.' },
  { id: 'sql-specialist', label: 'SQL specialist', kind: 'agent', group: 'backend', source: FD, path: 'plugins/backend/agents/sql-specialist.md', model: 'sonnet', summary: 'Queries, indexes, and schema design.' },
  { id: 'security-specialist', label: 'Security specialist', kind: 'agent', group: 'fullstack', source: FD, path: 'plugins/backend/agents/security-specialist.md', model: 'opus', summary: 'Security reviews, authentication, and common vulnerabilities.' },
  { id: 'cicd-specialist', label: 'CI/CD specialist', kind: 'agent', group: 'fullstack', source: FD, path: 'plugins/backend/agents/cicd-specialist.md', model: 'sonnet', summary: 'Build and deploy pipelines, such as GitHub Actions.' },
  { id: 'code-reviewer', label: 'Code reviewer', kind: 'agent', group: 'fullstack', source: FD, path: 'plugins/development/agents/code-reviewer.md', model: 'opus', summary: 'Reviews changes for bugs, style, and maintainability.' },
  { id: 'debug-specialist', label: 'Debug specialist', kind: 'agent', group: 'fullstack', source: FD, path: 'plugins/development/agents/debug-specialist.md', model: 'sonnet', summary: 'Finds root causes from errors, logs, and stack traces.' },
  { id: 'documentation-architect', label: 'Documentation architect', kind: 'agent', group: 'fullstack', source: FD, path: 'plugins/development/agents/documentation-architect.md', model: 'opus', summary: 'READMEs, API docs, and architecture notes.' },
  { id: 'brainstorming', label: 'Brainstorming', kind: 'skill', group: 'design', source: FD, path: 'plugins/development/skills/brainstorming', summary: 'Explores options and asks questions before building.' },
  { id: 'taste-skill', label: 'Taste (frontend design)', kind: 'skill', group: 'design', source: 'taste-skill', path: 'skills/taste-skill', summary: 'Design rules for polished websites; about 40 MB of assets, downloaded on first use.' },
]

export const addonById = (id: string): AddonDef | undefined => ADDONS.find(a => a.id === id)

/** Known ids only, without duplicates, in catalog order. */
export const cleanAddonIds = (ids: readonly unknown[] | undefined): string[] =>
  ADDONS.filter(a => ids?.includes(a.id)).map(a => a.id)
