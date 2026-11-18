/// <reference lib="webworker" />
import { Inflate, strFromU8, strToU8, zipSync } from "fflate";
import { MAX_ASSET_BYTES } from "../domain/limits";
import {
  PosterError,
  type PosterAsset,
  type PosterErrorCode,
  type PosterTemplate,
  type TemplateBundle,
} from "../domain/types";
import { validateTemplate } from "../domain/validation";

const FORMAT = "recruitment-poster-template";
const MAX_PACKAGE_BYTES = 100 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_PACKAGE_FILES = 64;
const MANIFEST_PATH = "manifest.json";
const ZIP_END_BYTES = 22;
const ZIP_LOCAL_HEADER_BYTES = 30;
const ZIP_DIRECTORY_HEADER_BYTES = 46;
const INFLATE_CHUNK_BYTES = 4 * 1024;

export type PackageRequest =
  { kind: "create"; bundle: TemplateBundle } | { kind: "parse"; file: Blob };
export type PackageResponse =
  | { ok: true; result: Blob | TemplateBundle }
  | { ok: false; code: PosterErrorCode; message: string };

interface ManifestAsset {
  id: string;
  name: string;
  mimeType: string;
  path: string;
}
interface Manifest {
  format: typeof FORMAT;
  version: 1;
  template: PosterTemplate;
  assets: ManifestAsset[];
}
interface ZipEntry {
  offset: number;
  compressedBytes: number;
  bytes: number;
  method: number;
}

function inspectZip(data: Uint8Array): Map<string, ZipEntry> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let end = -1;
  for (
    let index = data.length - ZIP_END_BYTES;
    index >= Math.max(0, data.length - 65_557);
    index--
  ) {
    if (
      view.getUint32(index, true) === 0x06054b50 &&
      index + ZIP_END_BYTES + view.getUint16(index + 20, true) === data.length
    ) {
      end = index;
      break;
    }
  }
  if (end < 0) throw new PosterError("INVALID_TEMPLATE", "模板包缺少有效 ZIP 目录。");
  const count = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  const directoryOffset = view.getUint32(end + 16, true);
  const directoryEnd = directoryOffset + directorySize;
  if (!count || count > MAX_PACKAGE_FILES || directoryEnd > end)
    throw new PosterError("INVALID_TEMPLATE", "模板包文件数量或 ZIP 目录不合法。");

  const entries = new Map<string, ZipEntry>();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let cursor = directoryOffset;
  let total = 0;
  for (let index = 0; index < count; index++) {
    const nameOffset = cursor + ZIP_DIRECTORY_HEADER_BYTES;
    if (nameOffset > directoryEnd || view.getUint32(cursor, true) !== 0x02014b50)
      throw new PosterError("INVALID_TEMPLATE", "模板包 ZIP 目录损坏。");
    const method = view.getUint16(cursor + 10, true);
    const compressedBytes = view.getUint32(cursor + 20, true);
    const bytes = view.getUint32(cursor + 24, true);
    const nameEnd = nameOffset + view.getUint16(cursor + 28, true);
    const next = nameEnd + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true);
    if (next > directoryEnd) throw new PosterError("INVALID_TEMPLATE", "模板包 ZIP 目录损坏。");
    if (![0, 8].includes(method) || bytes === 0xffffffff || compressedBytes === 0xffffffff)
      throw new PosterError("INVALID_TEMPLATE", "模板包使用不支持的压缩方式。");

    let name: string;
    try {
      name = decoder.decode(data.subarray(nameOffset, nameEnd));
    } catch {
      throw new PosterError("INVALID_TEMPLATE", "模板包文件名不是有效 UTF-8。");
    }
    if (name !== MANIFEST_PATH && !/^assets\/\d+$/.test(name))
      throw new PosterError("INVALID_TEMPLATE", "模板包必须只包含 manifest.json 和 assets 素材。");
    if (entries.has(name)) throw new PosterError("INVALID_TEMPLATE", "模板包文件清单不一致。");
    if (name === MANIFEST_PATH) {
      if (bytes > MAX_MANIFEST_BYTES)
        throw new PosterError("INVALID_TEMPLATE", "模板包 manifest 不能超过 2 MB。");
    } else if (!bytes || bytes > MAX_ASSET_BYTES) {
      throw new PosterError("INVALID_ASSET", "模板素材为空或超过 20 MB。");
    }
    total += bytes;
    if (total > MAX_PACKAGE_BYTES)
      throw new PosterError("INVALID_ASSET", "模板包展开后不能超过 100 MB。");

    const localOffset = view.getUint32(cursor + 42, true);
    if (
      localOffset + ZIP_LOCAL_HEADER_BYTES > directoryOffset ||
      view.getUint32(localOffset, true) !== 0x04034b50 ||
      view.getUint16(localOffset + 8, true) !== method
    )
      throw new PosterError("INVALID_TEMPLATE", "模板包 ZIP 文件头损坏。");
    const offset =
      localOffset +
      ZIP_LOCAL_HEADER_BYTES +
      view.getUint16(localOffset + 26, true) +
      view.getUint16(localOffset + 28, true);
    if (offset + compressedBytes > directoryOffset || (method === 0 && compressedBytes !== bytes))
      throw new PosterError("INVALID_TEMPLATE", "模板包 ZIP 文件大小不一致。");

    entries.set(name, { offset, compressedBytes, bytes, method });
    cursor = next;
  }
  return entries;
}

function inflateEntry(data: Uint8Array, entry: ZipEntry): Uint8Array<ArrayBuffer> {
  const end = entry.offset + entry.compressedBytes;
  const output = new Uint8Array(entry.bytes);
  let written = 0;
  const sizeError = () => new PosterError("INVALID_TEMPLATE", "模板包 ZIP 文件大小不一致。");
  const inflate = new Inflate((chunk) => {
    if (written + chunk.length > output.length) throw sizeError();
    output.set(chunk, written);
    written += chunk.length;
  });
  try {
    // 分段解压，避免 ZIP 目录低报尺寸时一次展开整个条目。
    for (let offset = entry.offset; offset < end; offset += INFLATE_CHUNK_BYTES) {
      const next = Math.min(end, offset + INFLATE_CHUNK_BYTES);
      inflate.push(data.subarray(offset, next), next === end);
    }
  } catch (error) {
    if (error instanceof PosterError) throw error;
    throw new PosterError("INVALID_TEMPLATE", "模板包 ZIP 数据损坏。");
  }
  if (written !== output.length) throw sizeError();
  return output;
}

function validateAssets(template: PosterTemplate, assets: PosterAsset[]): void {
  const ids = new Set<string>();
  for (const asset of assets) {
    if (
      !asset.id ||
      ids.has(asset.id) ||
      !asset.name ||
      !asset.mimeType ||
      !(asset.blob instanceof Blob) ||
      !asset.blob.size ||
      asset.blob.size > MAX_ASSET_BYTES
    ) {
      throw new PosterError("INVALID_ASSET", "模板素材为空、重复或超过 20 MB。");
    }
    ids.add(asset.id);
  }
  const required = [
    template.backgroundId,
    ...template.fontIds,
    ...template.boxes.map((box) => box.fontId),
  ];
  if (required.some((id) => !ids.has(id)))
    throw new PosterError("INVALID_ASSET", "模板缺少底图或字体素材。");
}

async function createPackage(bundle: TemplateBundle): Promise<Blob> {
  const template = validateTemplate(bundle.template);
  if (bundle.assets.length + 1 > MAX_PACKAGE_FILES)
    throw new PosterError("INVALID_TEMPLATE", "模板包最多包含 64 个文件（含 manifest）。");
  validateAssets(template, bundle.assets);
  const assets = bundle.assets.map(({ id, name, mimeType }, index) => ({
    id,
    name,
    mimeType,
    path: `assets/${index}`,
  }));
  const manifest: Manifest = { format: FORMAT, version: 1, template, assets };
  const manifestBytes = strToU8(JSON.stringify(manifest));
  if (manifestBytes.length > MAX_MANIFEST_BYTES)
    throw new PosterError("INVALID_TEMPLATE", "模板包 manifest 不能超过 2 MB。");

  // 导出使用 STORE。文件名均为 ASCII，分别写入本地头和中央目录。
  const storedEntryBytes = (path: string, bytes: number) =>
    ZIP_LOCAL_HEADER_BYTES + ZIP_DIRECTORY_HEADER_BYTES + 2 * path.length + bytes;
  const packageBytes = bundle.assets.reduce(
    (total, asset, index) => total + storedEntryBytes(assets[index].path, asset.blob.size),
    ZIP_END_BYTES + storedEntryBytes(MANIFEST_PATH, manifestBytes.length),
  );
  if (packageBytes > MAX_PACKAGE_BYTES)
    throw new PosterError("INVALID_ASSET", "模板包不能超过 100 MB（含 ZIP 文件头）。");

  const entries: Record<string, Uint8Array> = {};
  for (const [index, asset] of bundle.assets.entries()) {
    entries[assets[index].path] = new Uint8Array(await asset.blob.arrayBuffer());
  }
  entries[MANIFEST_PATH] = manifestBytes;
  return new Blob([zipSync(entries, { level: 0 })], { type: "application/zip" });
}

async function parsePackage(file: Blob): Promise<TemplateBundle> {
  if (!file.size || file.size > MAX_PACKAGE_BYTES)
    throw new PosterError("INVALID_ASSET", "模板包必须是非空且不超过 100 MB 的 ZIP 文件。");
  const data = new Uint8Array(await file.arrayBuffer());
  const entries = inspectZip(data);
  const manifestEntry = entries.get(MANIFEST_PATH);
  if (!manifestEntry)
    throw new PosterError("INVALID_TEMPLATE", "模板包必须只包含 manifest.json 和 assets 素材。");
  const manifestBytes =
    manifestEntry.method === 0
      ? data.subarray(manifestEntry.offset, manifestEntry.offset + manifestEntry.bytes)
      : inflateEntry(data, manifestEntry);
  let manifest: Manifest;
  try {
    manifest = JSON.parse(strFromU8(manifestBytes)) as Manifest;
  } catch {
    throw new PosterError("INVALID_TEMPLATE", "模板包 manifest 不是有效 JSON。");
  }
  if (
    !manifest ||
    manifest.format !== FORMAT ||
    manifest.version !== 1 ||
    !Array.isArray(manifest.assets)
  )
    throw new PosterError("INVALID_TEMPLATE", "模板包格式或版本不受支持。");
  const template = validateTemplate(manifest.template);
  const paths = new Set<string>();
  const assets: PosterAsset[] = [];
  for (const item of manifest.assets) {
    if (
      !item ||
      typeof item.id !== "string" ||
      typeof item.name !== "string" ||
      typeof item.mimeType !== "string" ||
      typeof item.path !== "string" ||
      item.path === MANIFEST_PATH ||
      paths.has(item.path)
    ) {
      throw new PosterError("INVALID_TEMPLATE", "模板包素材清单或路径不合法。");
    }
    const entry = entries.get(item.path);
    if (!entry) throw new PosterError("INVALID_TEMPLATE", "模板包素材清单或路径不合法。");
    paths.add(item.path);
    assets.push({
      id: item.id,
      name: item.name,
      mimeType: item.mimeType,
      blob:
        entry.method === 0
          ? file.slice(entry.offset, entry.offset + entry.bytes, item.mimeType)
          : new Blob([inflateEntry(data, entry)], { type: item.mimeType }),
    });
  }
  if (paths.size !== entries.size - 1)
    throw new PosterError("INVALID_TEMPLATE", "模板包含有未声明素材。");
  validateAssets(template, assets);
  return { template, assets };
}

export function processPackage(request: PackageRequest): Promise<Blob | TemplateBundle> {
  return request.kind === "create" ? createPackage(request.bundle) : parsePackage(request.file);
}

if (typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope) {
  const scope = self as DedicatedWorkerGlobalScope;
  scope.onmessage = async ({ data }: MessageEvent<PackageRequest>) => {
    try {
      scope.postMessage({ ok: true, result: await processPackage(data) } satisfies PackageResponse);
    } catch (error) {
      scope.postMessage({
        ok: false,
        code: error instanceof PosterError ? error.code : "INVALID_TEMPLATE",
        message: error instanceof Error ? error.message : "模板包处理失败。",
      } satisfies PackageResponse);
    }
  };
}
