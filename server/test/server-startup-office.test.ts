/**
 * Issue #1074（任务 15.1–15.3）、issue 1505：生产入口接上办公文档转换器——http-service-skeleton
 * 「预览监听器的装配与关停」里转换的部分、office-preview「转换缓存与作业目录清理」的启动清空与
 * 周期清理在入口的接线，以及「转换 sidecar 的健康与 fail-closed」场景「预检失败后的服务」与
 * preview-origin「sidecar 不可用时转换不可用」。
 *
 * 每一例都跑真实的 compiled production 入口，两个端口都显式预留（#1273 / #1337）。`OFFICE_SPOOL_DIR`
 * 指向临时 spool，应答它的是测试进程里的假 sidecar（`support/fake-sidecar.ts`，不做任何隔离）：真的
 * LibreOffice、Docker 一次都不执行，入口自己也不启动任何转换进程（orderTrace 里没有 `runtime-exit`）。
 * 真实墙钟只有三例：无 `heartbeat` 的 5 s 窗口、2 s 后才有心跳、预检等待中的 SIGTERM。
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { get as httpGet } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { rawAnswer } from "./preview-app-helpers.js";
import { applicationStderr, expectDbReopens } from "./server-startup-order-helpers.js";
import {
  compileEntry,
  type Entry,
  makeSandboxRoot,
  openWorkspace,
  releaseEntries,
  startEntry,
} from "./server-startup-preview-helpers.js";
import {
  type FakeSidecar,
  type Heartbeat,
  PDF,
  startFakeSidecar,
  stopFakeSidecars,
} from "./support/fake-sidecar.js";

const DAY_MS = 86_400_000;
const UNAVAILABLE_LINE = '{"event":"office_convert_sidecar_unavailable"}\n';
const CONFIG_FAILED_LINE = '{"event":"server_start_failed","reason":"config"}\n';
/** office-preview「办公文档预览路由」失败表里的固定文案，逐字。 */
const UNAVAILABLE_TEXT = "服务器未启用文档转换，请下载后查看";
const TOO_LARGE_TEXT = "文件超过预览上限，请下载后查看";
const TIMEOUT_TEXT = "文档转换超时，请下载后查看";
/** 第一例的 `OFFICE_CONVERT_TIMEOUT_MS`：够短，测得出超时；够长，关停那一步赶在它之前。 */
const CONVERT_TIMEOUT_MS = 3_000;
/** 「无 heartbeat」一例 `server_started` 的窗口：预检等满 5 s，δ 给编译入口其余步骤与慢机器。 */
const WAIT_MS = 5_000;
const DELTA_MS = 1_500;
/** 预检失败三例预置在 `jobs/` 里的遗留作业：入口不碰 spool，它应原样留着。 */
const LEFTOVER_ID = "0123456789abcdef0123456789abcdef";
/**
 * 子进程预加载钩子（#1751，verification-harness「假 sidecar 的 cancel 观察不依赖文件事件送达」第三类）：
 * 包住 `fs.rmSync`，删的是 `<OFFICE_SPOOL_DIR>/jobs/<id>` 且其下已有 `cancel` 时，先同步追加一行
 * `cancel:<id>` 到本次尝试根下的 `cancel.log`（与次序 trace 分开），再执行真实删除——留痕失败也照删。
 * 无 `cancel` 的删除（启动清空遗留、转换成功的作业）不留痕。`syncBuiltinESMExports` 让 `office.ts`
 * 的 ESM 具名导入也换成包装后的版本。
 */
const CANCEL_TRACE_HOOK = `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const spool = process.env.OFFICE_SPOOL_DIR;
const jobsDir = typeof spool === 'string' ? path.join(spool, 'jobs') : undefined;
const cancelLog = path.join(__dirname, 'cancel.log');
const nativeRm = fs.rmSync;
fs.rmSync = function traceCancel(...args) {
  const target = args[0];
  try {
    if (
      jobsDir !== undefined &&
      typeof target === 'string' &&
      path.dirname(target) === jobsDir &&
      fs.existsSync(path.join(target, 'cancel'))
    ) {
      fs.appendFileSync(cancelLog, 'cancel:' + path.basename(target) + '\\n');
    }
  } catch {
    // 留痕失败不得跳过真实删除。
  }
  return nativeRm.apply(this, args);
};
Module.syncBuiltinESMExports();
`;

beforeAll(compileEntry, 90_000);
afterEach(stopFakeSidecars);
afterAll(releaseEntries);

async function until(condition: () => boolean, deadlineMs: number, what: string): Promise<void> {
  const deadlineAt = performance.now() + deadlineMs;
  while (!condition()) {
    if (performance.now() > deadlineAt) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await delay(10);
  }
}

type SpoolLayout = "absent" | "group-writable" | Heartbeat;

interface SpoolOptions {
  layout?: SpoolLayout;
  env?: Record<string, string>;
  held?: true;
  prepare?: (root: string) => void;
  /** 预加载钩子的源码文本，原样转给 `startEntry`。 */
  hook?: string;
}

/**
 * 起入口：`<root>/spool` 按 `layout` 建（`0700`、属本进程；`group-writable` 为 `0770`；`absent` 不建），
 * 其上的假 sidecar 按同名心跳模式应答（`absent` 不起）。每次尝试各一个根与一个假 sidecar，交还最后那个。
 */
async function spoolEntry(
  options: SpoolOptions = {},
): Promise<{ entry: Entry; sidecar: FakeSidecar | undefined }> {
  const { layout = "fresh" } = options;
  let sidecar: FakeSidecar | undefined;
  const entry = await startEntry({
    ...(options.held === undefined ? {} : { held: options.held }),
    ...(options.hook === undefined ? {} : { hook: options.hook }),
    prepare: (root) => {
      makeSandboxRoot(root);
      if (layout !== "absent") {
        mkdirSync(join(root, "spool"));
        chmodSync(join(root, "spool"), layout === "group-writable" ? 0o770 : 0o700);
      }
      options.prepare?.(root);
      if (layout !== "absent") {
        sidecar = startFakeSidecar(
          join(root, "spool"),
          layout === "group-writable" ? "fresh" : layout,
        );
      }
    },
    env: (root) => ({ OFFICE_SPOOL_DIR: join(root, "spool"), ...options.env }),
  });
  return { entry, sidecar };
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

function placeExpiredPdf(root: string): void {
  const pdf = join(root, "preview-cache", "pdf");
  mkdirSync(pdf, { recursive: true });
  writeFileSync(join(pdf, "expired.pdf"), PDF);
  const at = (Date.now() - 8 * DAY_MS) / 1000;
  utimesSync(join(pdf, "expired.pdf"), at, at);
}

describe("production entry with the office converter on a spool", () => {
  it("clears leftover jobs, converts through the real cache and the spool, then on SIGTERM writes cancel for the conversion in flight before closing the listeners and the database", async () => {
    const leftoverId = "0123456789abcdef0123456789abcdef";
    const leftover = join("jobs", leftoverId);
    const { entry, sidecar } = await spoolEntry({
      env: {
        PREVIEW_DOCUMENT_MAX_BYTES: "100",
        OFFICE_CONVERT_TIMEOUT_MS: String(CONVERT_TIMEOUT_MS),
      },
      hook: CANCEL_TRACE_HOOK,
      prepare: (root) => {
        mkdirSync(join(root, "spool", leftover, "in"), { recursive: true, mode: 0o700 });
        writeFileSync(join(root, "spool", leftover, "in", "x.docx"), "stale");
      },
    });
    const { server, port, previewPort } = entry;
    const jobs = join(entry.root, "spool", "jobs");
    // 假 sidecar 在入口清空之前已经看见那个遗留作业；这里只看本次启动之后的作业。
    const records = () => (sidecar?.jobs() ?? []).filter((job) => job.id !== leftoverId);
    const cancelLog = join(entry.root, "cancel.log");
    const cancelTrace = () => (existsSync(cancelLog) ? readFileSync(cancelLog, "utf8") : "");
    const cancelled = (id: string | undefined) =>
      id !== undefined && cancelTrace().split("\n").includes(`cancel:${id}`);
    try {
      await server.waitForStarted();
      // 入口建了 `jobs/`（`0700`）、清空了遗留（本进程删，不启动子进程），jobs 自身仍在。
      expect(lstatSync(jobs).mode & 0o7777).toBe(0o700);
      expect(readdirSync(jobs)).toEqual([]);
      expect(existsSync(join(entry.root, "preview-cache", "work"))).toBe(false);
      const workspace = await openWorkspace(entry);
      expect(workspace.officeAvailable).toBe(true);
      for (const name of ["报告.docx", "slow@hang.docx", "late@hang.docx"]) {
        writeFileSync(join(workspace.root, name), "not a real office document");
      }
      writeFileSync(join(workspace.root, "big.docx"), Buffer.alloc(101, 0x61));

      // 整条链路：路由 → 缓存与排队 → 转换器 → spool → 假 sidecar → pdf/ → 区间发送。
      const converted = await fetch(officeUrl(workspace.base, "报告.docx"));
      expect(converted.status).toBe(200);
      expect(converted.headers.get("content-type")).toBe("application/pdf");
      expect(await converted.text()).toBe(PDF);
      const again = await fetch(officeUrl(workspace.base, "报告.docx"), {
        headers: { range: "bytes=0-7" },
      });
      expect(again.status).toBe(206);
      expect(await again.text()).toBe("%PDF-1.4");
      // 第二次命中缓存：spool 里只出现过一个作业。
      expect(records()).toHaveLength(1);

      // 两个配置值到了该到的地方：文档上限到路由（101 字节对 100），转换超时到转换器。
      const tooLarge = await fetch(officeUrl(workspace.base, "big.docx"));
      expect(tooLarge.status).toBe(413);
      expect(await tooLarge.text()).toBe(TOO_LARGE_TEXT);
      expect(records()).toHaveLength(1);
      const startedAt = performance.now();
      const late = await fetch(officeUrl(workspace.base, "late@hang.docx"));
      expect(late.status).toBe(504);
      expect(await late.text()).toBe(TIMEOUT_TEXT);
      // 假 sidecar 从不应答 `hang`：结束它的是配置的超时，作业写了 cancel、目录已删。
      // app 是子进程，写完 cancel 随即删目录，测试进程的扫描无法与它同拍、假 sidecar 的文件事件也可能
      // 丢（#1574 / #1751）：这里与下面关停时的 cancel 都看预加载钩子在删除那一刻留下的 cancel.log。
      // 它们承载「超时写了 cancel」与「1.5 s 内中止在途作业、早于 2 s 关停预算」两条结论。
      expect(performance.now() - startedAt).toBeGreaterThanOrEqual(CONVERT_TIMEOUT_MS - 1);
      expect(performance.now() - startedAt).toBeLessThan(15_000);
      await until(() => cancelled(records()[1]?.id), 2_000, "the timed-out job's cancel");
      const timedOutId = records()[1]?.id;
      expect(existsSync(records()[1]?.dir ?? "")).toBe(false);

      const inFlight = settleOf(officeUrl(workspace.base, "slow@hang.docx"));
      await until(() => records()[2]?.request !== undefined, 10_000, "the job in flight");
      const inFlightId = records()[2]?.id;
      const stopping = server.stop();
      // 有界：早于监听器 2 秒的关停预算——不是等连接被强制回收之后才顺带中止的。
      await until(() => cancelled(inFlightId), 1_500, "cancel for the job in flight");
      expect(await stopping).toBe(0);
      // 恰这两次 cancel，超时那次在前：遗留作业与转换成功的作业删除时都没有 cancel，不留痕。
      expect(cancelTrace()).toBe(`cancel:${timedOutId}\ncancel:${inFlightId}\n`);

      expect(await inFlight).toEqual({ failed: true });
      expect(readdirSync(jobs)).toEqual([]);
      expect(applicationStderr(server.stderr())).toBe("");
      // 入口没有启动任何子进程（没有 runtime-exit）：两个监听器先关，DB 最后。
      expect(entry.readTrace()).toBe(
        `listening:127.0.0.1:${port}\nlistening:127.0.0.1:${previewPort}\n` +
          `listener-close:${previewPort}\nlistener-close:${port}\ndb-close\n`,
      );
    } finally {
      await server.dispose();
    }
  }, 60_000);

  it("answers 503 once the heartbeat goes stale at runtime, with exactly one unavailable line through the managed writer, while the cached document is still served", async () => {
    const { entry, sidecar } = await spoolEntry();
    const { server } = entry;
    try {
      await server.waitForStarted();
      const workspace = await openWorkspace(entry);
      for (const name of ["a.docx", "b.docx", "c.docx"]) {
        writeFileSync(join(workspace.root, name), "not a real office document");
      }
      expect(await (await fetch(officeUrl(workspace.base, "a.docx"))).text()).toBe(PDF);
      // 不靠墙钟：假 sidecar 把心跳钉到 30 秒前，下一次转换前的检查即见不新鲜。
      sidecar?.heartbeat("stale");
      for (const name of ["b.docx", "c.docx"]) {
        const refused = await rawAnswer(
          new URL(workspace.base).origin,
          new URL(officeUrl(workspace.base, name)).pathname,
        );
        expect([refused.status, refused.body]).toEqual([503, UNAVAILABLE_TEXT]);
      }
      const cached = await fetch(officeUrl(workspace.base, "a.docx"));
      expect([cached.status, await cached.text()]).toEqual([200, PDF]);
      expect(sidecar?.jobs()).toHaveLength(1);

      expect(await server.stop()).toBe(0);
      // 边沿触发：两次 unavailable 只有一行。
      expect(applicationStderr(server.stderr())).toBe(UNAVAILABLE_LINE);
    } finally {
      await server.dispose();
    }
  }, 60_000);

  it("runs one conversion at a time under OFFICE_CONVERT_CONCURRENCY=1: the second job appears only after the first has settled", async () => {
    const { entry, sidecar } = await spoolEntry({ env: { OFFICE_CONVERT_CONCURRENCY: "1" } });
    const { server } = entry;
    const records = () => sidecar?.jobs() ?? [];
    try {
      await server.waitForStarted();
      const workspace = await openWorkspace(entry);
      writeFileSync(join(workspace.root, "first@gate.docx"), "not a real office document");
      writeFileSync(join(workspace.root, "second.docx"), "not a real office document");

      let firstSettled = false;
      let secondSettled = false;
      const first = settleOf(officeUrl(workspace.base, "first@gate.docx")).finally(() => {
        firstSettled = true;
      });
      await until(() => records().length === 1, 10_000, "the gated job");
      const second = settleOf(officeUrl(workspace.base, "second.docx")).finally(() => {
        secondSettled = true;
      });
      // 1 秒：并发若不是 1，第二个作业此时早已出现并答完（假 sidecar 每 100 ms 至少看一轮）。
      await delay(1_000);
      expect(records()).toHaveLength(1);
      expect(firstSettled).toBe(false);
      expect(secondSettled).toBe(false);

      sidecar?.release("first@gate.docx");
      expect(await first).toEqual({ status: 200 });
      expect(await second).toEqual({ status: 200 });
      expect(records()).toHaveLength(2);

      expect(await server.stop()).toBe(0);
      expect(applicationStderr(server.stderr())).toBe("");
    } finally {
      await server.dispose();
    }
  }, 60_000);

  it("sweeps the conversion cache once at startup and reports the converter unavailable without OFFICE_SPOOL_DIR, with no line and no work directory", async () => {
    const entry = await startEntry({
      prepare: (root) => {
        makeSandboxRoot(root);
        placeExpiredPdf(root);
        writeFileSync(join(root, "preview-cache", "pdf", "fresh.pdf"), PDF);
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
      expect(existsSync(join(entry.root, "preview-cache", "work"))).toBe(false);

      expect(await server.stop()).toBe(0);
      expect(applicationStderr(server.stderr())).toBe("");
    } finally {
      await server.dispose();
    }
  }, 60_000);
});

describe("production entry when the sidecar preflight fails", () => {
  it.each<[string, SpoolLayout]>([
    ["the spool path does not exist", "absent"],
    ["the spool is group-writable (0770)", "group-writable"],
    ["the spool has no heartbeat", "none"],
    ["the heartbeat is 30 s old", "stale"],
  ])(
    "%s: starts anyway with exactly one unavailable line before server_started, officeAvailable false, 503 and no job",
    async (_case, layout) => {
      const launchedAt = performance.now();
      const prepare = (root: string): void => {
        placeExpiredPdf(root);
        if (layout !== "absent") {
          mkdirSync(join(root, "spool", "jobs", LEFTOVER_ID, "in"), {
            recursive: true,
            mode: 0o700,
          });
          writeFileSync(join(root, "spool", "jobs", LEFTOVER_ID, "in", "x"), "stale");
        }
      };
      const { entry } = await spoolEntry({ layout, held: true, prepare });
      const { server } = entry;
      try {
        await server.waitForStarted();
        const startedMs = performance.now() - launchedAt;
        expect(applicationStderr(server.stderr())).toBe(UNAVAILABLE_LINE);
        if (layout === "none") {
          expect(startedMs).toBeGreaterThanOrEqual(WAIT_MS);
          expect(startedMs).toBeLessThan(WAIT_MS + DELTA_MS);
        }
        const workspace = await openWorkspace(entry);
        expect(workspace.officeAvailable).toBe(false);
        const again = await fetch(
          `http://127.0.0.1:${entry.port}/api/workspaces/${workspace.id}/preview-token`,
          {
            method: "POST",
            headers: { cookie: workspace.cookie },
            signal: AbortSignal.timeout(10_000),
          },
        );
        expect(((await again.json()) as { officeAvailable: boolean }).officeAvailable).toBe(false);
        writeFileSync(join(workspace.root, "a.docx"), "not a real office document");
        const refused = await rawAnswer(
          new URL(workspace.base).origin,
          new URL(officeUrl(workspace.base, "a.docx")).pathname,
        );
        expect(refused.status).toBe(503);
        expect(refused.body).toBe(UNAVAILABLE_TEXT);
        // 预检未过：入口不碰 spool（不建 `jobs/`、预置的遗留原样留着），`pdf/` 的启动清理照常。
        const jobs = join(entry.root, "spool", "jobs");
        if (layout === "absent") {
          expect(existsSync(jobs)).toBe(false);
        } else {
          expect(readdirSync(jobs)).toEqual([LEFTOVER_ID]);
          expect(existsSync(join(jobs, LEFTOVER_ID, "in", "x"))).toBe(true);
        }
        await until(
          () => !existsSync(join(entry.root, "preview-cache", "pdf", "expired.pdf")),
          10_000,
          "the sweep",
        );

        expect(await server.stop()).toBe(0);
        expect(applicationStderr(server.stderr())).toBe(UNAVAILABLE_LINE);
      } finally {
        await server.dispose();
      }
    },
    60_000,
  );

  it("waits for a heartbeat that only appears 2 s after launch: no line, officeAvailable true, the conversion succeeds", async () => {
    const { entry, sidecar } = await spoolEntry({ layout: "none", held: true });
    const beat = setTimeout(() => sidecar?.heartbeat("fresh"), 2_000);
    const { server } = entry;
    try {
      await server.waitForStarted();
      expect(applicationStderr(server.stderr())).toBe("");
      const workspace = await openWorkspace(entry);
      expect(workspace.officeAvailable).toBe(true);
      writeFileSync(join(workspace.root, "a.docx"), "not a real office document");
      const converted = await fetch(officeUrl(workspace.base, "a.docx"));
      expect(converted.status).toBe(200);
      expect(await converted.text()).toBe(PDF);
      expect(await server.stop()).toBe(0);
    } finally {
      clearTimeout(beat);
      await server.dispose();
    }
  }, 60_000);

  it("exits 0 within 5 s of a SIGTERM that lands in the preflight wait, with no record on either stream and the port and DB reusable", async () => {
    const { entry } = await spoolEntry({ layout: "none", held: true });
    const { server, root } = entry;
    try {
      await delay(1_000);
      const signalledAt = performance.now();
      expect(await server.stop()).toBe(0);
      expect(performance.now() - signalledAt).toBeLessThan(5_000);
      expect(server.stdout()).toBe("");
      expect(applicationStderr(server.stderr())).toBe("");
      expect(entry.readTrace()).toBe("db-close\n");
      expectDbReopens(join(root, "db", "dev.db"));
    } finally {
      await server.dispose();
    }
  }, 60_000);

  it("refuses to start while the retired OFFICE_BIN is still set: one generic config line that does not name the key", async () => {
    const { entry } = await spoolEntry({ env: { OFFICE_BIN: "/usr/bin/soffice" }, held: true });
    const { server, root } = entry;
    try {
      expect(await server.waitForClose()).toEqual({ code: 1, signal: null });
      expect(server.stdout()).toBe("");
      expect(applicationStderr(server.stderr())).toBe(CONFIG_FAILED_LINE);
      expect(server.stderr()).not.toContain("OFFICE_BIN");
      expect(existsSync(join(root, "db"))).toBe(false);
    } finally {
      await server.dispose();
    }
  }, 60_000);
});
