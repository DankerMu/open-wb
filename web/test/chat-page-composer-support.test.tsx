/**
 * Issue 1024 (parent task 13.4) the shared page-test support answers `GET /api/composer/options`
 * and carries the controllable `XMLHttpRequest` double of `uploadFile`. No product code asks for
 * the options yet, so each case asks itself: the real `createApiClient` over the global `fetch`
 * that the mount under test replaced. Oracles: the 「缺省配置」 body of session-composer-settings
 * 「输入框选项端点」 (`DEFAULT_COMPOSER_OPTIONS`) and the implementation notes of the task.
 */
import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/lib/api.js";
import type { ComposerOptions } from "../src/lib/composer-contract.js";
import { turn } from "./chat-page-file-changes-support.js";
import { renderChatPageWithAuthProbe } from "./chat-page-lifecycle-support.js";
import { chatShellFixture, openProbedSession } from "./chat-page-shell-support.js";
import { cleanupChatPage, renderChatPage } from "./chat-page-support.js";
import { DEFAULT_COMPOSER_OPTIONS } from "./session-meta-fixtures.js";
import {
  allowWorkspaceListFetch,
  CAPABILITIES_ROUTE,
  composerOptionsRoute,
  composerReadRoutes,
  createFetchMock,
  jsonResponse,
} from "./support.js";
import { FakeXhr, installFakeXhr, lastFakeXhr } from "./upload-support.js";

const WORKSPACE = "0123456789abcdef0123456789abcdef";
/** The default body with two approval modes and tighter upload limits. */
const CAPPED_OPTIONS: ComposerOptions = {
  ...DEFAULT_COMPOSER_OPTIONS,
  approvalModes: ["always-ask", "write"],
  upload: { maxBytes: 1_048_576, maxFiles: 3 },
};
/** The page's own list request; the composer options are the support's business, not the case's. */
const NO_SESSIONS = { "/api/sessions": () => jsonResponse({ sessions: [] }) };

// Unmounts the page and the probed shell after each case (`cleanupChatLifecycle` included).
chatShellFixture();

/** What a client created after the mount reads from the options endpoint. */
function options() {
  return createApiClient().getComposerOptions();
}

async function pageReady() {
  await screen.findByRole("textbox", { name: "给助手发消息" });
}

describe("整页测试支撑：输入框选项的缺省应答", () => {
  it("renderChatPage answers the default body every time it is asked", async () => {
    renderChatPage("/", NO_SESSIONS);
    await pageReady();

    expect(await options()).toEqual(DEFAULT_COMPOSER_OPTIONS);
    expect(await options()).toEqual(DEFAULT_COMPOSER_OPTIONS);
  });

  it("a case's own composerOptionsRoute replaces the default body", async () => {
    renderChatPage("/", { ...NO_SESSIONS, ...composerOptionsRoute(CAPPED_OPTIONS) });
    await pageReady();

    expect(await options()).toEqual(CAPPED_OPTIONS);
  });

  it("renderChatPageWithAuthProbe answers the default body", async () => {
    renderChatPageWithAuthProbe("/", NO_SESSIONS);
    await pageReady();

    expect(await options()).toEqual(DEFAULT_COMPOSER_OPTIONS);
  });

  it("openProbedSession answers the default body", async () => {
    await openProbedSession(turn("done"));

    expect(await options()).toEqual(DEFAULT_COMPOSER_OPTIONS);
  });

  it("allowWorkspaceListFetch answers the default body over an empty route table", async () => {
    vi.stubGlobal("fetch", createFetchMock({}));
    allowWorkspaceListFetch();

    expect(await options()).toEqual(DEFAULT_COMPOSER_OPTIONS);
  });
});

describe("整页测试支撑：专家清单与会话能力的缺省应答", () => {
  const NONE = { expertId: null, disabledSkills: [], disabledConnectors: [] };

  it("composerReadRoutes answers no experts and, for any session id, no capabilities", async () => {
    vi.stubGlobal("fetch", createFetchMock(composerReadRoutes()));
    const client = createApiClient();

    expect(await client.listExperts()).toEqual([]);
    expect(await client.getSessionCapabilities("a".repeat(32))).toEqual(NONE);
    expect(await client.getSessionCapabilities("b".repeat(32))).toEqual(NONE);
  });

  it("an exact capabilities key wins over the sentinel; other sessions still fall back", async () => {
    const mine = {
      expertId: "builtin:test-engineer",
      disabledSkills: ["deploy"],
      disabledConnectors: [],
    };
    vi.stubGlobal(
      "fetch",
      createFetchMock({
        ...composerReadRoutes(),
        [`/api/sessions/${"a".repeat(32)}/capabilities`]: () => jsonResponse(mine),
      }),
    );
    const client = createApiClient();

    expect(await client.getSessionCapabilities("a".repeat(32))).toEqual(mine);
    expect(await client.getSessionCapabilities("b".repeat(32))).toEqual(NONE);
  });

  it("a table without the sentinel still rejects an unregistered capabilities path", () => {
    const fetchMock = createFetchMock({ "/api/experts": () => jsonResponse({ experts: [] }) });

    expect(CAPABILITIES_ROUTE).toBe("/api/sessions/:id/capabilities");
    expect(() => fetchMock(`/api/sessions/${"a".repeat(32)}/capabilities`)).toThrow(
      `unexpected request /api/sessions/${"a".repeat(32)}/capabilities`,
    );
    expect(() => fetchMock(`/api/sessions/${"a".repeat(32)}/capabilities/x`)).toThrow();
  });

  it("renderChatPage and allowWorkspaceListFetch both answer the two defaults", async () => {
    renderChatPage("/", NO_SESSIONS);
    await pageReady();
    expect(await createApiClient().getSessionCapabilities("c".repeat(32))).toEqual(NONE);
    expect(await createApiClient().listExperts()).toEqual([]);

    vi.stubGlobal("fetch", createFetchMock({}));
    allowWorkspaceListFetch();
    expect(await createApiClient().getSessionCapabilities("c".repeat(32))).toEqual(NONE);
    expect(await createApiClient().listExperts()).toEqual([]);
  });
});

describe("整页测试支撑：上传替身", () => {
  it("uploadFile creates exactly one FakeXhr and cleanupChatPage removes the double", async () => {
    renderChatPage("/", NO_SESSIONS);
    await pageReady();
    installFakeXhr();

    const upload = createApiClient().uploadFile(WORKSPACE, new File(["x"], "a.txt"));
    void upload.catch(() => undefined);

    expect(FakeXhr.instances).toHaveLength(1);
    expect(lastFakeXhr()).toBe(FakeXhr.instances[0]);
    expect(lastFakeXhr().opens).toEqual([
      ["POST", `/api/workspaces/${WORKSPACE}/uploads?name=a.txt`],
    ]);

    cleanupChatPage();

    expect(FakeXhr.instances).toEqual([]);
    expect(globalThis.XMLHttpRequest).not.toBe(FakeXhr);
  });
});
