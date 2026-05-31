/**
 * E2E Encryption using Web Crypto API (AES-256-GCM).
 * Content is encrypted client-side before being stored in CouchDB.
 */
export class CryptoHelper {
  private passphrase: string;
  private keyCache: CryptoKey | null = null;

  constructor(passphrase: string) {
    this.passphrase = passphrase;
  }

  /** Derive an AES-256 key from the passphrase using PBKDF2 */
  private async getKey(): Promise<CryptoKey> {
    if (this.keyCache) return this.keyCache;

    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      encoder.encode(this.passphrase),
      "PBKDF2",
      false,
      ["deriveKey"]
    );

    // Use a fixed salt derived from the passphrase itself
    // This ensures all devices with the same passphrase derive the same key
    const salt = encoder.encode("sink-e2e-" + this.passphrase.slice(0, 8));

    this.keyCache = await crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: salt,
        iterations: 100000,
        hash: "SHA-256",
      },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );

    return this.keyCache;
  }

  /** Encrypt a string and return ciphertext + IV (both as base64) */
  async encrypt(plaintext: string): Promise<{ ciphertext: string; iv: string }> {
    const key = await this.getKey();
    const encoder = new TextEncoder();
    const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV for GCM

    const ciphertextBuffer = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      encoder.encode(plaintext)
    );

    return {
      ciphertext: this.bufferToBase64(ciphertextBuffer),
      iv: this.bufferToBase64(iv.buffer),
    };
  }

  /** Decrypt ciphertext using the provided IV */
  async decrypt(ciphertext: string, iv: string): Promise<string> {
    const key = await this.getKey();
    const decoder = new TextDecoder();

    const plaintextBuffer = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: this.base64ToBuffer(iv) },
      key,
      this.base64ToBuffer(ciphertext)
    );

    return decoder.decode(plaintextBuffer);
  }

  private bufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  private base64ToBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }
}
