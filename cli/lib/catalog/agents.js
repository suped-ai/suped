import { npmInstall, jsonOutput } from './installers.js';

// Optional clients run inside the same persistent home as the service CLIs.
// Login status does not send a prompt or consume a model request.
export const AGENT_TOOLS = [
  {
    id: 'codex', name: 'Codex', category: 'agents', command: 'codex', version: '0.153.4',
    description: 'OpenAI coding agent; use your workspace tools and connect remote MCP servers.',
    docs: 'https://developers.openai.com/codex/cli/',
    install: npmInstall({ id: 'codex', packageName: '@openai/codex', version: '0.153.4', command: 'codex' }),
    login: ['codex', 'login', '--device-auth'],
    authInstructions: 'Open the printed device URL and enter the code. Device authentication must be enabled in your ChatGPT security or workspace settings.',
    check: ['codex', 'login', 'status'],
    connected: (result) => result?.status === 0 && /^Logged in\b/m.test(`${result.stdout || ''}\n${result.stderr || ''}`),
  },
  {
    id: 'claude', name: 'Claude Code', category: 'agents', command: 'claude', version: '2.1.266',
    description: 'Anthropic coding agent; use your workspace tools and connect remote MCP servers.',
    docs: 'https://code.claude.com/docs/en/installation',
    install: npmInstall({ id: 'claude', packageName: '@anthropic-ai/claude-code', version: '2.1.266', command: 'claude' }),
    login: ['claude', 'auth', 'login'],
    authInstructions: 'Open the printed login URL in your browser. If the browser cannot reach the workspace callback, paste the displayed authorization code into Claude Code.',
    check: ['claude', 'auth', 'status'],
    connected: (result) => jsonOutput(result)?.loggedIn === true,
  },
];
