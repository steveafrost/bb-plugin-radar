#!/usr/bin/env node
// Fake gh/dt for the audit: behaviour comes from $FAKE_STATE, every call is logged to $FAKE_LOG.
import { readFileSync, appendFileSync } from "node:fs";
import { basename } from "node:path";
const state = JSON.parse(readFileSync(process.env.FAKE_STATE, "utf8"));
const argv = process.argv.slice(2);
const bin = basename(process.argv[1]).replace(/\..*$/, "");
appendFileSync(process.env.FAKE_LOG, JSON.stringify({ bin, argv }) + "\n");
const out = (value) => { process.stdout.write(typeof value === "string" ? value : JSON.stringify(value)); process.exit(0); };
const fail = (msg) => { process.stderr.write(msg + "\n"); process.exit(1); };
if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
if (bin === "dt") {
  const path = argv[argv.indexOf("api") + 1] ?? "";
  if (path.startsWith("search/issues")) {
    if (state.deltaFail) fail("dt: 503 service unavailable");
    out({ items: state.deltaItems ?? [] });
  }
  if (path === "/api/v1/me") out({ principal: "me@example.com" });
  out([]);
}
// gh
if (argv[0] === "api" && argv[1] === "user") out(state.login ?? "steve");
if (argv[0] === "api" && argv[1] === "graphql") {
  const q = argv.find((a) => a.startsWith("q="))?.slice(2) ?? "";
  const n = Number(argv.find((a) => a.startsWith("n="))?.slice(2) ?? 30);
  const hit = (state.searches ?? []).find((s) => q.includes(s.match));
  if (hit?.delayMs) await new Promise((r) => setTimeout(r, hit.delayMs));
  if (state.searchFail) fail("gh: 502 bad gateway");
  if (state.partialError) {
    process.stdout.write(JSON.stringify({ data: { search: { nodes: [...(hit?.nodes ?? []).slice(0, n), null] } }, errors: [{ type: "FORBIDDEN", message: "Resource protected by organization SAML enforcement." }] }));
    fail("gh: Resource protected by organization SAML enforcement.");
  }
  out({ data: { search: { nodes: (hit?.nodes ?? []).slice(0, n) } } });
}
if (argv[0] === "api" && argv[1] === "--method") {
  const path = argv[3];
  if (path.startsWith("/notifications?")) out(state.notifications ?? []);
  if (/\/issues\/\d+$/.test(path)) out({ body: state.issueBody ?? "" });
  const page = Number(path.match(/[?&]page=(\d+)/)?.[1] ?? 1);
  if (/\/issues\/\d+\/comments/.test(path)) {
    const total = state.comments ?? 0;
    const count = Math.max(0, Math.min(100, total - (page - 1) * 100));
    out(Array.from({ length: count }, (_, i) => ({ id: (page - 1) * 100 + i + 1, body: `comment ${i}` })));
  }
  out([]);
}
fail("unexpected call " + argv.join(" "));
