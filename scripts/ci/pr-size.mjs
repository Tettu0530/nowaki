// CI: outside contributors' PRs must stay under MAX changed lines (additions +
// deletions), not counting lockfiles. The maintainer and Dependabot are exempt.
// Env: GH_TOKEN, REPO (owner/name), PR (number), AUTHOR (login).
const MAX = 2000;
const EXEMPT = new Set(["Tettu0530", "dependabot[bot]"]);
const IGNORED = [/(^|\/)Cargo\.lock$/, /(^|\/)pnpm-lock\.yaml$/, /(^|\/)package-lock\.json$/];

const { GH_TOKEN, REPO, PR, AUTHOR } = process.env;
if (EXEMPT.has(AUTHOR)) {
  console.log(`pr-size: @${AUTHOR} is exempt`);
  process.exit(0);
}

let changed = 0;
let ignored = 0;
for (let page = 1; ; page++) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/pulls/${PR}/files?per_page=100&page=${page}`, {
    headers: { authorization: `Bearer ${GH_TOKEN}`, accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  const files = await res.json();
  for (const f of files) {
    const n = f.additions + f.deletions;
    if (IGNORED.some((re) => re.test(f.filename))) ignored += n;
    else changed += n;
  }
  if (files.length < 100) break;
}

console.log(`pr-size: ${changed} changed lines (limit ${MAX}; ${ignored} lockfile lines not counted)`);
if (changed > MAX) {
  console.error(
    `This PR changes ${changed} lines, over the ${MAX}-line limit for contributor PRs. ` +
      "Please split it into smaller PRs (see CONTRIBUTING.md).",
  );
  process.exit(1);
}
