import * as SecureStore from "expo-secure-store";

const CONNECTION_KEY = "psylium.remote-connection.v1";

export interface HostPairingPayload {
  version: number;
  endpoints: string[];
  pairing_code: string;
  expires_at: string;
}

export interface RemoteConnection {
  endpoint: string;
  device_id: string;
  device_token: string;
  paired_at: string;
}

export interface RemoteEnvelope<T = unknown> {
  type: string;
  data?: T;
}

/** Only accept private/LAN or Tailscale addresses emitted by our Host QR. */
function validateHostEndpoint(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("Endpoint do QR inválido."); }

  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw new Error("O QR contém um endpoint não permitido.");
  }

  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const octets = host.split(".").map((part) => /^\d{1,3}$/.test(part) ? Number(part) : NaN);
  const isIpv4 = octets.length === 4 && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255);
  const isPrivateIpv4 = isIpv4 && (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127)
  );
  const isPrivateIpv6 = host.includes(":") && (host === "::1" || host.startsWith("fc") || host.startsWith("fd"));
  if (!isPrivateIpv4 && !isPrivateIpv6) {
    throw new Error("O endpoint precisa ser um IP privado da LAN ou Tailscale.");
  }
  return url.origin;
}

export async function pairWithHost(
  scannedPayload: string,
  deviceName: string,
): Promise<RemoteConnection> {
  const pairing = JSON.parse(scannedPayload) as HostPairingPayload;
  if (pairing.version !== 1 || !Array.isArray(pairing.endpoints) || pairing.endpoints.length === 0 || !pairing.pairing_code) {
    throw new Error("QR de pareamento inválido ou incompatível.");
  }
  const expiresAt = Date.parse(pairing.expires_at);
  if (!Number.isFinite(expiresAt)) throw new Error("O QR não informa uma expiração válida.");
  if (expiresAt <= Date.now()) {
    throw new Error("O QR de pareamento expirou. Gere outro no Desktop.");
  }

  const endpoints = [...new Set(pairing.endpoints.map(validateHostEndpoint))];
  const failures: string[] = [];
  for (const endpoint of endpoints) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(`${endpoint}/api/v1/pair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pairing_code: pairing.pairing_code, device_name: deviceName }),
        signal: controller.signal,
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
      const connection: RemoteConnection = {
        endpoint,
        device_id: body.device_id,
        device_token: body.device_token,
        paired_at: new Date().toISOString(),
      };
      await SecureStore.setItemAsync(CONNECTION_KEY, JSON.stringify(connection));
      return connection;
    } catch (error) {
      failures.push(`${endpoint}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(`Não foi possível parear com nenhum endereço anunciado. ${failures.join(" | ")}`);
}

export async function loadRemoteConnection(): Promise<RemoteConnection | null> {
  const value = await SecureStore.getItemAsync(CONNECTION_KEY);
  if (!value) return null;
  try {
    const connection = JSON.parse(value) as RemoteConnection;
    connection.endpoint = validateHostEndpoint(connection.endpoint);
    if (!connection.device_token || !connection.device_id) throw new Error("invalid connection");
    return connection;
  }
  catch {
    await SecureStore.deleteItemAsync(CONNECTION_KEY);
    return null;
  }
}

export async function forgetRemoteConnection(): Promise<void> {
  await SecureStore.deleteItemAsync(CONNECTION_KEY);
}

export async function remoteFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const connection = await loadRemoteConnection();
  if (!connection) throw new Error("Nenhum computador pareado.");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${connection.device_token}`);
  const controller = new AbortController();
  const externalSignal = init.signal;
  const abortFromCaller = () => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  else externalSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(() => controller.abort(), 12_000);
  let response: Response;
  try {
    response = await fetch(`${connection.endpoint}${path}`, { ...init, headers, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", abortFromCaller);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error?.message ?? `Falha HTTP ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function openRemoteSocket(
  lastSequence: number | null,
  onMessage: (message: RemoteEnvelope) => void,
  onClose?: () => void,
): Promise<WebSocket> {
  const connection = await loadRemoteConnection();
  if (!connection) throw new Error("Nenhum computador pareado.");
  const socketUrl = `${connection.endpoint.replace(/^http:/, "ws:").replace(/^https:/, "wss:")}/ws`;
  const socket = new WebSocket(socketUrl);
  socket.onopen = () => {
    socket.send(JSON.stringify({
      type: "authenticate",
      token: connection.device_token,
      last_sequence: lastSequence,
    }));
  };
  socket.onmessage = (event) => {
    try { onMessage(JSON.parse(String(event.data)) as RemoteEnvelope); }
    catch { /* Ignore malformed frames; the caller can request a fresh snapshot. */ }
  };
  socket.onclose = () => onClose?.();
  return socket;
}
