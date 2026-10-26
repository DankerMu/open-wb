import { type Command, createCommandMethods, type ProjectConfigFile } from "./api-commands.js";
import {
  type ConnectorListing,
  type ConnectorView,
  type CreateConnectorInput,
  createConnectorMethods,
  type UpdateConnectorInput,
} from "./api-connectors.js";
import { createExpertMethods, type ExpertInput, type ExpertView } from "./api-experts.js";
import {
  type ArchiveListing,
  type CreateDirResult,
  type CreateWorkspaceInput,
  createFileMethods,
  type FilePreview,
  type MoveEntryInput,
  type PreviewToken,
  type Workspace,
  type WorkspaceList,
  type WorkspaceTree,
} from "./api-files.js";
import {
  hasExactlyKeys,
  isNonNegativeSafeInteger,
  isPlainJsonObject,
  parseJsonArray,
} from "./api-json.js";
import {
  type CreateModelInput,
  createModelMethods,
  type ModelView,
  type UpdateModelInput,
} from "./api-models.js";
import {
  type CreateMountInput,
  type CreateMountSourceInput,
  createMountMethods,
  type MountList,
  type MountSourceList,
  type MountSourceRow,
  type MountView,
} from "./api-mounts.js";
import {
  createSessionCapabilityMethods,
  type SessionCapabilities,
  type SessionCapabilitiesPatch,
} from "./api-session-capabilities.js";
import { createSessionMethods } from "./api-sessions.js";
import { createSkillMethods, type SkillList } from "./api-skills.js";
import { createUploadMethods, type UploadedFile } from "./api-upload.js";
import type { ComposerOptions } from "./composer-contract.js";
import type {
  ChatMessageSnapshot,
  ChatPromptAccepted,
  ChatRegenerateAccepted,
  ChatSession,
  ChatSessionFork,
  ChatSessionList,
  ChatSessionUndo,
  ChatSettledApproval,
} from "./session-contract.js";

export type Principal = {
  id: string;
  account: string;
  role: string;
};

export type ServiceInfo = {
  name: string;
  version: string;
  auth: { provider: string };
};

export type LoginCredentials = {
  account: string;
  password: string;
};

type AuditEvent = {
  id: number;
  ts: number;
  actorId: string;
  kind: string;
  title: string;
  detail: Record<string, unknown>;
  workspaceId: string | null;
};

type AuditList = {
  events: AuditEvent[];
};

type AuditFilter = {
  limit?: number;
  before?: string;
};

type ApiRequestOptions = {
  signal?: AbortSignal;
};

type ChatSessionScene = NonNullable<ChatSession["scene"]>;

/** 会话的三项输入框设置；只发送所给的键。 */
type ChatSessionComposerInput = {
  approvalMode?: ChatSession["approvalMode"];
  modelId?: string;
  reasoningEffort?: NonNullable<ChatSession["reasoningEffort"]>;
};

/**
 * 创建 input：只发送所给的键。`expertId` / `disabledSkills`（change s1d-experts-skills）与 `disabledConnectors`
 *（change s1d-connectors）是新会话的初始能力，不在会话视图的十四键里。
 */
type ChatSessionCreateInput = ChatSessionComposerInput & {
  workspaceId?: string;
  scene?: ChatSessionScene;
  expertId?: string;
  disabledSkills?: string[];
  disabledConnectors?: string[];
};

type ChatSessionPatch = ChatSessionComposerInput & {
  title?: string;
  scene?: ChatSessionScene;
  pinned?: boolean;
  archived?: boolean;
};

export type ApiClient = {
  getMe(options?: ApiRequestOptions): Promise<Principal>;
  getInfo(options?: ApiRequestOptions): Promise<ServiceInfo>;
  login(credentials: LoginCredentials, options?: ApiRequestOptions): Promise<Principal>;
  logout(options?: ApiRequestOptions): Promise<void>;
  listWorkspaces(options?: ApiRequestOptions): Promise<WorkspaceList>;
  createWorkspace(input: CreateWorkspaceInput, options?: ApiRequestOptions): Promise<Workspace>;
  promoteWorkspace(id: string, name: string, options?: ApiRequestOptions): Promise<Workspace>;
  listTree(workspaceId: string, path: string, options?: ApiRequestOptions): Promise<WorkspaceTree>;
  createDir(
    workspaceId: string,
    path: string,
    options?: ApiRequestOptions,
  ): Promise<CreateDirResult>;
  fetchPreview(
    workspaceId: string,
    path: string,
    options?: ApiRequestOptions,
  ): Promise<FilePreview>;
  issuePreviewToken(workspaceId: string, options?: ApiRequestOptions): Promise<PreviewToken>;
  moveEntry(
    workspaceId: string,
    input: MoveEntryInput,
    options?: ApiRequestOptions,
  ): Promise<{ path: string }>;
  deleteEntry(workspaceId: string, path: string, options?: ApiRequestOptions): Promise<void>;
  listArchive(
    workspaceId: string,
    path: string,
    options?: ApiRequestOptions,
  ): Promise<ArchiveListing>;
  listMounts(workspaceId: string, options?: ApiRequestOptions): Promise<MountList>;
  createMount(
    workspaceId: string,
    input: CreateMountInput,
    options?: ApiRequestOptions,
  ): Promise<MountView>;
  deleteMount(workspaceId: string, mountId: string, options?: ApiRequestOptions): Promise<void>;
  listMountSources(options?: ApiRequestOptions): Promise<MountSourceList>;
  createMountSource(
    input: CreateMountSourceInput,
    options?: ApiRequestOptions,
  ): Promise<MountSourceRow>;
  deleteMountSource(sourceId: string, options?: ApiRequestOptions): Promise<void>;
  listAudit(filter?: AuditFilter, options?: ApiRequestOptions): Promise<AuditList>;
  listSessions(options?: ApiRequestOptions): Promise<ChatSessionList>;
  createSession(input?: ChatSessionCreateInput, options?: ApiRequestOptions): Promise<ChatSession>;
  patchSession(
    sessionId: string,
    patch: ChatSessionPatch,
    options?: ApiRequestOptions,
  ): Promise<ChatSession>;
  deleteSession(sessionId: string, options?: ApiRequestOptions): Promise<void>;
  getMessages(sessionId: string, options?: ApiRequestOptions): Promise<ChatMessageSnapshot>;
  prompt(
    sessionId: string,
    message: string,
    options?: ApiRequestOptions & { attachments?: string[] },
  ): Promise<ChatPromptAccepted>;
  stopSession(sessionId: string, options?: ApiRequestOptions): Promise<"stopping" | "idle">;
  regenerateSession(
    sessionId: string,
    options?: ApiRequestOptions,
  ): Promise<ChatRegenerateAccepted>;
  forkSession(
    sessionId: string,
    messageId: number,
    options?: ApiRequestOptions,
  ): Promise<ChatSessionFork>;
  undoMessage(
    sessionId: string,
    messageId: number,
    files: "restore" | "force" | "keep",
    options?: ApiRequestOptions,
  ): Promise<ChatSessionUndo>;
  decideApproval(
    sessionId: string,
    approvalId: number,
    decision: "allow" | "deny",
    options?: ApiRequestOptions,
  ): Promise<ChatSettledApproval>;
  getComposerOptions(options?: ApiRequestOptions): Promise<ComposerOptions>;
  listCommands(workspaceId: string | null, options?: ApiRequestOptions): Promise<Command[]>;
  listProjectConfig(
    workspaceId: string | null,
    options?: ApiRequestOptions,
  ): Promise<ProjectConfigFile[]>;
  uploadFile(
    workspaceId: string,
    file: File,
    options?: { signal?: AbortSignal; onProgress?: (percent: number) => void },
  ): Promise<UploadedFile>;
  listModels(options?: ApiRequestOptions): Promise<ModelView[]>;
  createModel(input: CreateModelInput, options?: ApiRequestOptions): Promise<ModelView>;
  updateModel(id: string, input: UpdateModelInput, options?: ApiRequestOptions): Promise<ModelView>;
  deleteModel(id: string, options?: ApiRequestOptions): Promise<void>;
  setDefaultModel(id: string, options?: ApiRequestOptions): Promise<ModelView>;
  probeModel(id: string, options?: ApiRequestOptions): Promise<ModelView>;
  listExperts(options?: ApiRequestOptions): Promise<ExpertView[]>;
  createExpert(input: ExpertInput, options?: ApiRequestOptions): Promise<ExpertView>;
  updateExpert(id: string, input: ExpertInput, options?: ApiRequestOptions): Promise<ExpertView>;
  deleteExpert(id: string, options?: ApiRequestOptions): Promise<void>;
  listSkills(options?: ApiRequestOptions): Promise<SkillList>;
  putSkillDefaults(
    disabledSkills: readonly string[],
    options?: ApiRequestOptions,
  ): Promise<SkillList>;
  listConnectors(options?: ApiRequestOptions): Promise<ConnectorListing>;
  createConnector(input: CreateConnectorInput, options?: ApiRequestOptions): Promise<ConnectorView>;
  updateConnector(
    name: string,
    input: UpdateConnectorInput,
    options?: ApiRequestOptions,
  ): Promise<ConnectorView>;
  deleteConnector(name: string, options?: ApiRequestOptions): Promise<void>;
  probeConnector(name: string, options?: ApiRequestOptions): Promise<ConnectorView>;
  getConnectorDefaults(options?: ApiRequestOptions): Promise<string[]>;
  putConnectorDefaults(
    disabledConnectors: readonly string[],
    options?: ApiRequestOptions,
  ): Promise<string[]>;
  getSessionCapabilities(
    sessionId: string,
    options?: ApiRequestOptions,
  ): Promise<SessionCapabilities>;
  putSessionCapabilities(
    sessionId: string,
    patch: SessionCapabilitiesPatch,
    options?: ApiRequestOptions,
  ): Promise<SessionCapabilities>;
};

export type ApiClientOptions = {
  onUnauthorized?: (signal?: AbortSignal) => void | Promise<void>;
};

export const REQUEST_FAILED_MESSAGE = "请求失败，请稍后重试";
const REQUEST_FAILED_CODE = "request_failed";
const SERVICE_INFO_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

type ErrorEnvelope = {
  error: {
    code: string;
    message: string;
  };
};

function parsePrincipal(value: unknown): Principal | null {
  if (!hasExactlyKeys(value, ["id", "account", "role"])) {
    return null;
  }

  const { account, id, role } = value;
  if (typeof id !== "string" || typeof account !== "string" || typeof role !== "string") {
    return null;
  }

  return { id, account, role };
}

function parseServiceInfo(value: unknown): ServiceInfo | null {
  if (!hasExactlyKeys(value, ["name", "version", "auth"])) {
    return null;
  }

  const { auth, name, version } = value;
  if (typeof name !== "string" || name.length === 0 || typeof version !== "string") {
    return null;
  }

  if (!SERVICE_INFO_VERSION.test(version)) {
    return null;
  }

  if (!hasExactlyKeys(auth, ["provider"])) {
    return null;
  }

  const { provider } = auth;
  if (typeof provider !== "string" || provider.length === 0) {
    return null;
  }

  return { name, version, auth: { provider } };
}

function parseAuditEvent(value: unknown): AuditEvent | null {
  if (!hasExactlyKeys(value, ["id", "ts", "actorId", "kind", "title", "detail", "workspaceId"])) {
    return null;
  }

  const { actorId, detail, id, kind, title, ts, workspaceId } = value;
  if (
    !isNonNegativeSafeInteger(id) ||
    id === 0 ||
    !isNonNegativeSafeInteger(ts) ||
    typeof actorId !== "string" ||
    typeof kind !== "string" ||
    typeof title !== "string" ||
    !isPlainJsonObject(detail) ||
    (workspaceId !== null && typeof workspaceId !== "string")
  ) {
    return null;
  }

  return { id, ts, actorId, kind, title, detail, workspaceId };
}

function parseAuditList(value: unknown): AuditList | null {
  if (!hasExactlyKeys(value, ["events"])) {
    return null;
  }

  const events = parseJsonArray(value.events, parseAuditEvent);
  return events ? { events } : null;
}

function parseErrorEnvelope(value: unknown): ErrorEnvelope | null {
  if (!hasExactlyKeys(value, ["error"]) || !hasExactlyKeys(value.error, ["code", "message"])) {
    return null;
  }

  const { code, message } = value.error;
  if (typeof code !== "string" || typeof message !== "string") {
    return null;
  }

  return { error: { code, message } };
}

function requestFailed(status: number): ApiError {
  return new ApiError(status, REQUEST_FAILED_CODE, REQUEST_FAILED_MESSAGE);
}

function isSuccessfulStatus(status: number) {
  return status >= 200 && status < 300;
}

function requestOptions(signal?: AbortSignal): RequestInit {
  return {
    credentials: "same-origin",
    ...(signal ? { signal } : {}),
  };
}

function getRequestOptions(signal?: AbortSignal): RequestInit {
  return {
    ...requestOptions(signal),
    method: "GET",
    cache: "no-store",
  };
}

function notifyUnauthorized(
  onUnauthorized: ApiClientOptions["onUnauthorized"],
  signal: AbortSignal | undefined,
) {
  try {
    void Promise.resolve(onUnauthorized?.(signal)).catch(() => undefined);
  } catch {
    // The response contract must remain stable if a consumer callback fails.
  }
}

async function fetchResponse(path: string, options: RequestInit): Promise<Response> {
  try {
    return await fetch(path, options);
  } catch {
    throw requestFailed(0);
  }
}

async function parseJsonResponse(
  response: Response,
  signal: AbortSignal | undefined,
  onUnauthorized: ApiClientOptions["onUnauthorized"],
): Promise<unknown> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (response.status === 401) {
      notifyUnauthorized(onUnauthorized, signal);
    }

    throw requestFailed(response.status);
  }

  if (isSuccessfulStatus(response.status)) {
    return body;
  }

  const envelope = parseErrorEnvelope(body);
  if (!envelope) {
    if (response.status === 401) {
      notifyUnauthorized(onUnauthorized, signal);
    }

    throw requestFailed(response.status);
  }

  if (response.status === 401) {
    notifyUnauthorized(onUnauthorized, signal);
  }

  throw new ApiError(response.status, envelope.error.code, envelope.error.message);
}

async function request(
  path: string,
  options: RequestInit,
  onUnauthorized: ApiClientOptions["onUnauthorized"],
  expectedStatus?: number,
): Promise<unknown> {
  const response = await fetchResponse(path, options);
  if (
    expectedStatus !== undefined &&
    isSuccessfulStatus(response.status) &&
    response.status !== expectedStatus
  ) {
    throw requestFailed(response.status);
  }

  return parseJsonResponse(response, options.signal ?? undefined, onUnauthorized);
}

/** A request whose only success is 204: the body of a 204 is never read. */
async function noContentRequest(
  path: string,
  options: RequestInit,
  onUnauthorized: ApiClientOptions["onUnauthorized"],
): Promise<void> {
  const response = await fetchResponse(path, options);
  if (response.status === 204) {
    return;
  }

  if (isSuccessfulStatus(response.status)) {
    throw requestFailed(response.status);
  }

  await parseJsonResponse(response, options.signal ?? undefined, onUnauthorized);
  throw requestFailed(response.status);
}

export function createApiClient({ onUnauthorized }: ApiClientOptions = {}): ApiClient {
  const transport = {
    fetchResponse,
    getRequestOptions,
    isSuccessfulStatus,
    noContentRequest,
    parseJsonResponse,
    request,
    requestFailed,
    requestOptions,
  };
  return {
    ...createSessionMethods(onUnauthorized, transport),
    ...createFileMethods(onUnauthorized, transport),
    ...createMountMethods(onUnauthorized, transport),
    ...createCommandMethods(onUnauthorized, { getRequestOptions, request, requestFailed }),
    ...createUploadMethods(onUnauthorized, {
      isSuccessfulStatus,
      parseJsonResponse,
      requestFailed,
    }),
    ...createModelMethods(onUnauthorized, transport),
    ...createExpertMethods(onUnauthorized, transport),
    ...createSkillMethods(onUnauthorized, transport),
    ...createConnectorMethods(onUnauthorized, transport),
    ...createSessionCapabilityMethods(onUnauthorized, transport),
    async listAudit(filter, options) {
      const search = new URLSearchParams();
      if (filter?.limit !== undefined) {
        search.set("limit", String(filter.limit));
      }
      if (filter?.before !== undefined) {
        search.set("before", filter.before);
      }

      const query = search.toString();
      const response = await request(
        query.length === 0 ? "/api/audit" : `/api/audit?${query}`,
        getRequestOptions(options?.signal),
        onUnauthorized,
        200,
      );
      const audit = parseAuditList(response);
      if (!audit) {
        throw requestFailed(200);
      }

      return audit;
    },

    async getMe(options) {
      const response = await request(
        "/api/auth/me",
        getRequestOptions(options?.signal),
        onUnauthorized,
      );
      const principal = parsePrincipal(response);
      if (!principal) {
        throw requestFailed(200);
      }

      return principal;
    },

    async getInfo(options) {
      const response = await request(
        "/api/info",
        getRequestOptions(options?.signal),
        onUnauthorized,
        200,
      );
      const serviceInfo = parseServiceInfo(response);
      if (!serviceInfo) {
        throw requestFailed(200);
      }

      return serviceInfo;
    },

    async login(credentials, options) {
      const response = await request(
        "/api/auth/login",
        {
          ...requestOptions(options?.signal),
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ account: credentials.account, password: credentials.password }),
        },
        onUnauthorized,
      );
      const principal = parsePrincipal(response);
      if (!principal) {
        throw requestFailed(200);
      }

      return principal;
    },

    async logout(options) {
      await noContentRequest(
        "/api/auth/logout",
        { ...requestOptions(options?.signal), method: "POST" },
        onUnauthorized,
      );
    },
  };
}

export type {
  ConnectorListing,
  ConnectorSummary,
  ConnectorView,
  CreateConnectorInput,
  UpdateConnectorInput,
} from "./api-connectors.js";
export {
  EXPERT_CATEGORIES,
  type ExpertCategory,
  type ExpertInput,
  type ExpertView,
} from "./api-experts.js";
export { downloadUrl, fileUrl } from "./api-files.js";
export {
  type CreateModelInput,
  MODEL_EFFORTS,
  type ModelView,
  type UpdateModelInput,
} from "./api-models.js";
export type {
  CreateMountInput,
  CreateMountSourceInput,
  MountList,
  MountSourceList,
  MountSourceRow,
  MountView,
} from "./api-mounts.js";
export type { SessionCapabilities } from "./api-session-capabilities.js";
export type { SkillList } from "./api-skills.js";
