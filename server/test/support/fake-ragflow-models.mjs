/**
 * 假 RAGFlow 的模型路由（`fake-ragflow.mjs` 的兄弟文件，design D17、D7）：提供方、实例、实例的模型列表与账号缺省模型，
 * 协议全部抄自实测记录 §11，`embedding_model` 的引用校验抄自 §4.4。
 *
 * 只有 §11 实测用的一个提供方。`PUT /providers` 的未知名字回 `code:0` 但不进列表（§11.4），所以实例路由上它是
 * `provider '…' does not exist`，没先 `PUT` 的已知提供方同样如此：夹具不能比下发序列宽松。
 *
 * 记录里没有的行为落到未知路由，不猜（处理函数返回 `undefined`）：
 * - 清空账号缺省：`PATCH /models/default` 只带 `model_type`，或任一名字缺失、为空串。D7 的不变量靠这一点断言。
 *   空 body 同样如此，§11.4 的 HTTP 400 只对带了名字而没带 `model_type` 的请求。
 * - 删除模型配置：`/providers` 下的 `DELETE` 一律没有路由。
 * - 单实例 `GET`：明文回显密钥（§11.1），客户端不提供，夹具也不提供。
 * - `PUT` 实例时 `model_info` 里缺了已有模型：效果没有测过（design D7）。
 * - 字段类型不对的建实例、改实例，建实例时 `api_key` 为空串，`PUT` 改实例名。
 *
 * 外推，记录里没有原文，用例不要钉死：
 * - 三处只记了 code 的 message：`code:400` 的两行（§11.4）、`PUT` 不存在的实例的 `code:404`。
 * - 引用实例不存在的 `embedding_model`：§4.4 只测过两段式查 `default` 实例，这里沿用它的 message。
 * - `model_id` 等 id 字段的取值。
 * - `model_info` 的同名项 upsert：§11.4 只记了「增一项」，同名项更新 `model_type`、`max_tokens` 没有记录。
 */
import { randomBytes } from "node:crypto";
import { failure, success } from "./fake-ragflow-script.mjs";

export const API = "/api/v1";
const PROVIDER = "OpenAI-API-Compatible";
const EMBEDDING_FORMAT = "embedding model identifier must follow <model_name>@<provider> format";
/** §11.2：`model_type` 的取值。 */
const DEFAULT_TYPES = ["chat", "embedding"];
/** §11.4 只测过含空格等的实例名被拒，合法字符的边界没有测过。 */
const INSTANCE_NAME = /^\S+$/u;

const newId = () => randomBytes(16).toString("hex");
const httpFailure = (status, message) => ({ status, ...failure(status, message) });

export function createModelState() {
  return {
    providers: new Set(),
    /** 实例名到 `{id, apiKey, baseUrl, models}`，`models` 是模型名到 `{id, modelType, maxTokens}`。 */
    instances: new Map(),
    /** `model_type` 到 `{instance, name}`。 */
    defaults: new Map(),
  };
}

function modelEntry(item, previous) {
  return {
    id: previous?.id ?? newId(),
    modelType: item.model_type,
    maxTokens: item.max_tokens,
  };
}

/** `model_info` 的项：模型名到它的三个字段；不是记录里的形状时为 `undefined`。 */
function parsedInfo(info) {
  if (!Array.isArray(info) || info.length === 0) {
    return undefined;
  }
  const items = info.filter(
    (item) =>
      typeof item?.model_name === "string" &&
      item.model_name !== "" &&
      Array.isArray(item.model_type) &&
      typeof item.max_tokens === "number",
  );
  return items.length === info.length
    ? new Map(items.map((item) => [item.model_name, item]))
    : undefined;
}

function addInstance(models, name, fields) {
  const instance = { id: newId(), models: new Map(), ...fields };
  models.instances.set(name, instance);
  return instance;
}

function mergeInfo(instance, info) {
  for (const [name, item] of info) {
    instance.models.set(name, modelEntry(item, instance.models.get(name)));
  }
}

function putProvider(state, request) {
  const name = request.body.provider_name;
  if (typeof name !== "string") {
    return undefined;
  }
  if (name === PROVIDER) {
    state.models.providers.add(name);
  }
  return success(null);
}

function modelRows(models) {
  return [...models.instances].flatMap(([instanceName, instance]) =>
    [...instance.models].map(([name, model]) => ({
      instance_id: instance.id,
      instance_name: instanceName,
      model_id: model.id,
      model_type: model.modelType,
      name,
      provider_id: "provider-1",
      provider_name: PROVIDER,
      rank: 500,
      tenant_id: "tenant-1",
      tenant_name: "tenant",
    })),
  );
}

function listModels(state) {
  return success(modelRows(state.models));
}

function createInstance(state, request, [provider]) {
  const { models } = state;
  if (!models.providers.has(provider)) {
    return failure(404, `provider '${provider}' does not exist`);
  }
  const { instance_name: name, api_key: apiKey, base_url: baseUrl } = request.body;
  if (typeof name !== "string" || !INSTANCE_NAME.test(name)) {
    return failure(400, "invalid instance name");
  }
  if (models.instances.has(name)) {
    return failure(500, `fail to create model instance: instance ${name} already exists`);
  }
  const info = parsedInfo(request.body.model_info);
  if (info === undefined || typeof apiKey !== "string" || apiKey === "") {
    return undefined;
  }
  if (typeof baseUrl !== "string") {
    return undefined;
  }
  mergeInfo(addInstance(models, name, { apiKey, baseUrl }), info);
  return success(null);
}

function instanceOf(models, provider, name) {
  return models.providers.has(provider) ? models.instances.get(name) : undefined;
}

function updateInstance(state, request, [provider, name]) {
  const instance = instanceOf(state.models, provider, name);
  if (instance === undefined) {
    return failure(404, "instance not found");
  }
  const {
    instance_name: named,
    api_key: apiKey,
    base_url: baseUrl,
    model_info: raw,
  } = request.body;
  if (raw === undefined) {
    return httpFailure(400, "model_info is required");
  }
  const info = parsedInfo(raw);
  const typed = named === name && typeof apiKey === "string" && typeof baseUrl === "string";
  if (info === undefined || !typed || [...instance.models.keys()].some((key) => !info.has(key))) {
    return undefined;
  }
  // §11.4：空串不是保留，密钥被清空。
  Object.assign(instance, { apiKey, baseUrl });
  mergeInfo(instance, info);
  return success(null);
}

function instanceModels(state, _request, [provider, name]) {
  const instance = instanceOf(state.models, provider, name);
  if (instance === undefined) {
    return undefined;
  }
  return success(
    [...instance.models].map(([model, { modelType, maxTokens }]) => ({
      extra: { max_tokens: maxTokens },
      features: [],
      max_tokens: maxTokens,
      model_type: modelType,
      name: model,
      status: "active",
      verify: "unknown",
    })),
  );
}

function setDefaultModel(state, request) {
  const { models } = state;
  const { model_provider: provider, model_instance: name, model_name: model } = request.body;
  const type = request.body.model_type;
  if (type === undefined && Object.keys(request.body).length > 0) {
    return httpFailure(400, "model_type is required");
  }
  const named = [provider, name, model].every((part) => typeof part === "string" && part !== "");
  if (!named || !DEFAULT_TYPES.includes(type)) {
    return undefined; // 清空缺省没有路由（D7、D17）。
  }
  const entry = instanceOf(models, provider, name)?.models.get(model);
  if (entry === undefined) {
    return failure(100, `model ${model} isn't available`);
  }
  if (!entry.modelType.includes(type)) {
    return failure(100, `model ${model} isn't a ${type} model`);
  }
  models.defaults.set(type, { instance: name, name: model });
  return success({ models: [] });
}

function readDefaults(state) {
  const { models } = state;
  const rows = DEFAULT_TYPES.flatMap((type) => {
    const chosen = models.defaults.get(type);
    if (chosen === undefined) {
      return [];
    }
    return {
      model_provider: PROVIDER,
      model_instance: chosen.instance,
      model_name: chosen.name,
      model_id: models.instances.get(chosen.instance).models.get(chosen.name).id,
      model_type: type,
      enable: true,
    };
  });
  return success({ models: rows });
}

function referenceRejection(models, name, instanceName, provider) {
  if (!models.providers.has(provider)) {
    return failure(102, `provider "${provider}" lookup failed: record not found`);
  }
  const instance = models.instances.get(instanceName);
  if (instance === undefined) {
    return failure(
      102,
      `model configuration unavailable: instance "${instanceName}" lookup failed: record not found`,
    );
  }
  const model = instance.models.get(name);
  if (model === undefined) {
    return failure(102, `model configuration unavailable: model config not found: ${name}`);
  }
  return model.modelType.includes("embedding")
    ? undefined
    : failure(102, `${name} cannot be used as embedding model`);
}

/** §4.4 的表。两段式查名为 `default` 的实例；`models` 是 `createModelState()` 的状态。 */
export function embeddingRejection(model, models) {
  if (model === undefined) {
    return undefined;
  }
  const parts = String(model).split("@");
  const complete = parts.every((part) => part !== "");
  if (parts.length === 2 && complete) {
    return models.instances.has("default")
      ? undefined
      : failure(
          102,
          'model configuration unavailable: instance "default" lookup failed: record not found',
        );
  }
  return parts.length === 3 && complete
    ? referenceRejection(models, ...parts)
    : failure(102, EMBEDDING_FORMAT);
}

/** 用例的种子：账号里已有这个模型，不经下发。 */
export function seedModel(models, instanceName, name, modelType) {
  models.providers.add(PROVIDER);
  const instance =
    models.instances.get(instanceName) ??
    addInstance(models, instanceName, { apiKey: "seeded", baseUrl: "http://seeded.invalid/v1" });
  instance.models.set(name, { id: newId(), modelType: [modelType], maxTokens: 8192 });
}

/** 用例读状态的两个视图；上游密钥是 `PUT` 的结果（§11.4 的空串），所以 `instances` 带它。 */
export function modelViews(models) {
  return {
    instances: () =>
      [...models.instances].map(([name, { apiKey, baseUrl, models: entries }]) => ({
        name,
        apiKey,
        baseUrl,
        models: [...entries].map(([model, { modelType, maxTokens }]) => ({
          name: model,
          modelType,
          maxTokens,
        })),
      })),
    defaultModels: () =>
      [...models.defaults].map(([modelType, { instance, name }]) => ({
        modelType,
        instance,
        name,
      })),
  };
}

const segment = "([^/]+)";
const INSTANCES = `${API}/providers/${segment}/instances`;
/** `[方法, 路径, 处理函数]`，同 `fake-ragflow.mjs` 的 `ROUTES`。 */
export const MODEL_ROUTES = [
  ["PUT", `${API}/providers`, putProvider],
  ["GET", `${API}/models`, listModels],
  ["POST", INSTANCES, createInstance],
  ["PUT", `${INSTANCES}/${segment}`, updateInstance],
  ["GET", `${INSTANCES}/${segment}/models`, instanceModels],
  ["PATCH", `${API}/models/default`, setDefaultModel],
  ["GET", `${API}/models/default`, readDefaults],
];
