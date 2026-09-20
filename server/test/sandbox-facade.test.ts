import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { emit as canonicalEmit } from "../src/core/audit/index.js";
import { HttpError } from "../src/core/errors/index.js";
import { createSandbox } from "../src/core/sandbox/index.js";
import { removeTempDirs, tempDir } from "./core-db-helpers.js";

type AuditEventInput = Parameters<typeof canonicalEmit>[1];

const PRINCIPAL = { id: "actor-1" };
const SHARED_MODE = 0o2770;
const WORKSPACE_ID = "ws-1";

afterEach(removeTempDirs);

function recordingAudit() {
  const events: AuditEventInput[] = [];
  return {
    events,
    emit(event: AuditEventInput): number {
      events.push(event);
      return events.length;
    },
  };
}

function sandboxLayout(): { parent: string; sandbox: string; canonical: string } {
  const parent = tempDir();
  const sandbox = join(parent, "sandbox");
  mkdirSync(sandbox);
  mkdirSync(join(sandbox, "a"));
  writeFileSync(join(parent, "outside.txt"), "outside");
  symlinkSync(join(parent, "outside.txt"), join(sandbox, "outside-link"));
  return { parent, sandbox, canonical: realpathSync(sandbox) };
}

function expectCanonicalError(run: () => unknown, code: "not_found" | "sandbox_denied"): void {
  try {
    run();
    expect.fail(`expected canonical HttpError ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ name: "HttpError", code });
  }
}

describe("core/sandbox createSandbox", () => {
  it("throws canonical not_found for a missing or foreign root and emits no audit for an escape path", () => {
    const decoy = tempDir();
    writeFileSync(join(decoy, "keep.txt"), "keep");
    const before = readdirSync(decoy).toSorted();

    for (const workspaceId of ["missing-ws", "foreign-ws"]) {
      const audit = recordingAudit();
      const { resolve } = createSandbox({
        rootOf: () => null,
        audit,
      });
      expectCanonicalError(() => resolve(PRINCIPAL, workspaceId, "../escape", "read"), "not_found");
      expect(audit.events).toEqual([]);
    }

    expect(readdirSync(decoy).toSorted()).toEqual(before);
    expect(readFileSync(join(decoy, "keep.txt"), "utf8")).toBe("keep");
  });

  it("forwards the original principal and returns canonical nested read/list paths without emitting or creating entries", () => {
    const { parent, sandbox, canonical } = sandboxLayout();
    const principal = { id: "actor-1", mark: "original" };
    const seen: unknown[] = [];
    const audit = recordingAudit();
    const { resolve } = createSandbox({
      rootOf: (supplied, workspaceId) => {
        seen.push(supplied, workspaceId);
        return sandbox;
      },
      audit,
    });

    expect(resolve(principal, WORKSPACE_ID, "a/b/c.md", "read")).toBe(`${canonical}/a/b/c.md`);
    expect(resolve(principal, WORKSPACE_ID, "a", "list")).toBe(`${canonical}/a`);

    expect(seen).toEqual([principal, WORKSPACE_ID, principal, WORKSPACE_ID]);
    expect(seen[0]).toBe(principal);
    expect(seen[2]).toBe(principal);
    expect(audit.events).toEqual([]);
    expect(readdirSync(parent).toSorted()).toEqual(["outside.txt", "sandbox"]);
    expect(readdirSync(sandbox).toSorted()).toEqual(["a", "outside-link"]);
    expect(() => lstatSync(join(sandbox, "a", "b"))).toThrow();
  });

  it("audits exactly one sandbox.reject then throws sandbox_denied for traversal and a real symlink", () => {
    const { parent, sandbox } = sandboxLayout();
    const beforeParent = readdirSync(parent).toSorted();
    const beforeSandbox = readdirSync(sandbox).toSorted();
    const audit = recordingAudit();
    const { resolve } = createSandbox({
      rootOf: () => sandbox,
      audit,
    });

    expectCanonicalError(
      () => resolve(PRINCIPAL, WORKSPACE_ID, "../outside.txt", "read"),
      "sandbox_denied",
    );
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toEqual({
      kind: "sandbox.reject",
      actorId: PRINCIPAL.id,
      workspaceId: WORKSPACE_ID,
      title: "越界访问被沙箱拦截",
      detail: {
        relPath: "../outside.txt",
        op: "read",
        reason: expect.stringMatching(/\S/),
      },
    });

    expectCanonicalError(
      () => resolve(PRINCIPAL, WORKSPACE_ID, "outside-link", "list"),
      "sandbox_denied",
    );
    expect(audit.events).toHaveLength(2);
    expect(audit.events[1]).toEqual({
      kind: "sandbox.reject",
      actorId: PRINCIPAL.id,
      workspaceId: WORKSPACE_ID,
      title: "越界访问被沙箱拦截",
      detail: {
        relPath: "outside-link",
        op: "list",
        reason: expect.stringMatching(/\S/),
      },
    });

    expectCanonicalError(
      () => resolve(PRINCIPAL, WORKSPACE_ID, "../missing-sibling", "mkdir"),
      "sandbox_denied",
    );
    expect(audit.events).toHaveLength(3);
    expect(audit.events[2]).toEqual({
      kind: "sandbox.reject",
      actorId: PRINCIPAL.id,
      workspaceId: WORKSPACE_ID,
      title: "越界访问被沙箱拦截",
      detail: {
        relPath: "../missing-sibling",
        op: "mkdir",
        reason: expect.stringMatching(/\S/),
      },
    });

    expect(readdirSync(parent).toSorted()).toEqual(beforeParent);
    expect(readdirSync(sandbox).toSorted()).toEqual(beforeSandbox);
    expect(readFileSync(join(parent, "outside.txt"), "utf8")).toBe("outside");
    expect(() => lstatSync(join(parent, "missing-sibling"))).toThrow();
  });

  it("propagates an audit emit sentinel without sandbox_denied, success, or a filesystem write", () => {
    const { parent, sandbox } = sandboxLayout();
    const beforeParent = readdirSync(parent).toSorted();
    const beforeSandbox = readdirSync(sandbox).toSorted();
    const sentinel = new Error("audit-sentinel");
    const { resolve } = createSandbox({
      rootOf: () => sandbox,
      audit: {
        emit(): number {
          throw sentinel;
        },
      },
    });

    try {
      resolve(PRINCIPAL, WORKSPACE_ID, "../outside.txt", "read");
      expect.fail("expected audit sentinel to propagate");
    } catch (error) {
      expect(error).toBe(sentinel);
      expect(error).not.toBeInstanceOf(HttpError);
    }

    expect(readdirSync(parent).toSorted()).toEqual(beforeParent);
    expect(readdirSync(sandbox).toSorted()).toEqual(beforeSandbox);
    expect(readFileSync(join(parent, "outside.txt"), "utf8")).toBe("outside");
  });

  it("propagates a rootOf sentinel without an audit event or path side effect", () => {
    const decoy = tempDir();
    writeFileSync(join(decoy, "keep.txt"), "keep");
    const before = readdirSync(decoy).toSorted();
    const sentinel = new Error("root-sentinel");
    const audit = recordingAudit();
    const { resolve } = createSandbox({
      rootOf: () => {
        throw sentinel;
      },
      audit,
    });

    try {
      resolve(PRINCIPAL, WORKSPACE_ID, "../escape", "read");
      expect.fail("expected rootOf sentinel to propagate");
    } catch (error) {
      expect(error).toBe(sentinel);
      expect(error).not.toBeInstanceOf(HttpError);
    }

    expect(audit.events).toEqual([]);
    expect(readdirSync(decoy).toSorted()).toEqual(before);
    expect(readFileSync(join(decoy, "keep.txt"), "utf8")).toBe("keep");
  });

  it("creates nested shared directories at mode 2770 without changing the parent", () => {
    const parent = tempDir();
    chmodSync(parent, 0o755);
    const beforeMode = lstatSync(parent).mode & 0o7777;
    writeFileSync(join(parent, "keep.txt"), "keep-bytes");
    const { ensureSharedDir } = createSandbox({
      rootOf: () => parent,
      audit: recordingAudit(),
    });
    const nested = join(parent, "n1", "n2");

    ensureSharedDir(nested);

    expect(lstatSync(join(parent, "n1")).mode & 0o7777).toBe(SHARED_MODE);
    expect(lstatSync(nested).mode & 0o7777).toBe(SHARED_MODE);
    expect(lstatSync(parent).mode & 0o7777).toBe(beforeMode);
    expect(readFileSync(join(parent, "keep.txt"), "utf8")).toBe("keep-bytes");
    expect(readdirSync(parent).toSorted()).toEqual(["keep.txt", "n1"]);
  });
});
