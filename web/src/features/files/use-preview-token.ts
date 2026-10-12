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
type Issued = { client: Client; workspaceId: string; at: number };

const IDLE: Value = { status: "idle" };
const LOADING: Value = { status: "loading" };

/**
 * The one freshness rule, for the effect and for the render-time check alike: how long the last
 * successful issue may still be reused, in milliseconds; 0 when there is none, when it is five
 * minutes old or more, or when the local clock has gone back behind it.
 */
function reusableFor(issued: Issued | null): number {
  if (!issued) return 0;
  const age = Date.now() - issued.at;
  return age >= 0 && age < RENEW_MS ? RENEW_MS - age : 0;
}

/**
 * The preview token of one workspace, for the single host above the previewers: call it once per
 * page and pass the result down (a second host issues a second time).
 *
 * `base` and `officeBase` contain the token, so the returned `ready` object is a credential. It
 * lives in this hook's React state and in the return value, nowhere else: the hook has no storage,
 * address or log call (pinned by the test's spies). The response's `token` and `expiresAt` are not
 * kept. Where the caller puts `base` is the caller's business.
 *
 * `attempt` is a change signal from the host (刷新, a second click on the selected row), not a
 * count: when it changes while the token is needed, a successful issue under five minutes old is
 * kept and the renewal stays where it was; otherwise (a failed issue, none yet, five minutes or
 * more) the call in flight is aborted and a new one goes out at once.
 */
export function usePreviewToken(
  client: Client,
  workspaceId: string | null,
  needed: boolean,
  attempt: number,
) {
  const [held, setHeld] = useState<Held | null>(null);
  // Local clock of the last successful issue for this key. No part of the response is in here.
  const issuedRef = useRef<Issued | null>(null);
  // What the effect last ran with. Two plain values, nothing of the response.
  const ranWithRef = useRef<{ needed: boolean; attempt: number } | null>(null);

  useEffect(() => {
    const issued = issuedRef.current;
    if (issued && (issued.client !== client || issued.workspaceId !== workspaceId)) {
      issuedRef.current = null;
    }
    // Written before the early return: the run that finds the token not needed is recorded too.
    ranWithRef.current = { needed, attempt };
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

    const reusable = reusableFor(issuedRef.current);
    if (reusable > 0) {
      schedule(reusable);
    } else {
      issuedRef.current = null;
      setHeld({ client, workspaceId, value: LOADING });
      issue();
    }

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [client, workspaceId, needed, attempt]);

  // Compared while rendering: the render that switches workspace or client must not hand out the
  // previous one's `base` (an iframe would resolve the same relative path in the wrong workspace).
  const mine =
    held && held.client === client && held.workspaceId === workspaceId ? held.value : null;
  if (!needed || workspaceId === null) {
    return mine ?? IDLE;
  }
  // Also while rendering: when `needed` or `attempt` differs from what the effect last ran with,
  // the effect is about to run again, and by the rule above it issues again unless the last
  // successful issue is still reusable. That render is loading already, so what was held before (a
  // `base` that may have lapsed, or an old failure) is not handed out for one frame. With the same
  // `needed` and `attempt` the held value stands, whether a renewal is in flight or has failed.
  const ranWith = ranWithRef.current;
  const rerun = ranWith?.needed !== needed || ranWith.attempt !== attempt;
  if (rerun && reusableFor(issuedRef.current) === 0) {
    return LOADING;
  }
  return mine ?? LOADING;
}
