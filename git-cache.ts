// Git state the desk keeps between polls, so a poll never has to ask git.
//
// Why this exists: every poll (4 s visible, 16 s hidden) used to run `git
// status` in each agent's directory with a 900 ms budget. Agent projects live on
// NFS here, and a status over NFS costs thousands of round trips (measured:
// 3 s for a 120-file repository, over two minutes for a large one). So the
// status was killed at 900 ms, uninterruptibly asleep in the kernel, and started
// again on the next poll, forever. Measured on the development machine: a steady
// ~1,400 NFS calls a second, load 15-20 on an idle CPU, and a dozen git
// processes stuck in D-state.
//
// The rule now: a poll NEVER spawns git. It reads this cache and, for a
// repository whose answer is old or whose HEAD, index or branch ref moved, asks
// one detached worker (collector.ts --refresh-git) to refresh it. The worker
// runs one git at a time on a network filesystem, two on a local one, gives a
// slow repository the time it needs, and backs off a repository that fails
// instead of retrying it every four seconds.
//
// Pure policy lives here, so it can be tested without a repository or a mount.
// The git calls themselves stay in collector.ts beside the other observational
// git code.

import { lstatSync, readFileSync } from "fs";
import { isAbsolute, join, resolve } from "path";

export const GIT_CACHE_VERSION = 1;
// How long an answer is served without asking again. A change to HEAD, the
// index or the branch ref invalidates it sooner (see gitStamp); the TTL is what
// notices an edit to a working-tree file, which touches none of those. A network
// filesystem answers more slowly and is asked less often.
export const GIT_TTL_LOCAL_MS = 60_000;
export const GIT_TTL_NET_MS = 120_000;
// A directory that is not a repository costs no git at all, so it is only
// re-checked now and then (a `git init` inside an agent's folder shows up
// within this).
export const GIT_TTL_NONE_MS = 5 * 60_000;
// After a status that timed out or failed, that repository is left alone for
// this long, doubling per consecutive failure up to the cap. One huge
// repository must cost one wasted attempt per backoff window, not one per poll.
export const GIT_FAIL_BACKOFF_MS = 10 * 60_000;
export const GIT_FAIL_BACKOFF_MAX_MS = 60 * 60_000;
// Concurrent git processes the worker may have in flight, per filesystem class.
export const GIT_CAP_NET = 1;
export const GIT_CAP_LOCAL = 2;
// A status in the background may take as long as it needs; nobody is waiting.
export const GIT_STATUS_TIMEOUT_LOCAL_MS = 10_000;
export const GIT_STATUS_TIMEOUT_NET_MS = 45_000;
// The worker stops itself after this, whatever it is doing; the next poll starts
// a fresh one for what is still stale.
export const GIT_WORKER_MAX_MS = 180_000;
// It stops starting new repositories this long before that, so it normally ends
// between repositories rather than being killed inside one.
export const GIT_WORKER_WIND_DOWN_MS = 30_000;
export const GIT_CACHE_MAX_ENTRIES = 96;
export const GIT_CACHE_KEEP_MS = 6 * 60 * 60_000;
export const GIT_COMMIT_CACHE_LIMIT = 48;
// The remote URL of a repository almost never changes; ask again this rarely.
export const GIT_ORIGIN_RECHECK_MS = 60 * 60_000;

// ----------------------------------------------------------------- limiter
export type Limiter = (<T>(task: () => Promise<T>) => Promise<T>) & { peak: () => number; running: () => number };
// At most `max` tasks at once, the rest wait their turn in order. A task that
// throws frees its slot like any other.
export function createLimiter(max: number): Limiter {
  const cap = Math.max(1, Math.floor(max) || 1);
  let active = 0, peak = 0;
  const waiting: Array<() => void> = [];
  const release = () => {
    active--;
    const next = waiting.shift();
    if (next) next();
  };
  const limit = (async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= cap) await new Promise<void>(resolveSlot => waiting.push(resolveSlot));
    active++;
    if (active > peak) peak = active;
    try { return await task(); }
    finally { release(); }
  }) as Limiter;
  limit.peak = () => peak;
  limit.running = () => active;
  return limit;
}

// Runs fn over the items with at most `max` in flight, in order. A separate
// mechanism from the limiter on purpose: this one gates whole repositories, the
// limiter gates the git processes inside them, and a task holding a limiter
// slot while it waits for another slot would deadlock a cap of one.
export async function runPool<T>(items: T[], max: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = items.slice();
  const lanes = Math.max(1, Math.min(Math.floor(max) || 1, queue.length));
  await Promise.all(Array.from({ length: lanes }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
      try { await fn(item); } catch {}
    }
  }));
}

// ---------------------------------------------------- network filesystems
// fstypes whose every metadata call crosses a wire.
const NETWORK_FS = new Set(["nfs", "nfs4", "cifs", "smb3", "smbfs", "9p", "ceph", "glusterfs", "lustre", "afs", "fuse.sshfs", "fuse.rclone", "fuse.nfs"]);
export type MountPoint = { point: string; fstype: string };
function unescapeMount(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
}
// /proc/self/mountinfo: `id parent maj:min root POINT opts [optional...] - FSTYPE source opts`.
export function parseMountInfo(text: string): MountPoint[] {
  const mounts: MountPoint[] = [];
  for (const line of String(text || "").split("\n")) {
    const split = line.indexOf(" - ");
    if (split < 0) continue;
    const left = line.slice(0, split).split(" "), right = line.slice(split + 3).split(" ");
    const point = unescapeMount(left[4] || ""), fstype = right[0] || "";
    if (point.startsWith("/") && fstype) mounts.push({ point, fstype });
  }
  return mounts;
}
// The filesystem type of the deepest mount a path is under. Later lines win a
// tie, which is how mountinfo orders an over-mount.
export function fsTypeFor(realPath: string, mounts: MountPoint[]): string {
  let best = "", type = "";
  for (const mount of mounts) {
    const inside = mount.point === "/" || realPath === mount.point || realPath.startsWith(mount.point + "/");
    if (inside && mount.point.length >= best.length) { best = mount.point; type = mount.fstype; }
  }
  return type;
}
// True when git work in this path crosses a network. The mount table decides.
// Only when it has no answer at all (mountinfo unreadable) does the path decide:
// under ~/nas, where this machine mounts the NAS, counts as network, so the
// caps and the cheap status still apply.
export function isNetworkPath(realPath: string, mounts: MountPoint[], home = ""): boolean {
  const type = fsTypeFor(realPath, mounts);
  if (type) return NETWORK_FS.has(type) || type.startsWith("nfs");
  return !!home && (realPath === join(home, "nas") || realPath.startsWith(join(home, "nas") + "/"));
}

// --------------------------------------------------------- where git keeps it
export type GitLocation = { gitdir: string; commondir: string; headRef: string };
function readSmall(path: string): string | null {
  try { return readFileSync(path, "utf8").slice(0, 4096); } catch { return null; }
}
// A repository root holds either a `.git` directory or, for a linked worktree
// and a submodule, a `.git` file saying where the real one is. HEAD and the
// index live in that gitdir; branches and packed-refs live in the common dir
// the worktree shares with its main checkout.
export function locateGit(root: string): GitLocation | null {
  const dotGit = join(root, ".git");
  let gitdir = dotGit;
  try {
    const info = lstatSync(dotGit);
    if (info.isFile()) {
      const text = readSmall(dotGit) || "";
      const match = text.match(/^gitdir:\s*(.+?)\s*$/m);
      if (!match) return null;
      gitdir = isAbsolute(match[1]) ? match[1] : resolve(root, match[1]);
    } else if (!info.isDirectory()) return null;
  } catch { return null; }
  let commondir = gitdir;
  const common = readSmall(join(gitdir, "commondir"));
  if (common && common.trim()) commondir = isAbsolute(common.trim()) ? common.trim() : resolve(gitdir, common.trim());
  const head = readSmall(join(gitdir, "HEAD")) || "";
  const ref = head.match(/^ref:\s*(\S+)/);
  return { gitdir, commondir, headRef: ref ? ref[1] : "" };
}
// What the repository looked like when its answer was taken. One stat each of
// HEAD, the index, the branch HEAD points at and packed-refs: a checkout, a
// stage, a commit, a fetch that moves a branch and a `git gc` all change at
// least one of them, and four stats cost a few round trips where a status costs
// thousands. A path that does not exist stamps as "-".
export function gitStamp(location: Partial<GitLocation> | null | undefined, stat: (path: string) => number | null = statMtime): string {
  if (!location || !location.gitdir) return "";
  const gitdir = location.gitdir, commondir = location.commondir || gitdir;
  const paths = [join(gitdir, "HEAD"), join(gitdir, "index"), location.headRef ? join(commondir, location.headRef) : "", join(commondir, "packed-refs")];
  return paths.map(path => {
    if (!path) return "-";
    const mtime = stat(path);
    return mtime === null ? "-" : String(mtime);
  }).join("|");
}
function statMtime(path: string): number | null {
  try { return lstatSync(path).mtimeMs; } catch { return null; }
}

// ------------------------------------------------------------- the cache
export type GitEntry = {
  v: number;
  root: string;            // repository root; "" when the directory is not in one
  gitdir: string; commondir: string; headRef: string;
  net: boolean;            // the repository is on a network filesystem
  stamp: string;           // gitStamp() taken BEFORE the git calls, so a change during them is not lost
  fetchedAt: number;       // last successful refresh (0: never succeeded)
  failedAt: number;        // last failed refresh (0: none)
  failures: number;        // consecutive failures, drives the backoff
  ms: number;              // how long the last successful refresh took
  origin?: string;         // `git remote get-url origin`, "" when there is none; undefined: not asked yet
  originAt: number;
  remoteName: string;
  state: any;              // parseGitStatus() result
  changes: any;            // the card's change summary
};
export type GitCache = { v: number; repos: Record<string, GitEntry>; commits: Record<string, any> };
export function emptyGitCache(): GitCache { return { v: GIT_CACHE_VERSION, repos: {}, commits: {} }; }
export function emptyGitEntry(): GitEntry {
  return { v: GIT_CACHE_VERSION, root: "", gitdir: "", commondir: "", headRef: "", net: false, stamp: "", fetchedAt: 0, failedAt: 0, failures: 0, ms: 0, originAt: 0, remoteName: "", state: null, changes: null };
}
const plainObject = (value: any) => !!value && typeof value === "object" && !Array.isArray(value);
const num = (value: any) => Number.isFinite(value) && value >= 0 ? Number(value) : 0;
const str = (value: any, max = 1024) => typeof value === "string" ? value.slice(0, max) : "";
// A cache file is read every poll and could be damaged or hand-edited, so each
// entry is rebuilt field by field and a shape it does not recognise is dropped.
export function sanitizeGitEntry(value: any): GitEntry | null {
  if (!plainObject(value) || value.v !== GIT_CACHE_VERSION) return null;
  const entry: GitEntry = {
    ...emptyGitEntry(),
    root: str(value.root), gitdir: str(value.gitdir), commondir: str(value.commondir), headRef: str(value.headRef, 512),
    net: value.net === true, stamp: str(value.stamp, 512),
    fetchedAt: num(value.fetchedAt), failedAt: num(value.failedAt), failures: Math.min(32, num(value.failures)), ms: num(value.ms),
    originAt: num(value.originAt), remoteName: str(value.remoteName, 64),
    state: plainObject(value.state) ? value.state : null,
    changes: plainObject(value.changes) ? value.changes : null,
  };
  if (typeof value.origin === "string") entry.origin = value.origin.slice(0, 512);
  return entry;
}
export function parseGitCache(text: string | null, parse: (text: string) => any = text => { try { return JSON.parse(text); } catch { return null; } }): GitCache {
  const cache = emptyGitCache();
  const value = text ? parse(text) : null;
  if (!plainObject(value) || value.v !== GIT_CACHE_VERSION) return cache;
  if (plainObject(value.repos)) {
    for (const [cwd, raw] of Object.entries(value.repos)) {
      if (!cwd.startsWith("/") || cwd.length > 1024 || Object.keys(cache.repos).length >= GIT_CACHE_MAX_ENTRIES) continue;
      const entry = sanitizeGitEntry(raw);
      if (entry) cache.repos[cwd] = entry;
    }
  }
  if (plainObject(value.commits)) {
    for (const [oid, commit] of Object.entries(value.commits)) if (/^[0-9a-f]{7,64}$/.test(oid) && plainObject(commit) && Object.keys(cache.commits).length < GIT_COMMIT_CACHE_LIMIT) cache.commits[oid] = commit;
  }
  return cache;
}
// Entries nobody has asked about for hours go, then the oldest past the cap, so
// the file stays small however many directories agents have visited.
export function pruneGitCache(cache: GitCache, at: number): GitCache {
  const touched = (entry: GitEntry) => Math.max(entry.fetchedAt, entry.failedAt);
  const kept = Object.entries(cache.repos).filter(([, entry]) => at - touched(entry) < GIT_CACHE_KEEP_MS)
    .sort((a, b) => touched(b[1]) - touched(a[1])).slice(0, GIT_CACHE_MAX_ENTRIES);
  return { v: GIT_CACHE_VERSION, repos: Object.fromEntries(kept), commits: Object.fromEntries(Object.entries(cache.commits).slice(-GIT_COMMIT_CACHE_LIMIT)) };
}

// ------------------------------------------------------------- the verdict
export type GitVerdict = "fresh" | "stale" | "cold" | "backoff";
export function gitBackoffMs(failures: number): number {
  return Math.min(GIT_FAIL_BACKOFF_MAX_MS, GIT_FAIL_BACKOFF_MS * 2 ** Math.max(0, Math.min(failures, 8) - 1));
}
export function gitTtlMs(entry: GitEntry): number {
  return !entry.root ? GIT_TTL_NONE_MS : entry.net ? GIT_TTL_NET_MS : GIT_TTL_LOCAL_MS;
}
// `stampNow` is gitStamp() for the entry's repository as it is right now.
//   cold    never asked about: refresh
//   backoff the last refresh failed, recently: serve what there is, do not ask
//   stale   older than its TTL, or the stamp moved: serve it AND refresh
//   fresh   serve it
export function gitCacheVerdict(entry: GitEntry | null | undefined, at: number, stampNow: string): GitVerdict {
  if (!entry) return "cold";
  if (entry.failedAt > 0 && at >= entry.failedAt && at - entry.failedAt < gitBackoffMs(entry.failures)) return "backoff";
  if (entry.fetchedAt <= 0 || at < entry.fetchedAt) return "stale";
  if (at - entry.fetchedAt >= gitTtlMs(entry)) return "stale";
  if (stampNow !== entry.stamp) return "stale";
  return "fresh";
}
// Which of these directories need a refresh, never-seen ones first, then the
// longest-waiting. `stampOf` does the (cheap) stats; nothing here runs git.
export function planGitRefresh(cwds: string[], cache: GitCache, at: number, stampOf: (entry: GitEntry) => string = entry => gitStamp(entry)): string[] {
  const due: Array<{ cwd: string; cold: boolean; age: number }> = [];
  for (const cwd of cwds) {
    const entry = cache.repos[cwd];
    const verdict = gitCacheVerdict(entry, at, entry ? stampOf(entry) : "");
    if (verdict === "cold" || verdict === "stale") due.push({ cwd, cold: verdict === "cold", age: entry ? entry.fetchedAt : 0 });
  }
  due.sort((a, b) => Number(b.cold) - Number(a.cold) || a.age - b.age);
  return due.map(item => item.cwd);
}

// ------------------------------------------------------------- the worker lock
// Same shape as the topic worker's: a pid and a start time, trusted only while
// the process is alive and younger than its own lifetime cap. A claim with pid 0
// is a poll that has taken the lock and is still starting the worker: alive for
// a few seconds, so a second poll landing in that gap leaves it alone instead of
// treating it as dead and starting a second worker.
export const GIT_CLAIM_GRACE_MS = 10_000;
export function gitWorkerAlive(lock: any, at: number, isAlive: (pid: number) => boolean, maxMs = GIT_WORKER_MAX_MS): boolean {
  const pid = Number(lock?.pid), started = Number(lock?.at);
  if (!Number.isFinite(started) || started <= 0 || at < started - 1000) return false;
  if (pid === 0) return at - started < GIT_CLAIM_GRACE_MS;
  return Number.isInteger(pid) && pid > 1 && at - started < maxMs + 5000 && isAlive(pid);
}
// What the tick hands the worker on stdin: absolute directories, bounded.
export function parseGitWant(text: string | null, max = 64): string[] {
  let value: any = null;
  try { value = JSON.parse(text || ""); } catch {}
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item === "string" && item.startsWith("/") && item.length <= 1024 && !item.includes("\0")) seen.add(item);
    if (seen.size >= max) break;
  }
  return [...seen];
}
