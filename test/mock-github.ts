// A mock of the two read-only GitHub endpoints that oked-openshell uses.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export const GITHUB_TOKEN = "github_pat_TESTSECRET123";

export type MockGithub = {
  url: string;
  calls: string[];
  delayMs: number;
  fail: boolean;
  defaultBranch: string;
  pulls: Record<number, { title: string; base: string; head: string }>;
  close(): Promise<void>;
};

export async function startMockGithub(): Promise<MockGithub> {
  const gh: MockGithub = {
    url: "",
    calls: [],
    delayMs: 0,
    fail: false,
    defaultBranch: "main",
    pulls: {},
    close: () => new Promise((r) => (server.closeAllConnections(), server.close(() => r()))),
  };
  const server = createServer(async (req, res) => {
    gh.calls.push(req.url ?? "");
    if (gh.delayMs) await new Promise((r) => setTimeout(r, gh.delayMs));
    if (res.destroyed) return;
    if (req.headers.authorization !== `Bearer ${GITHUB_TOKEN}` || gh.fail) {
      res.writeHead(gh.fail ? 500 : 401).end("{}");
      return;
    }
    const pr = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/.exec(req.url ?? "");
    if (pr) {
      const p = gh.pulls[Number(pr[3])];
      if (!p) return void res.writeHead(404).end("{}");
      return void res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ number: Number(pr[3]), title: p.title, base: { ref: p.base }, head: { ref: p.head } }));
    }
    if (/^\/repos\/([^/]+)\/([^/]+)$/.test(req.url ?? "")) {
      return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ default_branch: gh.defaultBranch }));
    }
    res.writeHead(404).end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  gh.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return gh;
}
