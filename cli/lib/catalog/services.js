import { binaryInstall, npmInstall, jsonOutput } from './installers.js';

// Provider versions and official release checksums verified September 9, 2026.
// Each CLI owns its credentials. Suped records tool selections, never tokens.
const neonLogin = `set +x
set -euo pipefail
if CI=1 neon api /projects --output json >/dev/null 2>&1; then
  printf 'Neon is already connected. Existing credentials were kept.\\n'
  exit 0
fi
if [ -n "\${NEON_API_KEY:-}" ]; then
  printf 'The exported NEON_API_KEY could not be verified. Update or unset it before connecting a saved profile.\\n' >&2
  exit 1
fi
printf 'Create a Neon API key at https://console.neon.tech/app/settings/api-keys\\n'
printf 'The Neon CLI will validate and save it in your active profile (%s).\\n' "\${NEON_PROFILE:-DEFAULT}"
printf 'Neon API key (hidden; Enter to cancel): ' >&2
trap 'unset suped_neon_token' EXIT
if ! IFS= read -r -s suped_neon_token; then
  printf '\\nConnection cancelled.\\n' >&2
  exit 1
fi
printf '\\n' >&2
if [ -z "\${suped_neon_token//[[:space:]]/}" ]; then
  printf 'Connection cancelled.\\n' >&2
  exit 1
fi
printf '%s' "$suped_neon_token" | neon profile create "\${NEON_PROFILE:-DEFAULT}" --api-key -
`;

export const SERVICE_TOOLS = [
  {
    id: 'neon',
    name: 'Neon',
    description: 'Serverless Postgres projects, databases, branches, and migrations.',
    category: 'database',
    command: 'neon',
    version: '4.14.5',
    install: npmInstall({ id: 'neon', packageName: 'neon', version: '4.14.5', command: 'neon' }),
    // This release's browser login binds a random container-only localhost port.
    // A masked prompt pipes directly into the provider's supported stdin flow.
    login: ['bash', '--noprofile', '--norc', '-c', neonLogin],
    authInstructions: 'Create an API key in your Neon account settings. Paste it at the hidden prompt; the Neon CLI validates it and saves it in its own active profile. A valid existing connection is kept.',
    check: ['env', 'CI=1', 'neon', 'api', '/projects', '--output', 'json'],
    connected(result) {
      return Array.isArray(jsonOutput(result)?.projects);
    },
    docs: 'https://neon.com/docs/cli',
  },
  {
    id: 'turso',
    name: 'Turso',
    description: 'Hosted SQLite and libSQL databases with replicas and branching.',
    category: 'database',
    command: 'turso',
    version: '1.0.32',
    install: binaryInstall({
      command: 'turso', version: '1.0.32', repository: 'tursodatabase/turso-cli',
      checksums: {
        amd64: 'c35acbcad8e2e7a32580fe380adc4658d3032ddc56d25396b9b123aa4a704107',
        arm64: '672f29e8f77b4c30a5f31c04fe0d5636d29fb1bb5be1137c40234bb2e76c2150',
      },
      architectures: { amd64: 'x86_64', arm64: 'arm64' },
      archive: 'turso-cli_Linux_${arch}.tar.gz', member: 'turso',
    }),
    // --headless only prints a URL; it does not complete authentication.
    // This pinned CLI's token persistence command has no stdin option.
    login: null,
    authInstructions: 'In `suped shell`, run `turso auth login --headless`, open its URL, and follow the provider instructions to save the token with `turso config set token`. Turn off shell history before pasting the provider command (`set +o history`). Then run `suped tools` from your host to verify. Turso login tokens expire after one week.',
    check: ['turso', 'auth', 'whoami'],
    connected(result) {
      // Logged-out Turso can exit 0 with a human sentence. whoami emits only
      // the username after an authenticated GET /v1/auth/user succeeds.
      return result?.status === 0 && typeof result.stdout === 'string'
        && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(result.stdout.trim());
    },
    docs: 'https://docs.turso.tech/cli/headless-mode',
  },
  {
    id: 'planetscale',
    name: 'PlanetScale',
    description: 'Managed Postgres and Vitess databases, branches, and deploy requests.',
    category: 'database',
    command: 'pscale',
    version: '0.330.0',
    versionArgs: ['version'],
    install: binaryInstall({
      command: 'pscale', version: '0.330.0', repository: 'planetscale/cli',
      checksums: {
        amd64: 'd2ab5501b52cf7076a70042b84ac08bba9c5c9bbe5f68a0d5787eedcb72678d7',
        arm64: 'c54397fae24ad9ffb27408cdabe27fd76704bfe622b5d3ae4d6792f5cdae8401',
      },
      archive: 'pscale_${version}_linux_${arch}.tar.gz', member: 'pscale', versionArgs: ['version'],
    }),
    // JSON mode supports device-code polling without a desktop keychain.
    // The native CLI falls back to its home config file if no keyring exists.
    login: ['env', 'BROWSER=echo', 'pscale', 'auth', 'login', '--format', 'json'],
    authInstructions: 'Open the verification_url PlanetScale prints, enter its user_code if requested, and approve access. The CLI waits for approval and saves the connection. Choose an organization in PlanetScale if it asks you to finish account setup.',
    check: ['pscale', 'auth', 'check', '--format', 'json'],
    connected(result) {
      const value = jsonOutput(result);
      return value?.status === 'ok' && value.authenticated === true;
    },
    docs: 'https://planetscale.com/docs/cli/auth',
  },
  {
    id: 'firebase',
    name: 'Firebase',
    description: 'Hosting, Firestore, authentication, functions, and app projects.',
    category: 'cloud',
    command: 'firebase',
    version: '15.29.0',
    install: npmInstall({ id: 'firebase', packageName: 'firebase-tools', version: '15.29.0', command: 'firebase' }),
    login: ['firebase', 'login', '--no-localhost'],
    authInstructions: 'Open the Firebase sign-in URL in your browser, sign in with Google, and paste the authorization code into the Firebase CLI when prompted.',
    check: ['firebase', 'projects:list', '--json', '--non-interactive'],
    connected(result) {
      const value = jsonOutput(result);
      return value?.status === 'success' && Array.isArray(value.result);
    },
    docs: 'https://firebase.google.com/docs/cli',
  },
  {
    id: 'digitalocean',
    name: 'DigitalOcean',
    description: 'App Platform, Droplets, managed databases, and cloud infrastructure.',
    category: 'cloud',
    command: 'doctl',
    version: '1.168.0',
    versionArgs: ['version'],
    install: binaryInstall({
      command: 'doctl', version: '1.168.0', repository: 'digitalocean/doctl',
      checksums: {
        amd64: 'ad817330e1a12fd60729f105d8c39af31ca845f221a60886a1b2215f74d9b35d',
        arm64: 'cb5bc103b00e83021f348e555df703f9b5a40d50be5ddbd549e867f4039ae3cb',
      },
      archive: 'doctl-${version}-linux-${arch}.tar.gz', member: 'doctl', versionArgs: ['version'],
      // The official Linux binary reports a release suffix, then a Git hash.
      versionPattern: "\"doctl version 1.168.0-release\"|\"doctl version 1.168.0-release\"$'\\n'*",
    }),
    login: ['doctl', 'auth', 'init'],
    authInstructions: 'Create a personal access token at https://cloud.digitalocean.com/account/api/tokens with account read access and the permissions your work needs. Paste it at the doctl token prompt; doctl validates and saves it.',
    check: ['doctl', 'account', 'get', '--output', 'json'],
    connected(result) {
      const account = jsonOutput(result);
      return typeof account?.uuid === 'string' && account.uuid.length > 0
        && typeof account.email === 'string' && account.email.length > 0;
    },
    docs: 'https://docs.digitalocean.com/reference/doctl/how-to/install/',
  },
  {
    id: 'stripe',
    name: 'Stripe',
    description: 'Payments integration, test data, products, and webhook development.',
    category: 'payments',
    command: 'stripe',
    version: '1.50.10',
    install: binaryInstall({
      command: 'stripe', version: '1.50.10', repository: 'stripe/stripe-cli',
      checksums: {
        amd64: 'de57a83f97c813bb2440d06db4345a2361e57dd684198452cd121e9f22479b38',
        arm64: '173b74ce056029055097d0d2dfdecb9559a255febd6bacc30fd3f24cb0fbc8b1',
      },
      architectures: { amd64: 'x86_64', arm64: 'arm64' },
      archive: 'stripe_${version}_linux_${arch}.tar.gz', member: 'stripe',
    }),
    login: ['env', 'BROWSER=echo', 'stripe', 'login'],
    authInstructions: 'Open the Stripe verification URL in your browser and approve the displayed pairing code. Choose the account or sandbox for your work. If Stripe prints a next_step command, run it inside `suped shell` to finish authorization.',
    // Captured stdin is noninteractive, so this release fails rather than
    // initiating automatic login when no credentials exist.
    check: ['stripe', 'get', '/v1/account'],
    connected(result) {
      const account = jsonOutput(result);
      return account?.object === 'account' && typeof account.id === 'string' && /^acct_[A-Za-z0-9]+$/.test(account.id);
    },
    docs: 'https://docs.stripe.com/cli/login',
  },
];
