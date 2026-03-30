#!/usr/bin/env node

import fs from "fs";
import path from "path";

const API_BASE = "https://api.github.com";
const DEFAULT_OUT_DIR = "docs/generated";
const DEFAULT_TOP = 10;
const DEFAULT_CANDIDATE_LIMIT = 40;
const DEFAULT_FORK_PAGES = 1;

const SEARCH_QUERIES = [
  'excalidraw mcp in:name,description,readme',
  '"model context protocol" excalidraw in:name,description,readme',
  '"self-hosted excalidraw" websocket in:name,description,readme',
  'excalidraw sqlite in:name,description,readme',
  'excalidraw collaboration self-hosted in:name,description,readme',
  'excalidraw-mcp in:name,description,readme',
  'mcp_excalidraw in:name,description,readme',
];

const SEED_REPOS = [
  "excalidraw/excalidraw",
  "yctimlin/mcp_excalidraw",
  "sanjibdevnathlabs/mcp-excalidraw-local",
  "celstnblacc/excalidraw-mcp-sentinel",
  "i-tozer/excalidraw-mcp",
  "alswl/excalidraw-collaboration",
];

const SIGNALS = {
  mcp: [
    "@modelcontextprotocol/sdk",
    "model context protocol",
    "mcp server",
    "mcp",
  ],
  liveBackend: [
    "websocket",
    "socket.io",
    " ws ",
    "canvas server",
    "backend",
    "live canvas",
    "real-time",
    "realtime",
    "collaboration",
    "sync",
    "express",
  ],
  persistence: [
    "better-sqlite3",
    "sqlite",
    "postgres",
    "mongodb",
    "storage",
    "filesystem",
    "s3",
    "backup",
    "versioning",
    "drizzle",
    "prisma",
  ],
  security: [
    "helmet",
    "rate limit",
    "rate-limit",
    "apikey",
    "api key",
    "auth",
    "oauth",
    "oidc",
    "encryption",
    "secure",
    "security",
  ],
  workspaceIsolation: [
    "multi-tenant",
    "multi tenant",
    "workspace",
    "tenant",
    "project",
    "organizer",
  ],
  selfHosted: [
    "self-hosted",
    "self hosted",
    "docker-compose",
    "docker compose",
    "docker",
    "localhost",
    "single binary",
  ],
  excalidraw: [
    "@excalidraw/excalidraw",
    "excalidraw",
  ],
};

function parseArgs(argv) {
  const options = {
    top: DEFAULT_TOP,
    candidateLimit: DEFAULT_CANDIDATE_LIMIT,
    forkPages: DEFAULT_FORK_PAGES,
    outDir: DEFAULT_OUT_DIR,
    excludeRepos: new Set(),
    verbose: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--verbose") {
      options.verbose = true;
      continue;
    }
    if (arg === "--top") {
      options.top = parsePositiveInt(argv[++i], "--top");
      continue;
    }
    if (arg === "--candidate-limit") {
      options.candidateLimit = parsePositiveInt(argv[++i], "--candidate-limit");
      continue;
    }
    if (arg === "--fork-pages") {
      options.forkPages = parsePositiveInt(argv[++i], "--fork-pages");
      continue;
    }
    if (arg === "--out-dir") {
      options.outDir = argv[++i];
      if (!options.outDir) {
        throw new Error("--out-dir requires a value");
      }
      continue;
    }
    if (arg === "--exclude-repo") {
      const repoName = argv[++i];
      if (!repoName || !repoName.includes("/")) {
        throw new Error("--exclude-repo requires a value like owner/name");
      }
      options.excludeRepos.add(repoName);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function parsePositiveInt(value, flagName) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flagName} requires a positive integer`);
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage: node scripts/scan-excalidraw-similar-projects.mjs [options]

Options:
  --top <n>              Number of ranked results to keep (default: ${DEFAULT_TOP})
  --candidate-limit <n>  Max unique candidates to inspect (default: ${DEFAULT_CANDIDATE_LIMIT})
  --fork-pages <n>       Number of GitHub fork pages to inspect per seed (default: ${DEFAULT_FORK_PAGES})
  --out-dir <path>       Output directory for JSON and Markdown reports (default: ${DEFAULT_OUT_DIR})
  --exclude-repo <repo>  Exclude a repo by full name; repeatable
  --verbose              Print progress while scanning
  -h, --help             Show this help

Environment:
  GITHUB_TOKEN           Optional but recommended. Raises GitHub API rate limits.
`);
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function formatDateUtc(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function log(options, message) {
  if (options.verbose) {
    console.error(message);
  }
}

async function githubRequest(apiPath, options, query = {}) {
  const url = new URL(`${API_BASE}${apiPath}`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, String(value));
  }

  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "excalidraw-similar-project-scan",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const response = await fetch(url, { headers });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status} for ${url}: ${body.slice(0, 200)}`);
  }
  return response.json();
}

async function searchRepositories(query, options) {
  log(options, `search: ${query}`);
  const payload = await githubRequest("/search/repositories", options, {
    q: query,
    per_page: 20,
    sort: "stars",
    order: "desc",
  });
  return payload?.items ?? [];
}

async function listForks(fullName, options, pages) {
  const [owner, repo] = fullName.split("/");
  const results = [];
  for (let page = 1; page <= pages; page += 1) {
    log(options, `forks: ${fullName} page ${page}`);
    const payload = await githubRequest(`/repos/${owner}/${repo}/forks`, options, {
      per_page: 100,
      page,
      sort: "newest",
    });
    if (!Array.isArray(payload) || payload.length === 0) {
      break;
    }
    results.push(...payload);
  }
  return results;
}

async function getRepoDetails(fullName, options) {
  const [owner, repo] = fullName.split("/");
  return githubRequest(`/repos/${owner}/${repo}`, options);
}

async function getReadme(fullName, options) {
  const [owner, repo] = fullName.split("/");
  const payload = await githubRequest(`/repos/${owner}/${repo}/readme`, options);
  if (!payload?.content) {
    return "";
  }
  return decodeGitHubContent(payload.content);
}

async function getPackageJson(fullName, options) {
  const [owner, repo] = fullName.split("/");
  const payload = await githubRequest(`/repos/${owner}/${repo}/contents/package.json`, options);
  if (!payload?.content) {
    return null;
  }
  try {
    return JSON.parse(decodeGitHubContent(payload.content));
  } catch {
    return null;
  }
}

function decodeGitHubContent(content) {
  return Buffer.from(content.replace(/\n/g, ""), "base64").toString("utf8");
}

function dedupeRepos(repos) {
  const map = new Map();
  for (const repo of repos) {
    if (!repo?.full_name) {
      continue;
    }
    if (!map.has(repo.full_name)) {
      map.set(repo.full_name, repo);
    }
  }
  return [...map.values()];
}

function rankSeedPriority(fullName) {
  const index = SEED_REPOS.indexOf(fullName);
  return index === -1 ? 999 : index;
}

function sortCandidates(repos) {
  return [...repos].sort((a, b) => {
    const seedDelta = rankSeedPriority(a.full_name) - rankSeedPriority(b.full_name);
    if (seedDelta !== 0) {
      return seedDelta;
    }
    const starsA = a.stargazers_count ?? 0;
    const starsB = b.stargazers_count ?? 0;
    if (starsA !== starsB) {
      return starsB - starsA;
    }
    return a.full_name.localeCompare(b.full_name);
  });
}

function buildRepoText(repo, readmeText, packageJson) {
  const topics = Array.isArray(repo.topics) ? repo.topics.join(" ") : "";
  const dependencies = Object.keys({
    ...(packageJson?.dependencies ?? {}),
    ...(packageJson?.devDependencies ?? {}),
  }).join(" ");
  return [
    repo.full_name,
    repo.description ?? "",
    topics,
    readmeText,
    dependencies,
  ].join(" ").toLowerCase();
}

function includesAny(text, needles) {
  return needles.some((needle) => text.includes(needle));
}

function scoreRepo(repo, readmeText, packageJson) {
  const text = buildRepoText(repo, readmeText, packageJson);
  const signals = {
    excalidraw: includesAny(text, SIGNALS.excalidraw),
    mcp: includesAny(text, SIGNALS.mcp),
    liveBackend: includesAny(text, SIGNALS.liveBackend),
    persistence: includesAny(text, SIGNALS.persistence),
    security: includesAny(text, SIGNALS.security),
    workspaceIsolation: includesAny(text, SIGNALS.workspaceIsolation),
    selfHosted: includesAny(text, SIGNALS.selfHosted),
  };

  const score =
    (signals.mcp ? 5 : 0) +
    (signals.liveBackend ? 4 : 0) +
    (signals.persistence ? 3 : 0) +
    (signals.security ? 3 : 0) +
    (signals.workspaceIsolation ? 3 : 0) +
    (signals.selfHosted ? 2 : 0);

  let classification = "NOT_REALLY";
  if (signals.mcp && signals.liveBackend && score >= 10) {
    classification = "SAME";
  } else if (score >= 6) {
    classification = "ADJACENT";
  }

  const reasons = [];
  if (signals.mcp) reasons.push("MCP");
  if (signals.liveBackend) reasons.push("live backend");
  if (signals.persistence) reasons.push("persistence");
  if (signals.security) reasons.push("security");
  if (signals.workspaceIsolation) reasons.push("workspace isolation");
  if (signals.selfHosted) reasons.push("self-hosted");

  return {
    score,
    classification,
    signals,
    reason: reasons.join(", ") || "weak match",
    closestToThisRepo: signals.mcp && signals.liveBackend && (signals.persistence || signals.security),
  };
}

function trimReadme(readmeText) {
  return readmeText.length > 24000 ? readmeText.slice(0, 24000) : readmeText;
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Excalidraw Similar Project Scan");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push("");
  lines.push("Scoring weights: `MCP=5`, `live backend=4`, `persistence=3`, `security=3`, `workspace isolation=3`, `self-hosted=2`.");
  lines.push("");
  lines.push("| Repo | Score | Class | Excalidraw fork? | Why it matched |");
  lines.push("|---|---:|---|---|---|");
  for (const result of report.results) {
    lines.push(
      `| [${result.fullName}](${result.htmlUrl}) | ${result.score}/20 | ${result.classification} | ${result.directExcalidrawFork ? "Yes" : "No"} | ${result.reason} |`
    );
  }
  lines.push("");
  lines.push("## Notes");
  lines.push("");
  lines.push("- This scan uses capability matching, not only fork ancestry.");
  lines.push("- `SAME` requires strong evidence of both `MCP` and a live backend/canvas layer.");
  lines.push("- Results are heuristic and based on public repo metadata, README content, and `package.json` when present.");
  return `${lines.join("\n")}\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const candidates = [];

  for (const seed of SEED_REPOS) {
    const details = await getRepoDetails(seed, options);
    if (details) {
      candidates.push(details);
    }
  }

  for (const query of SEARCH_QUERIES) {
    const repos = await searchRepositories(query, options);
    candidates.push(...repos);
  }

  for (const seed of SEED_REPOS) {
    const forks = await listForks(seed, options, options.forkPages);
    candidates.push(...forks);
  }

  const uniqueCandidates = sortCandidates(
    dedupeRepos(candidates).filter((repo) => !repo.archived && !options.excludeRepos.has(repo.full_name))
  ).slice(0, options.candidateLimit);

  const scored = [];
  for (const repo of uniqueCandidates) {
    const [readmeText, packageJson] = await Promise.all([
      getReadme(repo.full_name, options).catch(() => ""),
      getPackageJson(repo.full_name, options).catch(() => null),
    ]);

    const evaluation = scoreRepo(repo, trimReadme(readmeText), packageJson);
    if (!evaluation.signals.excalidraw) {
      continue;
    }
    scored.push({
      fullName: repo.full_name,
      htmlUrl: repo.html_url,
      description: repo.description ?? "",
      score: evaluation.score,
      classification: evaluation.classification,
      reason: evaluation.reason,
      signals: evaluation.signals,
      closestToThisRepo: evaluation.closestToThisRepo,
      stars: repo.stargazers_count ?? 0,
      fork: !!repo.fork,
    });
  }

  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.closestToThisRepo !== b.closestToThisRepo) return Number(b.closestToThisRepo) - Number(a.closestToThisRepo);
    if (a.stars !== b.stars) return b.stars - a.stars;
    return a.fullName.localeCompare(b.fullName);
  });

  const topResults = scored.slice(0, options.top);

  for (const result of topResults) {
    const details = await getRepoDetails(result.fullName, options).catch(() => null);
    result.directExcalidrawFork = details?.parent?.full_name === "excalidraw/excalidraw";
    result.parentFullName = details?.parent?.full_name ?? null;
  }

  const report = {
    generatedAt: new Date().toISOString(),
    config: {
      top: options.top,
      candidateLimit: options.candidateLimit,
      forkPages: options.forkPages,
      excludeRepos: [...options.excludeRepos],
      searchQueries: SEARCH_QUERIES,
      seedRepos: SEED_REPOS,
    },
    results: topResults,
  };

  fs.mkdirSync(options.outDir, { recursive: true });
  const stamp = formatDateUtc();
  const baseName = `${stamp}-${slugify("excalidraw-similar-project-scan")}`;
  const jsonPath = path.join(options.outDir, `${baseName}.json`);
  const markdownPath = path.join(options.outDir, `${baseName}.md`);

  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(markdownPath, renderMarkdown(report));

  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${markdownPath}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
