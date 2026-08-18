/**
 * Crash-safe JSON persistence.
 *
 * Every on-disk artefact the bot rebuilds state from (EOD cache, shadow journal)
 * must survive a kill mid-write: a truncated file that still parses as JSON is
 * worse than no file at all, because the next run would read it as complete.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Writes via a temporary file in the destination directory, then renames.
 * `rename` is atomic within a filesystem, so a reader sees either the previous
 * content or the new one, never a partial write.
 *
 * The temp name carries the pid so two processes cannot clobber each other's
 * staging file.
 */
export async function writeJsonAtomic(
  filePath: string,
  payload: unknown,
  opts: { pretty?: boolean } = {},
): Promise<void> {
  const resolved = path.resolve(filePath);
  const tempPath = `${resolved}.${process.pid}.tmp`;

  try {
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(
      tempPath,
      opts.pretty === true ? JSON.stringify(payload, null, 2) : JSON.stringify(payload),
    );
    await fs.rename(tempPath, resolved);
  } catch (err) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * Reads and parses a JSON file. Returns null when the file is absent or does not
 * parse — callers decide whether that is fatal or simply a cold start.
 */
export async function readJson(filePath: string): Promise<unknown | null> {
  try {
    const raw = await fs.readFile(path.resolve(filePath), 'utf8');
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}
