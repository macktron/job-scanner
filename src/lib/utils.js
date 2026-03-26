import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export function nowIso() {
  return new Date().toISOString();
}

export function todayStamp() {
  return nowIso().slice(0, 10);
}

export async function ensureDir(dirPath) {
  await mkdir(dirPath, { recursive: true });
}

export async function readJson(filePath, fallback) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

export async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function normalizeWhitespace(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

export function stripHtml(html) {
  return normalizeWhitespace(
    String(html || "")
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, "\"")
      .replace(/&#39;/gi, "'")
  );
}

export function truncate(value, maxLength) {
  if (!value || value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}...`;
}

export function normalizeUrl(rawUrl) {
  if (!rawUrl) {
    return null;
  }

  try {
    const url = new URL(rawUrl);
    for (const key of [...url.searchParams.keys()]) {
      if (
        key.startsWith("utm_") ||
        key === "gh_jid" ||
        key === "gh_src" ||
        key === "trk"
      ) {
        url.searchParams.delete(key);
      }
    }

    if (!url.search) {
      url.search = "";
    }

    return url.toString();
  } catch {
    return rawUrl;
  }
}

export function hashString(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function uniqueBy(items, getKey) {
  const seen = new Map();
  for (const item of items) {
    seen.set(getKey(item), item);
  }
  return [...seen.values()];
}

export function extractJsonText(rawText) {
  if (!rawText) {
    throw new Error("OpenAI response was empty.");
  }

  const text = String(rawText).trim();
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch) {
    return fencedMatch[1].trim();
  }

  const arrayStart = text.indexOf("[");
  const objectStart = text.indexOf("{");
  const start =
    arrayStart === -1
      ? objectStart
      : objectStart === -1
        ? arrayStart
        : Math.min(arrayStart, objectStart);

  if (start === -1) {
    return text;
  }

  const slice = text.slice(start).trim();
  const opening = slice[0];
  const closing = opening === "[" ? "]" : "}";

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < slice.length; index += 1) {
    const char = slice[index];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === "\\") {
        escaped = true;
        continue;
      }

      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === opening) {
      depth += 1;
      continue;
    }

    if (char === closing) {
      depth -= 1;
      if (depth === 0) {
        return slice.slice(0, index + 1);
      }
    }
  }

  return slice;
}

export function buildJobFingerprint(job) {
  const key = [
    job.company_id || job.company || "",
    normalizeWhitespace(job.title || "").toLowerCase(),
    normalizeWhitespace(job.location || "").toLowerCase(),
    normalizeUrl(job.apply_url || job.source_url || "") || ""
  ].join("::");

  return hashString(key).slice(0, 24);
}

export function daysBetween(dateA, dateB) {
  const oneDay = 24 * 60 * 60 * 1000;
  return Math.floor((dateA.getTime() - dateB.getTime()) / oneDay);
}
