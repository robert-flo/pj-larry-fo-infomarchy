import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  GIT_CAP_LOCAL, GIT_CAP_NET, GIT_CLAIM_GRACE_MS, GIT_FAIL_BACKOFF_MAX_MS, GIT_FAIL_BACKOFF_MS, GIT_CACHE_KEEP_MS, GIT_CACHE_MAX_ENTRIES, GIT_CACHE_VERSION,
  GIT_TTL_LOCAL_MS, GIT_TTL_NET_MS, GIT_TTL_NONE_MS, GIT_WORKER_MAX_MS, GIT_WORKER_WIND_DOWN_MS,
  createLimiter, emptyGitCache, emptyGitEntry, fsTypeFor, gitBackoffMs, gitCacheVerdict, gitStamp, gitWorkerAlive, isNetworkPath, locateGit,
  parseGitCache, parseGitWant, parseMountInfo, planGitRefresh, pruneGitCache, runPool, sanitizeGitEntry,
  type GitCache, type GitEntry,
} from "./git-cache";
import { gitLimiters, gitLimiterFor, runGitRefresh } from "./collector.ts";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const entryAt = (over: Partial<GitEntry> = {}): GitEntry => ({ ...emptyGitEntry(), root: "/r", gitdir: "/r/.git", commondir: "/r/.git", headRef: "refs/heads/main", stamp: "1|2|3|-", fetchedAt: 1_000_000, ...over });

describe("the git concurrency cap", () => {
  test("a limiter never runs more than its cap at once, however many are queued", async () => {
    for (const cap of [1, 2, 3]) {
      const limit = createLimiter(cap);
      let live = 0, seen = 0;
      await Promise.all(Array.from({ length: 14 }, () => limit(async () => { live++; seen = Math.max(seen, live); await sleep(4); live--; })));
      expect(seen).toBe(cap);
      expect(limit.peak()).toBe(cap);
      expect(limit.running()).toBe(0);
    }
  });

  test("queued work starts in the order it arrived", async () => {
    const limit = createLimiter(1), order: number[] = [];
    await Promise.all([0, 1, 2, 3, 4].map(n => limit(async () => { await sleep(3 - Math.min(n, 3)); order.push(n); })));
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  test("a task that throws frees its slot and does not stall the queue", async () => {
    const limit = createLimiter(1);
    const results = await Promise.allSettled([limit(async () => { throw new Error("boom"); }), limit(async () => "after"), limit(async () => "last")]);
    expect(results.map(r => r.status)).toEqual(["rejected", "fulfilled", "fulfilled"]);
    expect(limit.running()).toBe(0);
  });

  test("the caps are 1 on a network filesystem and 2 on a local one", () => {
    expect(GIT_CAP_NET).toBe(1);
    expect(GIT_CAP_LOCAL).toBe(2);
    expect(GIT_WORKER_WIND_DOWN_MS).toBeLessThan(GIT_WORKER_MAX_MS);
  });

  test("the collector's own git limiters hold those caps under load", async () => {
    for (const [limiter, cap] of [[gitLimiters.net, GIT_CAP_NET], [gitLimiters.local, GIT_CAP_LOCAL]] as const) {
      let live = 0, seen = 0;
      await Promise.all(Array.from({ length: 9 }, () => limiter(async () => { live++; seen = Math.max(seen, live); await sleep(3); live--; })));
      expect(seen).toBeLessThanOrEqual(cap);
    }
  });

  test("a directory on the local disk gets the local limiter", () => {
    const dir = mkdtempSync(join(tmpdir(), "infomarchy-limiter-"));
    try { expect(gitLimiterFor(dir) === gitLimiters.local || gitLimiterFor(dir) === gitLimiters.net).toBe(true); } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("runPool gates whole repositories by lane width and survives a failing one", async () => {
    let live = 0, seen = 0;
    const done: number[] = [];
    await runPool([1, 2, 3, 4, 5, 6, 7], 2, async n => { live++; seen = Math.max(seen, live); await sleep(3); live--; if (n === 4) throw new Error("bad repo"); done.push(n); });
    expect(seen).toBe(2);
    expect(done.sort()).toEqual([1, 2, 3, 5, 6, 7]);
    let serial = 0, widest = 0;
    await runPool([1, 2, 3], 1, async () => { serial++; widest = Math.max(widest, serial); await sleep(2); serial--; });
    expect(widest).toBe(1);
  });
});

describe("network filesystems are recognised from the mount table", () => {
  const table = [
    "22 1 0:21 / / rw,noatime - btrfs /dev/mapper/root rw",
    "40 22 0:44 / /home/user/nas/projects rw,noatime - nfs4 server:/export rw,vers=4.1",
    "41 22 0:45 / /home/user/with\\040space rw - cifs //srv/x rw",
    "42 22 0:46 / /mnt/box rw - fuse.sshfs me@box:/ rw",
    "43 22 0:47 / /home/user/nas/projects/inner rw - tmpfs tmpfs rw",
  ].join("\n");
  const mounts = parseMountInfo(table);

  test("mountinfo lines give a mount point and fstype, with escapes decoded", () => {
    expect(mounts.map(m => m.point)).toEqual(["/", "/home/user/nas/projects", "/home/user/with space", "/mnt/box", "/home/user/nas/projects/inner"]);
    expect(mounts.map(m => m.fstype)).toEqual(["btrfs", "nfs4", "cifs", "fuse.sshfs", "tmpfs"]);
    expect(parseMountInfo("garbage\n\n- - -\n")).toEqual([]);
  });

  test("the deepest mount decides, and a name prefix is not a path prefix", () => {
    expect(fsTypeFor("/home/user/nas/projects/blip", mounts)).toBe("nfs4");
    expect(fsTypeFor("/home/user/nas/projects/inner/x", mounts)).toBe("tmpfs");
    expect(fsTypeFor("/home/user/nas/projects-other/x", mounts)).toBe("btrfs");
    expect(fsTypeFor("/home/user/code", mounts)).toBe("btrfs");
  });

  test("nfs, cifs and sshfs are network; btrfs and tmpfs are not", () => {
    expect(isNetworkPath("/home/user/nas/projects/blip", mounts, "/home/user")).toBe(true);
    expect(isNetworkPath("/home/user/with space/a", mounts, "/home/user")).toBe(true);
    expect(isNetworkPath("/mnt/box/a", mounts, "/home/user")).toBe(true);
    expect(isNetworkPath("/home/user/code", mounts, "/home/user")).toBe(false);
    // The mount table wins over the path: a tmpfs mounted inside the NAS tree is not network.
    expect(isNetworkPath("/home/user/nas/projects/inner/x", mounts, "/home/user")).toBe(false);
  });

  test("a path under ~/nas counts as network even when the mount table cannot be read", () => {
    expect(isNetworkPath("/home/user/nas/projects/blip", [], "/home/user")).toBe(true);
    expect(isNetworkPath("/home/user/nas", [], "/home/user")).toBe(true);
    expect(isNetworkPath("/home/user/nasty/x", [], "/home/user")).toBe(false);
    expect(isNetworkPath("/home/user/code", [], "/home/user")).toBe(false);
    expect(isNetworkPath("/home/user/nas/x", [], "")).toBe(false);
  });
});

describe("the stamp that invalidates a cached answer", () => {
  function repoWithGit() {
    const root = mkdtempSync(join(tmpdir(), "infomarchy-stamp-"));
    mkdirSync(join(root, ".git", "refs", "heads"), { recursive: true });
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(root, ".git", "index"), "i");
    writeFileSync(join(root, ".git", "refs", "heads", "main"), "0123456789abcdef0123456789abcdef01234567\n");
    return root;
  }
  const bump = (path: string) => { const t = new Date(Date.now() + 5000 + Math.floor(Math.random() * 1000)); utimesSync(path, t, t); };

  test("HEAD, the index, the branch ref and packed-refs each move the stamp; an untouched repository does not", () => {
    const root = repoWithGit();
    try {
      const location = locateGit(root)!;
      expect(location.gitdir).toBe(join(root, ".git"));
      expect(location.headRef).toBe("refs/heads/main");
      const first = gitStamp(location);
      expect(gitStamp(location)).toBe(first);
      for (const file of [join(root, ".git", "HEAD"), join(root, ".git", "index"), join(root, ".git", "refs", "heads", "main")]) {
        const before = gitStamp(location);
        bump(file);
        expect(gitStamp(location)).not.toBe(before);
      }
      const before = gitStamp(location);
      writeFileSync(join(root, ".git", "packed-refs"), "# pack-refs\n");
      expect(gitStamp(location)).not.toBe(before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("it costs stats, not a read of the repository, and a missing path stamps as a dash", () => {
    const touched: string[] = [];
    const stamp = gitStamp({ gitdir: "/g", commondir: "/c", headRef: "refs/heads/x" }, path => { touched.push(path); return path.endsWith("index") ? null : 7; });
    expect(touched).toEqual(["/g/HEAD", "/g/index", "/c/refs/heads/x", "/c/packed-refs"]);
    expect(stamp).toBe("7|-|7|7");
    expect(gitStamp(null)).toBe("");
    expect(gitStamp({ gitdir: "" })).toBe("");
    expect(gitStamp({ gitdir: "/g", commondir: "/g", headRef: "" }, () => 1)).toBe("1|1|-|1");
  });

  test("a linked worktree is stamped through its own gitdir and the shared refs", () => {
    const base = mkdtempSync(join(tmpdir(), "infomarchy-worktree-"));
    try {
      const main = join(base, "main"), tree = join(base, "tree"), wt = join(main, ".git", "worktrees", "tree");
      mkdirSync(join(main, ".git", "refs", "heads"), { recursive: true }); mkdirSync(wt, { recursive: true }); mkdirSync(tree, { recursive: true });
      writeFileSync(join(wt, "HEAD"), "ref: refs/heads/feature\n");
      writeFileSync(join(wt, "commondir"), "../..\n");
      writeFileSync(join(tree, ".git"), `gitdir: ${wt}\n`);
      const location = locateGit(tree)!;
      expect(location.gitdir).toBe(wt);
      expect(location.commondir).toBe(main + "/.git");
      expect(location.headRef).toBe("refs/heads/feature");
      writeFileSync(join(tree, ".git"), "gitdir: ../main/.git/worktrees/tree\n");
      expect(locateGit(tree)!.gitdir).toBe(join(base, "main", ".git", "worktrees", "tree"));
      expect(locateGit(join(base, "nowhere"))).toBeNull();
      writeFileSync(join(tree, ".git"), "not a gitdir line\n");
      expect(locateGit(tree)).toBeNull();
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});

describe("the cache verdict: fresh, stale, cold or backed off", () => {
  const t0 = 1_000_000;
  test("nothing cached is cold", () => {
    expect(gitCacheVerdict(undefined, t0, "")).toBe("cold");
    expect(gitCacheVerdict(null, t0, "x")).toBe("cold");
  });

  test("a local answer is served for 60 s and stale from 60 s", () => {
    const entry = entryAt({ fetchedAt: t0, net: false });
    expect(gitCacheVerdict(entry, t0 + 1, entry.stamp)).toBe("fresh");
    expect(gitCacheVerdict(entry, t0 + GIT_TTL_LOCAL_MS - 1, entry.stamp)).toBe("fresh");
    expect(gitCacheVerdict(entry, t0 + GIT_TTL_LOCAL_MS, entry.stamp)).toBe("stale");
  });

  test("a network answer is served twice as long", () => {
    const entry = entryAt({ fetchedAt: t0, net: true });
    expect(GIT_TTL_NET_MS).toBeGreaterThanOrEqual(120_000);
    expect(gitCacheVerdict(entry, t0 + GIT_TTL_LOCAL_MS + 1, entry.stamp)).toBe("fresh");
    expect(gitCacheVerdict(entry, t0 + GIT_TTL_NET_MS - 1, entry.stamp)).toBe("fresh");
    expect(gitCacheVerdict(entry, t0 + GIT_TTL_NET_MS, entry.stamp)).toBe("stale");
  });

  test("a moved stamp makes a young answer stale at once", () => {
    const entry = entryAt({ fetchedAt: t0, net: true });
    expect(gitCacheVerdict(entry, t0 + 2000, entry.stamp)).toBe("fresh");
    expect(gitCacheVerdict(entry, t0 + 2000, "9|2|3|-")).toBe("stale");
    expect(gitCacheVerdict(entry, t0 + 2000, "1|9|3|-")).toBe("stale");
    expect(gitCacheVerdict(entry, t0 + 2000, "1|2|9|-")).toBe("stale");
    expect(gitCacheVerdict(entry, t0 + 2000, "1|2|3|9")).toBe("stale");
  });

  test("a directory outside any repository is re-checked rarely and costs no stamp", () => {
    const none = entryAt({ root: "", gitdir: "", commondir: "", headRef: "", stamp: "", fetchedAt: t0 });
    expect(gitCacheVerdict(none, t0 + GIT_TTL_NONE_MS - 1, "")).toBe("fresh");
    expect(gitCacheVerdict(none, t0 + GIT_TTL_NONE_MS, "")).toBe("stale");
  });

  test("a clock that went backwards, or an entry that never succeeded, is stale not fresh", () => {
    expect(gitCacheVerdict(entryAt({ fetchedAt: t0 }), t0 - 5000, "1|2|3|-")).toBe("stale");
    expect(gitCacheVerdict(entryAt({ fetchedAt: 0 }), t0, "1|2|3|-")).toBe("stale");
  });

  test("a failed repository is left alone, doubling per failure up to the cap, then retried", () => {
    const failed = (failures: number) => entryAt({ fetchedAt: t0 - 10 * 60_000, failedAt: t0, failures });
    expect(gitBackoffMs(1)).toBe(GIT_FAIL_BACKOFF_MS);
    expect(gitBackoffMs(2)).toBe(2 * GIT_FAIL_BACKOFF_MS);
    expect(gitBackoffMs(3)).toBe(4 * GIT_FAIL_BACKOFF_MS);
    expect(gitBackoffMs(50)).toBe(GIT_FAIL_BACKOFF_MAX_MS);
    expect(gitCacheVerdict(failed(1), t0 + GIT_FAIL_BACKOFF_MS - 1, "moved")).toBe("backoff");
    expect(gitCacheVerdict(failed(1), t0 + GIT_FAIL_BACKOFF_MS, "moved")).toBe("stale");
    expect(gitCacheVerdict(failed(2), t0 + GIT_FAIL_BACKOFF_MS + 1, "moved")).toBe("backoff");
    expect(gitCacheVerdict(failed(2), t0 + 2 * GIT_FAIL_BACKOFF_MS, "moved")).toBe("stale");
  });

  test("a repository that has never answered is backed off too, not retried every poll", () => {
    const never = entryAt({ fetchedAt: 0, failedAt: t0, failures: 1 });
    expect(gitCacheVerdict(never, t0 + 5000, "")).toBe("backoff");
    expect(gitCacheVerdict(never, t0 + GIT_FAIL_BACKOFF_MS, "")).toBe("stale");
  });
});

describe("which repositories get refreshed", () => {
  const t0 = 5_000_000;
  const cache = (repos: Record<string, GitEntry>): GitCache => ({ ...emptyGitCache(), repos });

  test("only cold and stale ones, never-seen first, then the longest waiting; fresh and backed-off are left", () => {
    const repos = {
      "/fresh": entryAt({ fetchedAt: t0 - 1000, stamp: "s" }),
      "/old": entryAt({ fetchedAt: t0 - 500_000, stamp: "s" }),
      "/older": entryAt({ fetchedAt: t0 - 900_000, stamp: "s" }),
      "/failed": entryAt({ fetchedAt: t0 - 900_000, failedAt: t0 - 1000, failures: 1, stamp: "s" }),
      "/moved": entryAt({ fetchedAt: t0 - 1000, stamp: "before" }),
    };
    const stamps: Record<string, string> = { "/fresh": "s", "/old": "s", "/older": "s", "/failed": "moved", "/moved": "after" };
    const plan = planGitRefresh(["/fresh", "/old", "/new", "/older", "/failed", "/moved"], cache(repos), t0, e => stamps[Object.keys(repos).find(k => repos[k] === e)!]);
    expect(plan).toEqual(["/new", "/older", "/old", "/moved"]);
  });

  test("a poll with every repository fresh asks for nothing, so no worker starts", () => {
    const repos = { "/a": entryAt({ fetchedAt: t0 - 10_000, stamp: "s" }), "/b": entryAt({ fetchedAt: t0 - 20_000, stamp: "s", net: true }) };
    expect(planGitRefresh(["/a", "/b"], cache(repos), t0, () => "s")).toEqual([]);
  });
});

describe("the cache file is read like untrusted input", () => {
  const good = () => ({ v: GIT_CACHE_VERSION, repos: { "/r": { ...entryAt(), state: { branch: "main", dirty: 2 }, changes: { count: 2 }, origin: "git@github.com:a/b.git" } }, commits: { ["a".repeat(40)]: { hash: "a".repeat(40), short: "aaaaaaa", committedAt: 1, subject: "s" } } });

  test("a well-formed file round-trips", () => {
    const parsed = parseGitCache(JSON.stringify(good()));
    expect(parsed.repos["/r"].state).toEqual({ branch: "main", dirty: 2 });
    expect(parsed.repos["/r"].origin).toBe("git@github.com:a/b.git");
    expect(Object.keys(parsed.commits)).toHaveLength(1);
  });

  test("missing, damaged or foreign files give an empty cache, never a throw", () => {
    for (const text of [null, "", "{", "[]", "null", JSON.stringify({ v: 99, repos: {} }), JSON.stringify({ repos: {} })]) {
      expect(parseGitCache(text as any)).toEqual(emptyGitCache());
    }
  });

  test("a bad entry is dropped and the good ones survive", () => {
    const file: any = good();
    file.repos["relative/path"] = entryAt();
    file.repos["/wrongversion"] = { ...entryAt(), v: 7 };
    file.repos["/notobject"] = "x";
    file.repos["/ok2"] = { ...entryAt(), fetchedAt: -5, failures: 1e9, state: [1], changes: "no", origin: 5 };
    const parsed = parseGitCache(JSON.stringify(file));
    expect(Object.keys(parsed.repos).sort()).toEqual(["/ok2", "/r"]);
    const sanitized = parsed.repos["/ok2"];
    expect(sanitized.fetchedAt).toBe(0);
    expect(sanitized.failures).toBe(32);
    expect(sanitized.state).toBeNull();
    expect(sanitized.changes).toBeNull();
    expect(sanitized.origin).toBeUndefined();
    expect(sanitizeGitEntry({ v: GIT_CACHE_VERSION, root: "x".repeat(5000) })!.root.length).toBe(1024);
  });

  test("the file cannot grow past its entry cap, and old entries are pruned", () => {
    const repos: Record<string, any> = {};
    for (let i = 0; i < GIT_CACHE_MAX_ENTRIES + 40; i++) repos["/r" + i] = entryAt();
    expect(Object.keys(parseGitCache(JSON.stringify({ v: GIT_CACHE_VERSION, repos, commits: {} })).repos)).toHaveLength(GIT_CACHE_MAX_ENTRIES);
    const at = 10 * GIT_CACHE_KEEP_MS;
    const cache: GitCache = { ...emptyGitCache(), repos: {
      "/today": entryAt({ fetchedAt: at - 1000 }),
      "/yesterday": entryAt({ fetchedAt: at - GIT_CACHE_KEEP_MS - 1 }),
      "/failedtoday": entryAt({ fetchedAt: 0, failedAt: at - 5 }),
    } };
    expect(Object.keys(pruneGitCache(cache, at).repos).sort()).toEqual(["/failedtoday", "/today"]);
  });
});

describe("the refresh worker's lock", () => {
  const t0 = 9_000_000, yes = () => true, no = () => false;
  test("a live worker inside its lifetime blocks a second one; a dead or overdue one does not", () => {
    expect(gitWorkerAlive({ pid: 4242, at: t0 - 5000 }, t0, yes)).toBe(true);
    expect(gitWorkerAlive({ pid: 4242, at: t0 - 5000 }, t0, no)).toBe(false);
    expect(gitWorkerAlive({ pid: 4242, at: t0 - GIT_WORKER_MAX_MS - 6000 }, t0, yes)).toBe(false);
    expect(gitWorkerAlive({ pid: 1, at: t0 }, t0, yes)).toBe(false);
    expect(gitWorkerAlive({ pid: "4242", at: "soon" }, t0, yes)).toBe(false);
    expect(gitWorkerAlive(null, t0, yes)).toBe(false);
    expect(gitWorkerAlive({ pid: 4242, at: t0 + 600_000 }, t0, yes)).toBe(false);
  });

  test("a poll that has claimed the lock and is still starting the worker counts as alive, briefly", () => {
    expect(gitWorkerAlive({ pid: 0, at: t0 - 1000 }, t0, no)).toBe(true);
    expect(gitWorkerAlive({ pid: 0, at: t0 - GIT_CLAIM_GRACE_MS }, t0, yes)).toBe(false);
    expect(gitWorkerAlive({ pid: 0, at: 0 }, t0, yes)).toBe(false);
  });

  test("what a poll hands the worker is bounded absolute directories", () => {
    expect(parseGitWant(JSON.stringify(["/a", "/a", "/b"]))).toEqual(["/a", "/b"]);
    expect(parseGitWant(JSON.stringify(["rel", "/ok", 5, null, "/x\0y", "/" + "z".repeat(2000)]))).toEqual(["/ok"]);
    expect(parseGitWant(JSON.stringify(Array.from({ length: 500 }, (_, i) => "/d" + i)))).toHaveLength(64);
    for (const bad of [null, "", "{", "{}", "7"]) expect(parseGitWant(bad as any)).toEqual([]);
  });
});

describe("the worker keeps each filesystem to its cap and skips what is fresh", () => {
  const t0 = 20_000_000;
  function harness(fresh: string[] = []) {
    const cache = emptyGitCache();
    for (const cwd of fresh) cache.repos[cwd] = entryAt({ fetchedAt: t0 - 1000, stamp: gitStamp(entryAt()), net: true });
    const saved: string[][] = [];
    const live = { net: 0, local: 0 }, widest = { net: 0, local: 0 }, started: string[] = [];
    const isNetwork = (cwd: string) => cwd.startsWith("/nas");
    return {
      cache, saved, widest, started,
      io: {
        load: () => cache, save: (c: GitCache) => { saved.push(Object.keys(c.repos)); },
        clock: () => t0, isNetwork,
        refresh: async (cwd: string, _previous: GitEntry | undefined, _commits: Record<string, any>, at: number): Promise<GitEntry> => {
          const lane = isNetwork(cwd) ? "net" : "local";
          started.push(cwd); live[lane]++; widest[lane] = Math.max(widest[lane], live[lane]);
          await sleep(5); live[lane]--;
          return entryAt({ fetchedAt: at, net: lane === "net" });
        },
      },
    };
  }

  test("eight network repositories are refreshed one at a time, six local ones two at a time", async () => {
    const h = harness();
    const nas = Array.from({ length: 8 }, (_, i) => "/nas/p" + i), local = Array.from({ length: 6 }, (_, i) => "/home/l" + i);
    const done = await runGitRefresh([...nas, ...local], h.io as any);
    expect(done.sort()).toEqual([...local, ...nas].sort());
    expect(h.widest.net).toBe(GIT_CAP_NET);
    expect(h.widest.local).toBe(GIT_CAP_LOCAL);
  });

  test("it saves after every repository, so a worker killed halfway still left a usable cache", async () => {
    const h = harness();
    await runGitRefresh(["/nas/a", "/nas/b", "/nas/c"], h.io as any);
    expect(h.saved.map(keys => keys.length)).toEqual([1, 2, 3]);
  });

  test("a repository another worker just refreshed is not asked again", async () => {
    const h = harness(["/nas/done"]);
    const done = await runGitRefresh(["/nas/done", "/nas/todo"], h.io as any);
    expect(done).toEqual(["/nas/todo"]);
    expect(h.started).toEqual(["/nas/todo"]);
  });

  test("it stops starting new repositories once its deadline passes, and what it skipped stays stale", async () => {
    const h = harness();
    let now = t0;
    const inner = h.io.refresh;
    const io: any = { ...h.io, clock: () => now, deadline: t0 + 12, refresh: async (cwd: string, ...rest: any[]) => { const entry = await (inner as any)(cwd, ...rest); now += 8; return entry; } };
    const done = await runGitRefresh(["/nas/a", "/nas/b", "/nas/c", "/nas/d"], io);
    expect(done).toEqual(["/nas/a", "/nas/b"]);
    expect(h.cache.repos["/nas/c"]).toBeUndefined();
    expect(planGitRefresh(["/nas/c", "/nas/d"], h.cache, t0, () => "")).toEqual(["/nas/c", "/nas/d"]);
  });

  test("a repository that blows up costs its own slot only, the rest still refresh", async () => {
    const h = harness();
    const inner = h.io.refresh;
    (h.io as any).refresh = async (cwd: string, ...rest: any[]) => { if (cwd === "/nas/bad") throw new Error("kaput"); return (inner as any)(cwd, ...rest); };
    const done = await runGitRefresh(["/nas/a", "/nas/bad", "/nas/c"], h.io as any);
    expect(done.sort()).toEqual(["/nas/a", "/nas/c"]);
  });
});

describe("a poll never runs git (real collector, real repository, a git that logs every call)", () => {
  // The collector scans every process on the machine, so a poll here also meets
  // whatever real agents are running. The shim below answers only for the test
  // repository and fails at once for any other, so this suite can never put
  // load on a real checkout (or an NFS mount) however many agents are up.
  const bun = process.execPath, real = Bun.which("git") || "/usr/bin/git", sleepBin = Bun.which("sleep") || "/usr/bin/sleep";
  const base = realpathSync(mkdtempSync(join(tmpdir(), "infomarchy-poll-")));
  const home = join(base, "home"), repo = join(base, "repo"), shim = join(base, "shim"), state = join(home, "state"), log = join(base, "git.log"), other = join(base, "other.log");
  const stateDir = join(state, "infomarchy");
  mkdirSync(home, { recursive: true }); mkdirSync(repo, { recursive: true }); mkdirSync(shim, { recursive: true });
  writeFileSync(join(shim, "git"), `#!/bin/sh\nif [ "$1" = "-C" ] && [ "$2" = "${repo}" ]; then echo "$PPID $*" >> "${log}"; exec "${real}" "$@"; fi\necho "$PPID $*" >> "${other}"\nexit 128\n`, { mode: 0o755 });
  symlinkSync(sleepBin, join(base, "claude"));
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const git = (...args: string[]) => Bun.spawnSync([real, "-C", repo, ...args], { env: gitEnv, stdout: "pipe", stderr: "pipe" });
  git("init", "-q", "-b", "main"); writeFileSync(join(repo, "a.txt"), "one\n"); git("add", "."); git("commit", "-q", "-m", "first");
  git("remote", "add", "origin", "git@example.com:acme/widget.git");
  const env = { HOME: home, USER: "tester", XDG_STATE_HOME: state, PATH: `${shim}:${process.env.PATH || ""}`, INFOMARCHY_SKIP_EXTERNAL_IP: "1", INFOMARCHY_SKIP_GITHUB: "1", INFOMARCHY_SKIP_CONTAINERS: "1", OLLAMA_HOST: "http://127.0.0.1:9" };
  // Launched through a shell that exits, so the "agent" is reparented to init. The
  // collector skips any agent whose ancestor is already an agent, and whoever runs
  // this suite may well be inside one (Claude Code, for one).
  const launched = Bun.spawnSync(["sh", "-c", '"$1" 300 >/dev/null 2>&1 </dev/null & echo $!', "sh", join(base, "claude")], { cwd: repo, stdout: "pipe", stderr: "ignore" });
  const agent = { pid: Number(launched.stdout.toString().trim()), kill: () => { try { process.kill(agent.pid); } catch {} } };
  const read = (path: string) => existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
  const lines = () => read(log), otherLines = () => read(other);
  const byParent = (all: string[], pid: number) => all.filter(line => line.split(" ")[0] === String(pid));

  async function poll() {
    const proc = Bun.spawn([bun, join(import.meta.dir, "collector.ts"), "--id", "gitpoll"], { stdout: "pipe", stderr: "ignore", env });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const frames = out.trim().split("\n").map(line => JSON.parse(line));
    const data = JSON.parse(frames.filter((f: any) => f.type === "chunk").map((f: any) => f.data).join(""));
    return { pid: proc.pid, session: (data.ai.sessions as any[]).find(s => s.pid === agent.pid) };
  }
  async function workerIdle(timeoutMs = 30_000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) { if (!existsSync(join(stateDir, "git-refresh.lock"))) return true; await sleep(100); }
    return false;
  }
  const entryFor = () => { try { return JSON.parse(readFileSync(join(stateDir, "git-state.json"), "utf8")).repos[repo]; } catch { return undefined; } };

  test("the first poll serves no git state, spawns no git itself, and a worker fills the cache", async () => {
    const first = await poll();
    expect(first.session).toBeTruthy();
    expect(first.session.git).toBeNull();
    expect(await workerIdle()).toBe(true);
    const entry = entryFor();
    expect(entry).toBeTruthy();
    expect(entry.state.branch).toBe("main");
    expect(entry.origin).toBe("git@example.com:acme/widget.git");
    expect(entry.changes.commitSubject).toBe("first");
    expect(entry.net).toBe(false);
    // The worker ran git; the poll did not, for this repository or any other.
    expect(lines().length).toBeGreaterThan(0);
    expect(byParent(lines(), first.pid)).toEqual([]);
    expect(byParent(otherLines(), first.pid)).toEqual([]);
  }, 90_000);

  test("later polls serve the cache and spawn no git at all while it is fresh", async () => {
    const before = lines().length, otherBefore = otherLines().length;
    const second = await poll(), third = await poll();
    await sleep(800);
    expect(second.session.git.branch).toBe("main");
    expect(second.session.changes.headShort).toBe(entryFor().changes.headShort);
    expect(second.session.repoRoot.length).toBeGreaterThan(0);
    expect(third.session.git.branch).toBe("main");
    expect(lines().length).toBe(before);
    expect(byParent(otherLines().slice(otherBefore), second.pid)).toEqual([]);
    expect(byParent(otherLines().slice(otherBefore), third.pid)).toEqual([]);
  }, 90_000);

  test("a commit moves the stamp, so the next poll refreshes long before the TTL", async () => {
    const before = lines().length, fetchedBefore = entryFor().fetchedAt, headBefore = entryFor().changes.head;
    writeFileSync(join(repo, "b.txt"), "two\n"); git("add", "."); git("commit", "-q", "-m", "second");
    const fourth = await poll();
    expect(await workerIdle()).toBe(true);
    expect(entryFor().fetchedAt).toBeGreaterThan(fetchedBefore);
    expect(entryFor().changes.head).not.toBe(headBefore);
    expect(entryFor().changes.commitSubject).toBe("second");
    expect(byParent(lines(), fourth.pid)).toEqual([]);
    // One status for the commit, and the remote was not asked about again.
    const added = lines().slice(before);
    expect(added.filter(line => /\bstatus\b/.test(line))).toHaveLength(1);
    expect(added.filter(line => /\bremote\b/.test(line))).toHaveLength(0);
  }, 90_000);

  afterAll(() => { agent.kill(); rmSync(base, { recursive: true, force: true }); });
});
