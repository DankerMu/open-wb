// Fake-upstream gate control for the UI walk: arm, release, delete and read one held gate.

export function controlOrigin(): string {
  const base = process.env.MODEL_UPSTREAM_BASE_URL;
  if (base === undefined || base.length === 0) {
    throw new Error("MODEL_UPSTREAM_BASE_URL is required for the UI walk gate");
  }
  return new URL(base).origin;
}

function controlHeaders(): Record<string, string> {
  const apiKey = process.env.MODEL_UPSTREAM_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error("MODEL_UPSTREAM_API_KEY is required for the UI walk gate");
  }
  return { authorization: `Bearer ${apiKey}` };
}

function gateUrl(origin: string, id: string, action?: "release"): string {
  const path = action === "release" ? `/__control/gates/${id}/release` : `/__control/gates/${id}`;
  return `${origin}${path}`;
}

export async function armGate(origin: string, id: string): Promise<void> {
  const response = await fetch(gateUrl(origin, id), {
    method: "POST",
    headers: controlHeaders(),
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`gate arm failed: ${response.status}`);
  }
}

export async function releaseGate(origin: string, id: string): Promise<void> {
  const response = await fetch(gateUrl(origin, id, "release"), {
    method: "POST",
    headers: controlHeaders(),
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`gate release failed: ${response.status}`);
  }
}

export async function deleteGate(origin: string, id: string): Promise<void> {
  try {
    await fetch(gateUrl(origin, id), { method: "DELETE", headers: controlHeaders() });
  } catch {
    /* finally must not hide the journey error */
  }
}

export async function gatePhase(origin: string, id: string): Promise<string> {
  const response = await fetch(gateUrl(origin, id), { headers: controlHeaders() });
  if (response.status < 200 || response.status >= 300) {
    return `status:${response.status}`;
  }
  const body: unknown = await response.json();
  if (body === null || typeof body !== "object" || !("phase" in body)) {
    return "missing-phase";
  }
  return String(body.phase);
}
