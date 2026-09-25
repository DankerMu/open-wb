import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthGuard, AuthProvider } from "../src/features/auth/index.js";
import { mountAuthenticatedApp } from "./render-app-router.js";
import {
  createFetchMock,
  currentLocation,
  deferredResponse,
  type FetchMock,
  jsonResponse,
  setBrowserPath,
} from "./support.js";
import { readRepoFile, ruleBody, stripComments } from "./ui-support.js";

type LoginRoutes = Parameters<typeof createFetchMock>[0];

let router: ReturnType<typeof mountAuthenticatedApp>["router"] | undefined;

afterEach(() => {
  cleanup();
  router?.dispose();
  router = undefined;
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  setBrowserPath("/");
});

function loginFetchMock(routes: LoginRoutes = {}): FetchMock {
  return createFetchMock({
    "/api/auth/me": () =>
      jsonResponse({ error: { code: "unauthorized", message: "登录已失效" } }, 401),
    ...routes,
  });
}

/** 未登录态直接挂 AuthProvider + AuthGuard（登录页唯一消费者），不经路由。 */
async function openLoginPage({ routes = {}, strict = false } = {}) {
  const fetchMock = loginFetchMock(routes);
  vi.stubGlobal("fetch", fetchMock);
  const tree = (
    <AuthProvider>
      <AuthGuard>
        <p>受保护内容</p>
      </AuthGuard>
    </AuthProvider>
  );
  render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  const heading = await screen.findByRole("heading", { level: 1, name: "登录 WorkBuddy" });
  return { fetchMock, heading, ...loginFields() };
}

function loginFields() {
  return {
    account: screen.getByLabelText("账号") as HTMLInputElement,
    password: screen.getByLabelText("密码") as HTMLInputElement,
    button: screen.getByRole("button", { name: "登录" }) as HTMLButtonElement,
  };
}

function fillAndSubmit(fields: ReturnType<typeof loginFields>) {
  fireEvent.change(fields.account, { target: { value: "zhangsan" } });
  fireEvent.change(fields.password, { target: { value: "demo" } });
  fireEvent.click(fields.button);
}

async function expectAccountFocused() {
  await waitFor(() => {
    expect(document.activeElement).toBe(screen.getByLabelText("账号"));
  });
}

/** 断言 nodes 在文档中严格按给定顺序出现。 */
function expectDocumentOrder(nodes: Element[]) {
  for (let index = 1; index < nodes.length; index += 1) {
    const previous = nodes[index - 1] as Element;
    const next = nodes[index] as Element;
    expect(previous.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }
}

describe("login card structure", () => {
  it("renders brand, title, subtitle, fields and the primary button in demo order", async () => {
    const { heading, account, password, button } = await openLoginPage();

    const subtitle = screen.getByText("内网统一身份 · 本实例不出网");
    expect(subtitle.tagName).toBe("P");
    expect(subtitle.classList.contains("login-sub")).toBe(true);

    const card = document.querySelector(".login-card") as HTMLElement;
    const brand = card.querySelector(".login-brand") as HTMLElement;
    expect(brand).not.toBeNull();
    const mark = brand.querySelector("svg.ui-brand-mark") as SVGElement;
    expect(mark.getAttribute("width")).toBe("26");
    expect(mark.getAttribute("height")).toBe("26");
    expect(mark.getAttribute("aria-hidden")).toBe("true");
    expect(within(brand).getByText("WorkBuddy", { exact: true })).toBeTruthy();

    const ordered = [brand, heading, subtitle, account, password, button];
    for (const node of ordered) expect(card.contains(node)).toBe(true);
    expectDocumentOrder(ordered);

    expect(screen.queryByText(/演示账号/)).toBeNull();
    expect(document.querySelector(".login-quick")).toBeNull();
    expect(document.querySelector(".brand-mark")).toBeNull();
  });

  it("focuses the account field on mount", async () => {
    await openLoginPage();
    await expectAccountFocused();
  });

  it("focuses the account field on mount under StrictMode", async () => {
    await openLoginPage({ strict: true });
    await expectAccountFocused();
  });

  it("exposes exact field attributes and label associations", async () => {
    const { account, password } = await openLoginPage();

    expect(account.getAttribute("placeholder")).toBe("域账号，如 zhangsan");
    expect(account.getAttribute("autocomplete")).toBe("username");
    expect(account.getAttribute("name")).toBe("account");
    expect(account.required).toBe(true);

    expect(password.getAttribute("placeholder")).toBe("密码");
    expect(password.getAttribute("autocomplete")).toBe("current-password");
    expect(password.getAttribute("type")).toBe("password");
    expect(password.getAttribute("name")).toBe("password");

    for (const [text, input] of [
      ["账号", account],
      ["密码", password],
    ] as const) {
      expect(input.classList.contains("ui-input")).toBe(true);
      expect(input.id).not.toBe("");
      const label = screen.getByText(text, { selector: "label" }) as HTMLLabelElement;
      expect(label.htmlFor).toBe(input.id);
      expect(label.classList.contains("login-label")).toBe(true);
    }
  });
});

describe("login card submission", () => {
  it("shows 正在登录 on the disabled button, then the envelope message above it", async () => {
    const pendingLogin = deferredResponse();
    const fields = await openLoginPage({
      routes: { "/api/auth/login": () => pendingLogin.promise },
    });
    const { password, button } = fields;

    fillAndSubmit(fields);

    await waitFor(() => {
      expect(button.textContent).toBe("正在登录");
    });
    expect(button.disabled).toBe(true);
    expect(screen.getByRole("button", { name: "正在登录" })).toBe(button);
    expect(screen.queryByRole("button", { name: "登录" })).toBeNull();
    expect(screen.getAllByText("正在登录")).toHaveLength(1);

    pendingLogin.resolve(
      jsonResponse(
        { error: { code: "account_disabled", message: "该账号已停用，请联系管理员" } },
        403,
      ),
    );

    const alert = await screen.findByRole("alert");
    await waitFor(() => {
      expect(button.textContent).toBe("登录");
    });
    expect(button.disabled).toBe(false);
    expect(alert.textContent).toBe("该账号已停用，请联系管理员");
    expect(alert.classList.contains("login-err")).toBe(true);
    expect(alert.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expectDocumentOrder([password, alert, button]);
  });

  it("shows the stable fallback on network failure and clears the password", async () => {
    const fields = await openLoginPage({
      routes: { "/api/auth/login": () => new Error("private transport failure") },
    });

    fillAndSubmit(fields);

    expect((await screen.findByRole("alert")).textContent).toBe("请求失败，请稍后重试");
    await waitFor(() => {
      expect(fields.button.disabled).toBe(false);
    });
    expect(fields.password.value).toBe("");
  });
});

describe("login card routing and scope", () => {
  it("renders the focused login page at /files without changing the URL", async () => {
    const mounted = mountAuthenticatedApp("/files", loginFetchMock());
    router = mounted.router;

    expect(await screen.findByRole("heading", { level: 1, name: "登录 WorkBuddy" })).toBeTruthy();
    expect(currentLocation()).toBe("/files");
    await expectAccountFocused();
  });

  it("issues no request beyond /api/auth/me", async () => {
    const { fetchMock } = await openLoginPage();
    await expectAccountFocused();

    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual(["/api/auth/me"]);
  });
});

describe("login card static contract", () => {
  const authCssPath = "web/src/features/auth/auth.css";

  it("auth.css carries demo provenance and demo-aligned geometry on semantic tokens", () => {
    const raw = readRepoFile(authCssPath);
    expect(raw).toContain("resource/workbuddy-live-demo.html:637");
    const css = stripComments(raw);

    const card = ruleBody(css, ".login-card");
    expect(card).toContain("width: 360px;");
    expect(card).toContain("border: 1px solid var(--wb-border-card);");
    expect(card).toContain("max-width: calc(100vw - 32px);");
    expect(ruleBody(css, ".login-sub")).toContain("color: var(--wb-text-tertiary);");
    expect(ruleBody(css, ".login-btn")).toContain("height: 36px;");
    expect(ruleBody(css, ".login-err")).toContain("var(--wb-status-error-soft-bg)");
  });

  it("styles.css imports auth.css and drops the migrated login and brand-mark rules", () => {
    const styles = readRepoFile("web/src/styles.css");
    expect(styles).toContain('@import "./features/auth/auth.css";');
    expect(styles).not.toContain(".brand-mark");
    expect(styles).not.toContain(".login-");
    expect(styles).not.toContain(".login-dialog");
  });

  it("login-form.tsx avoids autoFocus, radix and ui-muted and imports primitives via ui/index", () => {
    const source = readRepoFile("web/src/features/auth/login-form.tsx");
    expect(source).not.toContain("autoFocus");
    expect(source).not.toContain("@radix-ui");
    expect(source).not.toContain("ui-muted");
    expect(source).toContain('from "../../ui/index.js"');
  });
});
