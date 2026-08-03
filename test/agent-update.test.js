import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

const skip = process.platform === 'win32' ? 'requires POSIX shell utilities' : false;

async function executable(path, contents) {
  await writeFile(path, contents, 'utf8');
  await chmod(path, 0o755);
}

async function runUpdater({ failHealth = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'netpilot-agent-update-'));
  const binDirectory = join(directory, 'bin');
  const agentBinary = join(directory, 'netpilot-agent');
  const releaseBinary = join(directory, 'release-agent');
  const nexttraceRelease = join(directory, 'nexttrace-release');
  const nexttraceLicenseRelease = join(directory, 'nexttrace-license-release');
  const nexttraceBinary = join(directory, 'installed', 'nexttrace');
  const nexttraceLicense = join(directory, 'installed', 'LICENSE');
  const serviceLog = join(directory, 'service.log');
  await mkdir(binDirectory);
  await executable(agentBinary, '#!/bin/sh\necho v0.1.2\n');
  await executable(releaseBinary, '#!/bin/sh\necho v0.1.3\n');
  await executable(nexttraceRelease, '#!/bin/sh\necho NextTrace v1.7.1\n');
  await writeFile(nexttraceLicenseRelease, 'GPL-3.0 test fixture\n', 'utf8');
  const checksum = (await import('node:crypto')).createHash('sha256').update(await readFile(releaseBinary)).digest('hex');
  await writeFile(join(directory, 'SHA256SUMS'), `${checksum}  netpilot-agent-linux-amd64\n`, 'utf8');
  await executable(join(binDirectory, 'id'), '#!/bin/sh\necho 0\n');
  await executable(join(binDirectory, 'uname'), '#!/bin/sh\necho x86_64\n');
  await executable(join(binDirectory, 'curl'), `#!/bin/sh\nurl=""\ndestination=""\nwhile [ "$#" -gt 0 ]; do\n  case "$1" in\n    http*) url="$1" ;;\n    -o) shift; destination="$1" ;;\n  esac\n  shift\ndone\ncase "$url" in\n  */SHA256SUMS) cp '${join(directory, 'SHA256SUMS')}' "$destination" ;;\n  */nexttrace_linux_amd64) cp '${nexttraceRelease}' "$destination" ;;\n  */LICENSE) cp '${nexttraceLicenseRelease}' "$destination" ;;\n  *) cp '${releaseBinary}' "$destination" ;;\nesac\n`);
  await executable(join(binDirectory, 'sha256sum'), `#!/bin/sh\ncase "$1" in\n  */nexttrace) echo '1f4c559cbdf6f667a1a9e050567c9cf1fc11741e8cc1e50f5fdcaf2dbb247232  '"$1" ;;\n  */NEXTTRACE-LICENSE) echo '3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986  '"$1" ;;\n  *) /usr/bin/sha256sum "$@" ;;\nesac\n`);
  await executable(join(binDirectory, 'systemctl'), `#!/bin/sh\necho "$1" >> '${serviceLog}'\ncase "$1" in\n  cat|stop|start) exit 0 ;;\n  is-active) [ "${failHealth ? '1' : '0'}" = 0 ] ;;
  *) exit 1 ;;
esac\n`);

  const updater = resolve(import.meta.dirname, '../public/update-agent.sh');
  const child = spawn('sh', [updater], {
    env: {
      ...process.env,
      PATH: `${binDirectory}${delimiter}${process.env.PATH}`,
      NETPILOT_UPDATE_MODE: 'native',
      NETPILOT_AGENT_BINARY: agentBinary,
      NETPILOT_NEXTTRACE_BINARY: nexttraceBinary,
      NETPILOT_NEXTTRACE_LICENSE: nexttraceLicense
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolvePromise) => child.on('close', resolvePromise));
  const version = (await readFile(agentBinary, 'utf8')).match(/v\d+\.\d+\.\d+/)?.[0];
  const nexttraceVersion = (await readFile(nexttraceBinary, 'utf8')).match(/v\d+\.\d+\.\d+/)?.[0];
  const log = await readFile(serviceLog, 'utf8');
  await rm(directory, { recursive: true, force: true });
  return { exitCode, stdout, stderr, version, nexttraceVersion, log };
}

test('native Agent updater verifies and replaces the binary', { skip }, async () => {
  const result = await runUpdater();
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.version, 'v0.1.3');
  assert.equal(result.nexttraceVersion, 'v1.7.1');
  assert.match(result.stdout, /updated to v0\.1\.3/);
  assert.match(result.log, /stop\nstart\nis-active/);
});

test('native Agent updater rolls back when the service is unhealthy', { skip }, async () => {
  const result = await runUpdater({ failHealth: true });
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.version, 'v0.1.2');
  assert.match(result.stderr, /restoring previous Agent binary/);
  assert.match(result.log, /stop\nstart\nis-active\nstop\nstart/);
});
