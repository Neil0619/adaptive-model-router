import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

function contextKey(db) {
  const salt = db.prepare("SELECT value FROM meta WHERE key = 'local_salt'").get()?.value;
  if (typeof salt !== "string" || !salt) throw new Error("router context encryption key is unavailable");
  return createHash("sha256").update(`adaptive-router-context\0${salt}`).digest();
}

export function sealPrivateState(db, value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", contextKey(db), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["enc-v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(":");
}

export function openPrivateState(db, value) {
  const [version, iv, tag, encrypted, ...extra] = String(value || "").split(":");
  if (version !== "enc-v1" || !iv || !tag || !encrypted || extra.length) throw new Error("router context package encoding is invalid");
  const decipher = createDecipheriv("aes-256-gcm", contextKey(db), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
}
