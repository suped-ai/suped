import * as computer from './computer.js';

const HELP = `suped ${computer.VERSION} — give the agent a computer

usage
  suped                    open a shell in your computer (creates it on first run)
  suped up                 start the computer without attaching
  suped exec <command...>  run a command inside the computer
  suped status             show image / volume / container state
  suped stop               stop the computer (home is kept)
  suped reset              recreate the container from the current image (home is kept, apt installs are not)
  suped rebuild            rebuild the image, then reset
  suped destroy --yes      remove the container AND the persistent home
  suped prompt             print the system prompt to hand to an agent

options (used when the container is first created)
  -p, --publish <host:container>   publish a port (repeatable)
  -v, --volume  <host:container>   mount an extra host path (repeatable)

environment
  SUPED_CONTAINER  container name   (default: ${computer.CONTAINER})
  SUPED_VOLUME     home volume name (default: ${computer.VOLUME})
  SUPED_IMAGE      image tag        (default: ${computer.IMAGE})

the computer is a Linux container with a persistent /home/suped.
everything you install, clone, configure or authenticate stays there.
`;

const log = (msg) => console.error(`suped: ${msg}`);

/** Split argv into { command, args, runArgs, flags } without any library. */
export function parseArgs(argv) {
  const runArgs = [];
  const flags = new Set();
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (a === '-p' || a === '--publish') runArgs.push('-p', argv[++i]);
    else if (a === '-v' || a === '--volume') runArgs.push('-v', argv[++i]);
    else if (a.startsWith('--publish=')) runArgs.push('-p', a.slice(10));
    else if (a.startsWith('--volume=')) runArgs.push('-v', a.slice(9));
    else if (a.startsWith('--') || (a.startsWith('-') && a.length === 2)) flags.add(a.replace(/^-+/, ''));
    else rest.push(a);
  }
  if (runArgs.includes(undefined)) throw new Error('missing value for -p/--publish or -v/--volume');
  const [command = 'shell', ...args] = rest;
  return { command, args, runArgs, flags };
}

function warnIfStale(stale) {
  if (stale) log(`container was created from an older image; run "suped reset" to recreate it (your home is kept)`);
}

export async function main(argv) {
  const { command, args, runArgs, flags } = parseArgs(argv);

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
      const { stale } = computer.ensureUp({ runArgs, log });
      warnIfStale(stale);
      return computer.shell();
    }

    case 'up': {
      const { created, stale } = computer.ensureUp({ runArgs, log });
      warnIfStale(stale);
      log(created ? `${computer.CONTAINER} is up (new)` : `${computer.CONTAINER} is up`);
      return 0;
    }

    case 'exec': {
      if (args.length === 0) throw new Error('exec: nothing to run. usage: suped exec <command...>');
      const { stale } = computer.ensureUp({ runArgs, log });
      warnIfStale(stale);
      return computer.exec(args.join(' '));
    }

    case 'status': {
      const s = computer.status();
      const rows = [
        ['docker', s.docker ? 'available' : 'NOT AVAILABLE'],
        ['image', `${s.image} ${s.imageExists ? '(built)' : '(not built)'}`],
        ['home', `${s.volume} ${s.volumeExists ? '(exists)' : '(none)'}`],
        ['container', `${s.container} ${s.state ?? '(none)'}`],
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
      if (computer.containerState() !== null) computer.removeContainer();
      computer.ensureUp({ runArgs, log });
      log('container recreated; home kept');
      return 0;
    }

    case 'rebuild': {
      if (!computer.hasDocker()) throw new Error('Docker is not available');
      log(`rebuilding ${computer.IMAGE}`);
      computer.buildImage(computer.IMAGE, { noCache: flags.has('no-cache') });
      if (computer.containerState() !== null) computer.removeContainer();
      computer.ensureUp({ runArgs, log });
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
