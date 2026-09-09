import test from 'node:test';
import assert from 'node:assert/strict';
import { DEPLOY_TOOLS } from '../lib/catalog/deploy.js';

const tool = (id) => DEPLOY_TOOLS.find((entry) => entry.id === id);
const json = (value, status = 0) => ({ status, stdout: JSON.stringify(value), stderr: '' });

test('deployment account checks reject successful commands without an identity', () => {
  for (const entry of DEPLOY_TOOLS) {
    for (const result of [undefined, {}, json(null), json({}), json([]), json({ loggedIn: false }), { status: 0, stdout: 'Logged out.\n' }]) {
      assert.equal(entry.connected(result), false, `${entry.id}: ${JSON.stringify(result)}`);
    }
  }
});

test('GitLab validates the authenticated user rather than any JSON response', () => {
  const gitlab = tool('gitlab');
  assert.equal(gitlab.connected(json({ id: 123, username: 'example' })), true);
  for (const value of [{ id: 0, username: 'example' }, { id: '123', username: 'example' }, { id: 123, username: '' }, { message: '401 Unauthorized' }]) {
    assert.equal(gitlab.connected(json(value)), false);
  }
  assert.equal(gitlab.connected(json({ id: 123, username: 'example' }, 1)), false);
});

test('Vercel accepts personal and application identities without needing a team', () => {
  const vercel = tool('vercel');
  assert.equal(vercel.connected(json({ username: 'example', team: null })), true);
  assert.equal(vercel.connected(json({ app: { id: 'cl_example' }, team: { id: 'team_example' } })), true);
  assert.equal(vercel.connected(json({ team: { id: 'team_example' } })), false);
  assert.equal(vercel.connected(json({ username: 'example', loggedIn: false })), false);
  assert.equal(vercel.connected(json({ username: 'example' }, 1)), false);
});

test('Netlify account check works without a linked site', () => {
  const netlify = tool('netlify');
  assert.deepEqual(netlify.check, ['netlify', 'api', 'getCurrentUser']);
  assert.equal(netlify.connected(json({ id: 'user-example', email: 'example@example.com' })), true);
  assert.equal(netlify.connected(json({ id: 'user-example' })), false);
  assert.equal(netlify.connected(json({ id: 'user-example', email: 'example@example.com' }, 1)), false);
});

test('Railway accepts a new account with zero workspaces', () => {
  const railway = tool('railway');
  const user = { name: null, email: 'example@example.com', workspaces: [] };
  assert.equal(railway.connected(json(user)), true);
  assert.equal(railway.connected(json({ email: 'example@example.com' })), false);
  assert.equal(railway.connected(json(user, 1)), false);
});

test('Fly and Render verify current user outputs', () => {
  assert.equal(tool('fly').connected(json({ email: 'example@example.com' })), true);
  assert.equal(tool('fly').connected(json({ email: ' ' })), false);
  assert.equal(tool('fly').connected(json({ email: 'example@example.com' }, 1)), false);
  const renderOutput = 'Name: Example User\nEmail: example@example.com\n';
  assert.equal(tool('render').connected({ status: 0, stdout: renderOutput }), true);
  assert.equal(tool('render').connected({ status: 1, stdout: renderOutput }), false);
  assert.equal(tool('render').connected({ status: 0, stdout: 'Error: Email: example@example.com\n' }), false);
});
