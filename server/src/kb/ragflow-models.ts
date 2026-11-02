/**
 * RAGFlow 客户端的模型下发一块（`ragflow-client.ts` 的兄弟文件，s2a-kb-ragflow D7；实测记录 §11）：提供方、实例的建与改、
 * 实例与模型的列表、账号缺省的读与设。`modelCalls` 只在 `createRagflowClient` 里调用，`json` 经闭包参数交进来，这里拼不出
 * 别的路径：`GET …/instances/<实例>`（明文回显上游密钥）、清空账号缺省与 `/providers` 下的删除都没有写法。
 */
import {
  API,
  fieldOf,
  isNonEmptyString,
  type JsonCall,
  type Result,
  type Route,
  UNAVAILABLE,
  usable,
} from "./ragflow-route.js";

export const PROVIDER = "OpenAI-API-Compatible";
const INSTANCES = `${API}/providers/${PROVIDER}/instances`;

/** `model_info` 的一项（§11.1），键名就是线上的键名。 */
export interface ModelInfo {
  model_name: string;
  model_type: readonly string[];
  max_tokens: number;
}

interface ModelInstance {
  instanceName: string;
  /** 上游密钥。RAGFlow 按 trim 后的值写入，空值会清空实例密钥（§11.4），所以空串与纯空白都拒绝发出。 */
  apiKey: string;
  baseUrl: string;
  modelInfo: readonly ModelInfo[];
}

/** 语义对齐 RAGFlow 写入实例密钥时的 Go `strings.TrimSpace`：JS 的 `trim()` 不剥 U+0085，所以先去掉它。 */
export function isBlankApiKey(key: string): boolean {
  return key.replaceAll("\u0085", "").trim() === "";
}

/** 账号缺省（§11.2）：`model_name` 非空的那些 `model_type`。 */
const DEFAULT_MODELS: Route<string[], never> = {
  read(data) {
    const models = fieldOf(data, "models");
    if (!Array.isArray(models)) {
      return undefined;
    }
    const rows = models.map((row: unknown) => [
      fieldOf(row, "model_type"),
      fieldOf(row, "model_name"),
    ]);
    const typed = rows.every((cells) => cells.every((cell) => typeof cell === "string"));
    return typed
      ? rows.flatMap(([type, name]) => (name === "" ? [] : [type as string]))
      : undefined;
  },
};

/** 不读应答字段的下发路由（§11）：`PUT /providers`、实例的建与改、`PATCH /models/default`。 */
const ACKNOWLEDGED: Route<null, never> = { read: () => null };

/** 一行模型属于哪个实例；有实例就一定有行，系统从不删模型（D7）。 */
const MODEL_INSTANCES: Route<string[], never> = {
  read(data) {
    if (!Array.isArray(data)) {
      return undefined;
    }
    const rows = data.map((row: unknown) => ({
      provider: fieldOf(row, "provider_name"),
      instance: fieldOf(row, "instance_name"),
    }));
    const named = rows.every(
      ({ provider, instance }) => isNonEmptyString(provider) && isNonEmptyString(instance),
    );
    if (!named) {
      return undefined;
    }
    const ours = rows.filter(({ provider }) => provider === PROVIDER);
    return [...new Set(ours.map(({ instance }) => instance as string))];
  },
};

function modelInfoOf(row: unknown): ModelInfo | undefined {
  const name = fieldOf(row, "name");
  const type = fieldOf(row, "model_type");
  const maxTokens = fieldOf(row, "max_tokens");
  return isNonEmptyString(name) && Array.isArray(type) && typeof maxTokens === "number"
    ? { model_name: name, model_type: type as string[], max_tokens: maxTokens }
    : undefined;
}

/** 实例的模型列表，读成 `PUT` 实例要带回去的 `model_info` 项。 */
const INSTANCE_MODELS: Route<ModelInfo[], never> = {
  read(data) {
    if (!Array.isArray(data)) {
      return undefined;
    }
    const models = data.flatMap((row: unknown) => modelInfoOf(row) ?? []);
    return models.length === data.length ? models : undefined;
  },
};

const instanceBody = (instance: ModelInstance) => ({
  instance_name: instance.instanceName,
  api_key: instance.apiKey,
  base_url: instance.baseUrl,
  model_info: instance.modelInfo,
});

/** 客户端的模型下发方法；`json` 是 `createRagflowClient` 里的 JSON 调用。 */
export function modelCalls(json: JsonCall) {
  return {
    /** 只读，不改账号缺省：建 pipeline 之前的核对（D7）。 */
    readDefaultModels(signal?: AbortSignal): Promise<Result<string[]>> {
      return json("GET", `${API}/models/default`, DEFAULT_MODELS, undefined, signal);
    },

    async createModelInstance(instance: ModelInstance): Promise<Result<null>> {
      if (isBlankApiKey(instance.apiKey)) {
        return UNAVAILABLE;
      }
      return json("POST", INSTANCES, ACKNOWLEDGED, instanceBody(instance));
    },

    async updateModelInstance(instance: ModelInstance): Promise<Result<null>> {
      if (isBlankApiKey(instance.apiKey) || !usable(instance.instanceName)) {
        return UNAVAILABLE;
      }
      const name = encodeURIComponent(instance.instanceName);
      return json("PUT", `${INSTANCES}/${name}`, ACKNOWLEDGED, instanceBody(instance));
    },

    /** 幂等（§11.4）。 */
    ensureProvider(): Promise<Result<null>> {
      return json("PUT", `${API}/providers`, ACKNOWLEDGED, { provider_name: PROVIDER });
    },

    /** `GET /models`：账号在本系统提供方下的实例名。这个列表不含密钥，单实例 `GET` 才有（D4）。 */
    listModelInstances(): Promise<Result<string[]>> {
      return json("GET", `${API}/models`, MODEL_INSTANCES);
    },

    async listInstanceModels(instanceName: string): Promise<Result<ModelInfo[]>> {
      if (!usable(instanceName)) {
        return UNAVAILABLE;
      }
      const name = encodeURIComponent(instanceName);
      return json("GET", `${INSTANCES}/${name}/models`, INSTANCE_MODELS);
    },

    /** 把账号缺省切到这个模型。名字为空就是清空缺省的写法（§11.2、§13），这里拒绝发出。 */
    async setDefaultModel(target: {
      instanceName: string;
      modelName: string;
      modelType: "embedding" | "chat";
    }): Promise<Result<null>> {
      if (target.instanceName === "" || target.modelName === "") {
        return UNAVAILABLE;
      }
      return json("PATCH", `${API}/models/default`, ACKNOWLEDGED, {
        model_provider: PROVIDER,
        model_instance: target.instanceName,
        model_name: target.modelName,
        model_type: target.modelType,
      });
    },
  };
}
