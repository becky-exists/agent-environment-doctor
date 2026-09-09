/**
 * Host Signals v0.1 — CPU / RAM（システム全体 + agent process）
 *
 * #69 Dogfood で「重い/遅い」に対する計器が無かったことを受けて追加。**Finding は作らない。**
 * ここは Observation。大きい/少ないの判断は Emma / ベキたんが主訴と合わせてやる。
 *
 * cross-platform = 全 OS で同じ値を取ることではない。取れない値は 0 にせず、
 * `AccessStatus`（observed / unsupported / failed / …）で言う。runtime adapter（claude-code / codex）
 * には触らない。platform 分岐が要るのはこの Host collector の中だけ。
 *
 * Windows 分岐は実機で検証していない（#69 で Windows 実機 Dogfood が未実施のまま）。
 * 使える Node 組み込み（os.totalmem / os.freemem）だけに留め、確認できない値は unsupported にしている。
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { loadavg, platform as osPlatform, totalmem, freemem } from 'node:os';
import { promisify } from 'node:util';

import { recordAccess } from '../ir/access.js';
import type { HostLoad, HostMemory, HostResources, HostSwap } from '../ir/types.js';

const execFileAsync = promisify(execFile);
const COLLECTOR = 'host';

function collectLoad(plat: string): HostLoad {
  if (plat === 'win32') {
    recordAccess({ target: 'os.loadavg', collector: COLLECTOR, what: 'system load average', status: 'unsupported', runtime: null });
    return { load1: null, load5: null, load15: null, status: 'unsupported', method: null, reason: 'Node.js os.loadavg() always returns [0, 0, 0] on Windows — there is no equivalent single-number load average exposed on this platform, so it is not reported rather than shown as 0.' };
  }
  const [load1, load5, load15] = loadavg();
  recordAccess({ target: 'os.loadavg', collector: COLLECTOR, what: 'system load average', status: 'observed', count: 3, runtime: null });
  return { load1: load1 ?? null, load5: load5 ?? null, load15: load15 ?? null, status: 'observed', method: 'os.loadavg', reason: null };
}

async function collectMemory(plat: string): Promise<HostMemory> {
  const total = totalmem();
  if (plat === 'darwin') {
    try {
      const { stdout } = await execFileAsync('vm_stat', [], { timeout: 5000 });
      const pageSizeMatch = /page size of (\d+) bytes/.exec(stdout);
      const pageSize = pageSizeMatch ? Number(pageSizeMatch[1]) : 4096;
      const pages = (label: string) => {
        const m = new RegExp(`${label}:\\s+(\\d+)\\.`).exec(stdout);
        return m ? Number(m[1]) : null;
      };
      const free = pages('Pages free');
      const inactive = pages('Pages inactive');
      if (free === null || inactive === null) throw new Error('expected fields not found in vm_stat output');
      const available = (free + inactive) * pageSize;
      recordAccess({ target: 'vm_stat', collector: COLLECTOR, what: 'system memory', status: 'observed', count: 1, runtime: null });
      return { total_bytes: total, used_bytes: total - available, available_bytes: available, status: 'observed', method: 'vm_stat (free+inactive pages)', reason: null };
    } catch (e) {
      recordAccess({ target: 'vm_stat', collector: COLLECTOR, what: 'system memory', status: 'failed', runtime: null, reason: 'vm_stat could not be run or parsed' });
      return { total_bytes: total, used_bytes: null, available_bytes: null, status: 'failed', method: 'vm_stat', reason: `vm_stat could not be read or parsed: ${(e as Error).message}` };
    }
  }
  if (plat === 'linux') {
    try {
      const text = await readFile('/proc/meminfo', 'utf8');
      const kb = (label: string) => {
        const m = new RegExp(`^${label}:\\s+(\\d+)\\s+kB`, 'm').exec(text);
        return m ? Number(m[1]) * 1024 : null;
      };
      const memTotal = kb('MemTotal');
      const memAvailable = kb('MemAvailable');
      if (memTotal === null) throw new Error('MemTotal missing from /proc/meminfo');
      if (memAvailable === null) {
        recordAccess({ target: '/proc/meminfo', collector: COLLECTOR, what: 'system memory', status: 'failed', runtime: null, reason: 'MemAvailable not present (kernel < 3.14); no reliable available-memory figure' });
        return { total_bytes: memTotal, used_bytes: null, available_bytes: null, status: 'failed', method: '/proc/meminfo', reason: 'MemAvailable not present in /proc/meminfo on this kernel (< 3.14). MemFree alone undercounts reclaimable cache, so it is not substituted.' };
      }
      recordAccess({ target: '/proc/meminfo', collector: COLLECTOR, what: 'system memory', status: 'observed', count: 1, runtime: null });
      return { total_bytes: memTotal, used_bytes: memTotal - memAvailable, available_bytes: memAvailable, status: 'observed', method: '/proc/meminfo (MemAvailable)', reason: null };
    } catch (e) {
      recordAccess({ target: '/proc/meminfo', collector: COLLECTOR, what: 'system memory', status: 'failed', runtime: null, reason: 'could not read /proc/meminfo' });
      return { total_bytes: total, used_bytes: null, available_bytes: null, status: 'failed', method: '/proc/meminfo', reason: `could not read /proc/meminfo: ${(e as Error).message}` };
    }
  }
  // win32 / その他: Node 組み込みのみ。os.freemem() は Windows では GlobalMemoryStatusEx 相当で
  // Linux の free と違って cache/reclaimable の扱いに大きな乖離が無いとされるが、実機未検証（#69）
  const free = freemem();
  recordAccess({ target: 'os.freemem', collector: COLLECTOR, what: 'system memory', status: 'observed', count: 1, runtime: null });
  return { total_bytes: total, used_bytes: total - free, available_bytes: free, status: 'observed', method: 'os.freemem (untested on real Windows — #69)', reason: null };
}

async function collectSwap(plat: string): Promise<HostSwap> {
  if (plat === 'darwin') {
    try {
      const { stdout } = await execFileAsync('sysctl', ['vm.swapusage'], { timeout: 5000 });
      const m = /total\s*=\s*([\d.]+)M\s+used\s*=\s*([\d.]+)M/.exec(stdout);
      if (!m) throw new Error('unparseable sysctl vm.swapusage output');
      const total_bytes = Math.round(Number(m[1]) * 1024 * 1024);
      const used_bytes = Math.round(Number(m[2]) * 1024 * 1024);
      recordAccess({ target: 'sysctl vm.swapusage', collector: COLLECTOR, what: 'swap', status: 'observed', count: 1, runtime: null });
      return { total_bytes, used_bytes, status: 'observed', method: 'sysctl vm.swapusage', reason: null };
    } catch (e) {
      recordAccess({ target: 'sysctl vm.swapusage', collector: COLLECTOR, what: 'swap', status: 'failed', runtime: null, reason: 'sysctl could not be run or parsed' });
      return { total_bytes: null, used_bytes: null, status: 'failed', method: 'sysctl vm.swapusage', reason: `sysctl could not be read or parsed: ${(e as Error).message}` };
    }
  }
  if (plat === 'linux') {
    try {
      const text = await readFile('/proc/meminfo', 'utf8');
      const kb = (label: string) => {
        const m = new RegExp(`^${label}:\\s+(\\d+)\\s+kB`, 'm').exec(text);
        return m ? Number(m[1]) * 1024 : null;
      };
      const swapTotal = kb('SwapTotal');
      const swapFree = kb('SwapFree');
      if (swapTotal === null || swapFree === null) throw new Error('Swap fields missing from /proc/meminfo');
      recordAccess({ target: '/proc/meminfo', collector: COLLECTOR, what: 'swap', status: 'observed', count: 1, runtime: null });
      return { total_bytes: swapTotal, used_bytes: swapTotal - swapFree, status: 'observed', method: '/proc/meminfo', reason: null };
    } catch (e) {
      recordAccess({ target: '/proc/meminfo', collector: COLLECTOR, what: 'swap', status: 'failed', runtime: null, reason: 'could not read swap fields' });
      return { total_bytes: null, used_bytes: null, status: 'failed', method: '/proc/meminfo', reason: `could not read /proc/meminfo: ${(e as Error).message}` };
    }
  }
  recordAccess({ target: 'swap', collector: COLLECTOR, what: 'swap', status: 'unsupported', runtime: null, reason: 'not implemented for this platform yet' });
  return { total_bytes: null, used_bytes: null, status: 'unsupported', method: null, reason: 'Swap / page-file observation is not implemented for this platform yet — it needs verification on a real machine before being added (#69 Windows Dogfood is still outstanding), so it is left unsupported rather than guessed.' };
}

/**
 * システム全体の CPU load / memory / swap。agent process 別の CPU%・RSS は probe/process.ts 側が持つ
 * （同じ ps 呼び出しを再利用するため）。
 * `platformOverride` はテスト専用（win32 分岐を実機 Windows なしで検証するため）。省略時は実際の platform。
 */
export async function collectHostResources(platformOverride?: string): Promise<Omit<HostResources, 'processes'>> {
  const plat = platformOverride ?? osPlatform();
  const [load, memory, swap] = await Promise.all([Promise.resolve(collectLoad(plat)), collectMemory(plat), collectSwap(plat)]);
  return { observed_at: new Date().toISOString(), platform: plat, load, memory, swap };
}
