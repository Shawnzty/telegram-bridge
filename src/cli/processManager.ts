import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import { execSync } from 'node:child_process';
import type { ModelConfig, ReasoningLevel } from '../config.js';

export interface SpawnOptions {
  prompt: string;
  model: ModelConfig;
  cwd: string;
  continueSession?: string;
  reasoningLevel?: ReasoningLevel;
  fullPermissions?: boolean;
}

// Resolve full path to a CLI binary using the user's shell
function resolveCommand(cmd: string): string {
  try {
    return execSync(`which ${cmd}`, { encoding: 'utf-8' }).trim();
  } catch {
    return cmd; // Fall back to bare command name
  }
}

// Cache resolved paths
const resolvedPaths = new Map<string, string>();

function getCommandPath(cmd: string): string {
  if (!resolvedPaths.has(cmd)) {
    resolvedPaths.set(cmd, resolveCommand(cmd));
  }
  return resolvedPaths.get(cmd)!;
}

export class ProcessManager {
  buildArgs(options: SpawnOptions): { command: string; args: string[] } {
    if (options.model.cli === 'claude') {
      const args = [
        '-p',
        options.prompt,
        '--model',
        options.model.model,
        '--verbose',
      ];
      if (options.fullPermissions) {
        args.push('--dangerously-skip-permissions');
      }
      if (options.continueSession) {
        args.push('--resume', options.continueSession);
      }
      return { command: getCommandPath('claude'), args };
    } else {
      // Codex CLI
      const reasoningValue = options.reasoningLevel === 'extra_high'
        ? 'extra_high'
        : (options.reasoningLevel ?? 'medium');
      const permissionArgs = options.fullPermissions
        ? ['--dangerously-bypass-approvals-and-sandbox']
        : ['--full-auto'];
      const args = ['exec', options.prompt, '-m', options.model.model,
        '-c', `reasoning_effort="${reasoningValue}"`];
      args.push(...permissionArgs);
      if (options.continueSession) {
        return {
          command: getCommandPath('codex'),
          args: [
            'exec',
            'resume',
            '--last',
            options.prompt,
            '-m',
            options.model.model,
            '-c',
            `reasoning_effort="${reasoningValue}"`,
            ...permissionArgs,
          ],
        };
      }
      return { command: getCommandPath('codex'), args };
    }
  }

  spawn(options: SpawnOptions): IPty {
    const { command, args } = this.buildArgs(options);

    // Filter out undefined env values — node-pty's native posix_spawnp
    // crashes if any env value is undefined
    const cleanEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        cleanEnv[key] = value;
      }
    }
    cleanEnv.TERM = 'xterm-256color';
    cleanEnv.NO_COLOR = '1';
    cleanEnv.FORCE_COLOR = '0';

    console.log(`Spawning: ${command} ${args.join(' ')}`);
    console.log(`  CWD: ${options.cwd}`);

    const ptyProcess = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: options.cwd,
      env: cleanEnv,
    });

    return ptyProcess;
  }

  spawnShell(command: string, cwd: string): IPty {
    const cleanEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        cleanEnv[key] = value;
      }
    }
    cleanEnv.TERM = 'xterm-256color';
    cleanEnv.NO_COLOR = '1';
    cleanEnv.FORCE_COLOR = '0';

    const shell = process.env.SHELL ?? '/bin/zsh';
    console.log(`Spawning shell: ${shell} -c ${command}`);
    console.log(`  CWD: ${cwd}`);

    const ptyProcess = pty.spawn(shell, ['-c', command], {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd,
      env: cleanEnv,
    });

    return ptyProcess;
  }

  sendStdin(proc: IPty, text: string): void {
    proc.write(text);
  }

  stop(proc: IPty): void {
    proc.kill('SIGINT');
  }

  kill(proc: IPty): void {
    proc.kill('SIGKILL');
  }
}
