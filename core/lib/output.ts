import { promises as fs } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { DivletError } from './model.ts';
import { canonicalMediaType } from './media-type.ts';

const MANIFEST = '.divlet-build.json';
const LOCK = '.divlet-write.lock';
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const inside = (root: string, file: string): boolean => file === root || (!path.relative(root, file).startsWith('..' + path.sep) && path.relative(root, file) !== '..' && !path.isAbsolute(path.relative(root, file)));
function fail(code: string, message: string): never { throw new DivletError(code, message); }

/** Owned hashes and optional authored MIME; MIME is provenance, never HTTP/public-file authority. */
export interface OutputManifest { schemaVersion: 1; project: string; files: Record<string, string>; mediaTypes?: Record<string, string> }
/** When supplied, the complete MIME map replaces prior metadata; omitted maps preserve it across partial writes. */
export interface OutputMetadata { mediaTypes?: ReadonlyMap<string, string> }
/** Generated files by relative name, as a build plans to publish them. */
export type GeneratedFiles = Map<string, string | Buffer>;

export function outputDirectory(projectFile: string, configured: string | null | undefined): string {
  const source = path.dirname(projectFile);
  const directory = path.resolve(source, configured || path.join('.divlet', path.basename(projectFile, path.extname(projectFile))));
  if (inside(directory, source)) fail('INVALID_OUTPUT_DIR', 'The output directory cannot be the project source directory or one of its parents.');
  return directory;
}

/** Refuse symbolic links in every path component, including existing directory ancestors. */
export async function safeDirectory(directory: string, { create = false }: { create?: boolean } = {}): Promise<void> {
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!create) return;
      try { await fs.mkdir(current); } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause; }
      stat = await fs.lstat(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('UNSAFE_PATH', `Not a safe output directory: ${current}`);
  }
}

const sameFile = (a: { dev: number; ino: number }, b: { dev: number; ino: number }): boolean => a.dev === b.dev && a.ino === b.ino;



/** Owns generated-file provenance and collision checks, not project sources or rendering. */
export class OutputStore {
  projectFile: string;
  directory: string;
  owner: string;
  locked: boolean;

  constructor(projectFile: string, configured: string | null | undefined) {
    this.projectFile = projectFile;
    this.directory = outputDirectory(projectFile, configured);
    this.owner = path.relative(this.directory, projectFile).split(path.sep).join('/');
    this.locked = false;
  }

  file(name: unknown): string {
    if (typeof name !== 'string' || !name || name.includes('\\') || name.includes('\0') || path.isAbsolute(name) || name.split('/').some(part => !part || part === '.' || part === '..')) fail('UNSAFE_PATH', 'Invalid generated output path.');
    const file = path.resolve(this.directory, name);
    if (!inside(this.directory, file)) fail('UNSAFE_PATH', 'Generated file escapes the output directory.');
    return file;
  }

  async read(name: string): Promise<Buffer | null> {
    const file = this.file(name);
    await safeDirectory(path.dirname(file));
    let stat;
    try { stat = await fs.lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    if (stat.isSymbolicLink() || !stat.isFile()) fail('UNSAFE_PATH', `Not a regular generated file: ${file}`);
    if (stat.size > 32 * 1024 * 1024) fail('FILE_TOO_LARGE', `Generated file is too large: ${file}`);
    return fs.readFile(file);
  }

  async manifest(): Promise<OutputManifest> {
    const contents = await this.read(MANIFEST);
    if (contents === null) return { schemaVersion: 1, project: this.owner, files: Object.create(null) as Record<string, string> };
    let manifest: any;
    try { manifest = JSON.parse(contents.toString('utf8')); } catch { fail('OUTPUT_CONFLICT', 'The output manifest is not valid JSON.'); }
    if (manifest?.schemaVersion !== 1 || manifest.project !== this.owner || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) fail('OUTPUT_CONFLICT', 'The output directory belongs to another project or has an invalid manifest.');
    for (const [name, digest] of Object.entries(manifest.files as Record<string, string>)) {
      this.file(name);
      if ([MANIFEST, LOCK].includes(name) || !/^[a-f0-9]{64}$/.test(digest)) fail('OUTPUT_CONFLICT', 'The output manifest has an invalid file record.');
    }
    manifest.files = Object.assign(Object.create(null), manifest.files);
    if (Object.hasOwn(manifest, 'mediaTypes')) {
      if (!manifest.mediaTypes || typeof manifest.mediaTypes !== 'object' || Array.isArray(manifest.mediaTypes)) fail('OUTPUT_CONFLICT', 'The output manifest has invalid MIME metadata.');
      for (const [name, value] of Object.entries(manifest.mediaTypes)) if (!Object.hasOwn(manifest.files, name) || !canonicalMediaType(value)) fail('OUTPUT_CONFLICT', 'The output manifest has invalid MIME metadata.');
      manifest.mediaTypes = Object.assign(Object.create(null), manifest.mediaTypes);
    }
    return manifest;
  }

  async generated(name: string, contents: string | Buffer): Promise<boolean> {
    const html = name.endsWith('.html') ? name : name.endsWith('.meta.json') ? name.slice(0, -10) + '.html' : null;
    if (!html) return false;
    const sidecar = html.slice(0, -5) + '.meta.json';
    try {
      const meta = JSON.parse(String(name === sidecar ? contents : await this.read(sidecar)));
      const page = name === html ? contents : await this.read(html);
      const source = path.relative(path.dirname(this.file(html)), this.projectFile).split(path.sep).join('/');
      return page !== null && meta?.project === source && meta.html === path.basename(html) && meta.hashes?.html === hash(page);
    } catch { return false; }
  }

  async preflight(files: GeneratedFiles, removed: string[] = [], metadata: OutputMetadata = {}): Promise<OutputManifest> {
    const manifest = await this.manifest();
    if (metadata.mediaTypes !== undefined) {
      if (!(metadata.mediaTypes instanceof Map)) fail('OUTPUT_CONFLICT', 'Output MIME metadata must be a map.');
      const names = new Set([...Object.keys(manifest.files), ...files.keys()].filter(name => !removed.includes(name)));
      const mediaTypes: Record<string, string> = Object.create(null);
      for (const [name, value] of metadata.mediaTypes) {
        this.file(name);
        if (!names.has(name) || !canonicalMediaType(value)) fail('OUTPUT_CONFLICT', 'Output MIME metadata must name planned or owned files and canonical media types.');
        mediaTypes[name] = value;
      }
      if (Object.keys(mediaTypes).length) manifest.mediaTypes = mediaTypes;
      else delete manifest.mediaTypes;
    }
    let preserve = false;
    for (const name of files.keys()) {
      const parts = name.split('/');
      for (let index = 1; index < parts.length; index++) if (files.has(parts.slice(0, index).join('/'))) fail('OUTPUT_CONFLICT', `Generated file and directory paths collide: ${name}`);
    }
    for (const [name, contents] of files) {
      if ([MANIFEST, LOCK].includes(name) || name.startsWith('.trash/')) fail('OUTPUT_CONFLICT', 'Generated output uses a reserved path.');
      const disk = await this.read(name);
      if (disk !== null && !Object.hasOwn(manifest.files, name)) fail('OUTPUT_CONFLICT', `Refusing to overwrite an unowned output file: ${this.file(name)}`);
      if (disk !== null && !disk.equals(Buffer.from(contents)) && hash(disk) !== manifest.files[name] && !await this.generated(name, disk)) preserve = true;
    }
    for (const name of removed) {
      const disk = await this.read(name);
      if (disk !== null && !Object.hasOwn(manifest.files, name)) fail('OUTPUT_CONFLICT', `Refusing to remove an unowned output file: ${this.file(name)}`);
      if (disk !== null) preserve = true;
    }
    if (preserve) await safeDirectory(path.join(this.directory, '.trash'));
    return manifest;
  }

  /** A filesystem lock prevents different processes from claiming or rewriting one build concurrently. */
  async withLock<T>(task: () => Promise<T>): Promise<T> {
    await safeDirectory(this.directory, { create: true });
    let handle: Awaited<ReturnType<typeof fs.open>>;
    try { handle = await fs.open(this.file(LOCK), 'wx'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('OUTPUT_BUSY', `Another writer holds ${this.file(LOCK)}. A stale lock must be removed only after its writer has stopped.`);
      throw error;
    }
    this.locked = true;
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, project: this.owner }));
      return await task();
    } finally {
      this.locked = false;
      await handle.close();
      await fs.unlink(this.file(LOCK));
    }
  }

  async atomic(name: string, contents: string | Buffer): Promise<void> {
    const file = this.file(name);
    await safeDirectory(path.dirname(file), { create: true });
    await this.read(name);
    const temporary = path.join(path.dirname(file), `.divlet-save-${randomBytes(12).toString('hex')}`);
    try {
      await fs.writeFile(temporary, contents, { flag: 'wx' });
      await fs.rename(temporary, file);
    } finally { await fs.rm(temporary, { force: true }); }
  }

  async preserve(name: string, disk: Buffer): Promise<void> {
    const destination = `.trash/${Date.now()}-${randomBytes(6).toString('hex')}-${path.basename(name)}`;
    await this.atomic(destination, disk);
  }

  async write(files: GeneratedFiles, metadata: OutputMetadata = {}): Promise<void> {
    await this.preflight(files, [], metadata);
    return this.withLock(() => this.writeLocked(files, metadata));
  }

  async writeLocked(files: GeneratedFiles, metadata: OutputMetadata = {}): Promise<void> {
    if (!this.locked) fail('OUTPUT_BUSY', 'Output writes require the build lock.');
    const manifest = await this.preflight(files, [], metadata);
    const previous: Record<string, string> = { ...manifest.files };
    for (const [name] of files) {
      const disk = await this.read(name);
      if (disk !== null && Object.hasOwn(previous, name) && await this.generated(name, disk)) previous[name] = hash(disk);
    }
    for (const [name, contents] of files) manifest.files[name] = hash(contents);
    // Claim the planned paths before writing data, so an interrupted build can safely recover.
    await this.atomic(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
    for (const [name, contents] of files) {
      const disk = await this.read(name);
      if (disk !== null && !disk.equals(Buffer.from(contents))) {
        if (hash(disk) !== previous[name]) await this.preserve(name, disk);
        await this.atomic(name, contents);
      } else if (disk === null) await this.atomic(name, contents);
    }
  }

  remove(names: string[]): Promise<void> { return this.withLock(() => this.removeLocked(names)); }

  async removeLocked(names: string[]): Promise<void> {
    if (!this.locked) fail('OUTPUT_BUSY', 'Output removals require the build lock.');
    const manifest = await this.preflight(new Map(), names);
    for (const name of names) {
      if (!Object.hasOwn(manifest.files, name)) continue;
      const disk = await this.read(name);
      if (disk !== null) {
        await this.preserve(name, disk);
        await fs.unlink(this.file(name));
      }
      delete manifest.files[name];
      if (manifest.mediaTypes) delete manifest.mediaTypes[name];
    }
    if (manifest.mediaTypes && !Object.keys(manifest.mediaTypes).length) delete manifest.mediaTypes;
    await this.atomic(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  }
}
