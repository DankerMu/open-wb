// UI walk：走查删除它自己创建的会话（chat-harness「冒烟与走查不留会话与临时空间」）。不带工作空间创建的
// 会话各带一个临时空间，不删就会在重复运行里积累空间行与目录。
import { expect, type Page, type Response } from "@playwright/test";

const FORK_PATH = /^\/api\/sessions\/[0-9a-f]{32}\/fork$/;

// `finally` 里调用：只产生 soft 失败，不盖掉 try 里的原始失败。204 或 404；409 判失败。
export async function deleteCreatedSession(page: Page, sessionId: string | null): Promise<void> {
  if (sessionId === null) return;
  try {
    const deleted = await page.request.delete(`/api/sessions/${sessionId}`);
    expect.soft([204, 404], "cleanup: DELETE session status").toContain(deleted.status());
    const listed = await page.request.get("/api/sessions");
    const body = (await listed.json()) as { sessions: { id: string }[] };
    expect
      .soft(
        body.sessions.map((session) => session.id),
        "cleanup: session list",
      )
      .not.toContain(sessionId);
  } catch (error) {
    expect.soft(String(error), "cleanup: request failed").toBe("");
  }
}

// 从挂上起记下页面经界面创建的每个会话：`POST /api/sessions` 与 `POST …/fork` 的 201 响应一到就取其
// id（先于旅程对该请求的任何断言）。`firstId` 是首次发送创建的那个会话；`deleteAll` 放在包住旅程的
// `finally` 里，逐个删除（fork 出的会话与源会话共用临时空间，两个都删空间才消失）。
export function watchCreatedSessions(page: Page) {
  const ids: Promise<string>[] = [];
  const onResponse = (response: Response) => {
    if (response.request().method() !== "POST" || response.status() !== 201) return;
    const { pathname } = new URL(response.url());
    if (pathname === "/api/sessions") {
      ids.push(response.json().then((body: { id: string }) => body.id));
    } else if (FORK_PATH.test(pathname)) {
      ids.push(response.json().then((body: { session: { id: string } }) => body.session.id));
    }
  };
  page.on("response", onResponse);
  return {
    async firstId(): Promise<string> {
      const first = ids[0];
      if (first === undefined) throw new Error("no POST /api/sessions 201 was observed");
      return first;
    },
    async deleteAll(): Promise<void> {
      page.off("response", onResponse);
      for (const result of await Promise.allSettled(ids)) {
        if (result.status === "fulfilled") {
          await deleteCreatedSession(page, result.value);
        } else {
          expect.soft(String(result.reason), "cleanup: created session id unreadable").toBe("");
        }
      }
    },
  };
}

export type CreatedSessions = ReturnType<typeof watchCreatedSessions>;
