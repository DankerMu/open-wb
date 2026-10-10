type WorkspaceEndpoint = "tree" | "dirs" | "file" | "promote" | "download";

/** Same-origin address of one endpoint of a workspace; the id is encoded as a single path segment. */
export function workspaceEndpoint(workspaceId: string, endpoint: WorkspaceEndpoint): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/${endpoint}`;
}

/**
 * Address the browser reads a workspace file from (`GET …/file?path=`). Builds the string only, no
 * request. The path is data: encoded whole, never normalised — the server's sandbox decides.
 */
export function fileUrl(workspaceId: string, path: string): string {
  return `${workspaceEndpoint(workspaceId, "file")}?path=${encodeURIComponent(path)}`;
}

/** Address a browser navigation downloads a workspace file from (`GET …/download?path=`). */
export function downloadUrl(workspaceId: string, path: string): string {
  return `${workspaceEndpoint(workspaceId, "download")}?path=${encodeURIComponent(path)}`;
}
