/**
 * Step 3 of the pre-dispatch alignment (change s2c-kb-session D3; chat-sessions「派发前按会话设置对齐进程」,
 * omp-runtime「`kb_search` 的注册」): after `set_model` / `set_thinking_level`, before `prompt` (a
 * regenerate's `get_branch_messages`). Each generation records the bases it last registered (`Generation.
 * hostTools`, undefined on a new one: omp keeps no host tool across a spawn or a resume). Every
 * dispatch reads the owner's definition anew and sends `set_host_tools` only when it differs from the
 * record — `[]` when the definition is gone but bases are recorded; never a frame on a generation that
 * never had a definition. The definition source is the kb module's session search, injected by
 * `app.ts` (sessions does not import kb); the structural type is written here.
 */
import { isDeepStrictEqual } from "node:util";
import type { HostToolResult } from "./omp/host-tools.js";
import { AgentUnavailableError } from "./omp/process.js";
import { commandOn, KB_SEARCH, type Slot } from "./pool.js";

type Bases = readonly { id: string; name: string }[];

interface HostToolDefinition {
  tool: { name: string } & object;
  /** The bases the definition's description lists, in its order: what a generation records. */
  bases: Bases;
}

/** The kb module's session search, as sessions sees it (kb/session-search.ts is the other half). */
interface HostToolSource {
  /** The owner's `kb_search` definition, or null (knowledge base off or no base); local reads only. */
  definitionFor(ownerId: string): HostToolDefinition | null;
  execute(ownerId: string, args: unknown, signal: AbortSignal): Promise<HostToolResult>;
}

/** Read at each use: the assembly hands it over before the kb module is registered (late binding). */
export type HostToolPort = () => HostToolSource | undefined;

/** A throw of the source (a DB error) is a step-3 failure, like an unreadable `mcp.json` in step 1. */
function definitionOf(hostTools: HostToolPort | undefined, ownerId: string) {
  try {
    return hostTools?.()?.definitionFor(ownerId) ?? null;
  } catch (error) {
    const unavailable = new AgentUnavailableError("kb_search definition unavailable");
    unavailable.cause = error;
    throw unavailable;
  }
}

const sameBases = (recorded: Bases, bases: Bases): boolean =>
  recorded.length === bases.length &&
  recorded.every((base, index) => base.id === bases[index]?.id && base.name === bases[index]?.name);

/**
 * One `set_host_tools` on the slot; the answer must name exactly the tools sent, else the step fails
 * as `AgentUnavailableError` (a `success:false` already is, by `runtime.command`). The bases are
 * recorded only then, on the generation the command ran on, like `alignModel`'s applied values.
 */
async function register(slot: Slot, tools: readonly object[], bases: Bases): Promise<void> {
  const data = await commandOn(slot, { type: "set_host_tools", tools });
  const expected = tools.length === 0 ? [] : [KB_SEARCH];
  if (!isDeepStrictEqual((data as { toolNames?: unknown } | undefined)?.toolNames, expected)) {
    throw new AgentUnavailableError("set_host_tools answered other tool names");
  }
  if (slot.generation !== undefined) {
    slot.generation.hostTools = bases.map(({ id, name }) => ({ id, name }));
  }
}

/** Step 3 on a slot the dispatch holds; a rejection is the caller's pre-dispatch failure. */
export async function alignHostTools(
  slot: Slot,
  hostTools: HostToolPort | undefined,
  ownerId: string,
): Promise<void> {
  const definition = definitionOf(hostTools, ownerId);
  const recorded = slot.generation?.hostTools;
  if (definition === null) {
    if (recorded !== undefined && recorded.length > 0) {
      await register(slot, [], []);
    }
    return;
  }
  if (recorded === undefined || !sameBases(recorded, definition.bases)) {
    await register(slot, [definition.tool], definition.bases);
  }
}
