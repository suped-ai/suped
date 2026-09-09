import { binaryInstall, jsonOutput, npmInstall } from './installers.js';

const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;

// Official distribution versions and release checksums checked September 9, 2026.
// These are optional alternatives: choosing one never installs its competitors.
export const DEPLOY_TOOLS = [
  {
    id: 'gitlab',
    name: 'GitLab',
    description: 'Repositories, merge requests, issues, and pipelines with glab.',
    category: 'source',
    command: 'glab',
    version: '1.117.0',
    docs: 'https://docs.gitlab.com/cli/',
    install: binaryInstall({
      command: 'glab',
      version: '1.117.0',
      checksums: {
        amd64: '1edfd0fba284e93396a9fd8899b9fff10f34f90b733943b1a70e21431a1991ab',
        arm64: 'ce533c314b69014664020567d006b5c86435f0fa16561aba18929bea26506828',
      },
      archive: 'glab_${version}_linux_${arch}.tar.gz',
      member: 'bin/glab',
      downloadUrl: 'https://gitlab.com/gitlab-org/cli/-/releases/v$version/downloads/$archive',
    }),
    // Device authorization works without forwarding container callback ports.
    // HTTPS login offers glab's native Git credential-helper setup.
    login: ['glab', 'auth', 'login', '--hostname', 'gitlab.com', '--device', '--git-protocol', 'https'],
    authInstructions: 'Open the GitLab verification URL on your computer and enter its one-time code. Accept Git authentication when prompted so your agent can push repositories. For a self-managed instance, use glab auth login --hostname YOUR_HOST --device inside Suped.',
    check: ['glab', 'api', '--hostname', 'gitlab.com', 'user'],
    connected(result) {
      const user = jsonOutput(result);
      return Boolean(user && Number.isInteger(user.id) && user.id > 0 && nonempty(user.username));
    },
  },
  {
    id: 'vercel',
    name: 'Vercel',
    description: 'Web apps, preview deployments, domains, and environment variables.',
    category: 'hosting',
    command: 'vercel',
    version: '59.14.0',
    docs: 'https://vercel.com/docs/cli',
    install: npmInstall({ id: 'vercel', packageName: 'vercel', version: '59.14.0', command: 'vercel' }),
    // Vercel's device flow honors CI to skip opening a browser but still polls.
    login: ['env', 'CI=1', 'vercel', 'login'],
    authInstructions: 'Open the verification URL Vercel prints in your browser and approve access. The CLI saves the login in your persistent home.',
    check: ['vercel', 'whoami', '--format', 'json'],
    connected(result) {
      const identity = jsonOutput(result);
      return Boolean(identity && identity.loggedIn !== false && (nonempty(identity.username) || nonempty(identity.app?.id)));
    },
  },
  {
    id: 'netlify',
    name: 'Netlify',
    description: 'Sites, preview deployments, functions, and environment variables.',
    category: 'hosting',
    command: 'netlify',
    version: '27.5.2',
    docs: 'https://docs.netlify.com/cli/get-started/',
    install: npmInstall({ id: 'netlify', packageName: 'netlify-cli', version: '27.5.2', command: 'netlify' }),
    // Native login detects Docker, prints the URL, and polls the login ticket.
    login: ['netlify', 'login'],
    authInstructions: 'Open the Netlify authorization URL printed in your terminal and approve access. Keep the terminal open until login finishes.',
    // `status --json` exits 1 for an authenticated but unlinked directory.
    // This GET works before the user has created or linked any project.
    check: ['netlify', 'api', 'getCurrentUser'],
    connected(result) {
      const user = jsonOutput(result);
      return Boolean(user && nonempty(user.id) && nonempty(user.email));
    },
  },
  {
    id: 'railway',
    name: 'Railway',
    description: 'Full-stack services, databases, deployments, and logs.',
    category: 'hosting',
    command: 'railway',
    version: '5.50.2',
    docs: 'https://docs.railway.com/cli',
    install: npmInstall({ id: 'railway', packageName: '@railway/cli', version: '5.50.2', command: 'railway' }),
    login: ['railway', 'login', '--browserless'],
    authInstructions: 'Open the Railway sign-in URL on your computer, enter the pairing code, and approve access. The CLI saves your login in your persistent home.',
    check: ['railway', 'whoami', '--json'],
    connected(result) {
      const user = jsonOutput(result);
      return Boolean(user && nonempty(user.email) && Array.isArray(user.workspaces));
    },
  },
  {
    id: 'fly',
    name: 'Fly.io',
    description: 'Deploy apps and manage Machines, secrets, volumes, and logs.',
    category: 'hosting',
    command: 'fly',
    version: '0.4.101',
    versionArgs: ['version'],
    docs: 'https://fly.io/docs/flyctl/',
    install: binaryInstall({
      command: 'fly',
      version: '0.4.101',
      repository: 'superfly/flyctl',
      checksums: {
        amd64: '81ada177239513e12e825c525290ad4de91f55a1c287d654876b6eadbb28b7f6',
        arm64: 'a9ea27a1520dbc976cc45812057b4a645bff780f8fee4604681df3058a2b5bd6',
      },
      architectures: { amd64: 'x86_64', arm64: 'arm64' },
      archive: 'flyctl_${version}_Linux_${arch}.tar.gz',
      member: 'flyctl',
      versionArgs: ['version'],
    }),
    // Requires an interactive terminal. The native PKCE flow accepts a pasted
    // completion code when the browser cannot reach the container's loopback.
    login: ['fly', 'auth', 'login'],
    authInstructions: 'Run login from an interactive terminal. Open the Fly.io URL on your computer and paste the completion code into the terminal if prompted. App deployments from Suped can use Fly remote builders (fly deploy --remote-only).',
    check: ['fly', 'auth', 'whoami', '--json'],
    connected(result) {
      return nonempty(jsonOutput(result)?.email);
    },
  },
  {
    id: 'render',
    name: 'Render',
    description: 'Web services, background workers, databases, deployments, and logs.',
    category: 'hosting',
    command: 'render',
    version: '2.26.0',
    docs: 'https://render.com/docs/cli',
    install: binaryInstall({
      command: 'render',
      version: '2.26.0',
      repository: 'render-oss/cli',
      checksums: {
        amd64: 'd8dad589005d64219869571f7278c07b717d46f53d0784f09dec3cc8eadd955f',
        arm64: '735122d26a9adb3bd07cb4f210545541958b2e9c1a4eded2fc191b1c2fbe2e05',
      },
      archive: 'cli_${version}_linux_${arch}.zip',
      archiveFormat: 'zip',
      member: 'cli_v${version}',
    }),
    // Native device flow prints a URL and continues if opening a browser fails.
    login: ['render', 'login'],
    authInstructions: 'Open the Render Dashboard URL printed by the CLI, confirm its code, and authorize the CLI. Choose a workspace with render workspace set before managing services.',
    // whoami makes a current-user API request without requiring a workspace.
    // The pinned release always prints text, including when -o json is passed.
    check: ['render', 'whoami'],
    connected(result) {
      return result?.status === 0 && typeof result.stdout === 'string' && /^Email: [^\s@]+@[^\s@]+\s*$/m.test(result.stdout);
    },
  },
];
