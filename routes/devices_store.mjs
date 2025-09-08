import fs from "fs";
import path from "path";

const storeDir = process.env.DEVICES_STORE_DIR || (fs.existsSync("/data") ? "/data" : process.cwd());
try { if (!fs.existsSync(storeDir)) fs.mkdirSync(storeDir, { recursive: true }); } catch {}
const devicesFile = path.join(storeDir, "devices.json");

function readFileJSON(file) {
  try {
    if (!fs.existsSync(file)) return {};
    const data = fs.readFileSync(file, "utf8");
    return JSON.parse(data || "{}") || {};
  } catch (e) {
    console.error("[devices_store] read error:", e?.message || e);
    return {};
  }
}

function writeFileJSON(file, obj) {
  try {
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), "utf8");
    return true;
  } catch (e) {
    console.error("[devices_store] write error:", e?.message || e);
    return false;
  }
}

export function getDevices() {
  return readFileJSON(devicesFile);
}

export function saveDevices(devices) {
  return writeFileJSON(devicesFile, devices);
}

export function upsertDevice({ mac, chipId = '', model = 'ESP32', firmware = '1.0.0', firstSeen = null }) {
  const devices = getDevices();
  const deviceId = (mac || '').replace(/:/g, '').toLowerCase();
  if (!deviceId) throw new Error("mac required");

  const nowIso = new Date().toISOString();
  const existing = devices[deviceId] || {};
  const device = {
    mac,
    chipId: chipId || existing.chipId || '',
    model: model || existing.model || 'ESP32',
    firmware: firmware || existing.firmware || '1.0.0',
    firstSeen: existing.firstSeen || firstSeen || nowIso,
    lastSeen: nowIso,
    status: 'online',
    name: existing.name || `CalcAI-${(mac || '').slice(-5)}`,
    updateAvailable: existing.updateAvailable || false,
    targetFirmware: existing.targetFirmware || null,
    // Update status fields
    lastUpdatePingAt: existing.lastUpdatePingAt || null,
    lastUpdateStatus: existing.lastUpdateStatus || null,
    updatedAt: existing.updatedAt || null,
  };
  devices[deviceId] = device;
  saveDevices(devices);
  return { deviceId, device };
}

export function setUpdateFlags(deviceId, { updateAvailable, targetFirmware }) {
  const devices = getDevices();
  const d = devices[deviceId];
  if (!d) return false;
  if (typeof updateAvailable !== 'undefined') d.updateAvailable = !!updateAvailable;
  if (typeof targetFirmware !== 'undefined') d.targetFirmware = targetFirmware || null;
  d.lastSeen = new Date().toISOString();
  // If target cleared or already on target, clear updateAvailable
  if (d.targetFirmware && d.firmware && d.firmware === d.targetFirmware) {
    d.updateAvailable = false;
    d.lastUpdateStatus = 'updated';
    d.updatedAt = new Date().toISOString();
  }
  saveDevices(devices);
  return true;
}

export function pingDevice({ mac, firmware = null, rssi = null }) {
  const devices = getDevices();
  const deviceId = (mac || '').replace(/:/g, '').toLowerCase();
  const d = devices[deviceId];
  if (!d) return { ok: false, notFound: true };
  const nowIso = new Date().toISOString();
  d.lastSeen = nowIso;
  d.status = 'online';
  if (firmware) d.firmware = firmware;
  if (typeof rssi === 'number') d.rssi = rssi;
  d.lastUpdatePingAt = nowIso;
  // Derive update status for dashboard
  if (d.targetFirmware && d.firmware === d.targetFirmware) {
    d.updateAvailable = false;
    d.lastUpdateStatus = 'updated';
    d.updatedAt = nowIso;
  } else {
    d.lastUpdateStatus = d.updateAvailable ? 'not_updated' : 'updated';
  }
  saveDevices(devices);
  return { ok: true, deviceId, device: d };
}
