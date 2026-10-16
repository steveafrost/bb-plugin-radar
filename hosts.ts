/**
 * Which hosts Radar reads besides GitHub, and how their items are named and linked.
 *
 * GitHub (via `gh`) always works. Gitstream (`gs`) and Delta (`dt`) are optional:
 * each turns on when its repo (and host or web URL) is set in plugin settings.
 * Server and panel share one current value: the server sets it from settings, the
 * panel from each snapshot, so lane, scope and rebase helpers read it directly.
 */
import { z } from "zod";

const REPO = /^[\w.-]+\/[\w.-]+$/;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

export const hostsSchema = z.object({
  /** Gitstream: PRs listed with `gs api repos/<repo>/pulls`, opened at `<web>/repos/<repo>/pulls/<n>`. */
  gitstream: z.object({ repo: z.string(), web: z.string(), label: z.string() }).nullable(),
  /** Delta: GitHub-compatible search with `dt --host <host> -R <repo>`. */
  delta: z.object({ host: z.string(), repo: z.string(), label: z.string() }).nullable(),
  /** A monorepo whose `//<path>` labels become focus areas ("" = none). */
  areaRepo: z.string(),
});
export type Hosts = z.infer<typeof hostsSchema>;

export const NO_HOSTS: Hosts = { gitstream: null, delta: null, areaRepo: "" };

export type HostSettings = {
  gitstreamRepo?: string;
  gitstreamWebUrl?: string;
  gitstreamLabel?: string;
  deltaHost?: string;
  deltaRepo?: string;
  deltaLabel?: string;
  areaRepo?: string;
};

/** Settings → Hosts. Anything malformed turns that host off and is reported in `problems`. */
export function readHosts(values: HostSettings): { hosts: Hosts; problems: string[] } {
  const problems: string[] = [];
  const repo = (value: string | undefined, what: string) => {
    const trimmed = (value ?? "").trim();
    if (trimmed === "") return "";
    if (REPO.test(trimmed) && !trimmed.includes("..")) return trimmed;
    problems.push(`${what} "${trimmed.slice(0, 80)}" is not owner/name`);
    return "";
  };
  let gitstream: Hosts["gitstream"] = null;
  const gsRepo = repo(values.gitstreamRepo, "Gitstream repo");
  if (gsRepo !== "") {
    const web = (values.gitstreamWebUrl ?? "").trim().replace(/\/+$/, "");
    let ok = false;
    try {
      const url = new URL(web);
      ok = url.protocol === "https:" && url.pathname === "/" && url.search === "" && url.hash === "";
    } catch {
      // Not a URL.
    }
    if (ok) gitstream = { repo: gsRepo, web, label: (values.gitstreamLabel ?? "").trim() || "Gitstream" };
    else problems.push(`Gitstream web URL "${web.slice(0, 80)}" must be an https origin like https://gitstream.example.com`);
  }
  let delta: Hosts["delta"] = null;
  const dtRepo = repo(values.deltaRepo, "Delta repo");
  if (dtRepo !== "") {
    const host = (values.deltaHost ?? "").trim().toLowerCase();
    if (HOSTNAME.test(host)) delta = { host, repo: dtRepo, label: (values.deltaLabel ?? "").trim() || "Delta" };
    else problems.push(`Delta host "${host.slice(0, 80)}" is not a host name`);
  }
  return { hosts: { gitstream, delta, areaRepo: repo(values.areaRepo, "Area repo") }, problems };
}

let current: Hosts = NO_HOSTS;
const listeners = new Set<(hosts: Hosts) => void>();

export const hosts = (): Hosts => current;

export function setHosts(next: Hosts): void {
  current = next;
  for (const listener of listeners) listener(next);
}

/** Runs whenever the hosts change (used to relabel sources). */
export function onHosts(listener: (hosts: Hosts) => void): () => void {
  listeners.add(listener);
  listener(current);
  return () => listeners.delete(listener);
}
