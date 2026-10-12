import { createHash } from "node:crypto";

const MAX_GCODE_SIZE_BYTES = 50 * 1024 * 1024;
const ALLOWED_GCODE_EXTENSIONS = [".gcode", ".gco", ".gc", ".bgcode"] as const;

export const sanitizeFilename = (name: string) =>
  name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);

// Characters outside [\w.\-()] (e.g. "&") are rejected by Bambuddy's upload
// filename allowlist, so they become hyphens along with whitespace/underscores.
// Accents are transliterated first ("é" -> "e") so they aren't lost to hyphens.
const toHyphenSlug = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/[^\w.\-()]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");

// Bambu printers choke on long file names on their SD card / in the UI, so
// the whole name (including extension) is capped. Room is left for the
// "-v10" suffix resolveUniqueFilename may append.
export const MAX_PRINT_FILENAME_LENGTH = 64;
const VERSION_SUFFIX_RESERVE = 5;
const MAX_NAME_SEGMENT = 20;
const MAX_PROJECT_SEGMENT = 14;
const MIN_FILE_BASE = 10;

const truncate = (value: string, max: number) =>
  value.slice(0, Math.max(0, max)).replace(/[-.]+$/, "");

// Long names keep the first name and reduce the rest to initials
// ("Abbas-Quettawala-Longsurname" -> "Abbas-Q-L") before any hard cut.
const shortenPersonName = (slug: string) => {
  if (slug.length <= MAX_NAME_SEGMENT) return slug;
  const [first, ...rest] = slug.split("-");
  const abbreviated = [first, ...rest.map((p) => p[0])].join("-");
  return truncate(abbreviated, MAX_NAME_SEGMENT);
};

/**
 * Builds the {name}_{project}_{filename} print file name so downstream
 * systems (and humans) can split on "_" to recover uploader/project.
 * Spaces and underscores inside each segment become hyphens first so the
 * top-level underscores stay unambiguous delimiters. Unsupported characters
 * are replaced and the result is capped at MAX_PRINT_FILENAME_LENGTH: the
 * uploader and project are shortened first, then the original file's base
 * name, so the extension (and the file's identity) survive.
 */
export const buildPrintUploadFilename = (
  userName: string,
  projectName: string,
  originalFilename: string,
) => {
  const { base, ext } = splitFilenameExtension(toHyphenSlug(originalFilename));
  const budget =
    MAX_PRINT_FILENAME_LENGTH - VERSION_SUFFIX_RESERVE - ext.length;

  let name = shortenPersonName(toHyphenSlug(userName)) || "user";
  let project = truncate(toHyphenSlug(projectName), MAX_PROJECT_SEGMENT) || "x";
  // Two underscore separators.
  const room = () => budget - name.length - project.length - 2;
  if (base.length > room()) {
    // Shrink the labels further before touching the file's own name.
    const spare = Math.max(MIN_FILE_BASE, base.length) - room();
    const shrink = (v: string, by: number) =>
      truncate(v, v.length - by) || v[0];
    const each = Math.ceil(spare / 2);
    project = shrink(project, Math.min(each, project.length - 1));
    name = shrink(name, Math.min(spare - each, name.length - 1));
  }
  const fileBase = truncate(base, Math.max(MIN_FILE_BASE, room())) || "print";
  return `${name}_${project}_${fileBase}${ext}`;
};

/**
 * Splits a print upload filename back into its {name}, {project}, and
 * {file} segments. Returns null if the filename doesn't match the
 * name_project_file convention (e.g. a legacy pre-rename upload).
 */
export const parsePrintUploadFilename = (
  filename: string,
): { name: string; project: string; file: string } | null => {
  const parts = filename.split("_");
  if (parts.length < 3) return null;
  const [name, project, ...rest] = parts;
  return { name, project, file: rest.join("_") };
};

const splitFilenameExtension = (
  filename: string,
): { base: string; ext: string } => {
  const compound = /\.gcode\.3mf$/i.exec(filename);
  if (compound) {
    return {
      base: filename.slice(0, filename.length - compound[0].length),
      ext: filename.slice(filename.length - compound[0].length),
    };
  }
  const idx = filename.lastIndexOf(".");
  if (idx <= 0) return { base: filename, ext: "" };
  return { base: filename.slice(0, idx), ext: filename.slice(idx) };
};

export const appendVersionSuffix = (filename: string, version: number) => {
  const { base, ext } = splitFilenameExtension(filename);
  return `${base}-v${version}${ext}`;
};

/**
 * Appends -v2, -v3, ... before the extension until `exists` reports no
 * collision, so two uploads that would otherwise share the same print
 * name stay distinguishable.
 */
export const resolveUniqueFilename = async (
  baseFilename: string,
  exists: (candidate: string) => Promise<boolean>,
): Promise<string> => {
  if (!(await exists(baseFilename))) return baseFilename;
  let version = 2;
  let candidate = appendVersionSuffix(baseFilename, version);
  while (await exists(candidate)) {
    version += 1;
    candidate = appendVersionSuffix(baseFilename, version);
  }
  return candidate;
};

/**
 * Recovers the uploader's display name from a print filename built by
 * {@link buildPrintUploadFilename}. Returns null for filenames that don't
 * match the name_project_file convention (legacy uploads, or archives
 * created directly in Bambuddy outside this app).
 *
 * Lossy by construction: buildPrintUploadFilename collapses spaces and
 * underscores in the name to hyphens, so a name containing a literal
 * hyphen (e.g. "Anne-Marie") is indistinguishable from a space here and
 * comes back as "Anne Marie". There's no way to recover the original
 * punctuation from the slug alone.
 */
export const printedByNameFromFilename = (
  filename: string | null | undefined,
): string | null => {
  if (!filename) return null;
  const parsed = parsePrintUploadFilename(filename);
  if (!parsed) return null;
  const name = parsed.name.replace(/-/g, " ").trim();
  return name || null;
};

/**
 * Prefers the name encoded in the print's current filename over a
 * DB/queue-derived fallback - the filename reflects who most recently
 * queued/reprinted the file (see buildPrintUploadFilename call sites),
 * which can be more current than stale queue/job attribution. Falls back
 * to `fallback` when the filename doesn't match the naming scheme.
 *
 * When the filename name and fallback name agree, the fallback is kept
 * as-is so its email is preserved. Otherwise the filename wins for
 * display but there's no email to attach, so it's returned empty.
 */
export const resolveStartedBy = (
  fallback: { name: string; email: string } | null,
  fileName: string | null,
): { name: string; email: string } | null => {
  const filenameName = printedByNameFromFilename(fileName);
  if (!filenameName) return fallback;
  if (fallback && fallback.name.toLowerCase() === filenameName.toLowerCase()) {
    return fallback;
  }
  return { name: filenameName, email: "" };
};

export const hasAllowedGcodeExtension = (name: string) => {
  const lower = name.toLowerCase();
  return ALLOWED_GCODE_EXTENSIONS.some((ext) => lower.endsWith(ext));
};

export const hashBufferSha256 = (buffer: Buffer) =>
  createHash("sha256").update(buffer).digest("hex");

export const validateGcodePayload = (fileName: string, fileBuffer: Buffer) => {
  if (!fileName.trim()) {
    throw new Error("File name is required.");
  }

  if (!hasAllowedGcodeExtension(fileName)) {
    throw new Error("Only .gcode, .gco, .gc, and .bgcode files are supported.");
  }

  if (fileBuffer.length === 0) {
    throw new Error("G-code file cannot be empty.");
  }

  if (fileBuffer.length > MAX_GCODE_SIZE_BYTES) {
    throw new Error("G-code file is too large. Max size is 50MB.");
  }
};
