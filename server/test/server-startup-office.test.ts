/**
 * Issue #1074（任务 15.1–15.3）：生产入口接上办公文档转换器——http-service-skeleton「预览监听器的
 * 装配与关停」里转换的部分，与 office-preview「转换缓存」的启动清空、周期清理在入口的接线。
 *
 * 每一例都跑真实的 compiled production 入口，两个端口都显式预留（#1273 / #1337）。`OFFICE_BIN` 指向
 * 仓库里的假 `soffice`（`fixtures/fake-soffice.mjs`），`sudo` 是临时 bin 目录里指向
 * `fixtures/fake-sudo-find.mjs` 的符号链接、靠 `PATH` 首项命中：真的 LibreOffice、`sudo`、`find` 一次
 * 都不执行。次序由 orderTrace 预加载观察得出（它给入口每个子进程的退出记一行 `runtime-exit`）。
 *
 * 证据等级：这里看得到的是入口对**自己启动的**假进程做了什么（实测）。`OMP_USER` 一例里只有假
 * `sudo`，没有真实的身份切换：真实 `sudo` 之下的 `find` 在 `sudo` 收到 `SIGTERM` 之后是否结束，
 * 不在本文件的观察范围内（未测）。该例另需一个预加载钩子，只让配置校验对 `/usr/bin/setpriv` 的
 * 存在性检查通过（macOS 上没有它）；`spawn` 保持原生。
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { get as httpGet } from "node:http";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rawAnswer } from "./preview-app-helpers.js";
import { waitForFile } from "./server-startup-helpers.js";
import { applicationStderr } from "./server-startup-order-helpers.js";
import {
  compileEntry,
  type Entry,
  makeSandboxRoot,
  openWorkspace,
  releaseEntries,
  startEntry,
} from "./server-startup-preview-helpers.js";

const FAKE_SOFFICE = fileURLToPath(new URL("./fixtures/fake-soffice.mjs", import.meta.url));
const FAKE_SUDO = fileURLToPath(new URL("./fixtures/fake-sudo-find.mjs", import.meta.url));
/** 假 soffice 正常转换写出的全部字节（与夹具各持一份字面量）。 */
const PDF = "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n";
const DAY_MS = 86_400_000;
const WORK_CLEAR_FAILED = '{"event":"preview_work_clear_failed"}\n';
/** office-preview「办公文档预览路由」失败表里的两条 503，逐字。 */
const UNAVAILABLE_TEXT = "服务器未启用文档转换，请下载后查看";
const BUSY_TEXT = "文档转换繁忙，请稍后重试";
const TOO_LARGE_TEXT = "文件超过预览上限，请下载后查看";
const TIMEOUT_TEXT = "文档转换超时，请下载后查看";
/** 第一例的 `OFFICE_CONVERT_TIMEOUT_MS`：够短，测得出超时；够长，关停那一步赶在它之前。 */
const CONVERT_TIMEOUT_MS = 3_000;

beforeAll(compileEntry, 90_000);
afterAll(releaseEntries);

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

async function until(condition: () => boolean, deadlineMs: number, what: string): Promise<void> {
  const deadlineAt = performance.now() + deadlineMs;
  while (!condition()) {
    if (performance.now() > deadlineAt) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await delay(10);
  }
}

/** 假 soffice 每次启动在 `work/` 下留一份 `<作业目录名>.record.json`。 */
function sofficeRecords(entry: Entry): Array<{ pid: number; argv: string[] }> {
  const work = join(entry.root, "preview-cache", "work");
  return readdirSync(work)
    .filter((name) => name.endsWith(".record.json"))
    .map((name) => JSON.parse(readFileSync(join(work, name), "utf8")) as never);
}

/** `/w/<token>/` 换成 `/o/<token>/<name>`。 */
function officeUrl(base: string, name: string): string {
  return `${base.replace("/w/", "/o/")}${encodeURIComponent(name)}`;
}

/** 发一个 GET：拿到响应头即 `{ status }`，连接在此之前断掉即 `{ failed: true }`。 */
function settleOf(url: string): Promise<{ status: number } | { failed: true }> {
  return new Promise((resolve) => {
    const request = httpGet(url, (response) => {
      response.resume();
      resolve({ status: response.statusCode ?? 0 });
    });
    request.once("error", () => resolve({ failed: true }));
  });
}

describe("production entry with the office converter", () => {
  it("converts through the real cache and converter, then on SIGTERM kills the conversion in flight before closing the listeners and the database", async () => {
    const entry = await startEntry({
      prepare: makeSandboxRoot,
      env: () => ({
        OFFICE_BIN: FAKE_SOFFICE,
        PREVIEW_DOCUMENT_MAX_BYTES: "100",
        OFFICE_CONVERT_TIMEOUT_MS: String(CONVERT_TIMEOUT_MS),
      }),
    });
    const { server, port, previewPort } = entry;
    try {
      await server.waitForStarted();
      const workspace = await openWorkspace(entry);
      expect(workspace.officeAvailable).toBe(true);
      writeFileSync(join(workspace.root, "报告.docx"), "not a real office document");
      writeFileSync(join(workspace.root, "slow@sleep.docx"), "not a real office document");
      writeFileSync(join(workspace.root, "late@sleep.docx"), "not a real office document");
      writeFileSync(join(workspace.root, "big.docx"), Buffer.alloc(101, 0x61));

      // 整条链路：路由 → 缓存与排队 → 转换器 → 假 soffice → pdf/ → 区间发送。
      const converted = await fetch(officeUrl(workspace.base, "报告.docx"));
      expect(converted.status).toBe(200);
      expect(converted.headers.get("content-type")).toBe("application/pdf");
      expect(await converted.text()).toBe(PDF);
      const again = await fetch(officeUrl(workspace.base, "报告.docx"), {
        headers: { range: "bytes=0-7" },
      });
      expect(again.status).toBe(206);
      expect(await again.text()).toBe("%PDF-1.4");
      // 第二次命中缓存：假 soffice 只被启动过一次。
      expect(sofficeRecords(entry)).toHaveLength(1);

      // 两个配置值到了该到的地方：文档上限到路由（101 字节对 100），转换超时到转换器。
      const tooLarge = await fetch(officeUrl(workspace.base, "big.docx"));
      expect(tooLarge.status).toBe(413);
      expect(await tooLarge.text()).toBe(TOO_LARGE_TEXT);
      expect(sofficeRecords(entry)).toHaveLength(1);
      const startedAt = performance.now();
      const late = await fetch(officeUrl(workspace.base, "late@sleep.docx"));
      expect(late.status).toBe(504);
      expect(await late.text()).toBe(TIMEOUT_TEXT);
      // 假 soffice 自己要睡 30 秒：结束它的是配置的超时。
      expect(performance.now() - startedAt).toBeGreaterThanOrEqual(CONVERT_TIMEOUT_MS - 1);
      expect(performance.now() - startedAt).toBeLessThan(15_000);
      const timedOut = sofficeRecords(entry).find((record) =>
        String(record.argv.at(-1)).endsWith("late@sleep.docx"),
      );
      expect(timedOut === undefined ? true : isAlive(timedOut.pid)).toBe(false);

      const inFlight = settleOf(officeUrl(workspace.base, "slow@sleep.docx"));
      await until(() => sofficeRecords(entry).length === 3, 10_000, "the sleeping fake soffice");
      const sleeping = sofficeRecords(entry).find((record) =>
        String(record.argv.at(-1)).endsWith("slow@sleep.docx"),
      );
      if (sleeping === undefined) {
        throw new Error("no record of the sleeping conversion");
      }
      expect(isAlive(sleeping.pid)).toBe(true);

      const stopping = server.stop();
      // 有界：早于监听器 2 秒的关停预算——不是等连接被强制回收之后才顺带中止的。
      await until(() => !isAlive(sleeping.pid), 1_500, "the conversion in flight to be killed");
      expect(await stopping).toBe(0);

      // 同 uid 模式：假进程自成一个进程组，整组都已不存在。
      expect(isAlive(sleeping.pid)).toBe(false);
      expect(isAlive(-sleeping.pid)).toBe(false);
      expect(await inFlight).toEqual({ failed: true });
      expect(applicationStderr(server.stderr())).toBe("");
      // 三行 runtime-exit 是三个假 soffice 的退出：最后一个（关停时被终止的）先于两个监听器的
      // 关闭，DB 最后。
      expect(entry.readTrace()).toBe(
        `listening:127.0.0.1:${port}\nlistening:127.0.0.1:${previewPort}\nruntime-exit\n` +
          "runtime-exit\nruntime-exit\n" +
          `listener-close:${previewPort}\nlistener-close:${port}\ndb-close\n`,
      );
    } finally {
      await server.dispose();
    }
  }, 60_000);

  it("runs one conversion at a time under OFFICE_CONVERT_CONCURRENCY=1: the second starts only after the first has settled", async () => {
    const entry = await startEntry({
      prepare: makeSandboxRoot,
      env: () => ({ OFFICE_BIN: FAKE_SOFFICE, OFFICE_CONVERT_CONCURRENCY: "1" }),
    });
    const { server } = entry;
    try {
      await server.waitForStarted();
      const workspace = await openWorkspace(entry);
      // `@gate`：假 soffice 写好输出后一直等 `<输入路径>.release` 出现才退出——第一个转换何时
      // 落定由本用例决定，不靠睡眠时长。
      writeFileSync(join(workspace.root, "first@gate.docx"), "not a real office document");
      writeFileSync(join(workspace.root, "second.docx"), "not a real office document");

      let firstSettled = false;
      let secondSettled = false;
      const first = settleOf(officeUrl(workspace.base, "first@gate.docx")).finally(() => {
        firstSettled = true;
      });
      await until(() => sofficeRecords(entry).length === 1, 10_000, "the gated fake soffice");
      const second = settleOf(officeUrl(workspace.base, "second.docx")).finally(() => {
        secondSettled = true;
      });
      // 1 秒：并发若不是 1，第二个假 soffice 此时早已启动（一次 node 冷启动加写记录，约 0.1 秒）
      // 并答完。这个余量只决定「并发被写死成 2」测不测得出；并发确为 1 时，第一个在放行之前
      // 不可能落定，下面三条不会因为机器慢而误红。
      await delay(1_000);
      expect(sofficeRecords(entry)).toHaveLength(1);
      expect(firstSettled).toBe(false);
      expect(secondSettled).toBe(false);

      writeFileSync(join(workspace.root, "first@gate.docx.release"), "");
      expect(await first).toEqual({ status: 200 });
      expect(await second).toEqual({ status: 200 });
      expect(sofficeRecords(entry)).toHaveLength(2);

      expect(await server.stop()).toBe(0);
      expect(applicationStderr(server.stderr())).toBe("");
    } finally {
      await server.dispose();
    }
  }, 60_000);

  it("sweeps the conversion cache once at startup and reports the converter unavailable without OFFICE_BIN", async () => {
    const now = Date.now();
    const entry = await startEntry({
      prepare: (root) => {
        makeSandboxRoot(root);
        const pdf = join(root, "preview-cache", "pdf");
        mkdirSync(pdf, { recursive: true });
        for (const [name, ageDays] of [
          ["expired.pdf", 8],
          ["fresh.pdf", 6],
        ] as const) {
          writeFileSync(join(pdf, name), PDF);
          const at = (now - ageDays * DAY_MS) / 1000;
          utimesSync(join(pdf, name), at, at);
        }
      },
    });
    const { server } = entry;
    const pdf = join(entry.root, "preview-cache", "pdf");
    try {
      await server.waitForStarted();
      // 入口不等这一轮清理。
      await until(() => !existsSync(join(pdf, "expired.pdf")), 10_000, "the expired PDF to go");
      await delay(200);
      expect(readdirSync(pdf)).toEqual(["fresh.pdf"]);

      const workspace = await openWorkspace(entry);
      expect(workspace.officeAvailable).toBe(false);
      writeFileSync(join(workspace.root, "a.docx"), "not a real office document");
      const refused = await rawAnswer(
        new URL(workspace.base).origin,
        new URL(officeUrl(workspace.base, "a.docx")).pathname,
      );
      expect(refused.status).toBe(503);
      expect(refused.body).toBe(UNAVAILABLE_TEXT);
      expect(readdirSync(join(entry.root, "preview-cache", "work"))).toEqual([]);

      expect(await server.stop()).toBe(0);
      expect(applicationStderr(server.stderr())).toBe("");
    } finally {
      await server.dispose();
    }
  }, 60_000);
});

describe("production entry clearing work/ as the omp user", () => {
  /** 只让配置校验对 `/usr/bin/setpriv` 的存在性检查通过；`spawn` 不动，假 `sudo` 真的被启动。 */
  const SETPRIV_PRESENT_HOOK = [
    "'use strict';",
    "const fs = require('node:fs');",
    "const { syncBuiltinESMExports } = require('node:module');",
    "const nativeAccess = fs.accessSync;",
    "fs.accessSync = function access(path, mode) {",
    "  if (path !== '/usr/bin/setpriv') return nativeAccess.call(this, path, mode);",
    "};",
    "syncBuiltinESMExports();",
    "",
  ].join("\n");

  /**
   * 再加一段：把写 `models.yml` 的那次 `rename` 扣住——先留下 `<根>/models.hold`，等
   * `<根>/models.release` 出现才放行（根取自 `PREVIEW_CACHE_DIR` 的上一级；最多等 20 秒）。入口因此
   * 停在 `publishStarted` 里 `writeManagedModelsYml` 的等待上，先于 `preparePreviewCache`。
   */
  const HOLD_MODELS_YML_HOOK = [
    SETPRIV_PRESENT_HOOK,
    "const { dirname, join } = require('node:path');",
    "const promises = require('node:fs/promises');",
    "const root = dirname(process.env.PREVIEW_CACHE_DIR);",
    "const nativeRename = promises.rename;",
    "promises.rename = async function rename(from, to) {",
    "  if (String(to).endsWith('/models.yml')) {",
    "    fs.writeFileSync(join(root, 'models.hold'), '');",
    "    const deadline = Date.now() + 20000;",
    "    while (!fs.existsSync(join(root, 'models.release')) && Date.now() < deadline) {",
    "      await new Promise((resolve) => setTimeout(resolve, 10));",
    "    }",
    "  }",
    "  return nativeRename.call(this, from, to);",
    "};",
    "syncBuiltinESMExports();",
    "",
  ].join("\n");

  /** `OMP_USER` 模式的入口：假 `sudo` 在 `PATH` 首项，`work/` 下有一项上一次运行的遗留。 */
  function startOmpEntry(hook: string, sudoExit?: string): Promise<Entry> {
    return startEntry({
      hook,
      // 两个调用方都要在 `server_started` 之前动作（假 sudo 挂住、models.yml 的写入被扣住）。
      held: true,
      prepare: (root) => {
        makeSandboxRoot(root);
        mkdirSync(join(root, "fake-bin"));
        symlinkSync(FAKE_SUDO, join(root, "fake-bin", "sudo"));
        // 上一次运行的遗留：本进程删得掉，但要等 sudo 结束之后才删。
        mkdirSync(join(root, "preview-cache", "work", "stale"), { recursive: true });
        writeFileSync(join(root, "preview-cache", "work", "stale", "x"), "stale");
        if (sudoExit !== undefined) {
          writeFileSync(join(root, "preview-cache", "sudo.exit"), sudoExit);
        }
      },
      env: (root) => ({
        OMP_USER: "omp",
        OFFICE_BIN: FAKE_SOFFICE,
        // 首项是假 sudo 的目录；其后是 `#!/usr/bin/env node` 要用的 node 所在目录。
        PATH: `${join(root, "fake-bin")}:${dirname(process.execPath)}:/usr/bin:/bin`,
      }),
    });
  }

  it("starts no conversion while the sudo find is still running, and on SIGTERM terminates it, logs one line and never publishes", async () => {
    const entry = await startOmpEntry(SETPRIV_PRESENT_HOOK, "hang");
    const { server, port, previewPort } = entry;
    const cache = join(entry.root, "preview-cache");
    try {
      // 成功记录要等清空落定才发：这里等的是假 sudo 自己的记录。
      await waitForFile(join(cache, "sudo.record.json"), 15_000);
      const seenAt = performance.now();
      const sudo = JSON.parse(readFileSync(join(cache, "sudo.record.json"), "utf8")) as {
        pid: number;
        argv: string[];
      };
      expect(sudo.argv.slice(1)).toEqual([
        "-n",
        "-u",
        "omp",
        "--",
        "/usr/bin/find",
        join(cache, "work"),
        "-mindepth",
        "1",
        "-delete",
      ]);
      expect(isAlive(sudo.pid)).toBe(true);
      expect(server.stdout()).toBe("");

      // 两个监听器此刻都已在监听：令牌签得出来，转换可用，但 /o/ 还不启动转换。
      const workspace = await openWorkspace(entry);
      expect(workspace.officeAvailable).toBe(true);
      writeFileSync(join(workspace.root, "a.docx"), "not a real office document");
      const early = await rawAnswer(
        new URL(workspace.base).origin,
        new URL(officeUrl(workspace.base, "a.docx")).pathname,
      );
      expect(early.status).toBe(503);
      expect(early.body).toBe(BUSY_TEXT);
      expect(sofficeRecords(entry)).toEqual([]);
      expect(readdirSync(join(cache, "work"))).toEqual(["stale"]);
      expect(isAlive(sudo.pid)).toBe(true);
      // 以上必须发生在入口自己的 10 秒时限之前，否则结束假 sudo 的就不是关停了。
      expect(performance.now() - seenAt).toBeLessThan(5_000);

      const stopping = server.stop();
      // 有界：远早于时限到期（那要再等约 9 秒）。
      await until(() => !isAlive(sudo.pid), 3_000, "the fake sudo to be terminated");
      expect(await stopping).toBe(0);

      expect(isAlive(sudo.pid)).toBe(false);
      expect(applicationStderr(server.stderr())).toBe(WORK_CLEAR_FAILED);
      expect(server.stdout()).toBe("");
      // 本进程自己的删除照常：sudo 结束之后遗留条目被删掉。
      expect(readdirSync(join(cache, "work"))).toEqual([]);
      // 假 sudo 的退出（runtime-exit）落在哪一行由进程调度定，其余各行的次序是确定的。
      const trace = entry.readTrace().split("\n");
      expect(trace.filter((line) => line === "runtime-exit")).toHaveLength(1);
      expect(trace.filter((line) => line !== "runtime-exit").join("\n")).toBe(
        `listening:127.0.0.1:${port}\nlistening:127.0.0.1:${previewPort}\n` +
          `listener-close:${previewPort}\nlistener-close:${port}\ndb-close\n`,
      );
    } finally {
      await server.dispose();
    }
  }, 60_000);

  it("never starts the sudo find when SIGTERM arrives before the clearing step: nothing is cleared or logged, and nothing is published", async () => {
    // 没有 `sudo.exit`：假 sudo 若被启动，约 150 毫秒后以 0 退出并留下 `sudo.record.json`。
    const entry = await startOmpEntry(HOLD_MODELS_YML_HOOK);
    const { server, port, previewPort } = entry;
    const cache = join(entry.root, "preview-cache");
    try {
      // 入口停在写 models.yml 的等待上：两个监听器已在监听，清空那一步还没到。
      await waitForFile(join(entry.root, "models.hold"), 15_000);
      expect(existsSync(join(cache, "sudo.record.json"))).toBe(false);
      expect(server.stdout()).toBe("");

      const stopping = server.stop();
      // `db-close` 是关停序列的最后一步：此时 `stopWorkClear` 早已调用过，而没有在途的 sudo。
      await until(() => entry.readTrace().includes("db-close\n"), 10_000, "the shutdown to finish");
      writeFileSync(join(entry.root, "models.release"), "");
      expect(await stopping).toBe(0);

      expect(existsSync(join(cache, "sudo.record.json"))).toBe(false);
      // 入口在清空那一步之前就返回：不清空、不记日志，遗留留给下一次启动。
      expect(applicationStderr(server.stderr())).toBe("");
      expect(readdirSync(join(cache, "work"))).toEqual(["stale"]);
      expect(server.stdout()).toBe("");
      // 没有任何子进程被启动过（没有 runtime-exit 行）。
      expect(entry.readTrace()).toBe(
        `listening:127.0.0.1:${port}\nlistening:127.0.0.1:${previewPort}\n` +
          `listener-close:${previewPort}\nlistener-close:${port}\ndb-close\n`,
      );
    } finally {
      await server.dispose();
    }
  }, 60_000);
});
