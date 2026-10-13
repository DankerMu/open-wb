/**
 * Issue #1257 (s1-followups-batch tasks 8.1–8.3; message-attachments「prompt 携带附件」conditions 1
 * and 4, scenarios「附件形状与前提」and「空间根丢失时带附件的 prompt」): the code points and the last
 * segment a path may not have, and the session workspace whose root is not there.
 *
 * The world is the one of session-prompt-attachments.test.ts (its helpers): the production
 * assembly over a real SQLite and real directories, driven through `app.inject()`. Oracles: the
 * response, the `chat_messages` rows, the rows the request added to `audit_events`, the calls that
 * reached the supervisor. `admitAttachments` is also called directly for what no request can
 * show: that nothing is resolved, and what a root lookup the real store never gives leads to.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type AttachmentAdmission, admitAttachments } from "../src/sessions/prompt-attachments.js";
import { WorkspaceRootOccupiedError } from "../src/workspaces/store.js";
import {
  BAD_REQUEST_ENVELOPE,
  INTERNAL_ERROR_ENVELOPE,
  NOT_FOUND_ENVELOPE,
} from "./session-db-helpers.js";
import {
  A_PDF,
  closeWorlds,
  expectAdmitted,
  expectRefused,
  openWorld,
  put,
  rowsOf,
  type World,
} from "./session-prompt-attachments-helpers.js";
import { REFUSED_CODE_POINTS, SANDBOX_DENIED_ENVELOPE } from "./workspace-upload-helpers.js";

const scratch: string[] = [];

afterEach(async () => {
  await closeWorlds();
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("attachment shape: refused code points and the last segment (#1257)", () => {
  it.each(REFUSED_CODE_POINTS)(
    "answers 400 for a path holding $label, though that file exists",
    async ({ char }) => {
      const world = await openWorld();
      const inName = `uploads/a${char}.pdf`;
      const inDirectory = `dir${char}/a.pdf`;
      put(world.proj.root, inName, "pdf");
      put(world.proj.root, inDirectory, "pdf");

      for (const path of [inName, inDirectory]) {
        const audit = await expectRefused(
          world,
          await world.proj.session(),
          { message: "看看", attachments: [path] },
          400,
          BAD_REQUEST_ENVELOPE,
        );
        expect(audit).toEqual([]);
      }
    },
  );

  it.each([
    ["看看", `${A_PDF}/.`],
    ["", `${A_PDF}/.`],
    ["看看", "uploads/./."],
  ])(
    "answers 400 for message %j with the path %j, whose last segment is `.`",
    async (message, path) => {
      const world = await openWorld();

      const audit = await expectRefused(
        world,
        await world.proj.session(),
        { message, attachments: [path] },
        400,
        BAD_REQUEST_ENVELOPE,
      );

      expect(audit).toEqual([]);
    },
  );

  it("still admits a `.` segment in the middle, stored as given", async () => {
    const world = await openWorld();
    const session = await world.proj.session();

    const admitted = await expectAdmitted(world, session, {
      message: "",
      attachments: ["uploads/./a.pdf", "./uploads/a.pdf"],
    });

    expect(admitted.text).toContain("\n- uploads/./a.pdf\n- ./uploads/a.pdf");
    expect(JSON.parse(String(rowsOf(world, session)[0]?.attachments))).toEqual([
      { path: "uploads/./a.pdf", size: 3 },
      { path: "./uploads/a.pdf", size: 3 },
    ]);
  });

  // Not in the list: ordinary non-ASCII text, and the assigned neighbours of the refused ranges
  // that a file name can carry on every file system the tests run on (the exact edges of each
  // range are in refused-characters.test.ts, where no file has to exist).
  it.each([
    ["Chinese and a space", "报告 v2"],
    ["an emoji", "a😀"],
    ["U+00A0", "a\u00a0b"],
    ["U+200D", "a\u200db"],
    ["U+2010", "a\u2010b"],
    ["U+202F", "a\u202fb"],
    ["U+206A", "a\u206ab"],
  ])("still admits a path holding %s", async (_label, stem) => {
    const world = await openWorld();
    const session = await world.proj.session();
    const path = `uploads/${stem}.pdf`;
    put(world.proj.root, path, "four");

    await expectAdmitted(world, session, { message: "看看", attachments: [path] });

    expect(JSON.parse(String(rowsOf(world, session)[0]?.attachments))).toEqual([{ path, size: 4 }]);
  });
});

describe("a prompt with attachments on a workspace whose root is not there (#1257)", () => {
  const body = { message: "看看", attachments: [A_PDF] };

  /** `count` sessions bound to `proj`, made while its root is still a directory. */
  async function sessionsOf(world: World, count: number): Promise<string[]> {
    const sessions: string[] = [];
    for (let made = 0; made < count; made += 1) {
      sessions.push(await world.proj.session());
    }
    return sessions;
  }

  it("answers 404 without an audit event when the root directory was deleted", async () => {
    const world = await openWorld();
    const sessions = await sessionsOf(world, 2);
    rmSync(world.proj.root, { recursive: true });

    for (const [index, sent] of [body, { message: "", attachments: [A_PDF] }].entries()) {
      const audit = await expectRefused(
        world,
        sessions[index] ?? "",
        sent,
        404,
        NOT_FOUND_ENVELOPE,
      );
      expect(audit).toEqual([]);
    }
  });

  it("answers the same 404 when the root path is occupied by a regular file", async () => {
    const world = await openWorld();
    const [session = ""] = await sessionsOf(world, 1);
    rmSync(world.proj.root, { recursive: true });
    writeFileSync(world.proj.root, "occupant");

    const audit = await expectRefused(world, session, body, 404, NOT_FOUND_ENVELOPE);

    expect(audit).toEqual([]);
    expect(readFileSync(world.proj.root, "utf8")).toBe("occupant");
  });

  it.each([
    ["deleted", false],
    ["occupied", true],
  ])(
    "resolves nothing while the root is %s: an escaping path is 404, not an audited 403",
    async (_label, occupied) => {
      const world = await openWorld();
      const paths = ["../other/secret.txt", "/etc/hosts", "uploads/missing.pdf", "uploads"];
      const sessions = await sessionsOf(world, paths.length);
      rmSync(world.proj.root, { recursive: true });
      if (occupied) {
        writeFileSync(world.proj.root, "occupant");
      }

      for (const [index, path] of paths.entries()) {
        const audit = await expectRefused(
          world,
          sessions[index] ?? "",
          { message: "看看", attachments: [path] },
          404,
          NOT_FOUND_ENVELOPE,
        );
        expect(audit).toEqual([]);
      }
    },
  );

  it("judges the shape, and the root again on every request", async () => {
    const world = await openWorld();
    const sessions = await sessionsOf(world, 7);
    rmSync(world.proj.root, { recursive: true });

    // Condition 1 comes first: a malformed list is 400 whatever the root is. `.` alone is one:
    // with the root in place it would be 400 anyway, as the directory it names.
    for (const attachments of [
      [`${A_PDF}/`],
      [`${A_PDF}/.`],
      ["."],
      ["uploads/a\u2028.pdf"],
      [A_PDF, A_PDF],
    ]) {
      const audit = await expectRefused(
        world,
        sessions.pop() ?? "",
        { message: "看看", attachments },
        400,
        BAD_REQUEST_ENVELOPE,
      );
      expect(audit).toEqual([]);
    }

    // The root is back: the same path is admitted, and an escape is the audited 403 it was.
    put(world.proj.root, A_PDF, "pdf");
    await expectAdmitted(world, sessions.pop() ?? "", body);
    const escaped = await expectRefused(
      world,
      sessions.pop() ?? "",
      { message: "看看", attachments: ["../other/secret.txt"] },
      403,
      SANDBOX_DENIED_ENVELOPE,
    );
    expect(escaped).toEqual([
      {
        kind: "sandbox.reject",
        actorId: "u1",
        workspaceId: world.proj.id,
        detail: { relPath: "../other/secret.txt", op: "read", reason: expect.any(String) },
      },
    ]);
  });

  // design D14-1: a root that is a symbolic link stays the store's generic failure.
  it("keeps the sanitized 500 for a root that is a symbolic link to a directory", async () => {
    const world = await openWorld();
    const target = join(world.proj.root, "..", "elsewhere");
    put(target, A_PDF, "pdf");
    const [session = ""] = await sessionsOf(world, 1);
    rmSync(world.proj.root, { recursive: true });
    symlinkSync(target, world.proj.root, "dir");

    const audit = await expectRefused(world, session, body, 500, INTERNAL_ERROR_ENVELOPE);

    expect(audit).toEqual([]);
  });
});

describe("admitAttachments and the root of the workspace (#1257)", () => {
  function scratchDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "open-wb-1257-"));
    scratch.push(dir);
    return dir;
  }

  /** An admission of `paths` whose root lookup is `rootOf`; `log` is what was asked, in order. */
  function admission(
    paths: string[],
    rootOf: AttachmentAdmission["workspaceRootOf"],
    log: string[] = [],
  ): AttachmentAdmission {
    return {
      sandbox: {
        resolve: (_principal, _workspace, path) => {
          log.push(`resolve ${path}`);
          return join(scratchDir(), path);
        },
      },
      workspaceRootOf: (ownerId, workspaceId) => {
        log.push(`root ${ownerId} ${workspaceId}`);
        return rootOf(ownerId, workspaceId);
      },
      principal: { id: "u9" },
      workspaceId: "w".repeat(32),
      builtin: false,
      paths,
    };
  }

  const notFound = (run: () => unknown) => {
    expect(run).toThrowError(expect.objectContaining({ code: "not_found" }));
  };

  it("looks the root up once, as that account and workspace, before any path is resolved", () => {
    const root = scratchDir();
    const log: string[] = [];
    const resolved = scratchDir();
    writeFileSync(join(resolved, "one"), "1");
    writeFileSync(join(resolved, "two"), "22");

    const stored = admitAttachments({
      ...admission(["two", "one"], () => root, log),
      sandbox: {
        resolve: (_principal, _workspace, path) => {
          log.push(`resolve ${path}`);
          return join(resolved, path);
        },
      },
    });

    expect(log).toEqual([`root u9 ${"w".repeat(32)}`, "resolve two", "resolve one"]);
    expect(stored).toEqual([
      { path: "two", size: 2 },
      { path: "one", size: 1 },
    ]);
  });

  it("answers not_found and resolves nothing when the lookup is null, occupied or no directory", () => {
    const dir = scratchDir();
    writeFileSync(join(dir, "file"), "x");
    mkdirSync(join(dir, "real"));
    symlinkSync(join(dir, "real"), join(dir, "link"), "dir");
    const lookups: Array<[string, AttachmentAdmission["workspaceRootOf"]]> = [
      ["null", () => null],
      [
        "occupied",
        () => {
          throw new WorkspaceRootOccupiedError(join(dir, "file"));
        },
      ],
      ["missing", () => join(dir, "missing")],
      ["below a regular file", () => join(dir, "file", "below")],
      // The store never answers these two (it throws for both); `lstat` does not follow the link.
      ["a regular file", () => join(dir, "file")],
      ["a link to a directory", () => join(dir, "link")],
    ];

    for (const [label, rootOf] of lookups) {
      const log: string[] = [];
      notFound(() => admitAttachments(admission(["a", "../b"], rootOf, log)));
      expect(log, label).toEqual([`root u9 ${"w".repeat(32)}`]);
    }
  });

  it("rethrows any other failure of the lookup as it is, and resolves nothing", () => {
    const failure = new Error("invalid workspace root");
    const log: string[] = [];

    expect(() =>
      admitAttachments(
        admission(
          ["a"],
          () => {
            throw failure;
          },
          log,
        ),
      ),
    ).toThrow(failure);
    expect(log).toEqual([`root u9 ${"w".repeat(32)}`]);
  });

  it("does not look the root up without a workspace, for a builtin or for no path", () => {
    const log: string[] = [];
    const never = admission(["a"], () => scratchDir(), log);

    expect(() => admitAttachments({ ...never, workspaceId: null })).toThrowError(
      expect.objectContaining({ code: "bad_request" }),
    );
    expect(() => admitAttachments({ ...never, builtin: true })).toThrowError(
      expect.objectContaining({ code: "bad_request" }),
    );
    expect(admitAttachments({ ...never, paths: [] })).toEqual([]);
    expect(log).toEqual([]);
  });
});
