/**
 * s1b-workspace-mounts task 8.2 (#1694), workspace-mounts「宿主不同步进入挂载」, scenarios「根一层按名字
 * 跳过」and「其它入口」: the production createApp with an injected real mount-manager (the
 * `mounts-manager-helpers.ts` world: fake rclone, fake mountinfo) that has `远端` registered on the
 * workspace W1 — once with `RCLONE_BIN` configured, once without it (feature off). The mount point is a
 * plain directory standing for an online mount: nothing here mounts anything, so whatever touches
 * `<root>/远端` is seen by the call recorder below (every `node:fs` and `node:fs/promises` function,
 * called through, recording its first argument). The undo runs over scripted omp children
 * (`session-regenerate-helpers.ts`); the preview listener is the real `createPreviewApp` on the app's own
 * workspace store and sandbox facade, as the production entry builds it.
 */
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
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
import { QUESTION, scriptedRuntime } from "./session-regenerate-helpers.js";
import { postPrompt } from "./session-rest-helpers.js";
import {
  createRealFakeRuntime,
  OWNER_ID,
  openRecordingSession,
  type RecordingWorld,
  waitForTurn,
} from "./session-supervisor-helpers.js";
import { postUndo, seedUndoable, undone } from "./session-undo-helpers.js";
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
async function openSkipWorld(featureOff: boolean) {
  const manager = managerWith(MOUNT, featureOff);
  const { rt, scripted } = scriptedRuntime([
    {
      messages: [
        { entryId: "e-1", text: `${FIRST}${BOTH_SUFFIX}` },
        { entryId: "e-2", text: QUESTION },
      ],
    },
  ]);
  const opened = await openRecordingSession(rt.runtime, {
    prepare: (db) => insertWorkspace(db, W1, OWNER_ID, "w1", "w1", 1),
    assembly: { mounts: manager },
  });
  const world = worlds.track({ ...opened, rt, scripted });
  mkdirSync(join(rt.runtime.sandboxRoot, OWNER_ID, "w1"), { recursive: true });
  const root = realpathSync(join(rt.runtime.sandboxRoot, OWNER_ID, "w1"));
  return { world, root, mount: join(root, MOUNT) };
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
