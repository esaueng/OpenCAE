import { promises as fs } from "node:fs";
import path from "node:path";

export interface ObjectStorageProvider {
  putObject(key: string, data: string | Buffer | Uint8Array): Promise<string>;
  getObject(key: string): Promise<Buffer>;
  listObjects(prefix?: string): Promise<string[]>;
  deleteObject(key: string): Promise<void>;
  getLocalPath(key: string): string;
}

export class FileSystemObjectStorageProvider implements ObjectStorageProvider {
  constructor(private readonly rootDir = path.resolve(process.cwd(), "data/artifacts")) {}

  async putObject(key: string, data: string | Buffer | Uint8Array): Promise<string> {
    const target = this.getLocalPath(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data);
    return target;
  }

  async getObject(key: string): Promise<Buffer> {
    return fs.readFile(this.getLocalPath(key));
  }

  async listObjects(prefix = ""): Promise<string[]> {
    const base = this.getLocalPath(prefix);
    try {
      const stat = await fs.stat(base);
      if (stat.isFile()) return [prefix];
    } catch {
      return [];
    }
    return this.walk(base, prefix);
  }

  async deleteObject(key: string): Promise<void> {
    await fs.rm(this.getLocalPath(key), { force: true });
  }

  getLocalPath(key: string): string {
    const cleanKey = key.replace(/^\/+/, "");
    return path.resolve(this.rootDir, cleanKey);
  }

  private async walk(dir: string, prefix: string): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const results: string[] = [];
    for (const entry of entries) {
      const key = path.posix.join(prefix, entry.name);
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...(await this.walk(full, key)));
      } else {
        results.push(key);
      }
    }
    return results;
  }
}
