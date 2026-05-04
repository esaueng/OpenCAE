import type { RouteShorthandOptions } from "fastify";

const supportedUploadExtensions = new Set(["step", "stp", "stl", "obj"]);

export const projectsReadRateLimit = {
  config: {
    rateLimit: {
      max: 300,
      timeWindow: "1 minute"
    }
  }
} satisfies RouteShorthandOptions;

export const mutatingRateLimit = {
  config: {
    rateLimit: {
      max: 60,
      timeWindow: "1 minute"
    }
  }
} satisfies RouteShorthandOptions;

export function pdfFilename(name: string): string {
  const base = dashSlug(name, "opencae");
  return `${base}-report.pdf`;
}

export function sanitizeFilename(filename: unknown): string | undefined {
  if (typeof filename !== "string") return undefined;
  const name = lastPathComponent(filename.trim());
  const cleaned = replaceUnsafeFilenameCharacters(name);
  if (!cleaned) return undefined;
  const extension = extensionFor(cleaned);
  if (!extension || !supportedUploadExtensions.has(extension)) return undefined;
  return cleaned;
}

export function sanitizeProjectName(name: unknown): string | undefined {
  if (typeof name !== "string") return undefined;
  const cleaned = collapseWhitespace(name);
  return cleaned || undefined;
}

function dashSlug(value: string, fallback: string): string {
  const parts: string[] = [];
  let previousDash = false;
  let hasAlphaNumeric = false;
  for (const char of value) {
    if (isSlugChar(char)) {
      parts.push(char.toLowerCase());
      previousDash = false;
      if (isAsciiLetter(char) || isDigit(char)) hasAlphaNumeric = true;
    } else if (!previousDash && parts.length > 0) {
      parts.push("-");
      previousDash = true;
    }
  }
  while (parts[parts.length - 1] === "-") parts.pop();
  return hasAlphaNumeric ? parts.join("") : fallback;
}

function lastPathComponent(value: string): string {
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "/" || value[index] === "\\") start = index + 1;
  }
  return value.slice(start);
}

function replaceUnsafeFilenameCharacters(value: string): string {
  const chars: string[] = [];
  for (const char of value) {
    chars.push(isFilenameChar(char) ? char : "_");
  }
  return chars.join("");
}

function extensionFor(value: string): string | undefined {
  const dotIndex = value.lastIndexOf(".");
  if (dotIndex < 0 || dotIndex === value.length - 1) return undefined;
  return value.slice(dotIndex + 1).toLowerCase();
}

function collapseWhitespace(value: string): string {
  const parts: string[] = [];
  let pendingSpace = false;
  for (const char of value.trim()) {
    if (isWhitespace(char)) {
      pendingSpace = parts.length > 0;
    } else {
      if (pendingSpace) parts.push(" ");
      parts.push(char);
      pendingSpace = false;
    }
  }
  return parts.join("");
}

function isSlugChar(char: string): boolean {
  return isAsciiLetter(char) || isDigit(char) || char === "_" || char === "." || char === "-";
}

function isFilenameChar(char: string): boolean {
  return isAsciiLetter(char) || isDigit(char) || char === "_" || char === " " || char === "." || char === "-";
}

function isAsciiLetter(char: string): boolean {
  const code = char.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isDigit(char: string): boolean {
  const code = char.charCodeAt(0);
  return code >= 48 && code <= 57;
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f";
}
