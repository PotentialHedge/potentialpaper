/**
 * Plugin releases (`handoffs/plugins.md` Phase 3). A plugin is released by tagging its repo with its manifest's
 * `version`, as `v1.2.0` (or `1.2.0`). A tag newer than the version a reader runs is an update. Prereleases
 * (`v2.0.0-beta.1`) are never offered: a reader moves to one by naming it. Pure, shared by the server and the browser.
 */

export interface Version {
  major: number;
  minor: number;
  patch: number;
  /** `''` for a release. */
  pre: string;
}

const VERSION = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** A version as a manifest writes it or a tag names it, or `null` if it doesn't read as one. */
export function parseVersion(text: string): Version | null {
  const m = VERSION.exec(text.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? '' };
}

/** Semver order: negative when `a` comes before `b`. A prerelease comes before its release. */
export function compareVersions(a: Version, b: Version): number {
  const d = a.major - b.major || a.minor - b.minor || a.patch - b.patch;
  if (d !== 0) return d;
  if (a.pre === b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  const x = a.pre.split('.');
  const y = b.pre.split('.');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === undefined) return -1;
    if (y[i] === undefined) return 1;
    const nx = /^\d+$/.test(x[i]) ? Number(x[i]) : null;
    const ny = /^\d+$/.test(y[i]) ? Number(y[i]) : null;
    if (nx !== null && ny !== null && nx !== ny) return nx - ny;
    if (nx !== null && ny === null) return -1;
    if (nx === null && ny !== null) return 1;
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

/** The newest release among a repo's tags, or `null` when none reads as a release. */
export function newestRelease(tags: Iterable<string>): { tag: string; version: Version } | null {
  let best: { tag: string; version: Version } | null = null;
  for (const tag of tags) {
    const version = parseVersion(tag);
    if (!version || version.pre) continue;
    // `v1.2.0` and `1.2.0` both: the `v` one wins, as the guide says to tag.
    const cmp = best ? compareVersions(version, best.version) : 1;
    if (cmp > 0 || (cmp === 0 && best && tag.startsWith('v') && !best.tag.startsWith('v'))) best = { tag, version };
  }
  return best;
}

/**
 * The release to offer a reader who runs `current` (their manifest's `version`): the newest release, if it is newer.
 * A manifest whose version doesn't read is offered the newest release.
 */
export function updateFor(tags: Iterable<string>, current: string): { tag: string; version: string } | null {
  const newest = newestRelease(tags);
  if (!newest) return null;
  const running = parseVersion(current);
  if (running && compareVersions(newest.version, running) <= 0) return null;
  const { major, minor, patch } = newest.version;
  return { tag: newest.tag, version: `${major}.${minor}.${patch}` };
}
