/**
 * s1b-workspace-mounts task 8.2 (#1694), workspace-mounts「宿主不同步进入挂载」, scenarios「根一层按名字
 * 跳过」and「其它入口」: the production createApp with an injected real mount-manager (the
 * `mounts-manager-helpers.ts` world: fake rclone, fake mountinfo) that has `远端` registered on the
 * workspace W1 — once with `RCLONE_BIN` configured, once without it (feature off). The mount point is a
 * plain directory standing for an online mount: nothing here mounts anything, so whatever touches
 * `<root>/远端` is seen by the call recorder below (every `node:fs` and `node:fs/promises` function,
 * called through, recording its first argument). Two cases differ: the file endpoints (D16; `远端` is
 * never brought up here, so it is offline in both runs) make `远端` a symlink to a directory outside the
 * workspace, and the restoring undo has the mount point appear only after the snapshot it goes back
 * to. The undo runs over scripted omp children
 * (`session-regenerate-helpers.ts`); the preview listener is the real `createPreviewApp` on the app's own
 * workspace store and sandbox facade, as the production entry builds it.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPreviewApp } from "../src/preview/app.js";
import { createPreviewTokens } from "../src/preview/tokens.js";
import type { MountManagerOptions } from "../src/workspaces/mounts/manager.js";
import { createWorld, disposeWorlds, ID1, seedMount, sftp, W1 } from "./mounts-manager-helpers.js";
import { DOCUMENT_MAX_BYTES, NOT_FOUND_TEXT, unavailableConverter } from "./preview-app-helpers.js";
import { ofType, prompted, sessionEvents, settle } from "./session-approval-helpers.js";
import { A_PDF_SUFFIX, FIRST, forkWorlds } from "./session-fork-helpers.js";
import {
  type ChildScript,
  QUESTION,
  scriptedRuntime,
  sendPrompt,
} from "./session-regenerate-helpers.js";
import { postPrompt } from "./session-rest-helpers.js";
import {
  createRealFakeRuntime,
  OWNER_ID,
  openRecordingSession,
  type RecordingWorld,
  waitForTurn,
} from "./session-supervisor-helpers.js";
import { postUndo, seedUndoable, undone, undoneWithFiles } from "./session-undo-helpers.js";
import { insertWorkspace } from "./workspaces-http-helpers.js";

/** Every `node:fs` / `node:fs/promises` call made through the module objects, by first argument. */
const fsCalls = vi.hoisted(() => [] as Array<{ name: string; path: string }>);

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const record = (prefix: string, source: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(source).map(([name, value]) => [
        name,
        typeof value !== "function"
          ? value
          : new Proxy(value, {
              apply(target, self, args) {
                fsCalls.push({ name: `${prefix}${name}`, path: String(args[0]) });
                return Reflect.apply(target, self, args);
              },
            }),
      ]),
    );
  return {
    ...record("", actual),
    promises: record("promises.", actual.promises as Record<string, unknown>),
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    Object.entries(actual).map(([name, value]) => [
      name,
      typeof value !== "function"
        ? value
        : new Proxy(value, {
            apply(target, self, args) {
              fsCalls.push({ name: `promises.${name}`, path: String(args[0]) });
              return Reflect.apply(target, self, args);
            },
          }),
    ]),
  );
});

const MOUNT = "远端";
const CASE_MS = 30_000;
/** The attachment suffix omp was given for `远端/a.md` then `uploads/a.pdf`, as `A_PDF_SUFFIX` spells one. */
const BOTH_SUFFIX = A_PDF_SUFFIX.replace("- uploads/a.pdf", `- ${MOUNT}/a.md\n- uploads/a.pdf`);
const BOTH_STORED = JSON.stringify([
  { path: `${MOUNT}/a.md`, size: 3 },
  { path: "uploads/a.pdf", size: 3 },
]);

const worlds = forkWorlds();
const unlocked: string[] = [];

beforeEach(() => {
  fsCalls.length = 0;
});

afterEach(async () => {
  for (const path of unlocked.splice(0)) {
    chmodSync(path, 0o700);
  }
  await disposeWorlds();
});

/**
 * The app over scripted omp children, with W1 (`<sandbox>/u1/w1`) of zhangsan in its database and the
 * manager of a mount world that registered `远端` on W1 before it was built (D12: the registry is read
 * at construction). `featureOff` builds that manager without `rcloneBin` / `fusermountBin`. The undo's
 * temporary process lists FIRST with both attachments' suffix, then QUESTION.
 */
async function openSkipWorld(
  featureOff: boolean,
  scripts: ChildScript[] = [
    {
      messages: [
        { entryId: "e-1", text: `${FIRST}${BOTH_SUFFIX}` },
        { entryId: "e-2", text: QUESTION },
      ],
    },
  ],
) {
  const manager = managerWith(MOUNT, featureOff);
  const { rt, scripted } = scriptedRuntime(scripts);
  const opened = await openRecordingSession(rt.runtime, {
    prepare: (db) => insertWorkspace(db, W1, OWNER_ID, "w1", "w1", 1),
    assembly: { mounts: manager },
  });
  const world = worlds.track({ ...opened, rt, scripted });
  mkdirSync(join(rt.runtime.sandboxRoot, OWNER_ID, "w1"), { recursive: true });
  const root = realpathSync(join(rt.runtime.sandboxRoot, OWNER_ID, "w1"));
  return { world, root, mount: join(root, MOUNT), sandboxRoot: rt.runtime.sandboxRoot };
}

/** A mount world's manager with `name` registered on W1; without the two bins when `featureOff`. */
function managerWith(name: string, featureOff: boolean) {
  const mounts = createWorld();
  seedMount(mounts, { id: ID1, body: sftp("/srv/data", { name }), createdAt: 1 });
  const full = mounts.options();
  const { rcloneBin: _rclone, fusermountBin: _fusermount, ...off } = full;
  const manager = mounts.build(featureOff ? (off as MountManagerOptions) : full);
  expect([...manager.namesOf(W1)]).toEqual([name]);
  return manager;
}

type SkipWorld = Awaited<ReturnType<typeof openSkipWorld>>;

/** The recorded calls whose first argument is the mount point or a path below it. */
function callsIntoMount(mount: string) {
  return fsCalls.filter((call) => call.path === mount || call.path.startsWith(`${mount}/`));
}

/** What the test itself writes goes through the recorder too; each case empties it afterwards. */
function put(root: string, path: string, bytes: string): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), bytes);
}

async function treeOf(skip: SkipWorld) {
  const response = await skip.world.fixture.app.inject({
    method: "GET",
    url: `/api/workspaces/${W1}/tree`,
    headers: { cookie: skip.world.cookie },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as { path: string; entries: Array<{ name: string; type: string }> };
}

/** A session of zhangsan bound to W1, created over REST. */
async function boundSession(world: RecordingWorld): Promise<string> {
  const response = await world.fixture.app.inject({
    method: "POST",
    url: "/api/sessions",
    headers: { cookie: world.cookie },
    payload: { workspaceId: W1 },
  });
  expect(response.statusCode, response.body).toBe(201);
  return (response.json() as { id: string }).id;
}

/** The recorded calls whose first argument is under any of `paths` (or is one of them). */
function callsInto(...paths: string[]) {
  return fsCalls.filter((call) =>
    paths.some((path) => call.path === path || call.path.startsWith(`${path}/`)),
  );
}

/** Every entry under `dir`: a file by its text, a directory (`path/`) as null. */
function listed(dir: string, parent = ""): Record<string, string | null> {
  const found: Record<string, string | null> = {};
  for (const entry of readdirSync(join(dir, parent), { withFileTypes: true })) {
    const path = parent === "" ? entry.name : `${parent}/${entry.name}`;
    if (entry.isDirectory()) {
      found[`${path}/`] = null;
      Object.assign(found, listed(dir, path));
    } else {
      found[path] = readFileSync(join(dir, path), "utf8");
    }
  }
  return found;
}

/** One REST turn of `message` on `session` to done; its user message id. */
async function turn(world: RecordingWorld, message: string, session: string): Promise<number> {
  const response = await sendPrompt(world, message, session);
  expect(response.statusCode, response.body).toBe(202);
  await waitForTurn(world.fixture, session, "done");
  await settle();
  return (response.json() as { userMessageId: number }).userMessageId;
}

const q = (path: string) => `path=${encodeURIComponent(path)}`;
const OFFLINE = [409, "mount_offline"];
const BOUNDARY = [409, "mount_boundary"];
const move = (from: string, to: string) => JSON.stringify({ from, to });

/**
 * D16 / D21 (workspace-mounts「挂载目录内的文件端点」, file-operations「删除到回收目录」「重命名与移动」):
 * [method, url below the workspace, body, [status, code]]. `远端备份` (a name that only starts with
 * the mount's) and the archive of the root are the controls the rule leaves alone.
 */
const ENDPOINT_CASES: Array<
  ["GET" | "POST" | "DELETE", string, string | undefined, (string | number)[]]
> = [
  ["GET", `tree?${q(MOUNT)}`, undefined, OFFLINE],
  ["GET", `tree?${q(`./${MOUNT}`)}`, undefined, OFFLINE],
  ["GET", `tree?${q(`${MOUNT}/x`)}`, undefined, OFFLINE],
  ["GET", `file?${q(`${MOUNT}/s.txt`)}`, undefined, OFFLINE],
  ["GET", `file?${q(`${MOUNT}//s.txt`)}`, undefined, OFFLINE],
  ["GET", `download?${q(`${MOUNT}/s.txt`)}`, undefined, OFFLINE],
  ["GET", `download?${q(`./${MOUNT}/s.txt`)}`, undefined, OFFLINE],
  ["GET", `archive?${q(MOUNT)}`, undefined, OFFLINE],
  ["GET", `archive?${q(`${MOUNT}/x.zip`)}`, undefined, OFFLINE],
  ["POST", "dirs", JSON.stringify({ path: `${MOUNT}/new` }), OFFLINE],
  ["POST", "dirs", JSON.stringify({ path: MOUNT }), OFFLINE],
  ["DELETE", `entries?${q(`${MOUNT}/x/inner.txt`)}`, undefined, BOUNDARY],
  ["POST", "move", move(`${MOUNT}/s.txt`, `${MOUNT}/t.txt`), OFFLINE],
  ["POST", "move", move(`${MOUNT}/s.txt`, "out/s.txt"), BOUNDARY],
  ["POST", "move", move("out/a", `${MOUNT}/a`), BOUNDARY],
  ["POST", "move", move(`./${MOUNT}/s.txt`, "s.txt"), BOUNDARY],
  ["POST", "move", move(MOUNT, "别名"), BOUNDARY],
  ["POST", "move", move(`${MOUNT}/x`, `${MOUNT}/x/y`), [400, "bad_request"]],
  ["DELETE", `entries?${q(MOUNT)}`, undefined, BOUNDARY],
  ["DELETE", `entries?${q(`./${MOUNT}`)}`, undefined, BOUNDARY],
  ["DELETE", `entries?${q(`${MOUNT}/s.txt`)}`, undefined, BOUNDARY],
  ["DELETE", `entries?${q(`${MOUNT}/../x`)}`, undefined, [403, "sandbox_denied"]],
  ["GET", `archive?${q("")}`, undefined, [404, "not_found"]],
  ["GET", `file?${q(`${MOUNT}备份/s.txt`)}`, undefined, [200, ""]],
  ["GET", "tree", undefined, [200, ""]],
];

describe.each([
  ["RCLONE_BIN configured", false],
  ["feature off (no RCLONE_BIN), 远端 still registered", true],
])("宿主不同步进入挂载 — %s", (_label, featureOff) => {
  it.skipIf(process.getuid?.() === 0)(
    "根一层按名字跳过: the root tree is exactly out; 远端 (mode 0000) keeps its mode and content and is never touched",
    { timeout: CASE_MS },
    async () => {
      const skip = await openSkipWorld(featureOff);
      mkdirSync(join(skip.root, "out"));
      put(skip.root, `${MOUNT}/b.txt`, "behind the mount\n");
      chmodSync(skip.mount, 0o000);
      unlocked.push(skip.mount);
      fsCalls.length = 0;

      const tree = await treeOf(skip);

      expect(tree).toEqual({ path: "", entries: [expect.objectContaining({ name: "out" })] });
      expect(tree.entries.map((entry) => [entry.name, entry.type])).toEqual([["out", "dir"]]);
      expect(callsIntoMount(skip.mount)).toEqual([]);
      expect(statSync(skip.mount).mode & 0o7777).toBe(0o000);
      chmodSync(skip.mount, 0o700);
      expect(readdirSync(skip.mount)).toEqual(["b.txt"]);
      expect(readFileSync(join(skip.mount, "b.txt"), "utf8")).toBe("behind the mount\n");
    },
  );

  it("其它入口: preview source 404, attachment 400 after the sandbox, undo hands it not back — nothing under 远端 touched", {
    timeout: CASE_MS,
  }, async () => {
    const skip = await openSkipWorld(featureOff);
    put(skip.root, `${MOUNT}/a.md`, "md!");
    put(skip.root, "uploads/a.pdf", "pdf");
    const session = await boundSession(skip.world);
    const { app } = skip.world.fixture;
    const tokens = createPreviewTokens();
    const preview = createPreviewApp({
      store: app.workspaces.store,
      sandbox: app.workspaces.sandbox,
      tokens,
      converter: unavailableConverter(),
      limits: { documentMaxBytes: DOCUMENT_MAX_BYTES },
    });
    const { token } = tokens.issue(
      { ownerId: OWNER_ID, workspaceId: W1, embedOrigin: null },
      Date.now(),
    );
    const seeded = seedUndoable(skip.world, {}, session);
    skip.world.fixture.db
      .prepare("UPDATE chat_messages SET attachments = ? WHERE id = ?")
      .run(BOTH_STORED, seeded.u1);
    fsCalls.length = 0;

    try {
      const inMount = await preview.inject({
        method: "GET",
        url: encodeURI(`/w/${token}/${MOUNT}/a.md`),
      });
      expect([inMount.statusCode, inMount.body]).toEqual([404, NOT_FOUND_TEXT]);
      const beside = await preview.inject({ method: "GET", url: `/w/${token}/uploads/a.pdf` });
      expect([beside.statusCode, beside.body]).toEqual([200, "pdf"]);
    } finally {
      await preview.close();
    }

    const prompt = (attachments: string[]) =>
      postPrompt(app, session, skip.world.cookie, JSON.stringify({ message: "看看", attachments }));
    const refused = await prompt([`${MOUNT}/a.md`]);
    expect([refused.statusCode, refused.json()]).toEqual([
      400,
      { error: expect.objectContaining({ code: "bad_request" }) },
    ]);
    // The sandbox judges every path first: an escape beside it is the 403 (and its audit row).
    const escaped = await prompt([`${MOUNT}/a.md`, "../x"]);
    expect([escaped.statusCode, escaped.json()]).toEqual([
      403,
      { error: expect.objectContaining({ code: "sandbox_denied" }) },
    ]);

    const body = undone(await postUndo(skip.world, seeded.u1, session));

    expect(body.draft).toBe(FIRST);
    expect(body.attachments).toEqual([{ path: "uploads/a.pdf", size: 3 }]);
    expect(callsIntoMount(skip.mount)).toEqual([]);
    expect(fsCalls.some((call) => call.path === join(skip.root, "uploads", "a.pdf"))).toBe(true);
  });

  it("挂载目录内的文件端点 (offline mount): 远端 is a symlink out of the workspace — every endpoint is 409 before any fs call, the target is untouched", {
    timeout: CASE_MS,
  }, async () => {
    const skip = await openSkipWorld(featureOff);
    const outside = join(realpathSync(dirname(skip.sandboxRoot)), "outside");
    put(outside, "s.txt", "outside sentinel\n");
    put(outside, "x/inner.txt", "inner\n");
    put(skip.root, "out/a", "local a\n");
    put(skip.root, `${MOUNT}备份/s.txt`, "beside\n");
    symlinkSync(outside, skip.mount);
    const outsideBefore = listed(outside);
    fsCalls.length = 0;

    const answers: Array<[string, number, string]> = [];
    for (const [method, url, payload] of ENDPOINT_CASES) {
      const response = await skip.world.fixture.app.inject({
        method,
        url: `/api/workspaces/${W1}/${url}`,
        headers:
          payload === undefined
            ? { cookie: skip.world.cookie }
            : { cookie: skip.world.cookie, "content-type": "application/json" },
        ...(payload === undefined ? {} : { payload }),
      });
      const code = response.statusCode >= 400 ? (response.json().error.code as string) : "";
      answers.push([
        `${method} ${url} ${JSON.stringify(payload ?? null)}`,
        response.statusCode,
        code,
      ]);
    }

    expect(answers.map(([, status, code]) => [status, code])).toEqual(
      ENDPOINT_CASES.map(([, , , expected]) => expected),
    );
    expect(callsInto(skip.mount, outside)).toEqual([]);
    expect(listed(outside)).toEqual(outsideBefore);
    expect(outsideBefore).toEqual({
      "s.txt": "outside sentinel\n",
      "x/": null,
      "x/inner.txt": "inner\n",
    });
    expect(readFileSync(join(skip.root, "out", "a"), "utf8")).toBe("local a\n");
    const { db } = skip.world.fixture;
    expect(
      db
        .prepare(
          "SELECT kind FROM audit_events WHERE kind IN ('file.delete','file.move','dir.create','file.download','sandbox.reject') ORDER BY id",
        )
        .all()
        .map((row) => row.kind),
    ).toEqual(["sandbox.reject"]);
    const batches = join(skip.sandboxRoot, ".trash", OWNER_ID, W1);
    expect(existsSync(batches) ? readdirSync(batches) : []).toEqual([]);
  });

  it("还原经快照服务带上挂载名: an undo restoring files leaves 远端 unread and untouched", {
    timeout: CASE_MS,
  }, async () => {
    const skip = await openSkipWorld(featureOff, [{}]);
    put(skip.root, "a.txt", "before\n");
    const session = await boundSession(skip.world);
    await turn(skip.world, FIRST, session);
    const u2 = await turn(skip.world, QUESTION, session);
    put(skip.root, "a.txt", "rewritten\n");
    // The mount point appears after u2's snapshot (attached later), so the manifest does not name
    // it: only the names `restore` is handed keep it from being removed as an extra.
    put(skip.root, `${MOUNT}/b.txt`, "behind the mount\n");
    put(skip.root, `${MOUNT}/new.txt`, "made while the mount was up\n");
    fsCalls.length = 0;

    const body = undoneWithFiles(await postUndo(skip.world, u2, session, "restore"));

    expect(body.files).toMatchObject({
      mode: "restored",
      restored: 1,
      removed: 0,
      skipped: { count: 1, paths: [{ path: MOUNT, reason: "mount" }] },
      failed: { count: 0, paths: [] },
    });
    expect(callsIntoMount(skip.mount)).toEqual([]);
    expect(readFileSync(join(skip.root, "a.txt"), "utf8")).toBe("before\n");
    expect(listed(skip.mount)).toEqual({
      "b.txt": "behind the mount\n",
      "new.txt": "made while the mount was up\n",
    });
  });
});

describe("文件变更归属经会话: the registered names reach the turn's ownership judgment", () => {
  it.each([
    ["RCLONE_BIN configured", false],
    ["feature off", true],
  ])(
    "%s: fake-omp edit-write with `out` registered — only notes.md is a file change, out/ is never touched",
    {
      timeout: CASE_MS,
    },
    async (_label, featureOff) => {
      const { runtime } = createRealFakeRuntime("edit-write");
      runtime.sandboxRoot = join(realpathSync(dirname(runtime.sandboxRoot)), "sandbox");
      mkdirSync(join(runtime.sandboxRoot, OWNER_ID, "w1"), { recursive: true });
      const opened = await openRecordingSession(runtime, {
        prepare: (db) => insertWorkspace(db, W1, OWNER_ID, "w1", "w1", 1),
        assembly: { mounts: managerWith("out", featureOff) },
      });
      const world = worlds.track(opened);
      const root = realpathSync(join(runtime.sandboxRoot, OWNER_ID, "w1"));
      const session = await boundSession(world);
      // There before the turn: the prompt's snapshot (D21, the app's snapshot service) skips it too.
      put(root, "out/old.txt", "old\n");
      fsCalls.length = 0;

      await prompted(world, session);
      await waitForTurn(world.fixture, session, "done");
      await settle();

      expect(
        ofType(sessionEvents(world, session), "files.changed").map((e) => e.data.files),
      ).toEqual([[{ path: "notes.md", added: 2, removed: 1, kind: "edit" }]]);
      const steps = world.fixture.db
        .prepare("SELECT name, changes FROM chat_steps ORDER BY id")
        .all()
        .map((row) => ({ ...row }));
      expect(steps).toEqual([
        { name: "edit", changes: '[{"path":"notes.md","added":2,"removed":1,"kind":"edit"}]' },
        { name: "write", changes: null },
      ]);
      expect(callsIntoMount(join(root, "out"))).toEqual([]);
      // The child really wrote both files: the one inside the registered mount is no file change.
      expect(readFileSync(join(root, "out", "report.html"), "utf8")).not.toBe("");
    },
  );
});
