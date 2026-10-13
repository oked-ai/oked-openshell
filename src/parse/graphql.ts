// A small GraphQL reader: enough to find the operation type, name and root fields.
// It never executes or validates the document.

export type GqlOperation = {
  type: "query" | "mutation" | "subscription";
  name: string | null;
  rootFields: string[];
};

export type GqlRequest = {
  // The operation that runs: the one named by operationName, else the first one.
  selected: GqlOperation | null;
  // The first mutation in the document, if any.
  firstMutation: GqlOperation | null;
  variables: Record<string, unknown>;
};

type Tok = { t: "name" | "punct" | "string"; v: string };

const OP_TYPES = new Set(["query", "mutation", "subscription"]);
const MAX_ROOT_FIELDS = 20;

// Reads a JSON body of the form { query, operationName?, variables? }. Null if it is not GraphQL.
export function readGraphqlBody(body: unknown): GqlRequest | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const obj = body as Record<string, unknown>;
  if (typeof obj.query !== "string") return null;
  const wanted = typeof obj.operationName === "string" ? obj.operationName : null;
  const ops = graphqlOperations(obj.query);
  const selected = (wanted ? ops.find((o) => o.name === wanted) : undefined) ?? ops[0] ?? null;
  const variables =
    obj.variables && typeof obj.variables === "object" && !Array.isArray(obj.variables)
      ? (obj.variables as Record<string, unknown>)
      : {};
  return { selected, firstMutation: ops.find((o) => o.type === "mutation") ?? null, variables };
}

export function graphqlOperations(source: string): GqlOperation[] {
  const toks = tokenize(source);
  const ops: GqlOperation[] = [];
  let i = 0;
  while (i < toks.length) {
    const tok = toks[i]!;
    if (tok.t === "punct" && tok.v === "{") {
      // Shorthand query.
      const [fields, next] = rootFields(toks, i);
      ops.push({ type: "query", name: null, rootFields: fields });
      i = next;
    } else if (tok.t === "name" && OP_TYPES.has(tok.v)) {
      const type = tok.v as GqlOperation["type"];
      let name: string | null = null;
      i++;
      if (toks[i]?.t === "name") name = toks[i++]!.v;
      // Skip variable definitions and directives up to the selection set.
      let depth = 0;
      while (i < toks.length) {
        const t = toks[i]!;
        if (t.t === "punct" && (t.v === "(" || t.v === "[")) depth++;
        else if (t.t === "punct" && (t.v === ")" || t.v === "]")) depth--;
        else if (depth === 0 && t.t === "punct" && t.v === "{") break;
        i++;
      }
      const [fields, next] = rootFields(toks, i);
      ops.push({ type, name, rootFields: fields });
      i = next;
    } else if (tok.t === "name" && tok.v === "fragment") {
      while (i < toks.length && !(toks[i]!.t === "punct" && toks[i]!.v === "{")) i++;
      i = skipBlock(toks, i);
    } else {
      i++;
    }
  }
  return ops;
}

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "#") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (/[\s,\ufeff]/.test(c)) {
      i++;
    } else if (c === '"') {
      if (src.startsWith('"""', i)) {
        const end = src.indexOf('"""', i + 3);
        i = end < 0 ? src.length : end + 3;
      } else {
        i++;
        while (i < src.length && src[i] !== '"' && src[i] !== "\n") {
          if (src[i] === "\\") i++;
          i++;
        }
        i++;
      }
      out.push({ t: "string", v: "" });
    } else if (/[_A-Za-z]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[_0-9A-Za-z]/.test(src[j]!)) j++;
      out.push({ t: "name", v: src.slice(i, j) });
      i = j;
    } else if (src.startsWith("...", i)) {
      out.push({ t: "punct", v: "..." });
      i += 3;
    } else {
      out.push({ t: "punct", v: c });
      i++;
    }
  }
  return out;
}

function skipBlock(toks: Tok[], start: number): number {
  let depth = 0;
  let i = start;
  for (; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.t !== "punct") continue;
    if (t.v === "{") depth++;
    else if (t.v === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return i;
}

// Field names at depth 1 of the selection set that starts at `start`.
function rootFields(toks: Tok[], start: number): [string[], number] {
  const fields: string[] = [];
  let depth = 0;
  let paren = 0;
  let i = start;
  for (; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.t === "punct") {
      if (t.v === "(") paren++;
      else if (t.v === ")") paren--;
      else if (paren === 0 && t.v === "{") depth++;
      else if (paren === 0 && t.v === "}") {
        depth--;
        if (depth === 0) return [fields, i + 1];
      }
      continue;
    }
    if (t.t !== "name" || paren !== 0 || depth !== 1) continue;
    const prev = toks[i - 1];
    if (prev?.t === "punct" && (prev.v === "@" || prev.v === "...")) continue;
    if (prev?.t === "name" && prev.v === "on") continue;
    // An alias: `alias: field`. Use the real field name.
    if (toks[i + 1]?.t === "punct" && toks[i + 1]!.v === ":") continue;
    if (fields.length < MAX_ROOT_FIELDS) fields.push(t.v);
  }
  return [fields, i];
}
