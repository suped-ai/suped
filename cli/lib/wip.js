// Carry work in progress between machines.
//
// Until now `sync` found uncommitted changes and unpushed commits, called them
// "at risk", and left them behind. That is the half of a move you actually
// feel: everything is reinstalled and nothing you were in the middle of came
// with you.
//
// Git is the transport. The work is pushed to a ref under refs/suped/ on the
// project's own remote, so it travels without touching your branches, your
// history, or anyone else's view of the repository, and it can be inspected and
// recovered with plain git if anything here goes wrong.
//
// The hard rule: capturing must not change the repository it captures. No
// stash, no checkout, no index writes -- a commit is built through a temporary
// index file and pushed by object id, so HEAD, the index and the working tree
// are exactly as they were.
export const REF_PREFIX = 'refs/suped/wip';

const SAFE_REF = /^refs\/suped\/wip\/[A-Za-z0-9._-]+$/;
const SHA = /^[0-9a-f]{7,64}$/;

/** Branches can hold characters a ref path or a shell should not carry. */
export function refFor(branch) {
  const name = String(branch || 'detached').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'detached';
  return `${REF_PREFIX}/${name}`;
}

/** These land in shell commands, so nothing unvalidated may reach one. */
export function validateWork(work, fail) {
  if (work === null || typeof work !== 'object' || Array.isArray(work)) fail('work must be an object');
  if (typeof work.ref !== 'string' || !SAFE_REF.test(work.ref)) fail(`unusable work ref: ${String(work.ref).slice(0, 60)}`);
  for (const key of ['commit', 'head']) {
    if (typeof work[key] !== 'string' || !SHA.test(work[key])) fail(`unusable work ${key}: ${String(work[key]).slice(0, 60)}`);
  }
  return work;
}

export function createWork({ capture, log = () => {} } = {}) {
  const sh = (script) => capture(['bash', '-lc', script]);

  /**
   * Build a commit holding the working tree and push it, without disturbing
   * anything. GIT_INDEX_FILE points `git add` at a throwaway index, and
   * commit-tree writes an object without moving HEAD, so this is a read of the
   * repository that happens to produce a commit.
   */
  function carry(project) {
    if (!project.remote) return { carried: false, why: 'no remote to push to' };
    const ref = refFor(project.branch);
    const script = `set -e
cd "$HOME/${project.path}"
head=$(git rev-parse --verify HEAD 2>/dev/null) || { printf 'NOHEAD\\n'; exit 0; }
index=$(mktemp -u "\${TMPDIR:-/tmp}/suped-index.XXXXXX")
export GIT_INDEX_FILE="$index"
trap 'rm -f "$index"' EXIT
git read-tree "$head"
git add -A
tree=$(git write-tree)
if [ "$tree" = "$(git rev-parse "$head^{tree}")" ]; then
  commit="$head"
else
  commit=$(git commit-tree "$tree" -p "$head" -m 'suped: work in progress')
fi
git push -q --force origin "$commit:${ref}"
printf '%s %s\\n' "$commit" "$head"`;
    const result = sh(script);
    const out = (result.stdout || '').trim();
    if (result.status !== 0) {
      return { carried: false, why: (result.stderr || '').trim().split('\n').pop() || 'git refused the push' };
    }
    if (out === 'NOHEAD') return { carried: false, why: 'no commits yet, so there is nothing to anchor the work to' };
    const [commit, head] = out.split(/\s+/);
    if (!SHA.test(commit || '') || !SHA.test(head || '')) return { carried: false, why: 'git did not report what it pushed' };
    return { carried: true, work: { ref, commit, head } };
  }

  /**
   * Put the work back. HEAD goes to the branch the other machine was on, then
   * the working tree is filled from the carried commit and the index is reset
   * back to HEAD -- so the changes reappear exactly as they were: uncommitted,
   * including deletions and files that were never added.
   */
  function apply(project) {
    const work = project.work;
    if (!work) return { applied: false };
    const branch = String(project.branch || '').replace(/[^A-Za-z0-9._/-]+/g, '-') || 'main';
    const restore = work.commit === work.head ? '' : `
git read-tree -u --reset "${work.commit}"
git reset -q --mixed "${work.head}"`;
    const result = sh(`set -e
cd "$HOME/${project.path}"
git fetch -q origin "${work.ref}"
git checkout -q -B "${branch}" "${work.head}"${restore}`);
    if (result.status !== 0) {
      return { applied: false, why: (result.stderr || '').trim().split('\n').pop() || 'git could not restore it' };
    }
    return { applied: true, dirty: work.commit !== work.head };
  }

  return { carry, apply };
}
