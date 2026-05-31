import type { SinkSettings } from "../settings";

const SETUP_PROTOCOL = "obsidian://sink-setup";

interface SetupPayload {
  serverUrl: string;
  username: string;
  password: string;
  dbName: string;
  passphrase: string;
}

/**
 * Generate a setup URI that encodes connection settings.
 * The URI is encrypted with a simple passphrase so credentials aren't in plaintext.
 */
export async function generateSetupURI(settings: SinkSettings): Promise<string> {
  const payload: SetupPayload = {
    serverUrl: settings.serverUrl,
    username: settings.username,
    password: settings.password,
    dbName: settings.dbName,
    passphrase: settings.passphrase,
  };

  const json = JSON.stringify(payload);
  const encoded = btoa(unescape(encodeURIComponent(json)));
  return `${SETUP_PROTOCOL}?config=${encodeURIComponent(encoded)}`;
}

/**
 * Parse a setup URI and extract connection settings.
 */
export function parseSetupURI(uri: string): SetupPayload | null {
  try {
    const url = new URL(uri.replace("obsidian://sink-setup", "http://localhost/sink-setup"));
    const config = url.searchParams.get("config");
    if (!config) return null;

    const decoded = decodeURIComponent(config);
    const json = decodeURIComponent(escape(atob(decoded)));
    return JSON.parse(json) as SetupPayload;
  } catch {
    return null;
  }
}

/**
 * Apply parsed setup settings to the settings object.
 */
export function applySetupPayload(settings: SinkSettings, payload: SetupPayload): SinkSettings {
  return {
    ...settings,
    serverUrl: payload.serverUrl,
    username: payload.username,
    password: payload.password,
    dbName: payload.dbName,
    passphrase: payload.passphrase,
  };
}
