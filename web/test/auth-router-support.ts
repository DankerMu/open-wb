import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect } from "vitest";
import { calls, type FetchMock, jsonResponse, lastCall } from "./support.js";

/** 匿名 GET（`/api/auth/me`、`/api/info`）的请求形状。 */
export const anonymousGetInit = {
  method: "GET",
  credentials: "same-origin",
  cache: "no-store",
  signal: expect.any(AbortSignal),
};

export function unauthenticatedResponse(message = "登录已失效") {
  return jsonResponse({ error: { code: "unauthorized", message } }, 401);
}

export function expectLastLoginRequest(fetchMock: FetchMock, body: string) {
  expect(lastCall(fetchMock, "/api/auth/login")).toEqual([
    "/api/auth/login",
    {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body,
      signal: expect.any(AbortSignal),
    },
  ]);
}

/** 等到 `path` 至少被请求一次，返回最后一次请求的 signal。 */
export async function requestSignal(fetchMock: FetchMock, path: string): Promise<AbortSignal> {
  await waitFor(() => {
    expect(calls(fetchMock, path).length).toBeGreaterThan(0);
  });
  const signal = lastCall(fetchMock, path)[1]?.signal;
  if (!signal) {
    throw new Error(`expected the last ${path} request to include an AbortSignal`);
  }
  return signal;
}

export async function expectLogin() {
  expect(await screen.findByRole("heading", { level: 1, name: "登录 WorkBuddy" })).toBeTruthy();
}

export function getLoginForm() {
  const account = screen.getByLabelText("账号") as HTMLInputElement;
  const password = screen.getByLabelText("密码") as HTMLInputElement;
  const submit = screen.getByRole("button", { name: "登录" }) as HTMLButtonElement;
  return { account, password, submit };
}

export function submitLogin(accountValue: string, passwordValue: string) {
  const { account, password, submit } = getLoginForm();
  fireEvent.change(account, { target: { value: accountValue } });
  fireEvent.change(password, { target: { value: passwordValue } });
  fireEvent.submit(submit.closest("form") as HTMLFormElement);
  return { account, password, submit };
}

export async function expectAuthenticatedShell(title: string, currentLabel: string) {
  expect(await screen.findByRole("heading", { level: 1, name: title })).toBeTruthy();
  await waitFor(() => {
    expect(screen.queryByRole("heading", { level: 1, name: "登录 WorkBuddy" })).toBeNull();
  });
  const sidebar = screen.getByRole("complementary", { name: "侧栏" });
  const current = within(sidebar).getByRole("link", { name: new RegExp(currentLabel) });
  const currentLinks = within(sidebar)
    .getAllByRole("link")
    .filter((link) => link.getAttribute("aria-current") === "page");
  expect(current.getAttribute("aria-current")).toBe("page");
  expect(currentLinks).toHaveLength(1);
  expect(currentLinks[0]).toBe(current);
}

export async function expectFilesShell() {
  await expectAuthenticatedShell("工作空间", "工作空间");
}
