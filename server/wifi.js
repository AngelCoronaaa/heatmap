// Lectura del RSSI de la interfaz Wi-Fi del equipo que ejecuta el servidor.
// Se usa durante el site survey: el portátil que recorre el sitio corre el servidor
// y cada clic en el plano guarda la señal medida en ese punto.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';

function run(cmd, args, timeout = 15000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

// Conversión aproximada de calidad (%) a dBm, usada por Windows y NetworkManager.
const percentToDbm = (pct) => Math.round(pct / 2 - 100);

function parseChannel(text) {
  // "37 (6GHz, 160MHz)" | "44" | "149,1"
  const m = String(text ?? '').match(/(\d+)/);
  const band = /6\s?GHz/i.test(text) ? '6' : /5\s?GHz/i.test(text) ? '5' : /2(\.4)?\s?GHz/i.test(text) ? '2.4' : null;
  return { channel: m ? Number(m[1]) : null, band };
}

async function readMac() {
  const out = await run('system_profiler', ['SPAirPortDataType', '-json']);
  const data = JSON.parse(out);
  const ifaces = data.SPAirPortDataType?.flatMap((d) => d.spairport_airport_interfaces ?? []) ?? [];
  for (const iface of ifaces) {
    const info = iface.spairport_current_network_information;
    const sn = info?.spairport_signal_noise;
    if (!sn) continue;
    const [signal, noise] = sn.match(/-?\d+/g).map(Number);
    const { channel, band } = parseChannel(info.spairport_network_channel);
    const ssid = info._name && info._name !== '<redacted>' ? info._name : null;
    return { rssi: signal, noise, ssid, channel, band, iface: iface._name, source: 'system_profiler' };
  }
  throw new Error('No hay una red Wi-Fi conectada');
}

async function readLinux() {
  // /proc/net/wireless no requiere herramientas extra
  try {
    const text = await readFile('/proc/net/wireless', 'utf8');
    const line = text.split('\n').slice(2).find((l) => l.includes(':'));
    if (line) {
      const [iface, rest] = line.split(':');
      const cols = rest.trim().split(/\s+/);
      const level = parseFloat(cols[2]);
      const noise = parseFloat(cols[3]);
      if (Number.isFinite(level) && level < 0) {
        let ssid = null;
        try {
          ssid = (await run('iwgetid', ['-r'], 3000)).trim() || null;
        } catch {}
        return {
          rssi: Math.round(level),
          noise: Number.isFinite(noise) && noise < 0 && noise > -150 ? Math.round(noise) : null,
          ssid,
          channel: null,
          band: null,
          iface: iface.trim(),
          source: '/proc/net/wireless',
        };
      }
    }
  } catch {}

  const out = await run('nmcli', ['-t', '-f', 'ACTIVE,SSID,SIGNAL,CHAN,FREQ', 'dev', 'wifi']);
  const active = out.split('\n').find((l) => l.startsWith('yes:'));
  if (!active) throw new Error('No hay una red Wi-Fi conectada');
  // SSID puede contener ":" escapados como "\:"
  const fields = active.split(/(?<!\\):/).map((f) => f.replace(/\\:/g, ':'));
  const [, ssid, signal, chan, freq] = fields;
  const mhz = parseInt(freq, 10);
  return {
    rssi: percentToDbm(Number(signal)),
    noise: null,
    ssid: ssid || null,
    channel: Number(chan) || null,
    band: mhz > 5900 ? '6' : mhz > 5000 ? '5' : mhz ? '2.4' : null,
    iface: null,
    source: 'nmcli',
  };
}

async function readWindows() {
  const out = await run('netsh', ['wlan', 'show', 'interfaces']);
  const get = (key) => out.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, 'mi'))?.[1]?.trim();
  const signal = get('(?:Signal|Señal)');
  if (!signal) throw new Error('No hay una red Wi-Fi conectada');
  const rssiLine = get('Rssi');
  const { channel } = parseChannel(get('(?:Channel|Canal)'));
  const bandText = get('(?:Band|Banda)') ?? '';
  return {
    rssi: rssiLine ? Number(rssiLine) : percentToDbm(parseInt(signal, 10)),
    noise: null,
    ssid: get('SSID') ?? null,
    channel,
    band: parseChannel(bandText).band ?? (channel > 14 ? '5' : channel ? '2.4' : null),
    iface: get('(?:Name|Nombre)') ?? null,
    source: 'netsh',
  };
}

export async function readWifi() {
  const started = Date.now();
  try {
    let result;
    if (process.platform === 'darwin') result = await readMac();
    else if (process.platform === 'linux') result = await readLinux();
    else if (process.platform === 'win32') result = await readWindows();
    else throw new Error(`Plataforma no soportada: ${process.platform}`);
    return { ok: true, platform: process.platform, ms: Date.now() - started, ...result };
  } catch (err) {
    return { ok: false, platform: process.platform, error: err.message };
  }
}
