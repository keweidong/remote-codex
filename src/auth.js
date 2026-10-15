import {
  randomBytes,
  randomUUID,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";

export const hash = (value) =>
  createHash("sha256").update(String(value)).digest("hex");
export function error(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}
export function equalSecret(a, b) {
  return timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
}
export function saveJson(path, value) {
  const temp = path + ".tmp";
  writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(temp, path);
}

export class AuthStore {
  constructor({ dataDir, now = Date.now }) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.file = join(dataDir, "devices.json");
    this.now = now;
    this.grant = null;
    this.devices = existsSync(this.file)
      ? JSON.parse(readFileSync(this.file, "utf8"))
      : [];
    if (!Array.isArray(this.devices)) throw new Error("设备记录格式无效");
    this.devices = this.devices.filter((x) => x.expiresAt > this.now());
    this.lastSave = 0;
  }
  createGrant() {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = this.now() + 300000;
    this.grant = { hash: hash(token), expiresAt };
    return { token, expiresAt };
  }
  pair(token, name) {
    if (
      typeof token !== "string" ||
      token.length > 128 ||
      !this.grant ||
      this.grant.expiresAt <= this.now() ||
      !equalSecret(hash(token), this.grant.hash)
    )
      throw error("配对码已过期或已使用，请在电脑上重新生成。", 401);
    if (this.devices.filter((x) => x.expiresAt > this.now()).length >= 10)
      throw error("已达到 10 台设备上限，请先撤销旧设备。", 409);
    this.grant = null;
    const secret = randomBytes(32).toString("base64url");
    const device = {
      id: randomUUID(),
      name: String(name || "我的手机")
        .replace(/[\x00-\x1f]/g, "")
        .slice(0, 60),
      createdAt: this.now(),
      lastSeen: this.now(),
      expiresAt: this.now() + 30 * 86400000,
      hash: hash(secret),
    };
    this.devices.push(device);
    this.save();
    return { token: secret, device: this.publicDevice(device) };
  }
  publicDevice({ hash: _, ...device }) {
    return device;
  }
  authenticate(token) {
    if (typeof token !== "string" || token.length > 128) return null;
    const digest = hash(token);
    const device = this.devices.find(
      (x) => x.hash === digest && x.expiresAt > this.now(),
    );
    if (!device) return null;
    device.lastSeen = this.now();
    if (this.now() - this.lastSave > 60000) this.save();
    return this.publicDevice(device);
  }
  list() {
    return this.devices
      .filter((x) => x.expiresAt > this.now())
      .map((x) => this.publicDevice(x));
  }
  revoke(id) {
    this.devices = this.devices.filter((x) => x.id !== id);
    this.save();
  }
  save() {
    saveJson(this.file, this.devices);
    this.lastSave = this.now();
  }
}
