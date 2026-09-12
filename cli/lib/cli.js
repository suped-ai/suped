import * as computer from './computer.js';

const HELP = `suped ${computer.VERSION} — a suped-up workspace for agents.

usage
  suped                    open a shell in your computer (creates it on first run)
  suped up                 start the computer without attaching
  suped exec <command...>  run a command inside the computer
  suped catalog           browse optional CLIs by category (no Docker needed)
  suped setup [tools...]   choose tools and connect your accounts
  suped tools [tools...]   show installed tools and their authentication status
  suped login <tools...>   authenticate selected tools again
  suped mcp list          browse curated app connections (no Docker needed)
  suped mcp add <ids...> --client codex|claude   configure a client's MCP servers
  suped mcp export <ids...> --client codex|claude|cursor   print client config
  suped sync               show what defines this workspace, and what would not move
  suped sync save <file>   write the workspace to a portable file (no credentials)
  suped sync restore <file>   install that workspace's tools and clone its projects
  suped secrets            show which account access can travel, and what cannot
  suped secrets key        create this workspace's encryption identity
  suped secrets save <file>    seal the credentials that can travel
  suped secrets restore <file> open a sealed file and sign those tools back in
  suped status             show image / volume / container state
  suped stop               stop the computer (home is kept)
  suped reset              recreate the container from the current image (home is kept, apt installs are not)
  suped rebuild            rebuild the image, then reset
  suped destroy --yes      remove the container AND the persistent home
  suped prompt             print the system prompt to hand to an agent

options (used when the container is first created)
  -p, --publish <host:container>   publish a port (repeatable)
  -v, --volume  <host:container>   mount an extra host path (repeatable)
  --with <features>               bake optional software into the image (comma separated)
  --without                       bake none of it in
  --skip-auth                     install selected tools without signing in (setup)

optional software (--with), baked into the image so it survives reset
  browser   Playwright driving headless Chromium, for automation and JS-heavy pages
  build     a C toolchain, for packages that compile native extensions
  media     ffmpeg and its codecs

the base reads pages with curl, w3m and lynx, which covers most research without a browser.
change what is baked in with "suped rebuild --with browser"; the selection is part of the image tag.

exec accepts one quoted shell command, or a program followed by exact arguments.
put Suped's port/mount options before exec; everything after exec belongs to the command.
reset/rebuild preserve ports and mounts; -p or -v replaces the corresponding list.

environment
  SUPED_CONTAINER  container name   (default: ${computer.CONTAINER})
  SUPED_VOLUME     home volume name (default: ${computer.VOLUME})
  SUPED_IMAGE      image tag        (default: ${computer.IMAGE})

the computer is a Linux container with a persistent /home/suped.
files and credentials in your home survive reset/rebuild; system package installs do not.
`;

const log = (msg) => console.error(`suped: ${msg}`);

/** Split argv into { command, args, runArgs, flags } without any library. */
export function parseArgs(argv) {
  const runArgs = [];
  const flags = new Set();
  const rest = [];
  let features = null;
  const addFeatures = (value) => {
    features = (features ?? []).concat(value.split(/[\s,]+/).filter(Boolean));
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (a === '--with') {
      const value = argv[++i];
      if (!value || value.startsWith('-')) throw new Error('missing value for --with (e.g. --with browser,media)');
      addFeatures(value);
    }
    else if (a.startsWith('--with=')) {
      const value = a.slice('--with='.length);
      if (!value) throw new Error('missing value for --with (e.g. --with browser,media)');
      addFeatures(value);
    }
    else if (a === '--without') {
      // An explicit empty selection, so "rebuild --without" strips extras.
      features = features ?? [];
    }
    else if (a === '-p' || a === '--publish' || a === '-v' || a === '--volume') {
      const value = argv[++i];
      if (!value || value.startsWith('-')) throw new Error('missing value for -p/--publish or -v/--volume');
      runArgs.push(a === '-p' || a === '--publish' ? '-p' : '-v', value);
    }
    else if (a.startsWith('--publish=') || a.startsWith('--volume=')) {
      const value = a.slice(a.indexOf('=') + 1);
      if (!value) throw new Error('missing value for -p/--publish or -v/--volume');
      runArgs.push(a.startsWith('--publish=') ? '-p' : '-v', value);
    }
    else if (a.startsWith('--') || (a.startsWith('-') && a.length === 2)) flags.add(a.replace(/^-+/, ''));
    else {
      rest.push(a);
      if (rest.length === 1 && (a === 'exec' || a === 'mcp')) {
        const start = argv[i + 1] === '--' ? i + 2 : i + 1;
        rest.push(...argv.slice(start));
        break;
      }
    }
  }
  if (runArgs.includes(undefined)) throw new Error('missing value for -p/--publish or -v/--volume');
  const [command = 'shell', ...args] = rest;
  return { command, args, runArgs, flags, features };
}

function warnIfStale(stale) {
  if (stale) log(`container was created from an older image; run "suped reset" to recreate it (your home is kept)`);
}

async function firstRunSetup() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return 0;
  const { setupIfNeeded } = await import('./setup.js');
  return setupIfNeeded();
}

export async function main(argv) {
  const { command, args, runArgs, flags, features } = parseArgs(argv);

  if (flags.has('help') || flags.has('h') || command === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (flags.has('version') || flags.has('V') || command === 'version') {
    console.log(computer.VERSION);
    return 0;
  }

  switch (command) {
    case 'shell': {
      const { stale } = computer.ensureUp({ runArgs, features: features ?? [], log });
      warnIfStale(stale);
      const setupStatus = await firstRunSetup();
      if (setupStatus) return setupStatus;
      return computer.shell();
    }

    case 'up': {
      const { created, stale } = computer.ensureUp({ runArgs, features: features ?? [], log });
      warnIfStale(stale);
      const setupStatus = await firstRunSetup();
      if (setupStatus) return setupStatus;
      log(created ? `${computer.CONTAINER} is up (new)` : `${computer.CONTAINER} is up`);
      return 0;
    }

    case 'exec': {
      if (args.length === 0) throw new Error('exec: nothing to run. usage: suped exec <command...>');
      const { stale } = computer.ensureUp({ runArgs, features: features ?? [], log });
      warnIfStale(stale);
      return computer.exec(args.length === 1 ? args[0] : args);
    }

    case 'setup': {
      if (args.length) (await import('./tools.js')).getTools(args);
      const { stale } = computer.ensureUp({ runArgs, features: features ?? [], log });
      warnIfStale(stale);
      const { setup } = await import('./setup.js');
      return setup({ tools: args.length ? args : null, authenticate: !flags.has('skip-auth') });
    }

    case 'tools': {
      if (args.length) (await import('./tools.js')).getTools(args);
      const { stale } = computer.ensureUp({ runArgs, features: features ?? [], log });
      warnIfStale(stale);
      const { showTools } = await import('./setup.js');
      return showTools(args);
    }

    case 'login': {
      if (args.length === 0) throw new Error('login: choose at least one tool. Run "suped catalog" for choices.');
      (await import('./tools.js')).getTools(args);
      const { stale } = computer.ensureUp({ runArgs, features: features ?? [], log });
      warnIfStale(stale);
      const { loginTools } = await import('./setup.js');
      return loginTools(args);
    }

    case 'catalog':
      if (args.length) throw new Error('usage: suped catalog');
      return (await import('./tools.js')).showCatalog();

    case 'mcp':
      return (await import('./mcp.js')).mainMcp(args, { runArgs });

    case 'sync':
      return (await import('./sync.js')).mainSync(args, { runArgs });

    case 'secrets':
      return (await import('./secrets.js')).mainSecrets(args, { runArgs });

    case 'status': {
      const s = computer.status();
      const rows = [
        ['docker', s.docker ? 'available' : 'NOT AVAILABLE'],
        ['image', `${s.image} ${s.docker ? (s.imageExists ? '(built)' : '(not built)') : '(unknown)'}`],
        ['baked in', s.features.length ? s.features.join(', ') : '(base only)'],
        ['home', `${s.volume} ${s.docker ? (s.volumeExists ? '(exists)' : '(none)') : '(unknown)'}`],
        ['container', `${s.container} ${s.docker ? (s.state ?? '(none)') : '(unknown)'}`],
      ];
      if (s.containerImage && s.containerImage !== s.image) rows.push(['note', `container uses ${s.containerImage}; run "suped reset"`]);
      for (const [k, v] of rows) console.log(`${k.padEnd(10)} ${v}`);
      return 0;
    }

    case 'stop': {
      const state = computer.containerState();
      if (state === 'running') {
        computer.stopContainer();
        log('stopped');
      } else {
        log(state ? `already ${state}` : 'no container to stop');
      }
      return 0;
    }

    case 'reset': {
      computer.resetComputer({ runArgs, features, log });
      log('container recreated; home kept');
      return 0;
    }

    case 'rebuild': {
      computer.resetComputer({ runArgs, features, rebuild: true, noCache: flags.has('no-cache'), log });
      log('rebuilt; home kept');
      return 0;
    }

    case 'destroy': {
      if (!flags.has('yes')) {
        throw new Error(`destroy removes the container AND everything in ${computer.HOME}. Re-run with --yes to confirm.`);
      }
      if (computer.containerState() !== null) computer.removeContainer();
      if (computer.volumeExists()) computer.removeVolume();
      log('destroyed');
      return 0;
    }

    case 'prompt': {
      console.log(computer.systemPrompt());
      return 0;
    }

    default:
      throw new Error(`unknown command "${command}". Try "suped --help".`);
  }
}
