import { useEffect, useRef, useState } from "react";
import type { ApiClient } from "../../lib/api.js";
import { errorMessage, isUnauthorized } from "./errors.js";

/** One more issue call this long after the previous attempt settled, and the age up to which an issue is reused. */
const RENEW_MS = 300_000;

type Client = Pick<ApiClient, "issuePreviewToken">;
type Value =
  | { status: "idle" }
  | { status: "loading" }
  | {
      status: "ready";
      base: string;
      officeBase: string;
      documentMaxBytes: number;
      officeAvailable: boolean;
    }
  | { status: "error"; message: string };
type Held = { client: Client; workspaceId: string; value: Value };

const IDLE: Value = { status: "idle" };
const LOADING: Value = { status: "loading" };

/**
 * The preview token of one workspace, for the single host above the previewers: call it once per
 * page and pass the result down (a second host issues a second time).
 *
 * `base` and `officeBase` contain the token, so the returned `ready` object is a credential. It
 * lives in this hook's React state and in the return value, nowhere else: the hook has no storage,
 * address or log call (pinned by the test's spies). The response's `token` and `expiresAt` are not
 * kept. Where the caller puts `base` is the caller's business.
 */
export function usePreviewToken(client: Client, workspaceId: string | null, needed: boolean) {
  const [held, setHeld] = useState<Held | null>(null);
  // Local clock of the last successful issue for this key. No part of the response is in here.
  const issuedRef = useRef<{ client: Client; workspaceId: string; at: number } | null>(null);

  useEffect(() => {
    const issued = issuedRef.current;
    if (issued && (issued.client !== client || issued.workspaceId !== workspaceId)) {
      issuedRef.current = null;
    }
    if (!needed || workspaceId === null) {
      // Not needed under a new key: drop the previous key's value instead of holding it.
      setHeld((previous) =>
        previous && (previous.client !== client || previous.workspaceId !== workspaceId)
          ? null
          : previous,
      );
      return;
    }

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (delay: number) => {
      timer = setTimeout(issue, delay);
    };
    const issue = () => {
      // An aborted call rejects as an `ApiError` of status 0 (the client swallows AbortError), so
      // both callbacks ask the signal first; `error.name` would not tell.
      void client.issuePreviewToken(workspaceId, { signal: controller.signal }).then(
        ({ base, officeBase, documentMaxBytes, officeAvailable }) => {
          if (controller.signal.aborted) return;
          issuedRef.current = { client, workspaceId, at: Date.now() };
          // Same four fields: keep the object, so an iframe keyed on it does not reload.
          setHeld((previous) =>
            previous?.client === client &&
            previous.workspaceId === workspaceId &&
            previous.value.status === "ready" &&
            previous.value.base === base &&
            previous.value.officeBase === officeBase &&
            previous.value.documentMaxBytes === documentMaxBytes &&
            previous.value.officeAvailable === officeAvailable
              ? previous
              : {
                  client,
                  workspaceId,
                  value: { status: "ready", base, officeBase, documentMaxBytes, officeAvailable },
                },
          );
          schedule(RENEW_MS);
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          schedule(RENEW_MS);
          // 401 is not shown: the client has told `onUnauthorized` already.
          if (isUnauthorized(error)) return;
          // A failed renewal keeps what was issued before; the next beat tries again.
          setHeld((previous) =>
            previous?.client === client &&
            previous.workspaceId === workspaceId &&
            previous.value.status === "ready"
              ? previous
              : { client, workspaceId, value: { status: "error", message: errorMessage(error) } },
          );
        },
      );
    };

    const age = issuedRef.current ? Date.now() - issuedRef.current.at : RENEW_MS;
    if (age >= 0 && age < RENEW_MS) {
      schedule(RENEW_MS - age);
    } else {
      issuedRef.current = null;
      setHeld({ client, workspaceId, value: LOADING });
      issue();
    }

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [client, workspaceId, needed]);

  // Compared while rendering: the render that switches workspace or client must not hand out the
  // previous one's `base` (an iframe would resolve the same relative path in the wrong workspace).
  if (held && held.client === client && held.workspaceId === workspaceId) {
    return held.value;
  }
  return needed && workspaceId !== null ? LOADING : IDLE;
}
