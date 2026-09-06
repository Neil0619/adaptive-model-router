import { win32 } from "node:path";

const POWERSHELL_ARGUMENTS = " -NoLogo -NoProfile -NonInteractive -EncodedCommand ";

export function isNodeCommand(command) {
  return typeof command === "string" && /^(?:.*[\\/])?node(?:\.exe)?$/iu.test(command);
}

export function windowsPowerShellCommand(systemRoot = process.env.SystemRoot || "C:\\Windows") {
  const executable = win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  // The outer command must be a single literal token in both cmd.exe and
  // PowerShell. The Node path and program live inside the encoded script.
  if (!win32.isAbsolute(executable) || /[^\p{L}\p{N}_:./\\-]/u.test(executable)) {
    throw new Error("Windows system PowerShell path is not a safe command token");
  }
  return executable;
}

export function parseHookNodeCommand(command) {
  if (typeof command !== "string") throw new Error("Hook command is invalid");
  const separator = command.indexOf(POWERSHELL_ARGUMENTS);
  if (separator >= 0) {
    const shell = command.slice(0, separator);
    if (win32.normalize(shell).toLowerCase() !== windowsPowerShellCommand().toLowerCase()) {
      throw new Error("Hook command does not use the Windows system PowerShell");
    }
    const encoded = command.slice(separator + POWERSHELL_ARGUMENTS.length);
    if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) throw new Error("Hook command encoding is invalid");
    const decoded = Buffer.from(encoded, "base64").toString("utf16le");
    if (Buffer.from(decoded, "utf16le").toString("base64") !== encoded) {
      throw new Error("Hook command encoding is not canonical");
    }
    const match = /^& '((?:[^']|'')+)'(?=\s)/u.exec(decoded);
    const executable = match?.[1].replaceAll("''", "'");
    if (!match || !isNodeCommand(executable) || !win32.isAbsolute(executable)) {
      throw new Error("Hook command is not an absolute Node invocation");
    }
    return { executable, suffix: decoded.slice(match[0].length), windowsEncoded: true };
  }
  const match = /^(?:"([^"]+)"|'([^']+)'|(\S+))(?=\s)/u.exec(command);
  const executable = match?.[1] || match?.[2] || match?.[3];
  if (!match || !isNodeCommand(executable)) throw new Error("Hook command is not a recognized Node executable");
  return { executable, suffix: command.slice(match[0].length), windowsEncoded: false };
}

export function renderHookNodeCommand(executable, suffix, { platform = process.platform } = {}) {
  if (!isNodeCommand(executable) || /["\r\n\0]/u.test(executable) || !/^\s/u.test(suffix)) {
    throw new Error("Hook Node invocation is invalid");
  }
  if (platform !== "win32") return `"${executable}"${suffix}`;
  if (!win32.isAbsolute(executable)) throw new Error("Windows Hook Node path must be absolute");
  // Codex dispatches hooks through the task shell, which may be PowerShell.
  // A quoted executable alone is an expression there, not a command. Use a
  // fixed system shell and a literal call operator without relying on PATH.
  const script = `& '${executable.replaceAll("'", "''")}'${suffix}`;
  return `${windowsPowerShellCommand()}${POWERSHELL_ARGUMENTS}${Buffer.from(script, "utf16le").toString("base64")}`;
}
