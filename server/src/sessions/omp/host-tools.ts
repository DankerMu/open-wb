/**
 * Host tool protocol of omp v18.12.3 (change s2c-kb-session D1; omp-runtime「宿主工具协议」; frames
 * per docs/reviews/2026-11-10-omp-host-tools.md §2.3, §2.7): each `host_tool_call` goes to the
 * injected handler with an abort signal and gets exactly one `host_tool_result`, unless it is
 * cancelled or the transport closes first. Calls run concurrently. Only the tool name is known
 * here, never which tools exist; errors of the handler never reach a frame, a log or an event.
 */
import type { OmpFrame } from "./frame.js";

export interface HostToolResult {
  text: string;
  details?: object;
  isError: boolean;
}

export interface HostToolHandler {
  /** Resolves `undefined` when the tool is not this handler's; the signal aborts on cancel or close. */
  call(toolName: string, args: unknown, signal: AbortSignal): Promise<HostToolResult | undefined>;
}

/**
 * Writes one frame; rejects unwritten when input is unwritable, or the frame is unserializable or
 * too long.
 */
type FrameWriter = (frame: OmpFrame) => Promise<void>;

const UNKNOWN_TOOL = "未知工具";
const TOOL_FAILED = "工具执行失败";
const RESULT_TOO_LARGE = "工具结果过大";

export class HostTools {
  readonly #handler: HostToolHandler | undefined;
  readonly #write: FrameWriter;
  readonly #inFlight = new Map<string, AbortController>();
  #closed = false;

  constructor(handler: HostToolHandler | undefined, write: FrameWriter) {
    this.#handler = handler;
    this.#write = write;
  }

  /** `host_tool_call` and `host_tool_cancel`; every other frame is ignored. */
  onFrame(frame: OmpFrame): void {
    if (this.#closed) {
      return;
    }
    if (frame.type === "host_tool_call" && typeof frame.id === "string" && frame.id.length > 0) {
      this.#onCall(frame, frame.id);
    } else if (frame.type === "host_tool_cancel" && typeof frame.targetId === "string") {
      this.#inFlight.get(frame.targetId)?.abort();
      this.#inFlight.delete(frame.targetId);
    }
  }

  /** Input is gone for good: abort every in-flight call and ignore every later frame. */
  close(): void {
    this.#closed = true;
    for (const controller of this.#inFlight.values()) {
      controller.abort();
    }
    this.#inFlight.clear();
  }

  #onCall(frame: OmpFrame, id: string): void {
    if (this.#inFlight.has(id)) {
      return;
    }
    const controller = new AbortController();
    this.#inFlight.set(id, controller);
    void this.#run(frame, id, controller);
  }

  async #run(frame: OmpFrame, id: string, controller: AbortController): Promise<void> {
    let result: HostToolResult | undefined;
    try {
      const toolName = typeof frame.toolName === "string" ? frame.toolName : "";
      result = await this.#handler?.call(toolName, frame.arguments, controller.signal);
    } catch {
      result = { text: TOOL_FAILED, isError: true };
    }
    if (this.#inFlight.get(id) !== controller) {
      return;
    }
    this.#inFlight.delete(id);
    await this.#reply(id, result ?? { text: UNKNOWN_TOOL, isError: true });
  }

  /**
   * Full frame; on any refusal (too long, unserializable `details`, a text that cannot be
   * rendered) the frame without `details`; then the too-large error. Each attempt is built inside
   * the try and passes the transport's writability guard, so after input is gone each one is
   * refused unwritten; a refusal never escapes.
   */
  async #reply(id: string, result: HostToolResult): Promise<void> {
    const attempts = [
      () => resultFrame(id, result.text, result.isError === true, plainObject(result.details)),
      () => resultFrame(id, result.text, result.isError === true, undefined),
      () => resultFrame(id, RESULT_TOO_LARGE, true, undefined),
    ];
    for (const attempt of attempts) {
      try {
        await this.#write(attempt());
        return;
      } catch {
        // Next, smaller attempt.
      }
    }
  }
}

function resultFrame(
  id: string,
  text: string,
  isError: boolean,
  details: object | undefined,
): OmpFrame {
  const content = [{ type: "text", text: String(text) }];
  return {
    type: "host_tool_result",
    id,
    result: details === undefined ? { content } : { content, details },
    ...(isError ? { isError: true } : {}),
  };
}

function plainObject(value: unknown): object | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null ? value : undefined;
}
