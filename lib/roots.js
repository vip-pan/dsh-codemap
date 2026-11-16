/**
 * Resolve which repository a codemap call belongs to, starting from the
 * session's current working directory. A subdirectory (or a directory the
 * session `cd`ed into) still maps to the same indexed root.
 */

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * Walk up from `start` and return the codemap/git repository root.
 *
 * Preference order: the nearest ancestor that contains `.codemaker/` (the
 * project config codemap indexes, so it always denotes the intended root),
 * otherwise the nearest ancestor with a `.git/` entry, otherwise `start`
 * itself (an unindexed directory is still a valid codemap root; the daemon
 * builds an index for it on demand).
 */
export function findRepoRoot(start) {
  const cwd = resolve(start)
  let directory = cwd
  let gitRoot
  for (;;) {
    if (existsSync(join(directory, '.codemaker'))) return directory
    if (gitRoot === undefined && existsSync(join(directory, '.git'))) gitRoot = directory
    const parent = dirname(directory)
    if (parent === directory) return gitRoot ?? cwd
    directory = parent
  }
}
