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
  # A workspace has no git identity configured, and commit-tree refuses without
  # one. Supply it here rather than reading the user's: this commit is a
  # transport artefact under refs/suped/, not something they authored, and it is
  # never merged into their history.
  commit=$(GIT_AUTHOR_NAME=suped GIT_AUTHOR_EMAIL=suped@localhost \
    GIT_COMMITTER_NAME=suped GIT_COMMITTER_EMAIL=suped@localhost \
    git commit-tree "$tree" -p "$head" -m 'suped: work in progress')
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
   * Put the work back.
   *
   * A freshly cloned project is only the easy case of a general rule: work can
   * be applied when the checkout is clean and its history is behind or level
   * with the machine the work came from. Anything else -- local changes, a
   * different branch, a history that has moved on -- is refused, because
   * applying over it would destroy whatever this machine has been doing. The
   * work stays on the remote either way, so refusing costs nothing.
   *
   * HEAD goes to the commit the other machine was on, the working tree is
   * filled from the carried commit, and the index is reset back, which is what
   * makes the changes reappear as changes rather than as history.
   */
  function apply(project, { fresh = false } = {}) {
    const work = project.work;
    if (!work) return { applied: false };
    const branch = String(project.branch || '').replace(/[^A-Za-z0-9._/-]+/g, '-') || 'main';
    const restore = work.commit === work.head ? '' : `
git read-tree -u --reset "${work.commit}"
git reset -q --mixed "${work.head}"`;
    // A clone has nothing of its own to protect, so it does not have to be on
    // the branch the work belongs to. An existing checkout does.
    const sameBranch = fresh ? '' : `
now=$(git symbolic-ref --quiet --short HEAD || printf '')
if [ -n "$now" ] && [ "$now" != "${branch}" ]; then printf 'OTHERBRANCH %s\\n' "$now"; exit 0; fi`;
    const result = sh(`set -e
cd "$HOME/${project.path}"
git fetch -q origin "${work.ref}"
if [ -n "$(git status --porcelain)" ]; then printf 'DIRTY\\n'; exit 0; fi${sameBranch}
current=$(git rev-parse --verify HEAD 2>/dev/null || printf '')
if [ -n "$current" ] && [ "$current" != "${work.head}" ] && ! git merge-base --is-ancestor "$current" "${work.head}"; then
  printf 'DIVERGED\\n'; exit 0
fi
git checkout -q -B "${branch}" "${work.head}"${restore}
printf 'APPLIED\\n'`);
    if (result.status !== 0) {
      return { applied: false, why: (result.stderr || '').trim().split('\n').pop() || 'git could not restore it' };
    }
    const [outcome, detail] = (result.stdout || '').trim().split(/\s+/);
    if (outcome === 'APPLIED') return { applied: true, dirty: work.commit !== work.head };
    const why = {
      DIRTY: 'it has uncommitted changes here',
      OTHERBRANCH: `it is on branch ${detail} here, not ${branch}`,
      DIVERGED: 'its history here has moved on independently',
    }[outcome] || 'git did not say what happened';
    return { applied: false, why, held: true };
  }

  return { carry, apply };
}
