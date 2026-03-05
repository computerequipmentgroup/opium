import { randomBytes, createCipheriv, createDecipheriv } from "crypto";
import bcrypt from "bcrypt";
import { config } from "../config.js";

const API_KEY_PREFIX = "op_";
const API_KEY_LENGTH = 32; // 32 hex chars = 128 bits

/**
 * Generate a new API key with prefix
 * Format: op_<32 random hex chars>
 */
export function generateApiKey(): string {
  const randomPart = randomBytes(API_KEY_LENGTH / 2).toString("hex");
  return `${API_KEY_PREFIX}${randomPart}`;
}

/**
 * Extract the prefix (first 8 chars) from an API key for identification
 */
export function getApiKeyPrefix(apiKey: string): string {
  return apiKey.substring(0, 8);
}

/**
 * Hash an API key using bcrypt
 */
export async function hashApiKey(apiKey: string): Promise<string> {
  return bcrypt.hash(apiKey, config.apiKeySaltRounds);
}

/**
 * Verify an API key against a hash
 */
export async function verifyApiKey(
  apiKey: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(apiKey, hash);
}

/**
 * Encrypt a string using AES-256-GCM
 * Used for storing OAuth tokens
 */
export function encrypt(text: string): string {
  const key = Buffer.from(config.encryptionKey.padEnd(32, "0").slice(0, 32));
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", key, iv);

  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");

  const authTag = cipher.getAuthTag();

  // Return iv:authTag:encrypted
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
}

/**
 * Decrypt a string encrypted with encrypt()
 */
export function decrypt(encryptedText: string): string {
  const parts = encryptedText.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted text format");
  }

  const [ivHex, authTagHex, encrypted] = parts;
  if (!ivHex || !authTagHex || !encrypted) {
    throw new Error("Invalid encrypted text format");
  }

  const key = Buffer.from(config.encryptionKey.padEnd(32, "0").slice(0, 32));
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}

/**
 * Generate a random string for PKCE code verifier
 */
export function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Generate code challenge from code verifier (SHA-256, base64url)
 */
export async function generateCodeChallenge(
  codeVerifier: string
): Promise<string> {
  const { createHash } = await import("crypto");
  const hash = createHash("sha256").update(codeVerifier).digest();
  return hash.toString("base64url");
}
