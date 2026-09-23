import type {
  ChatMessage,
  ChatMessageSnapshot,
  ChatSession,
  ChatStep,
} from "../../lib/session-contract.js";

type ChatStepView = {
  id: ChatStep["id"];
  name: ChatStep["name"];
  detail: ChatStep["detail"];
  status: ChatStep["status"];
};

type ChatMessageView = {
  id: ChatMessage["id"];
  role: ChatMessage["role"];
  content: ChatMessage["content"];
  status: ChatMessage["status"];
  steps: ChatStepView[];
  error: string | null;
};

export type ChatState = {
  status: ChatSession["status"];
  messages: ChatMessageView[];
};

export type ChatEvent =
  | { type: "turn.start"; data: { messageId: number } }
  | { type: "text.delta"; data: { messageId: number; delta: string } }
  | {
      type: "step.start";
      data: { messageId: number; stepId: number; name: string; detail: string };
    }
  | {
      type: "step.end";
      data: {
        messageId: number;
        stepId: number;
        status: "done" | "failed";
        detail: string;
      };
    }
  | { type: "turn.end"; data: { messageId: number; status: "done" | "failed" } }
  | { type: "error"; data: { messageId: number; message: string } };

export function chatStateFromSnapshot(snapshot: ChatMessageSnapshot): ChatState {
  return {
    status: snapshot.session.status,
    messages: snapshot.messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      status: message.status,
      steps: message.steps.map((step) => ({
        id: step.id,
        name: step.name,
        detail: step.detail,
        status: step.status,
      })),
      error: null,
    })),
  };
}

export function applyChatEvent(state: ChatState, event: ChatEvent): ChatState {
  switch (event.type) {
    case "turn.start":
      return replaceAssistant(
        state,
        event.data.messageId,
        (message) => ({
          id: message.id,
          role: "assistant",
          content: "",
          status: "running",
          steps: [],
          error: null,
        }),
        "running",
      );
    case "text.delta":
      return replaceAssistant(state, event.data.messageId, (message) => ({
        ...message,
        content: message.content + event.data.delta,
      }));
    case "step.start":
      return startStep(state, event.data);
    case "step.end":
      return endStep(state, event.data);
    case "error":
      return replaceAssistant(
        state,
        event.data.messageId,
        (message) => ({
          ...message,
          status: "failed",
          error: event.data.message,
        }),
        "running",
      );
    case "turn.end":
      return endTurn(state, event.data.messageId, event.data.status);
    default:
      return state;
  }
}

function startStep(
  state: ChatState,
  data: { messageId: number; stepId: number; name: string; detail: string },
): ChatState {
  return replaceAssistant(state, data.messageId, (message) => {
    if (message.steps.some((step) => step.id === data.stepId)) {
      return message;
    }
    return {
      ...message,
      steps: [
        ...message.steps,
        { id: data.stepId, name: data.name, detail: data.detail, status: "running" },
      ],
    };
  });
}

function endStep(
  state: ChatState,
  data: {
    messageId: number;
    stepId: number;
    status: "done" | "failed";
    detail: string;
  },
): ChatState {
  return replaceAssistant(state, data.messageId, (message) => {
    const index = message.steps.findIndex((step) => step.id === data.stepId);
    const current = index < 0 ? undefined : message.steps[index];
    if (current === undefined) {
      return message;
    }
    const steps = message.steps.slice();
    steps[index] = {
      id: current.id,
      name: current.name,
      detail: data.detail,
      status: data.status,
    };
    return { ...message, steps };
  });
}

function endTurn(state: ChatState, messageId: number, status: "done" | "failed"): ChatState {
  return replaceAssistant(
    state,
    messageId,
    (message) => ({
      ...message,
      status,
      error: status === "done" ? null : message.error,
      steps: message.steps.some((step) => step.status === "running")
        ? message.steps.map((step) => (step.status === "running" ? { ...step, status } : step))
        : message.steps,
    }),
    status,
  );
}

function emptyAssistant(messageId: number): ChatMessageView {
  return {
    id: messageId,
    role: "assistant",
    content: "",
    status: "running",
    steps: [],
    error: null,
  };
}

function replaceAssistant(
  state: ChatState,
  messageId: number,
  update: (message: ChatMessageView) => ChatMessageView,
  sessionStatus?: ChatSession["status"],
): ChatState {
  const index = state.messages.findIndex((message) => message.id === messageId);
  const current = index < 0 ? undefined : state.messages[index];
  if (current?.role === "user") {
    return state;
  }
  const source = current ?? emptyAssistant(messageId);
  const next = update(source);
  if (next === source && current !== undefined) {
    return sessionStatus === undefined || state.status === sessionStatus
      ? state
      : { ...state, status: sessionStatus };
  }
  if (next === source && current === undefined) {
    return state;
  }
  const messages = state.messages.slice();
  if (current === undefined) {
    messages.push(next);
  } else {
    messages[index] = next;
  }
  return {
    status: sessionStatus ?? state.status,
    messages,
  };
}
