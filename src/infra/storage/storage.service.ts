import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema.js';

export interface StoredFile {
  url: string;
}

/**
 * Where uploaded images live. Callers depend on this abstract class, so moving
 * to S3/R2 is a new implementation bound in StorageModule — no call-site changes.
 */
export abstract class StorageService {
  abstract save(data: Buffer, extension: string, folder: string): Promise<StoredFile>;
  /** Removes a file this service stored. A URL it did not issue is ignored. */
  abstract remove(url: string): Promise<void>;
}

/** Local disk, served by Express at `/uploads`. Fine for dev and a single box. */
@Injectable()
export class LocalDiskStorageService extends StorageService {
  private readonly root: string;
  private readonly publicBase: string;

  constructor(config: ConfigService<Env, true>) {
    super();
    this.root = resolve(config.get('UPLOAD_DIR', { infer: true }));
    this.publicBase = `${config.get('PUBLIC_BASE_URL', { infer: true }).replace(/\/$/, '')}/uploads`;
  }

  async save(data: Buffer, extension: string, folder: string): Promise<StoredFile> {
    // Server-generated name only: a client-supplied filename is a path
    // traversal waiting to happen.
    const safeFolder = folder.replace(/[^a-zA-Z0-9_-]/g, '');
    const name = `${randomUUID()}.${extension}`;
    const dir = join(this.root, safeFolder);

    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), data);

    return { url: `${this.publicBase}/${safeFolder}/${name}` };
  }

  async remove(url: string): Promise<void> {
    if (!url.startsWith(`${this.publicBase}/`)) return;

    const [folder, name] = url.slice(this.publicBase.length + 1).split('/');
    if (!folder || !name || basename(name) !== name) return;

    await rm(join(this.root, folder.replace(/[^a-zA-Z0-9_-]/g, ''), name), { force: true });
  }
}
