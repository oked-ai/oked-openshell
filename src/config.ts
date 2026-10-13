// Service config, validated with zod at startup. An invalid config stops the service.

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// Drop retry-state entries this long after creation.
export const ENTRY_TTL_MINUTES = 30;

const tier = z.enum(["safe", "warning", "review", "high_stakes"]);
const oneOrMany = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);
const scalar = z.union([z.string(), z.number(), z.boolean()]);

const condition = z
  .object({
    field: z.string().min(1),
    op: z.enum(["eq", "in", "regex", "gt", "lt"]),
    value: z.union([scalar, z.array(z.union([z.string(), z.number()])).min(1)]),
  })
  .strict()
  .superRefine((c, ctx) => {
    const bad = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if (c.op === "in" && !Array.isArray(c.value)) bad(`"in" needs a list value`);
    if (c.op !== "in" && Array.isArray(c.value)) bad(`"${c.op}" needs a single value`);
    if ((c.op === "gt" || c.op === "lt") && typeof c.value !== "number") bad(`"${c.op}" needs a number`);
    if (c.op === "regex") {
      if (typeof c.value !== "string") bad(`"regex" needs a string`);
      else if (!validRegex(c.value)) bad(`invalid regex: ${c.value}`);
    }
  });

const rule = z
  .object({
    name: z.string().min(1),
    host: oneOrMany.optional(),
    method: oneOrMany.optional(),
    path: z.string().min(1).refine(validRegex, "invalid path regex").optional(),
    operation: oneOrMany.optional(),
    kind: z.enum(["read", "write", "delete", "unknown"]).optional(),
    when: z.array(condition).min(1).optional(),
    tier,
  })
  .strict()
  .refine((r) => r.host || r.method || r.path || r.operation || r.kind || r.when, {
    message: "a rule needs at least one match condition",
  });

const configSchema = z
  .object({
    // The name in the manifest. Use the same name in the gateway registration.
    name: z.string().regex(/^[a-z][a-z0-9-]*$/).default("oked-approval"),
    listen: z.string().regex(/^[^\s]+:\d+$/, "listen must be host:port").default("127.0.0.1:50052"),
    oked: z
      .object({
        api_url: z.string().url().default("https://api.oked.ai"),
        api_key_env: z.string().min(1).default("OKED_API_KEY"),
        // Check the signed receipt before an approval allows a request.
        require_receipt: z.boolean().default(true),
      })
      .strict()
      .default({}),
    github: z
      .object({
        api_url: z.string().url().default("https://api.github.com"),
        read_token_env: z.string().min(1).default("OKED_GITHUB_READ_TOKEN"),
        lookup_timeout_ms: z.number().int().positive().max(10_000).default(2000),
      })
      .strict()
      .default({}),
    approval: z
      .object({
        pending_window_minutes: z.number().positive().default(10),
        grant_valid_minutes: z.number().positive().default(5),
        status_check_timeout_ms: z.number().int().positive().max(5000).default(1000),
        // Retry state, kept across restarts. null: memory only.
        state_file: z.string().min(1).nullable().default("~/.local/state/oked-openshell/retry-state.json"),
      })
      .strict()
      .default({}),
    approvers: z
      .object({
        default: z.string().min(1),
        // sandbox_id or sandbox name -> approver group. The sandbox_id wins.
        sandboxes: z.record(z.string().min(1)).default({}),
        // approver group -> the OKed API key of the person who approves. A group
        // that is not here uses oked.api_key_env.
        groups: z.record(z.object({ api_key_env: z.string().min(1) }).strict()).default({}),
      })
      .strict(),
    rules: z.array(rule).default([]),
  })
  .strict()
  .refine((c) => c.approval.pending_window_minutes + c.approval.grant_valid_minutes <= ENTRY_TTL_MINUTES, {
    message: `approval.pending_window_minutes + approval.grant_valid_minutes must be ${ENTRY_TTL_MINUTES} or less`,
  });

export type Config = z.infer<typeof configSchema>;
export type Rule = z.infer<typeof rule>;
export type Condition = z.infer<typeof condition>;

// Secrets stay out of Config, so that Config can be logged.
export type Secrets = {
  okedKeys: Map<string, string>; // approver group -> API key
  githubToken: string | null;
};

export type Loaded = { config: Config; secrets: Secrets };

function validRegex(source: string): boolean {
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}

export function parseConfig(text: string, env: Record<string, string | undefined>): Loaded {
  const result = configSchema.safeParse(parseYaml(text) ?? {});
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`invalid config:\n  ${issues.join("\n  ")}`);
  }
  const config = result.data;
  const groups = new Set([config.approvers.default, ...Object.values(config.approvers.sandboxes)]);
  const okedKeys = new Map<string, string>();
  for (const group of groups) {
    const envName = config.approvers.groups[group]?.api_key_env ?? config.oked.api_key_env;
    const key = env[envName]?.trim();
    if (!key) throw new Error(`invalid config: approver group "${group}" needs the OKed API key in $${envName}`);
    okedKeys.set(group, key);
  }
  const githubToken = env[config.github.read_token_env]?.trim() || null;
  return { config, secrets: { okedKeys, githubToken } };
}

export function loadConfig(path: string, env: Record<string, string | undefined>): Loaded {
  return parseConfig(readFileSync(path, "utf8"), env);
}

// Route by sandbox_id. A sandbox name also works. Else the default group.
export function approverGroup(config: Config, sandboxId: string, sandbox: string): string {
  const s = config.approvers.sandboxes;
  return (sandboxId && s[sandboxId]) || (sandbox && s[sandbox]) || config.approvers.default;
}
