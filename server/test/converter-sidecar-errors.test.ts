/**
 * Issue #1504 修订：转换 sidecar 脚本的错误路径与校验覆盖（office-preview「转换 sidecar 实现与镜像」；
 * design D3「`request.json` 不在 ≡ `cancel`」、D13「不吞 spawn 错误」、日志不含路径）。子进程夹具见
 * `support/converter-sidecar.ts`。竞态窗口用 `--import` 钩子在 sidecar 进程里确定性地打开
 * （钩子辅助复现）：钩子只在动作之前改文件系统，不改 sidecar 的代码。
 */
import { existsSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanUpSidecars,
  expectNoRealConverter,
  hook,
  lineFor,
  linesOf,
  makeSpool,
  markerOf,
  recordPath,
  settled,
  startSidecar,
  waitFor,
  writeJob,
} from "./support/converter-sidecar.js";

vi.setConfig({ testTimeout: 15_000 });

afterEach(cleanUpSidecars);

/** 第一次 spawn 之前删掉它的 `cwd`（作业目录）：app 在 sidecar 核对之后、子进程 chdir 之前收尾。 */
const RM_CWD_BEFORE_FIRST_SPAWN = `
import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const spawn = cp.spawn;
let armed = true;
cp.spawn = (command, args, options) => {
  if (armed) {
    armed = false;
    fs.rmSync(options.cwd, { recursive: true, force: true });
  }
  return spawn(command, args, options);
};
syncBuiltinESMExports();
`;

/** 第一次读 `request.json` 之前删掉它：领取（看见它）与读取之间 app 收尾。 */
const RM_REQUEST_BEFORE_FIRST_READ = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const read = fs.readFileSync;
let armed = true;
fs.readFileSync = (path, ...rest) => {
  if (armed && String(path).endsWith("/request.json")) {
    armed = false;
    fs.rmSync(path, { force: true });
  }
  return read(path, ...rest);
};
syncBuiltinESMExports();
`;

describe("sidecar 脚本：作业目录或 request.json 在半路消失 ≡ cancel", () => {
  it("spawn 前一刻作业目录被删（ENOENT）→ 日志记 cancelled、sidecar 不退出、随后的作业照常", async () => {
    const sidecar = startSidecar(makeSpool(), {}, hook(RM_CWD_BEFORE_FIRST_SPAWN));
    const job = writeJob(sidecar.jobs, "a.docx");

    const line = await lineFor(sidecar, job);
    expect(line).toMatchObject({ event: "convert", result: "failed", reason: "cancelled" });
    expect(existsSync(job)).toBe(false);
    const next = writeJob(sidecar.jobs, "b.docx");
    expect(await settled(next)).toBe("done");
    expect(sidecar.child.exitCode).toBeNull();
  });

  it("request.json 在领取之后、读取之前消失 → cancelled，不启动进程", async () => {
    const sidecar = startSidecar(makeSpool(), {}, hook(RM_REQUEST_BEFORE_FIRST_READ));
    const job = writeJob(sidecar.jobs, "a.docx");

    expect(await settled(job)).toBe("failed:cancelled");
    expect((await lineFor(sidecar, job)).reason).toBe("cancelled");
    expect(existsSync(recordPath(job))).toBe(false);
  });

  it("领取之前 cancel 已在 → cancelled，不启动进程", async () => {
    const spool = makeSpool();
    const job = writeJob(join(spool, "jobs"), "a.docx");
    writeFileSync(join(job, "cancel"), "");
    // 轮询间隔放到 1 s：启动时那一轮就领取它；漏掉领取后核对的实现要等 1 s 才在在途核对里杀，
    // 在此之前假 soffice 已经转换完、写出记录与 done。
    const sidecar = startSidecar(spool, { CONVERTER_POLL_MS: "1000" });

    expect(await settled(job)).toBe("failed:cancelled");
    expect((await lineFor(sidecar, job)).reason).toBe("cancelled");
    expect(existsSync(recordPath(job))).toBe(false);
  });
});

describe("sidecar 脚本：校验与领取的覆盖补充", () => {
  it("input 含 NUL → failed 内容恰为 bad-request，sidecar 仍在跑", async () => {
    const sidecar = startSidecar(makeSpool());
    const job = writeJob(sidecar.jobs, "a.docx", {
      version: 1,
      input: "a\u0000.docx",
      timeoutMs: 1e3,
    });

    expect(await settled(job)).toBe("failed:bad-request");
    expect(existsSync(recordPath(job))).toBe(false);
    expect(sidecar.child.exitCode).toBeNull();
  });

  it("jobs/ 下指向目录的符号链接被跳过：不领取、无记录、无日志行", async () => {
    const elsewhere = writeJob(join(makeSpool(), "jobs"), "a.docx");
    const sidecar = startSidecar(makeSpool());
    const linked = join(sidecar.jobs, "linked");
    symlinkSync(elsewhere, linked);
    const job = writeJob(sidecar.jobs, "b.docx");

    expect(await settled(job)).toBe("done");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(markerOf(elsewhere)).toBeUndefined();
    expect(existsSync(recordPath(linked))).toBe(false);
    expect(existsSync(recordPath(elsewhere))).toBe(false);
    expect(linesOf(sidecar).map((line) => line.id)).toEqual([basename(job)]);
  });
});

describe("sidecar 脚本：运行期的意外错误不带路径", () => {
  it("运行期心跳 touch 失败 → stderr 恰一行 fatal internal、不含路径，以 1 退出", async () => {
    const spool = makeSpool();
    const sidecar = startSidecar(spool);
    const heartbeat = join(spool, "heartbeat");
    await waitFor("the heartbeat", () => existsSync(heartbeat) || undefined, 6e3);
    // 原子地换成悬空的符号链接：`wx` 得 EEXIST，随后的 `utimes` 跟随链接得 ENOENT。
    symlinkSync(join(spool, "missing"), join(spool, "dangling"));
    renameSync(join(spool, "dangling"), heartbeat);

    expect((await sidecar.exit).code).toBe(1);
    expect(linesOf(sidecar)).toEqual([{ event: "fatal", reason: "internal", code: "ENOENT" }]);
    expect(sidecar.stderr()).not.toContain(spool);
  });
});

describe("真实转换的人工验证：自动化测试不需要 LibreOffice 与 Docker", () => {
  it("本文件启动过的可执行文件没有一个名为 soffice、libreoffice 或 docker", () => {
    expectNoRealConverter();
  });
});
