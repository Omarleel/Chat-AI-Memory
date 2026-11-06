import {spawn, spawnSync} from 'node:child_process';

// Procesos del equipo anfitrión. En Windows se termina el árbol completo (python, docker, etc.).
export const hostProcesses = {
  spawn(command, args, {cwd}) {
    const child = spawn(command, args, {cwd, windowsHide: true, env: {...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8'}});
    const exited = new Promise(resolve => {
      child.on('error', () => resolve(-1));
      child.on('close', code => resolve(code ?? -1));
    });
    return {
      exited,
      onOutput(fn) {child.stdout.setEncoding('utf8').on('data', fn); child.stderr.setEncoding('utf8').on('data', fn);},
      kill() {
        if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {windowsHide: true});
        else child.kill('SIGTERM');
      }
    };
  }
};

export function detectGpu() {
  const result = spawnSync('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader'], {encoding: 'utf8', windowsHide: true});
  return result.status === 0 ? result.stdout.trim().split('\n')[0] : '';
}
