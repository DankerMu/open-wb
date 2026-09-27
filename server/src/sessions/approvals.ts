/**
 * Issue #464 approval orchestration: registers each runtime approval request as a pending row,
 * publishes its approval.request at the select frame's position in the turn, runs one injected
 * clock timer per approvalId, and settles answers and timeouts through the store's CAS + audit
 * transaction. Frames, clearPending and events always target the slot and generation captured at
 * registration, never a lookup by session.
 */
import { HttpError } from "../core/errors/index.js";
import type { ChatEvent } from "./events.js";
import type { OmpFrame } from "./omp/frame.js";
import type { SessionClock } from "./omp/runtime.js";
import type { ApprovalRequest } from "./omp/ui-requests.js";
import type { Generation, Slot } from "./pool.js";
import type { ApprovalOutcome, ApprovalView, SessionStore } from "./store.js";

type RequestEvent = Extract<ChatEvent<number>, { type: "approval.request" }>;

interface ApprovalPorts {
  store: SessionStore;
  clock: SessionClock | undefined;
  /** The supervisor's ring + observer publication; false means the slot is being retired. */
  publish(slot: Slot, event: ChatEvent<number>, generation: Generation): Promise<boolean>;
  /** Owned error sink: retain the fault and retire the slot without awaiting. */
  fault(slot: Slot, error: Error): void;
}

interface Registration {
  slot: Slot;
  generation: Generation | undefined;
  sessionId: string;
  requestId: string;
  expiresAt: number;
  timer: unknown;
  request: RequestEvent;
  requestPublished: boolean;
}

const systemClock: SessionClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (id) => {
    clearTimeout(id as NodeJS.Timeout);
  },
};

export class ApprovalRegistry {
  readonly #store: SessionStore;
  readonly #clock: SessionClock;
  readonly #publish: ApprovalPorts["publish"];
  readonly #fault: ApprovalPorts["fault"];
  readonly #registrations = new Map<number, Registration>();

  constructor(ports: ApprovalPorts) {
    this.#store = ports.store;
    this.#clock = ports.clock ?? systemClock;
    this.#publish = ports.publish;
    this.#fault = ports.fault;
  }

  /** Runtime onApproval: synchronous and never throws; a failed insert takes the fault sink. */
  register(slot: Slot, request: ApprovalRequest): void {
    try {
      const requestedAt = this.#clock.now();
      const { approvalId, messageId, expiresAt } = this.#store.insertApproval(
        slot.sessionId,
        { requestId: request.id, tool: request.tool, title: request.title },
        requestedAt,
      );
      slot.runtime.markPending(approvalId);
      const registration: Registration = {
        slot,
        generation: slot.generation,
        sessionId: slot.sessionId,
        requestId: request.id,
        expiresAt,
        timer: undefined,
        request: {
          type: "approval.request",
          data: { messageId, approvalId, tool: request.tool, title: request.title, expiresAt },
        },
        requestPublished: false,
      };
      registration.timer = this.#clock.setTimeout(() => {
        this.#expire(approvalId, registration);
      }, expiresAt - requestedAt);
      this.#registrations.set(approvalId, registration);
    } catch (error) {
      this.#fault(slot, asError(error));
    }
  }

  /** Pump hook after each frame's own events: publishes a select's staged request once. */
  publishRequest(slot: Slot, frame: OmpFrame): Promise<boolean> {
    if (frame.type !== "extension_ui_request") {
      return Promise.resolve(true);
    }
    for (const registration of this.#registrations.values()) {
      if (
        registration.slot === slot &&
        registration.requestId === frame.id &&
        !registration.requestPublished
      ) {
        return this.#publishRequestOnce(registration);
      }
    }
    return Promise.resolve(true);
  }

  /** Read-only snapshot for stop (#473): this slot's registered approvalIds, ascending. */
  pendingFor(slot: Slot): number[] {
    const ids: number[] = [];
    for (const [approvalId, registration] of this.#registrations) {
      if (registration.slot === slot) {
        ids.push(approvalId);
      }
    }
    return ids.sort((a, b) => a - b);
  }

  /** CAS, audit, frame, timer and pending bookkeeping all complete before the first await. */
  async decide(
    sessionId: string,
    approvalId: number,
    decision: "allow" | "deny",
  ): Promise<ApprovalView> {
    const settled = this.#store.settleApproval(sessionId, approvalId, decision, this.#clock.now());
    if (settled === null) {
      throw new HttpError("approval_settled");
    }
    const registration = this.#registrations.get(approvalId);
    if (registration !== undefined) {
      await this.#finish(approvalId, registration, decision);
    }
    return settled;
  }

  /** Shutdown: revoke every approval timer without settling (terminal deny is #474's). */
  close(): void {
    for (const registration of this.#registrations.values()) {
      this.#clock.clearTimeout(registration.timer);
    }
    this.#registrations.clear();
  }

  /**
   * Timer callback: synchronous and never throws. A settled or vanished row (not_found: its
   * message was deleted, cascading the approval) is a silent miss; a failed transaction drops the
   * registration and takes the fault sink.
   */
  #expire(approvalId: number, registration: Registration): void {
    let settled: ApprovalView | null;
    try {
      settled = this.#store.settleApproval(
        registration.sessionId,
        approvalId,
        "timeout",
        registration.expiresAt,
      );
    } catch (error) {
      if (!(error instanceof HttpError && error.code === "not_found")) {
        this.#registrations.delete(approvalId);
        this.#fault(registration.slot, asError(error));
        return;
      }
      settled = null;
    }
    if (settled === null) {
      this.#registrations.delete(approvalId);
      registration.slot.runtime.clearPending(approvalId);
      return;
    }
    void this.#finish(approvalId, registration, "timeout");
  }

  /** After the committed settlement: answer, stop the timer, clear pending, then publish. */
  async #finish(
    approvalId: number,
    registration: Registration,
    decision: ApprovalOutcome,
  ): Promise<void> {
    const { slot } = registration;
    slot.runtime.respondApproval(registration.requestId, decision === "deny" ? "deny" : "allow");
    this.#clock.clearTimeout(registration.timer);
    slot.runtime.clearPending(approvalId);
    const requested =
      registration.requestPublished || (await this.#publishRequestOnce(registration));
    this.#registrations.delete(approvalId);
    if (requested) {
      const messageId = registration.request.data.messageId;
      await this.#emit(registration, {
        type: "approval.resolved",
        data: { messageId, approvalId, decision },
      });
    }
  }

  /** The flag is set before publishing, so the pump and a settlement never both publish. */
  #publishRequestOnce(registration: Registration): Promise<boolean> {
    registration.requestPublished = true;
    return this.#emit(registration, registration.request);
  }

  /** Only to the generation captured at registration, and only while it is unsealed. */
  #emit(registration: Registration, event: ChatEvent<number>): Promise<boolean> {
    const { generation } = registration;
    if (generation === undefined || generation.sealed) {
      return Promise.resolve(true);
    }
    return this.#publish(registration.slot, event, generation);
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
