/** Conservative renderer-memory limits; chunking does not avoid whole-file reads. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_CONTENT_LENGTH = Math.ceil(MAX_FILE_BYTES / 3) * 4;
export const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;

export function assertFileSize(size: number, path: string): void {
  if (!Number.isFinite(size) || size < 0 || size > MAX_FILE_BYTES) {
    throw new Error(`File ${path} exceeds Sink's 20 MiB safety limit or has an invalid size`);
  }
}

/** Reject non-canonical paths and never sync runtime state or Sink itself. */
export function isSyncPathAllowed(path: string, configDir: string, syncConfig: boolean): boolean {
  if (!path || path.includes("\\") || path.includes("\0") || path.startsWith("/") || /^[a-z]:/i.test(path)) return false;
  if (path.split("/").some((part) => !part || part === "." || part === "..")) return false;
  if (path === configDir || path.startsWith(`${configDir}/`)) {
    const relative = path.slice(configDir.length + 1);
    if (!syncConfig) return false;
    if (/^(workspace(?:-mobile)?\.json|community-plugins\.json|core-plugins(?:-migration)?\.json)$/i.test(relative)) return false;
    if (relative === "plugins/sink" || relative.startsWith("plugins/sink/")) return false;
  }
  return true;
}

/** Avoid one string node per byte; blocks are aligned to base64's three-byte groups. */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const blocks: string[] = [];
  const blockSize = 3 * 8192;
  for (let offset = 0; offset < bytes.length; offset += blockSize) {
    blocks.push(btoa(String.fromCharCode(...bytes.subarray(offset, offset + blockSize))));
  }
  return blocks.join("");
}