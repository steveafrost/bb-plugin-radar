import { setHosts } from "../hosts";

/** Example Gitstream + Delta monorepo so host-specific helpers have something to read. */
export const TEST_HOSTS = {
  gitstream: { repo: "acme/monorepo", web: "https://gitstream.example.com", label: "Gitstream" },
  delta: { host: "delta.example.com", repo: "acme/monorepo", label: "Delta" },
  areaRepo: "acme/monorepo",
};

setHosts(TEST_HOSTS);
