// A local JSON file for the retry state, so a middleware restart does not
// forget pending, decided or used approvals. The OKed backend has no lookup
// by request hash, so the state stays on this machine.
// The file holds request hashes, approval IDs, statuses and the approval text.
// It never holds an API key or a token. Mode 600, written by rename.

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { z } from "zod";
import type { Entry, StateStore } from "./state.js";

const entrySchema = z.object({
  requestHash: z.string().regex(/^[0-9a-f]{64}$/),
  approvalId: z.string().nullable(),
  status: z.enum(["pending", "approved", "denied", "timed_out", "failed"]),
  createdAt: z.number(),
  decidedAt: z.number().nullable(),
  used: z.boolean(),
  receiptId: z.string().nullable(),
  watching: z.boolean().optional().default(false),
  permanent: z.boolean(),
  via: z.enum(["human", "classifier"]).nullable(),
  previousApprovalId: z.string().nullable(),
  context: z.unknown().optional(),
});

const fileSchema = z.object({ version: z.literal(1), entries: z.array(entrySchema) });

export function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? homedir() + path.slice(1) : path;
}

export class FileStore implements StateStore {
  private readonly path: string;

  constructor(
    path: string,
    // Called on a read or write problem. Never gets file contents.
    private readonly onError: (event: { op: "load" | "save"; error: string }) => void = () => {},
  ) {
    this.path = expandHome(path);
  }

  // A missing file is an empty state. A file that does not parse is also an
  // empty state, with an error event: the worst case is one more approval.
  load(): Entry[] {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") this.onError({ op: "load", error: errorText(e) });
      return [];
    }
    const parsed = fileSchema.safeParse(safeJson(text));
    if (!parsed.success) {
      this.onError({ op: "load", error: "the state file does not match the expected format" });
      return [];
    }
    return parsed.data.entries as Entry[];
  }

  save(entries: Entry[]): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const tmp = `${this.path}.${process.pid}.tmp`;
      const data = entries.map(({ watching: _watching, ...rest }) => rest);
      writeFileSync(tmp, JSON.stringify({ version: 1, entries: data }), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.path);
    } catch (e) {
      this.onError({ op: "save", error: errorText(e) });
    }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 200) : String(e).slice(0, 200);
}
