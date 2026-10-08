import type { ApiClient, ApiClientOptions, ApiError } from "./api.js";
import { hasExactlyKeys, isNonNegativeSafeInteger } from "./api-json.js";

/**
 * The body of a 201 from `POST /api/workspaces/:id/uploads`: where the file landed inside the
 * workspace, the name it was stored under and its size in bytes.
 */
export type UploadedFile = {
  path: string;
  name: string;
  size: number;
};

type UploadTransport = {
  isSuccessfulStatus(status: number): boolean;
  parseJsonResponse(
    response: Response,
    signal: AbortSignal | undefined,
    onUnauthorized: ApiClientOptions["onUnauthorized"],
  ): Promise<unknown>;
  requestFailed(status: number): ApiError;
};

function parseUploadedFile(value: unknown): UploadedFile | null {
  if (!hasExactlyKeys(value, ["path", "name", "size"])) {
    return null;
  }

  const { name, path, size } = value;
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    typeof name !== "string" ||
    name.length === 0 ||
    !isNonNegativeSafeInteger(size)
  ) {
    return null;
  }

  return { path, name, size };
}

function uploadEndpoint(workspaceId: string, name: string) {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/uploads?name=${encodeURIComponent(name)}`;
}

/**
 * The one request of `web/src/lib` that does not go through `fetch`, which has no upload progress.
 * The finished exchange is handed to the injected `parseJsonResponse` as a `Response`, so the
 * error envelope and the 401 notification are the ones of every other method.
 */
export function createUploadMethods(
  onUnauthorized: ApiClientOptions["onUnauthorized"],
  { isSuccessfulStatus, parseJsonResponse, requestFailed }: UploadTransport,
): Pick<ApiClient, "uploadFile"> {
  async function parseUpload(
    status: number,
    text: string,
    signal: AbortSignal | undefined,
  ): Promise<UploadedFile> {
    if (status === 0 || (isSuccessfulStatus(status) && status !== 201)) {
      throw requestFailed(status);
    }

    let response: Response;
    try {
      response = new Response(text, { status });
    } catch {
      // `Response` refuses a status outside 200–599 and a body on a null-body status.
      throw requestFailed(status);
    }

    const uploaded = parseUploadedFile(await parseJsonResponse(response, signal, onUnauthorized));
    if (!uploaded) {
      throw requestFailed(201);
    }

    return uploaded;
  }

  return {
    uploadFile(workspaceId, file, options) {
      const signal = options?.signal;
      const onProgress = options?.onProgress;
      if (signal?.aborted) {
        return Promise.reject(requestFailed(0));
      }

      return new Promise<UploadedFile>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const abort = () => xhr.abort();
        const settled = () => signal?.removeEventListener("abort", abort);

        xhr.upload.addEventListener("progress", (event) => {
          const { lengthComputable, loaded, total } = event as ProgressEvent;
          if (lengthComputable && total !== 0) {
            onProgress?.(Math.floor((loaded / total) * 100));
          }
        });
        xhr.addEventListener("load", () => {
          settled();
          resolve(parseUpload(xhr.status, xhr.responseText, signal));
        });
        xhr.addEventListener("error", () => {
          settled();
          reject(requestFailed(0));
        });
        xhr.addEventListener("abort", () => {
          settled();
          reject(requestFailed(0));
        });
        signal?.addEventListener("abort", abort);

        xhr.open("POST", uploadEndpoint(workspaceId, file.name));
        xhr.setRequestHeader("Content-Type", "application/octet-stream");
        xhr.send(file);
      });
    },
  };
}
