// change chat-interleaved-segments 切片 6（issue 1475）：chat-web「助手消息分段」的切段函数。seam：纯函数
// `segmentMessage`，以及实时归约（`applyChatEvent`）与快照（`chatStateFromSnapshot`）两条路径各自生成的视图。
// 期望值取自规格场景的字面量；分叉与撤回两例的夹具取自服务端 3.9 的测试读出的库行值
// （`server/test/store-segments.test.ts`「拷贝分段位置」、`server/test/session-store-undo-transaction.test.ts`
// 「撤回连带删除分段数据」）。
import { describe, expect, it } from "vitest";
import {
  type MessageSegment,
  type SegmentSource,
  segmentMessage,
} from "../src/features/chat/message-segments.js";
import {
  applyChatEvent,
  type ChatEvent,
  type ChatState,
  chatStateFromSnapshot,
} from "../src/features/chat/stream.js";
import type { ChatStepView } from "../src/features/chat/stream-steps.js";
import type { ChatMessageSnapshot } from "../src/lib/session-contract.js";
import type { ChatThinkingSegment } from "../src/lib/session-contract-segments.js";
import { chatSnapshot } from "./chat-stream-support.js";

type Segment = ChatThinkingSegment;

function stepAt(id: number, name: string, bodyOffset: number | null): ChatStepView {
  return { id, name, detail: "", output: "", changes: null, status: "done", bodyOffset };
}

function segment(
  bodyOffset: number,
  thinkingOffset: number,
  thinkingLength: number | null,
  stepsBefore: number,
  thinkingMs: number | null,
): Segment {
  return { bodyOffset, thinkingOffset, thinkingLength, stepsBefore, thinkingMs };
}

function source(fields: Partial<SegmentSource>): SegmentSource {
  return {
    content: "",
    thinking: null,
    status: "done",
    thinkingActive: false,
    steps: [],
    thinkingSegments: [],
    ...fields,
  };
}

/** 一块的可读形状：正文与思考取原文，思考另带时长与是否进行中，工具段取步骤名。 */
function shape(block: MessageSegment) {
  switch (block.kind) {
    case "text":
      return ["text", block.text];
    case "thinking":
      return ["thinking", block.text, block.thinkingMs, block.active];
    default:
      return ["tool", block.steps.map((step) => step.name)];
  }
}

function shapes(message: SegmentSource) {
  const blocks = segmentMessage(message);
  return blocks === null ? null : blocks.map(shape);
}

const READ = stepAt(31, "read", 5);
const BASH = stepAt(32, "bash", 5);
const INTERLEAVED = source({
  content: "先看一下。看完了。",
  thinking: "想",
  steps: [READ, BASH],
  thinkingSegments: [segment(5, 0, 1, 2, 800)],
});

describe("chat-web「助手消息分段」：交替切段", () => {
  it("stepsBefore 2：正文段、工具段 [read, bash]、思考段（800，不在进行中）、正文段", () => {
    expect(shapes(INTERLEAVED)).toEqual([
      ["text", "先看一下。"],
      ["tool", ["read", "bash"]],
      ["thinking", "想", 800, false],
      ["text", "看完了。"],
    ]);
  });

  it("stepsBefore 改为 1：正文段、工具段 [read]、思考段、工具段 [bash]、正文段", () => {
    const message = { ...INTERLEAVED, thinkingSegments: [segment(5, 0, 1, 1, 800)] };

    expect(shapes(message)).toEqual([
      ["text", "先看一下。"],
      ["tool", ["read"]],
      ["thinking", "想", 800, false],
      ["tool", ["bash"]],
      ["text", "看完了。"],
    ]);
  });

  it("块键按种类加前缀：正文段取起点偏移、思考段取 thinkingOffset、工具段取第一个步骤 id", () => {
    expect(segmentMessage(INTERLEAVED)?.map((block) => block.key)).toEqual([
      "text:0",
      "tool:31",
      "thinking:0",
      "text:5",
    ]);
  });

  it("先思考后正文的消息里块键互不相同（思考段与第一个正文段的偏移都是 0）", () => {
    const keys = segmentMessage(
      source({ content: "答", thinking: "想", thinkingSegments: [segment(0, 0, 1, 0, 300)] }),
    )?.map((block) => block.key);

    expect(keys).toEqual(["thinking:0", "text:0"]);
    expect(new Set(keys).size).toBe(2);
  });

  it("思考段的进行中：末段、长度为 null、消息 running 且 thinkingActive；缺一不可", () => {
    const open = source({
      content: "先看一下。",
      thinking: "想",
      status: "running",
      thinkingActive: true,
      thinkingSegments: [segment(5, 0, null, 0, null)],
    });

    expect(shapes(open)).toEqual([
      ["text", "先看一下。"],
      ["thinking", "想", null, true],
    ]);
    expect(shapes({ ...open, status: "failed" })?.[1]).toEqual(["thinking", "想", null, false]);
    expect(shapes({ ...open, thinkingActive: false })?.[1]).toEqual([
      "thinking",
      "想",
      null,
      false,
    ]);
  });
});

describe("chat-web「助手消息分段」：空白与空思考不分隔工具段", () => {
  it("content 为 \\n\\n、两个步骤的 bodyOffset 为 0 与 2：只有一个含两个步骤的工具段", () => {
    const message = source({
      content: "\n\n",
      steps: [stepAt(1, "read", 0), stepAt(2, "bash", 2)],
    });

    expect(shapes(message)).toEqual([["tool", ["read", "bash"]]]);
  });

  it("两个步骤之间有一段 thinkingLength 为 0 的思考段：只有一个含两个步骤的工具段", () => {
    const message = source({
      steps: [stepAt(1, "read", 0), stepAt(2, "bash", 0)],
      thinkingSegments: [segment(0, 0, 0, 1, 40)],
    });

    expect(shapes(message)).toEqual([["tool", ["read", "bash"]]]);
  });
});

describe("chat-web「助手消息分段」：旧布局判定", () => {
  const twoSteps = [stepAt(1, "read", 2), stepAt(2, "bash", 4)];
  const legacy: Array<[string, Partial<SegmentSource>]> = [
    ["一个步骤的 bodyOffset 为 null", { steps: [stepAt(1, "read", 2), stepAt(2, "bash", null)] }],
    ["thinking 为 想 而 thinkingSegments 为 []", { thinking: "想" }],
    [
      "两段思考的第二段 thinkingOffset 与第一段的结尾不相接",
      { thinking: "想想想", thinkingSegments: [segment(0, 0, 1, 0, 1), segment(2, 2, 1, 0, 1)] },
    ],
    [
      "第一段 thinkingLength 为 null 而后面还有一段",
      {
        // 第二段与第一段（长度按 0 计）首尾相接、不越界：只有「开着的段不是末段」这一条不成立。
        thinking: "想",
        thinkingSegments: [segment(0, 0, null, 0, null), segment(2, 0, 1, 0, 1)],
      },
    ],
    [
      "stepsBefore 为 3 而只有 2 个步骤",
      { steps: twoSteps, thinking: "想", thinkingSegments: [segment(4, 0, 1, 3, 1)] },
    ],
    [
      "第二个步骤的 bodyOffset 小于第一个的",
      { steps: [stepAt(1, "read", 4), stepAt(2, "bash", 2)] },
    ],
    // 规则 3 的其余三条与规则 4 的思考段一侧（规格「旧布局判定」的条文）。
    [
      "第一段的 thinkingOffset 不为 0",
      { thinking: "想想", thinkingSegments: [segment(0, 1, 1, 0, 1)] },
    ],
    [
      "末段的 thinkingOffset 加其长度超过 thinking 的长度",
      { thinking: "想", thinkingSegments: [segment(0, 0, 2, 0, 1)] },
    ],
    [
      "stepsBefore 递减",
      {
        steps: twoSteps,
        thinking: "想想",
        thinkingSegments: [segment(4, 0, 1, 2, 1), segment(4, 1, 1, 1, 1)],
      },
    ],
    [
      "思考段排在偏移更大的步骤之后（合并后的偏移递减）",
      { steps: twoSteps, thinking: "想", thinkingSegments: [segment(1, 0, 1, 1, 1)] },
    ],
  ];

  it.each(legacy)("%s：旧布局", (_name, fields) => {
    expect(segmentMessage(source({ content: "一二三四五六", ...fields }))).toBeNull();
  });

  it("没有步骤、没有思考的消息：唯一的正文段", () => {
    expect(shapes(source({ content: "只有正文" }))).toEqual([["text", "只有正文"]]);
  });

  it("步骤 bodyOffset 为 12 而 content 只有 8 个码元：不判旧布局，工具段排在全部 8 个码元的正文之后", () => {
    const message = source({ content: "12345678", steps: [stepAt(1, "bash", 12)] });

    expect(shapes(message)).toEqual([
      ["text", "12345678"],
      ["tool", ["bash"]],
    ]);
  });

  it("越界的偏移先按末尾计再比较递减：步骤 12 之后的思考段 10 都按 8 计，不判旧布局", () => {
    const message = source({
      content: "12345678",
      thinking: "想",
      steps: [stepAt(1, "bash", 12)],
      thinkingSegments: [segment(10, 0, 1, 1, 200)],
    });

    expect(shapes(message)).toEqual([
      ["text", "12345678"],
      ["tool", ["bash"]],
      ["thinking", "想", 200, false],
    ]);
  });

  it("没有步骤、思考为 null 与空串、没有段：都不判旧布局（规则 2 只看非空的 thinking）", () => {
    expect(shapes(source({ content: "答", thinking: "" }))).toEqual([["text", "答"]]);
    expect(shapes(source({}))).toEqual([]);
  });
});

/** 事件序列上的视图：从一条空的 running 助手消息开始。 */
function running(): ChatState {
  return chatStateFromSnapshot(chatSnapshot({ content: "", assistantStatus: "running" }));
}

function emit(state: ChatState, type: ChatEvent["type"], data: Record<string, unknown>) {
  return applyChatEvent(state, { type, data: { messageId: 0, ...data } } as ChatEvent);
}

function assistantOf(state: ChatState) {
  const message = state.messages.find((candidate) => candidate.id === 0);
  if (!message) throw new Error("视图里没有消息 0");
  return message;
}

const CLOSED = {
  bodyOffset: 5,
  thinkingOffset: 0,
  thinkingLength: 1,
  stepsBefore: 0,
  thinkingMs: 600,
};
const APPROVAL = {
  approvalId: 7,
  tool: "bash",
  title: "Allow tool: bash",
  expiresAt: 9,
  stepId: null,
};
const STEP = { stepId: 21, name: "bash", detail: "ls", bodyOffset: 5, approvalId: 7 };
const AFTER_THINKING: Array<[ChatEvent["type"], Record<string, unknown>]> = [
  ["thinking.end", { thinkingMs: 600, segment: CLOSED }],
  ["approval.request", APPROVAL],
  ["step.start", STEP],
  ["approval.resolved", { approvalId: 7, decision: "allow" }],
  ["step.end", { stepId: 21, status: "done", output: "a.md" }],
  ["text.delta", { delta: "好了" }],
  ["turn.end", { status: "done" }],
];
const BEFORE_THINKING_END: Array<[ChatEvent["type"], Record<string, unknown>]> = [
  ["text.delta", { delta: "先看一下。" }],
  ["thinking.delta", { delta: "想" }],
];

/** 同一回合结束后的快照：与事件逐值一致。 */
function finishedSnapshot(): ChatMessageSnapshot {
  const base = chatSnapshot({ status: "done", assistantStatus: "done", content: "先看一下。好了" });
  const [user, reply] = base.messages as [
    ChatMessageSnapshot["messages"][number],
    ChatMessageSnapshot["messages"][number],
  ];
  return {
    ...base,
    messages: [
      user,
      {
        ...reply,
        thinking: "想",
        thinkingMs: 600,
        thinkingSegments: [CLOSED],
        steps: [
          {
            id: 21,
            ordinal: 0,
            name: "bash",
            detail: "ls",
            output: "a.md",
            status: "done",
            changes: null,
            bodyOffset: 5,
          },
        ],
        approvals: [
          {
            id: 7,
            tool: "bash",
            title: "Allow tool: bash",
            requestedAt: 1,
            expiresAt: 9,
            decision: "allow",
            stepId: 21,
          },
        ],
      },
    ],
  };
}

const EXPECTED_FINISHED = [
  ["text", "先看一下。"],
  ["thinking", "想", 600, false],
  ["tool", ["bash"]],
  ["text", "好了"],
];

describe("chat-web「助手消息分段」：实时与快照切段一致", () => {
  it("事件归约出的视图与快照视图逐块相等；过程中的每一个视图都不是旧布局", () => {
    let state = running();
    for (const [type, data] of [...BEFORE_THINKING_END, ...AFTER_THINKING]) {
      state = emit(state, type, data);
      expect(segmentMessage(assistantOf(state)), `${type} 之后`).not.toBeNull();
    }

    const live = segmentMessage(assistantOf(state));
    const fromSnapshot = segmentMessage(assistantOf(chatStateFromSnapshot(finishedSnapshot())));
    expect(live?.map(shape)).toEqual(EXPECTED_FINISHED);
    expect(fromSnapshot).toEqual(live);
  });

  it("思考段进行中读取的快照：正文段之后有一个进行中的思考段；续流到回合结束后与上例逐块相等", () => {
    const midway = chatSnapshot({ content: "先看一下。", assistantStatus: "running" });
    const reply = midway.messages[1] as ChatMessageSnapshot["messages"][number];
    midway.messages[1] = {
      ...reply,
      thinking: "想",
      thinkingSegments: [segment(5, 0, null, 0, null)],
    };

    let state = chatStateFromSnapshot(midway);
    expect(segmentMessage(assistantOf(state))?.map(shape)).toEqual([
      ["text", "先看一下。"],
      ["thinking", "想", null, true],
    ]);
    for (const [type, data] of AFTER_THINKING) {
      state = emit(state, type, data);
    }

    const finished = segmentMessage(assistantOf(chatStateFromSnapshot(finishedSnapshot())));
    expect(segmentMessage(assistantOf(state))).toEqual(finished);
  });
});

/**
 * 「逐块相等」：分叉出的副本步骤是新行、id 不同（服务端测试断言过），所以比较时去掉块键与步骤 id；
 * 正文段与思考段的键本来就相同。
 */
function withoutIds(message: SegmentSource) {
  return segmentMessage(message)?.map((block) =>
    block.kind === "tool"
      ? { kind: block.kind, steps: block.steps.map(({ id: _id, ...rest }) => rest) }
      : block,
  );
}

describe("turn-control「拷贝分段位置」与 message-undo「撤回连带删除分段数据」的 web 一半", () => {
  // store-segments.test.ts：步骤 bodyOffset 3 与 9（正文 abc + defghi），段 (0,0,4,120)、(9,4,null,null)。
  const forkSource = source({
    content: "abcdefghi",
    thinking: "想想想想",
    steps: [stepAt(11, "bash", 3), stepAt(12, "read", 9)],
    thinkingSegments: [segment(0, 0, 4, 0, 120), segment(9, 4, null, 2, null)],
  });

  it("分叉：源会话与副本（步骤是新行）经切段函数得到逐块相等的分段", () => {
    const copy = { ...forkSource, steps: [stepAt(51, "bash", 3), stepAt(52, "read", 9)] };

    expect(shapes(forkSource)).toEqual([
      ["thinking", "想想想想", 120, false],
      ["text", "abc"],
      ["tool", ["bash"]],
      ["text", "defghi"],
      ["tool", ["read"]],
    ]);
    expect(withoutIds(copy)).toEqual(withoutIds(forkSource));
  });

  it("分叉：045 之前的消息（步骤 bodyOffset 为 null、没有段）源与副本都是旧布局", () => {
    const legacy = source({ content: "旧消息", steps: [stepAt(11, "bash", null)] });

    expect(segmentMessage(legacy)).toBeNull();
    expect(segmentMessage({ ...legacy, steps: [stepAt(51, "bash", null)] })).toBeNull();
  });

  it("撤回：a1 撤回前与撤回后逐值相同的段、步骤与 stepId 得到逐块相等的分段；零长度的末段不渲染", () => {
    // session-store-undo-transaction.test.ts：a1 正文 `assistant at 20 ✓`、思考 `想`，段 (0,0,1,300)、
    // (5,1,null,null)，bash 步骤 bodyOffset 5。
    const before = source({
      content: "assistant at 20 ✓",
      thinking: "想",
      steps: [stepAt(2, "bash", 5)],
      thinkingSegments: [segment(0, 0, 1, 0, 300), segment(5, 1, null, 1, null)],
    });
    const after = structuredClone(before);

    expect(shapes(before)).toEqual([
      ["thinking", "想", 300, false],
      ["text", "assis"],
      ["tool", ["bash"]],
      ["text", "tant at 20 ✓"],
    ]);
    expect(segmentMessage(after)).toEqual(segmentMessage(before));
  });
});
