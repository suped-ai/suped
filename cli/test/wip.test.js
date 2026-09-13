import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWork, refFor, validateWork, REF_PREFIX } from '../lib/wip.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const fail = (why) => { throw new Error(why); };

test('a branch name becomes a ref that is safe in a ref path and in a shell', () => {
  assert.equal(refFor('main'), `${REF_PREFIX}/main`);
  assert.equal(refFor('feature/thing'), `${REF_PREFIX}/feature-thing`);
  for (const nasty of ['a b', '$(whoami)', '../../escape', 'semi;colon', '--upload-pack=x', '']) {
    const ref = refFor(nasty);
    assert.match(ref, /^refs\/suped\/wip\/[A-Za-z0-9._-]+$/, nasty);
  }
  assert.equal(refFor(undefined), `${REF_PREFIX}/detached`);
});

test('carried work is validated before any of it reaches a command', () => {
  assert.deepEqual(validateWork({ ref: `${REF_PREFIX}/main`, commit: SHA_A, head: SHA_B }, fail),
    { ref: `${REF_PREFIX}/main`, commit: SHA_A, head: SHA_B });
  const bad = [
    { ref: 'refs/heads/main', commit: SHA_A, head: SHA_B },
    { ref: `${REF_PREFIX}/main; rm -rf /`, commit: SHA_A, head: SHA_B },
    { ref: `${REF_PREFIX}/main`, commit: '$(whoami)', head: SHA_B },
    { ref: `${REF_PREFIX}/main`, commit: SHA_A, head: 'not-a-sha' },
    { ref: `${REF_PREFIX}/main`, commit: SHA_A },
    null, 'string', [],
  ];
  for (const work of bad) assert.throws(() => validateWork(work, fail), undefined, JSON.stringify(work));
});

function fixture({ result = { status: 0, stdout: `${SHA_A} ${SHA_B}\n`, stderr: '' } } = {}) {
  const scripts = [];
  const work = createWork({ capture: (argv) => { scripts.push(argv[2] ?? ''); return typeof result === 'function' ? result(argv[2] ?? '') : result; } });
  return { work, scripts, script: () => scripts.join('\n') };
}

test('capturing never modifies the repository it captures', () => {
  // The whole feature is unusable if it can disturb the work it is carrying.
  const f = fixture();
  f.work.carry({ path: 'projects/demo', remote: 'git@x', branch: 'main' });
  const script = f.script();
  assert.match(script, /GIT_INDEX_FILE/, 'staging goes to a throwaway index');
  assert.match(script, /commit-tree/, 'the commit is written without moving HEAD');
  for (const forbidden of [/git stash/, /git checkout/, /git reset/, /update-ref/, /git commit\s/]) {
    assert.doesNotMatch(script, forbidden, `capture must not run ${forbidden}`);
  }
});

test('a project with no remote has nowhere to put its work, and says so', () => {
  const f = fixture();
  assert.deepEqual(f.work.carry({ path: 'projects/demo', remote: null, branch: 'main' }),
    { carried: false, why: 'no remote to push to' });
  assert.deepEqual(f.scripts, [], 'nothing is run for a project that cannot be carried');
});

test('a repository with no commits is skipped rather than half-carried', () => {
  const f = fixture({ result: { status: 0, stdout: 'NOHEAD\n', stderr: '' } });
  const result = f.work.carry({ path: 'projects/demo', remote: 'git@x', branch: 'main' });
  assert.equal(result.carried, false);
  assert.match(result.why, /no commits yet/);
});

test('a push the remote refuses is reported, not silently treated as carried', () => {
  const f = fixture({ result: { status: 1, stdout: '', stderr: 'remote: refusing to create refs/suped/wip/main\n' } });
  const result = f.work.carry({ path: 'projects/demo', remote: 'git@x', branch: 'main' });
  assert.equal(result.carried, false);
  assert.match(result.why, /refusing to create/);
});

test('output git did not produce is never taken as a pair of object ids', () => {
  const f = fixture({ result: { status: 0, stdout: 'something unexpected\n', stderr: '' } });
  assert.equal(f.work.carry({ path: 'projects/demo', remote: 'git@x', branch: 'main' }).carried, false);
});

test('restoring uncommitted work leaves HEAD where the other machine had it', () => {
  // HEAD at the real commit, working tree from the carried one, index reset
  // back -- which is what makes the changes reappear as changes.
  const f = fixture({ result: { status: 0, stdout: 'APPLIED\n', stderr: '' } });
  const applied = f.work.apply({ path: 'projects/demo', branch: 'main', work: { ref: `${REF_PREFIX}/main`, commit: SHA_A, head: SHA_B } });
  assert.deepEqual(applied, { applied: true, dirty: true });
  const script = f.script();
  assert.match(script, new RegExp(`checkout -q -B "main" "${SHA_B}"`));
  assert.match(script, new RegExp(`read-tree -u --reset "${SHA_A}"`));
  assert.match(script, new RegExp(`reset -q --mixed "${SHA_B}"`));
});

test('work that was only unpushed commits needs no working-tree surgery', () => {
  const f = fixture({ result: { status: 0, stdout: 'APPLIED\n', stderr: '' } });
  const applied = f.work.apply({ path: 'projects/demo', branch: 'main', work: { ref: `${REF_PREFIX}/main`, commit: SHA_A, head: SHA_A } });
  assert.deepEqual(applied, { applied: true, dirty: false });
  assert.doesNotMatch(f.script(), /read-tree/);
  assert.doesNotMatch(f.script(), /--mixed/);
});

test('a project carrying nothing is left entirely alone', () => {
  const f = fixture();
  assert.deepEqual(f.work.apply({ path: 'projects/demo', branch: 'main' }), { applied: false });
  assert.deepEqual(f.scripts, []);
});

test('a restore that fails says where the work still is', () => {
  const f = fixture({ result: { status: 1, stdout: '', stderr: 'fatal: could not read from remote\n' } });
  const applied = f.work.apply({ path: 'projects/demo', branch: 'main', work: { ref: `${REF_PREFIX}/main`, commit: SHA_A, head: SHA_B } });
  assert.equal(applied.applied, false);
  assert.match(applied.why, /could not read from remote/);
});

test('the carry commit brings its own identity, because a workspace has none', () => {
  // commit-tree refuses without one, and suped never configures a git identity,
  // so without this the first carry on any real workspace fails.
  const f = fixture();
  f.work.carry({ path: 'projects/demo', remote: 'git@x', branch: 'main' });
  const script = f.script();
  for (const variable of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) {
    assert.match(script, new RegExp(`${variable}=suped`), variable);
  }
});

// --- applying into a checkout that already exists ---------------------------
// The daily case: both machines already have the repository. Work can be
// applied only when this checkout has nothing of its own to lose.

const WORK = { ref: `${REF_PREFIX}/main`, commit: 'a'.repeat(40), head: 'b'.repeat(40) };
const project = { path: 'projects/demo', branch: 'main', work: WORK };

test('work is never applied over a checkout with changes of its own', () => {
  const f = fixture({ result: { status: 0, stdout: 'DIRTY\n', stderr: '' } });
  const applied = f.work.apply(project);
  assert.equal(applied.applied, false);
  assert.equal(applied.held, true, 'refusing is a decision, not a failure');
  assert.match(applied.why, /uncommitted changes here/);
});

test('work is never applied to a checkout sitting on another branch', () => {
  const f = fixture({ result: { status: 0, stdout: 'OTHERBRANCH feature\n', stderr: '' } });
  const applied = f.work.apply(project);
  assert.equal(applied.applied, false);
  assert.match(applied.why, /on branch feature here, not main/);
});

test('work is never applied to a history that has moved on independently', () => {
  const f = fixture({ result: { status: 0, stdout: 'DIVERGED\n', stderr: '' } });
  const applied = f.work.apply(project);
  assert.equal(applied.applied, false);
  assert.match(applied.why, /moved on independently/);
});

test('an existing checkout is checked for changes, branch, and ancestry before anything moves', () => {
  const f = fixture({ result: { status: 0, stdout: 'APPLIED\n', stderr: '' } });
  f.work.apply(project);
  const script = f.script();
  assert.match(script, /git status --porcelain/, 'refuses over local changes');
  assert.match(script, /symbolic-ref/, 'refuses on another branch');
  assert.match(script, /merge-base --is-ancestor/, 'refuses a diverged history');
  // Every check comes before the first thing that changes the checkout.
  assert.ok(script.indexOf('merge-base --is-ancestor') < script.indexOf('checkout -q -B'));
});

test('a fresh clone has nothing of its own to protect, so its branch is not policed', () => {
  // Otherwise carrying work on a feature branch could never reach a new clone,
  // which lands on the remote's default branch.
  const f = fixture({ result: { status: 0, stdout: 'APPLIED\n', stderr: '' } });
  f.work.apply({ ...project, branch: 'feature' }, { fresh: true });
  assert.doesNotMatch(f.script(), /symbolic-ref/);
  // The checks that cannot lose work are still there.
  assert.match(f.script(), /merge-base --is-ancestor/);
});

test('a refusal the script reported is honoured even if the shell disagrees about the status', () => {
  // The decision paths are all `exit 0` by construction, so a printed refusal
  // is better evidence than a status that contradicts it. Treating "I left
  // this alone" as a failure would mark a correct move as broken.
  for (const [outcome, expected] of [['DIRTY', /uncommitted changes here/], ['DIVERGED', /moved on independently/]]) {
    const f = fixture({ result: { status: 1, stdout: `${outcome}\n`, stderr: '' } });
    const applied = f.work.apply(project);
    assert.equal(applied.held, true, outcome);
    assert.match(applied.why, expected);
  }
});

test('a run that reported no decision at all is still a failure, and says what it could', () => {
  const f = fixture({ result: { status: 128, stdout: '', stderr: 'fatal: not a git repository\n' } });
  const applied = f.work.apply(project);
  assert.equal(applied.applied, false);
  assert.notEqual(applied.held, true);
  assert.match(applied.why, /not a git repository/);
  const quiet = fixture({ result: { status: 128, stdout: '', stderr: '' } });
  assert.match(quiet.work.apply(project).why, /git exited 128/);
});
