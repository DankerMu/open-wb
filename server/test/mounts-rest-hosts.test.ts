/**
 * s1b-workspace-mounts tasks 7.2, the mount part (#1690): workspace-mounts「挂载取值与主机规则」through
 * `POST /api/workspaces/:id/mounts` —「键集与取值」「环回一律拒绝」「解析失败不启动子进程」「许可名单」(first group)
 * — the readiness-failure 502, and「挂载凭证文件」「凭证不外泄」's HTTP part. The literal-loopback and
 * allow-list rejections go through the manager createApp builds from `workspaceAssemblyOf` (`openBuilt`):
 * they come before any resolution, so the production resolver is never asked. The cases that need the
 * test resolver (a name resolving to loopback, a failed lookup, admitted names that then mount) use the
 * injected world manager (`openMounts`).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveMountSettings } from "../src/workspaces/mounts/config.js";
import type { HostResolver } from "../src/workspaces/mounts/host-policy.js";
import { BAD_REQUEST, expectAnswer } from "./models-rest-helpers.js";
import {
  alive,
  disposeWorlds,
  FAKE_RCLONE,
  OWNER,
  PASS_SENTINEL,
  sftpKey,
  USER_SENTINEL,
  W1,
  type World,
} from "./mounts-manager-helpers.js";
import {
  auditRows,
  CASE_MS,
  closeApps,
  DOMAIN_SENTINEL,
  expectNoSecret,
  MOUNT_FAILED,
  MOUNT_HOST_REJECTED,
  type MountsRest,
  mountRows,
  mountsUrl,
  openBuilt,
  openMounts,
  postMount,
  privateDirs,
  send,
  sftpBody,
} from "./mounts-rest-helpers.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await closeApps();
  await disposeWorlds();
});

const ALLOW_FILES_INTRA = allowList("files.intra");

/** `MOUNT_HOST_ALLOW` as the config seam resolves it. */
function allowList(raw: string): readonly string[] {
  const allow = resolveMountSettings({ MOUNT_HOST_ALLOW: raw }).mountHostAllow;
  if (allow === undefined) {
    throw new Error("MOUNT_HOST_ALLOW did not resolve");
  }
  return allow;
}

/** The `mount.reject` row of a refused `sftp` body (`sftpBody` defaults). */
function rejectRow(
  host: string,
  reason: "host_rejected" | "mount_failed",
  remotePath = "/srv/data",
) {
  return {
    kind: "mount.reject",
    actorId: OWNER,
    workspaceId: W1,
    title: "挂载被拒绝：远端",
    detail: {
      name: "远端",
      backend: "sftp",
      host,
      port: null,
      remotePath,
      sourceId: null,
      reason,
    },
  };
}

function expectNothingBuilt(world: World): void {
  expect(privateDirs(world)).toEqual([]);
  expect(existsSync(join(world.rootOf(W1), "远端"))).toBe(false);
  expect(mountRows(world)).toEqual([]);
}

describe("键集与取值", () => {
  const VALID = sftpBody("远端");
  const { password: _password, ...NO_SECRET } = VALID as { password: string };
  const CASES: Array<[string, Record<string, unknown>]> = [
    [
      "sftp with password and privateKey",
      { ...VALID, privateKey: "-----BEGIN TEST FIXTURE-----\n" },
    ],
    ["sftp with neither", NO_SECRET],
    [
      "smb with privateKey",
      {
        ...VALID,
        backend: "smb",
        remotePath: "/share",
        privateKey: "-----BEGIN TEST FIXTURE-----\n",
      },
    ],
    [
      "local with host",
      {
        name: "本机",
        backend: "local",
        sourceId: "d".repeat(32),
        readOnly: false,
        host: "files.intra",
      },
    ],
    ["name uploads", { ...VALID, name: "uploads" }],
    ["name screenshots", { ...VALID, name: "screenshots" }],
    ["name a.b", { ...VALID, name: "a.b" }],
    ["name of 65 characters", { ...VALID, name: "n".repeat(65) }],
    ["remotePath srv/data", { ...VALID, remotePath: "srv/data" }],
    ["smb remotePath /", { ...VALID, backend: "smb", remotePath: "/" }],
    ["port 0", { ...VALID, port: 0 }],
    ['port "22"', { ...VALID, port: "22" }],
    ["password with a newline and the sentinel", { ...VALID, password: `${PASS_SENTINEL}\nx` }],
  ];

  it.each(CASES)("%s → 400 bad_request, no sentinel, nothing built", async (_label, body) => {
    const rest = await openMounts();
    const response = await send(rest, "member", "POST", mountsUrl(W1), body);
    expectAnswer(response, 400, BAD_REQUEST);
    expectNoSecret(response.body);
    expectNoSecret(JSON.stringify(auditRows(rest.world)));
    expect(auditRows(rest.world)).toEqual([]);
    expect(rest.world.calls()).toEqual([]);
    expectNothingBuilt(rest.world);
  });
});

describe("环回一律拒绝", () => {
  const LITERALS = [
    "localhost",
    "LOCALHOST",
    "localhost.",
    "LOCALHOST.",
    "a.localhost",
    "a.localhost.",
    "127.0.0.1",
    "127.9.9.9",
    "::1",
    "0:0:0:0:0:0:0:1",
    "::ffff:127.0.0.1",
    "0.0.0.0",
  ];

  async function expectRejected(rest: MountsRest, host: string): Promise<void> {
    const before = auditRows(rest.world).length;
    const response = await send(rest, "member", "POST", mountsUrl(W1), sftpBody("远端", host));
    expectAnswer(response, 403, MOUNT_HOST_REJECTED);
    expect(auditRows(rest.world).slice(before)).toEqual([rejectRow(host, "host_rejected")]);
  }

  it("the twelve literal spellings, through the manager createApp builds (no MOUNT_HOST_ALLOW): 403 and one mount.reject each, no child", {
    timeout: CASE_MS,
  }, async () => {
    const rest = await openBuilt({ rcloneBin: FAKE_RCLONE, mountMaxPerWorkspace: 8 });
    for (const host of LITERALS) {
      await expectRejected(rest, host);
    }
    expect(auditRows(rest.world)).toHaveLength(LITERALS.length);
    expect(rest.world.calls()).toEqual([]);
    expectNothingBuilt(rest.world);
  });

  it("2130706433 and files.intra, both resolved to 127.0.0.1 by the test resolver: 403 and one mount.reject each, no child", {
    timeout: CASE_MS,
  }, async () => {
    const toLoopback: HostResolver = async () => [{ address: "127.0.0.1" }];
    const rest = await openMounts({ overrides: { resolveHost: toLoopback } });
    await expectRejected(rest, "2130706433");
    await expectRejected(rest, "files.intra");
    expect(rest.world.calls()).toEqual([]);
    expectNothingBuilt(rest.world);
  });
});

describe("解析失败不启动子进程 / 就绪失败", () => {
  it("nowhere.intra fails to resolve: 502 mount_failed and one mount.reject (mount_failed); no child, private dir or mount point", {
    timeout: CASE_MS,
  }, async () => {
    const rest = await openMounts();
    const response = await send(
      rest,
      "member",
      "POST",
      mountsUrl(W1),
      sftpBody("远端", "nowhere.intra"),
    );
    expectAnswer(response, 502, MOUNT_FAILED);
    expect(auditRows(rest.world)).toEqual([rejectRow("nowhere.intra", "mount_failed")]);
    expect(rest.world.calls()).toEqual([]);
    expectNothingBuilt(rest.world);
  });

  it("rclone exits before readiness: 502 mount_failed and one mount.reject (mount_failed); nothing left", {
    timeout: CASE_MS,
  }, async () => {
    const rest = await openMounts();
    const body = sftpBody("远端", "files.intra", "/srv/data@exit1");
    const response = await send(rest, "member", "POST", mountsUrl(W1), body);
    expectAnswer(response, 502, MOUNT_FAILED);
    expect(response.body).not.toContain("exit");
    expect(auditRows(rest.world)).toEqual([
      rejectRow("files.intra", "mount_failed", "/srv/data@exit1"),
    ]);
    const mounts = rest.world.mountCalls();
    expect(mounts).toHaveLength(1);
    expect(alive(Number(mounts[0]?.pid))).toBe(false);
    expectNothingBuilt(rest.world);
  });
});

describe("许可名单", () => {
  it("MOUNT_HOST_ALLOW=files.intra: FILES.INTRA and files.intra. mount (201)", {
    timeout: CASE_MS,
  }, async () => {
    const rest = await openMounts({ overrides: { mountHostAllow: ALLOW_FILES_INTRA } });
    const upper = await postMount(rest, W1, sftpBody("甲", "FILES.INTRA", "/srv/a"));
    const dotted = await postMount(rest, W1, sftpBody("乙", "files.intra.", "/srv/b"));
    expect([upper.host, upper.status, dotted.host, dotted.status]).toEqual([
      "FILES.INTRA",
      "online",
      "files.intra.",
      "online",
    ]);
    expect(rest.world.mountCalls()).toHaveLength(2);
  });

  it("MOUNT_HOST_ALLOW=files.intra through createApp's own manager: other.intra 403 and one mount.reject, no child", {
    timeout: CASE_MS,
  }, async () => {
    const rest = await openBuilt({
      rcloneBin: FAKE_RCLONE,
      mountHostAllow: ALLOW_FILES_INTRA,
      mountMaxPerWorkspace: 8,
    });
    const response = await send(
      rest,
      "member",
      "POST",
      mountsUrl(W1),
      sftpBody("远端", "other.intra"),
    );
    expectAnswer(response, 403, MOUNT_HOST_REJECTED);
    expect(auditRows(rest.world)).toEqual([rejectRow("other.intra", "host_rejected")]);
    expect(rest.world.calls()).toEqual([]);
    expectNothingBuilt(rest.world);
  });
});

describe("凭证不外泄", () => {
  it("password, private-key and smb-domain mounts: no username, password, key, domain or obscure string in responses, /api/audit, audit rows, stdout / stderr, the error channel or any mount argv / env", {
    timeout: CASE_MS,
  }, async () => {
    const written: string[] = [];
    for (const stream of [process.stdout, process.stderr]) {
      const original = stream.write.bind(stream);
      vi.spyOn(stream, "write").mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
        written.push(String(chunk));
        return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof stream.write);
    }
    const rest = await openMounts();
    const { world } = rest;
    const bodies: string[] = [];
    const keep = async (response: Promise<{ body: string; statusCode: number }>) => {
      const answer = await response;
      bodies.push(answer.body);
      return answer;
    };
    const smb = {
      name: "共享盘",
      backend: "smb",
      host: "files.intra",
      remotePath: "/share/product",
      readOnly: true,
      username: USER_SENTINEL,
      password: PASS_SENTINEL,
      domain: DOMAIN_SENTINEL,
    };
    const ids: string[] = [];
    for (const body of [sftpBody("远端"), sftpKey(), smb]) {
      const answer = await keep(send(rest, "member", "POST", mountsUrl(W1), body));
      expect(answer.statusCode, answer.body).toBe(201);
      ids.push(String((JSON.parse(answer.body) as { id: string }).id));
    }
    await keep(send(rest, "member", "GET", mountsUrl(W1)));
    await keep(send(rest, "member", "GET", "/api/audit"));
    await keep(send(rest, "admin", "GET", "/api/audit"));
    for (const id of ids) {
      const answer = await keep(send(rest, "member", "DELETE", mountsUrl(W1, id)));
      expect(answer.statusCode).toBe(204);
    }
    await keep(send(rest, "member", "GET", "/api/audit"));
    vi.restoreAllMocks();

    expect(auditRows(world).map((row) => row.kind)).toEqual([
      "mount.attach",
      "mount.attach",
      "mount.attach",
      "mount.detach",
      "mount.detach",
      "mount.detach",
    ]);
    for (const text of [
      ...bodies,
      JSON.stringify(auditRows(world)),
      written.join(""),
      ...world.errors.map((error) => `${error.message}\n${error.stack ?? ""}`),
    ]) {
      expectNoSecret(text);
    }
    const mounts = world.mountCalls();
    expect(mounts).toHaveLength(3);
    for (const entry of mounts) {
      expectNoSecret(JSON.stringify([entry.argv, entry.env]));
    }
  });
});
