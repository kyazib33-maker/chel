import * as SecureStore from "expo-secure-store";

const CONNECTION_KEY = "chel.remote-connection.v1";

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
  // Chel only talks to the computer through Tailscale (100.64.0.0/10).
  const isTailscale = isIpv4 && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
  if (!isTailscale) {
    throw new Error("Esse código não é de um endereço Tailscale. Ligue o Tailscale no PC e no celular e gere um código novo.");
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
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Normalizes what the user typed: "chel 7k2q-9f4m…" → "CHEL-7K2Q-9F4M-…". */
export function formatShortCode(input: string): string {
  const body = input.toUpperCase().replace(/^CHEL/, "").replace(/[^0-9A-Z]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0").slice(0, 16);
  const groups = body.match(/.{1,4}/g) ?? [];
  return groups.length ? `CHEL-${groups.join("-")}` : "";
}

/** "CHEL-XXXX-XXXX-XXXX-XXXX" carries the PC address, port and a one-time secret. */
export function decodeShortCode(code: string): { endpoint: string; secret: string } {
  const body = formatShortCode(code).replace(/^CHEL-/, "").replace(/-/g, "");
  if (body.length !== 16) throw new Error("O código tem 16 letras/números depois de CHEL-.");
  let bits = 0; let value = 0; const bytes: number[] = [];
  for (const ch of body) {
    const v = CROCKFORD.indexOf(ch);
    if (v < 0) throw new Error("Código inválido.");
    value = (value << 5) | v; bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((value >> bits) & 0xff); value &= (1 << bits) - 1; }
  }
  if (bytes.length < 10) throw new Error("Código incompleto.");
  const [a, b, c, d, p1, p2, ...secret] = bytes;
  const endpoint = validateHostEndpoint(`http://${a}.${b}.${c}.${d}:${(p1 << 8) | p2}`);
  return { endpoint, secret: secret.slice(0, 4).map((x) => x.toString(16).padStart(2, "0")).join("") };
}

/** Pairs using the short code typed by the user. */
export async function pairWithCode(code: string, deviceName: string): Promise<RemoteConnection> {
  const { endpoint, secret } = decodeShortCode(code);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6_000);
  try {
    const response = await fetch(`${endpoint}/api/v1/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairing_code: secret, device_name: deviceName }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.error?.message ?? `Erro ${response.status}`);
    const connection: RemoteConnection = { endpoint, device_id: body.device_id, device_token: body.device_token, paired_at: new Date().toISOString() };
    await SecureStore.setItemAsync(CONNECTION_KEY, JSON.stringify(connection));
    return connection;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error("O computador não respondeu. Confira se o Tailscale está ligado no celular e no PC, e se o Chel está aberto.");
    throw error;
  } finally { clearTimeout(timeout); }
}
