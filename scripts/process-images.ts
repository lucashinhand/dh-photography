import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { Photo, SiteContent } from '../src/content/types.js';
import type { AssetManifest } from './lib/extraction-types.js';

export const LARGE_WIDTH = 2500;
export const THUMB_WIDTH = 640;
export const LARGE_QUALITY = 85;
export const THUMB_QUALITY = 80;
export const WEBP_EFFORT = 4;
export const MAX_DOWNLOAD_BYTES = 50_000_000;
export const MAX_SERVING_FILE_BYTES = 50_000_000;
export const MAX_SERVING_BYTES = 750_000_000;
export const DOWNLOAD_CONCURRENCY = 4;
export const ENCODE_CONCURRENCY = 2;
export const RETRIES_PER_URL = 2;
export const RETRY_DELAY_MS = 250;
export const FALLBACK_WIDTHS = [2500, 1500, 1000, 750, 500, 300, 100] as const;
export const PREFLIGHT_SAMPLE_SIZE = 30;
export const PREFLIGHT_FIXED_OVERHEAD_BYTES = 25_000_000;
export const PREFLIGHT_SAFETY_FACTOR = 1.2;

const DEFAULT_ASSET_MANIFEST_PATH = path.join(
  'migration',
  'manifests',
  'assets.json',
);
const DEFAULT_BUDGET_PROJECTION_PATH = path.join(
  'migration',
  'manifests',
  'budget-projection.json',
);
const DEFAULT_SITE_PATH = path.join('src', 'content', 'site.json');
const DEFAULT_IMAGES_PATH = path.join('migration', 'manifests', 'images.json');
const PENDING_MANIFEST_SUFFIX = '.pending';
const DEFAULT_DOWNLOAD_DIR = path.join('migration', 'downloads');
const DEFAULT_OUTPUT_DIR = path.join('public', 'images');

type FetchLike = typeof fetch;

export interface SourcePhoto extends Partial<Photo> {
  id: string;
  /** The canonical Squarespace source URL. `large` is accepted for the extractor contract. */
  sourceUrl?: string;
  originalUrl?: string;
  url?: string;
  large?: string;
  thumbnail?: string;
  [key: string]: unknown;
}

export interface InputSite extends Omit<SiteContent, 'photos'> {
  photos: Record<string, SourcePhoto>;
  [key: string]: unknown;
}

export type InputAssetManifest = AssetManifest;

export interface ImageManifestImage {
  contentHash: string;
  photoIds: string[];
  sourceUrls: string[];
  sourceVariants: SourceVariant[];
  selectedUrl: string;
  sourceBytes: number;
  sourceMime: string;
  sourceFormat: string;
  sourceWidth: number;
  sourceHeight: number;
  sourceOrientation?: number;
  large: {
    path: string;
    bytes: number;
    sha256: string;
    width: number;
    height: number;
    mime: 'image/webp';
  };
  thumbnail: {
    path: string;
    bytes: number;
    sha256: string;
    width: number;
    height: number;
    mime: 'image/webp';
  };
  status: 'processed' | 'cached';
}

/**
 * Provenance for one downloaded source variant. Several source variants may
 * point at one serving pair after normalisation and WebP encoding.
 */
export interface SourceVariant {
  sourceSha256: string;
  photoIds: string[];
  sourceUrls: string[];
  selectedUrl: string;
  sourceBytes: number;
  sourceMime: string;
  sourceFormat: string;
  sourceWidth: number;
  sourceHeight: number;
  sourceOrientation?: number;
}

export interface ImagesManifest {
  version: 1;
  generatedAt: string;
  assetManifestPath: string;
  sitePath: string;
  outputDirectory: string;
  downloadDirectory: string;
  sourceCount: number;
  sourceContentCount?: number;
  uniqueContentCount: number;
  servingBytes: number;
  servingBudgetBytes: number;
  images: ImageManifestImage[];
  status?: 'complete' | 'failed';
  failures?: Array<{ photoIds: string[]; sourceUrl: string; error: string }>;
  error?: string;
  transactionId?: string;
  pendingCleanupPaths?: string[];
}

export interface PreflightPlan {
  mode: 'preflight';
  sourceCount: number;
  uniqueSourceCount: number;
  sampleSize: number;
  sampleBytes?: number;
  estimatedServingBytes?: number;
  sampleSource?: string;
  servingBudgetBytes: number;
  withinBudget: boolean | null;
  sourceUrls: string[];
}

export interface ProcessOptions {
  assetManifestPath?: string;
  sitePath?: string;
  imagesManifestPath?: string;
  downloadsDirectory?: string;
  outputDirectory?: string;
  mode?: 'preflight' | 'run';
  sampleBytes?: number;
  sampleSize?: number;
  budgetProjectionPath?: string;
  fetchImpl?: FetchLike;
  downloadConcurrency?: number;
  encodeConcurrency?: number;
  maxDownloadBytes?: number;
  maxServingBytes?: number;
  retryCount?: number;
  retryDelayMs?: number;
  now?: () => Date;
}

export interface ProcessResult {
  mode: 'preflight' | 'run';
  plan?: PreflightPlan;
  manifest?: ImagesManifest;
  site?: InputSite;
}

export interface ImageInspection {
  format: string;
  mime: string;
  width: number;
  height: number;
  orientation?: number;
}

export interface DownloadedSource extends ImageInspection {
  sourceUrl: string;
  selectedUrl: string;
  cachePath: string;
  bytes: number;
  sha256: string;
}

export interface EncodedImage {
  data: Buffer;
  bytes: number;
  sha256: string;
  width: number;
  height: number;
  mime: 'image/webp';
}

export interface EncodedPair {
  large: EncodedImage;
  thumbnail: EncodedImage;
}

export class ImageProcessorError extends Error {
  override name = 'ImageProcessorError';
}

export class DownloadTooLargeError extends ImageProcessorError {
  override name = 'DownloadTooLargeError';
}

export class InsecureRedirectError extends ImageProcessorError {
  override name = 'InsecureRedirectError';
}

export class ServingBudgetExceededError extends ImageProcessorError {
  override name = 'ServingBudgetExceededError';
}

interface CachedSource {
  version: 1;
  sourceUrl: string;
  selectedUrl: string;
  bytes: number;
  sha256: string;
  mime: string;
  format: string;
  width: number;
  height: number;
  orientation?: number;
}

interface SourceGroup {
  normalizedSourceUrl: string;
  photoIds: string[];
  sourceUrls: string[];
}

interface SourceResult extends DownloadedSource {
  sourcePhotoIds: string[];
  sourceUrls: string[];
}

type DownloadOutcome =
  | { ok: true; result: SourceResult }
  | { ok: false; group: SourceGroup; error: string };

interface ContentGroup {
  contentHash: string;
  sourceResults: SourceResult[];
  photoIds: string[];
}

interface EncodedResult {
  group: ContentGroup;
  source: SourceResult;
  pair: EncodedPair;
  cached: boolean;
}

interface ServingGroup {
  /** The source hash chosen as the stable filename for this serving pair. */
  contentHash: string;
  pair: EncodedPair;
  members: EncodedResult[];
}

interface TransactionJournal {
  version: 1;
  transactionId: string;
  outputDirectory: string;
  sitePath: string;
  stageDirectory: string;
  outputPaths: string[];
  previousManifest: ImagesManifest | null;
  nextManifest: ImagesManifest;
  previousSite: InputSite;
  nextSite: InputSite;
}

interface RecoveryState {
  manifest: ImagesManifest | undefined;
  site: InputSite;
}

function asPositiveInteger(
  value: number | undefined,
  fallback: number,
): number {
  return Number.isInteger(value) && value && value > 0 ? value : fallback;
}

function sha256Hex(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

function imageMime(format: string): string {
  switch (format.toLowerCase()) {
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    case 'avif':
      return 'image/avif';
    case 'heif':
      return 'image/heif';
    case 'tiff':
      return 'image/tiff';
    case 'jp2':
      return 'image/jp2';
    case 'jxl':
      return 'image/jxl';
    default:
      return `image/${format.toLowerCase()}`;
  }
}

function orientedDimensions(
  width: number,
  height: number,
  orientation?: number,
): { width: number; height: number } {
  return orientation && orientation >= 5 && orientation <= 8
    ? { width: height, height: width }
    : { width, height };
}

/**
 * Decode the image before trusting it. File extensions and response headers are
 * deliberately ignored when determining the real format and dimensions.
 */
export async function inspectImage(
  input: string | Buffer,
): Promise<ImageInspection> {
  const image = sharp(input, { failOn: 'error' });
  const metadata = await image.metadata();
  if (!metadata.format || !metadata.width || !metadata.height) {
    throw new ImageProcessorError(
      'Downloaded data is not a decodable image with dimensions',
    );
  }

  // A small decode catches truncated or otherwise malformed files that expose
  // plausible metadata but cannot be rendered.
  await sharp(input, { failOn: 'error' })
    .rotate()
    .resize({ width: 1, height: 1, fit: 'inside', withoutEnlargement: true })
    .toBuffer();

  const dimensions = orientedDimensions(
    metadata.width,
    metadata.height,
    metadata.orientation,
  );
  return {
    format: metadata.format,
    mime: imageMime(metadata.format),
    width: dimensions.width,
    height: dimensions.height,
    ...(metadata.orientation ? { orientation: metadata.orientation } : {}),
  };
}

export function normalizeSourceUrl(sourceUrl: string): string {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    throw new ImageProcessorError(`Invalid image source URL: ${sourceUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ImageProcessorError(
      `Image source URL must use HTTP(S): ${sourceUrl}`,
    );
  }
  url.protocol = 'https:';
  url.searchParams.delete('format');
  return url.toString();
}

export function sourceUrlForPhoto(photo: SourcePhoto): string {
  const candidates = [
    photo.sourceUrl,
    photo.originalUrl,
    photo.url,
    photo.large,
    photo.thumbnail,
  ];
  const candidate = candidates.find(
    (value): value is string =>
      typeof value === 'string' && value.trim().length > 0,
  );
  if (!candidate) {
    throw new ImageProcessorError(`Photo ${photo.id} has no source URL`);
  }
  return normalizeSourceUrl(candidate);
}

export function sourceGroups(site: InputSite): SourceGroup[] {
  const groups = new Map<string, SourceGroup>();
  for (const [photoId, photo] of Object.entries(site.photos)) {
    const id = photo.id || photoId;
    const normalizedSourceUrl = sourceUrlForPhoto({ ...photo, id });
    const existing = groups.get(normalizedSourceUrl);
    if (existing) {
      existing.photoIds.push(id);
    } else {
      groups.set(normalizedSourceUrl, {
        normalizedSourceUrl,
        photoIds: [id],
        sourceUrls: [normalizedSourceUrl],
      });
    }
  }
  return [...groups.values()];
}

function isAssetManifest(
  input: InputSite | InputAssetManifest,
): input is InputAssetManifest {
  return 'assets' in input && Array.isArray(input.assets);
}

export function assetSourceGroups(manifest: InputAssetManifest): SourceGroup[] {
  const groups = new Map<string, SourceGroup>();
  for (const asset of manifest.assets) {
    const normalizedSourceUrl = normalizeSourceUrl(asset.sourceUrl);
    const existing = groups.get(normalizedSourceUrl);
    const sourceUrls = [asset.sourceUrl, ...asset.sourceUrls].map(
      normalizeSourceUrl,
    );
    if (existing) {
      existing.photoIds.push(asset.id);
      existing.sourceUrls.push(...sourceUrls);
    } else {
      groups.set(normalizedSourceUrl, {
        normalizedSourceUrl,
        photoIds: [asset.id],
        sourceUrls,
      });
    }
  }
  return [...groups.values()].map((group) => ({
    ...group,
    photoIds: [...new Set(group.photoIds)],
    sourceUrls: [...new Set(group.sourceUrls)],
  }));
}

export function fallbackUrls(sourceUrl: string): string[] {
  const normalized = normalizeSourceUrl(sourceUrl);
  return FALLBACK_WIDTHS.map((width) => {
    const url = new URL(normalized);
    url.searchParams.set('format', `${width}w`);
    return url.toString();
  });
}

export function estimateServingBytes(
  uniqueSourceCount: number,
  sampleBytes: number,
  sampleSize = PREFLIGHT_SAMPLE_SIZE,
  fixedOverheadBytes = PREFLIGHT_FIXED_OVERHEAD_BYTES,
  safetyFactor = PREFLIGHT_SAFETY_FACTOR,
): number {
  if (!Number.isFinite(uniqueSourceCount) || uniqueSourceCount < 0) {
    throw new ImageProcessorError('uniqueSourceCount must be non-negative');
  }
  if (!Number.isFinite(sampleBytes) || sampleBytes < 0) {
    throw new ImageProcessorError('sampleBytes must be non-negative');
  }
  if (
    !Number.isFinite(sampleSize) ||
    sampleSize <= 0 ||
    !Number.isFinite(safetyFactor) ||
    safetyFactor <= 0
  ) {
    throw new ImageProcessorError(
      'sampleSize and safetyFactor must be positive',
    );
  }
  return Math.ceil(
    (sampleBytes / sampleSize) * uniqueSourceCount * safetyFactor +
      fixedOverheadBytes,
  );
}

export function preflightPlan(
  input: InputSite | InputAssetManifest,
  options: Pick<ProcessOptions, 'maxServingBytes'> & {
    sampleBytes?: number;
    sampleSize?: number;
    sampleSource?: string;
  } = {},
): PreflightPlan {
  const groups = isAssetManifest(input)
    ? assetSourceGroups(input)
    : sourceGroups(input);
  const sampleSize = options.sampleSize ?? PREFLIGHT_SAMPLE_SIZE;
  const estimate =
    options.sampleBytes === undefined
      ? undefined
      : estimateServingBytes(groups.length, options.sampleBytes, sampleSize);
  return {
    mode: 'preflight',
    sourceCount: isAssetManifest(input)
      ? input.assets.length
      : Object.keys(input.photos).length,
    uniqueSourceCount: groups.length,
    sampleSize,
    ...(options.sampleBytes === undefined
      ? {}
      : {
          sampleBytes: options.sampleBytes,
          estimatedServingBytes: estimate,
          ...(options.sampleSource
            ? { sampleSource: options.sampleSource }
            : {}),
        }),
    servingBudgetBytes: options.maxServingBytes ?? MAX_SERVING_BYTES,
    withinBudget:
      estimate === undefined
        ? null
        : estimate <= (options.maxServingBytes ?? MAX_SERVING_BYTES),
    sourceUrls: groups.map((group) => group.normalizedSourceUrl),
  };
}

async function sleep(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function readCachedSource(
  cachePath: string,
  metadataPath: string,
  sourceUrl: string,
): Promise<DownloadedSource | undefined> {
  try {
    const rawMetadata = await readFile(metadataPath, 'utf8');
    const cached = JSON.parse(rawMetadata) as CachedSource;
    const fileStats = await stat(cachePath);
    if (
      cached.version !== 1 ||
      cached.sourceUrl !== sourceUrl ||
      fileStats.size !== cached.bytes
    )
      return undefined;
    const fileHash = await sha256File(cachePath);
    if (fileHash !== cached.sha256) return undefined;
    const inspection = await inspectImage(cachePath);
    if (
      inspection.mime !== cached.mime ||
      inspection.width !== cached.width ||
      inspection.height !== cached.height
    )
      return undefined;
    return {
      ...inspection,
      sourceUrl,
      selectedUrl: cached.selectedUrl,
      cachePath,
      bytes: cached.bytes,
      sha256: cached.sha256,
    };
  } catch {
    return undefined;
  }
}

async function streamResponseToFile(
  response: Response,
  targetPath: string,
  maxBytes: number,
): Promise<{ bytes: number; sha256: string }> {
  if (!response.body)
    throw new ImageProcessorError('Image response has no body');
  const handle = await open(targetPath, 'w');
  const hash = createHash('sha256');
  let bytes = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      const chunk = Buffer.from(part.value);
      bytes += chunk.byteLength;
      if (bytes > maxBytes)
        throw new DownloadTooLargeError(
          `Image response exceeded ${maxBytes} bytes`,
        );
      hash.update(chunk);
      await handle.write(chunk);
    }
  } finally {
    reader.releaseLock();
    await handle.close();
  }
  return { bytes, sha256: hash.digest('hex') };
}

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 5;

interface TimedResponse {
  response: Response;
  cancel: () => void;
}

function assertSecureRequestUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ImageProcessorError(`Invalid redirect URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new InsecureRedirectError(
      `Refusing non-HTTPS image redirect: ${url}`,
    );
  }
}

function isRedirect(response: Response): boolean {
  return response.status >= 300 && response.status < 400;
}

async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
): Promise<TimedResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let currentUrl = url;
  try {
    for (let redirect = 0; ; redirect += 1) {
      assertSecureRequestUrl(currentUrl);
      const response = await fetchImpl(currentUrl, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          accept: 'image/avif,image/webp,image/jpeg,image/png,image/*;q=0.8',
        },
      });
      if (!isRedirect(response)) {
        return {
          response,
          // Keep the abort timer alive until the streaming body has been
          // consumed. A response can succeed at headers and then stall.
          cancel: () => clearTimeout(timeout),
        };
      }
      const location = response.headers.get('location');
      if (!location) {
        return {
          response,
          cancel: () => clearTimeout(timeout),
        };
      }
      if (redirect >= MAX_REDIRECTS) {
        await response.body?.cancel();
        throw new ImageProcessorError(
          `Too many redirects while downloading ${url}`,
        );
      }
      await response.body?.cancel();
      let redirectedUrl: string;
      try {
        redirectedUrl = new URL(location, currentUrl).toString();
      } catch {
        throw new ImageProcessorError(`Invalid redirect URL: ${location}`);
      }
      // Validate before making the redirected request. In particular, never
      // allow an HTTPS image source to follow a downgrade to plaintext HTTP.
      assertSecureRequestUrl(redirectedUrl);
      currentUrl = redirectedUrl;
    }
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
}

function shouldRetryResponse(response: Response): boolean {
  return (
    response.status === 408 ||
    response.status === 425 ||
    response.status === 429 ||
    response.status >= 500
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function downloadSource(
  sourceUrl: string,
  options: {
    downloadsDirectory: string;
    fetchImpl?: FetchLike;
    maxDownloadBytes?: number;
    retryCount?: number;
    retryDelayMs?: number;
  },
): Promise<DownloadedSource> {
  const normalizedSourceUrl = normalizeSourceUrl(sourceUrl);
  const downloadsDirectory = options.downloadsDirectory;
  const maxDownloadBytes = options.maxDownloadBytes ?? MAX_DOWNLOAD_BYTES;
  const retryCount = options.retryCount ?? RETRIES_PER_URL;
  const retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  await mkdir(downloadsDirectory, { recursive: true });

  const cacheKey = sha256Hex(Buffer.from(normalizedSourceUrl));
  const cachePath = path.join(downloadsDirectory, `${cacheKey}.bin`);
  const metadataPath = path.join(downloadsDirectory, `${cacheKey}.json`);
  const cached = await readCachedSource(
    cachePath,
    metadataPath,
    normalizedSourceUrl,
  );
  if (cached) return cached;

  const candidates = fallbackUrls(normalizedSourceUrl);
  let lastError: Error = new ImageProcessorError(
    `Unable to download ${normalizedSourceUrl}`,
  );
  for (const candidate of candidates) {
    for (let attempt = 0; attempt < retryCount; attempt += 1) {
      const partialPath = `${cachePath}.part`;
      await rm(partialPath, { force: true });
      try {
        const timed = await fetchWithTimeout(fetchImpl, candidate);
        const response = timed.response;
        if (!response.ok) {
          await response.body?.cancel();
          timed.cancel();
          lastError = new ImageProcessorError(
            `HTTP ${response.status} for ${candidate}`,
          );
          if (!shouldRetryResponse(response)) break;
          throw lastError;
        }
        try {
          const streamed = await streamResponseToFile(
            response,
            partialPath,
            maxDownloadBytes,
          );
          const inspection = await inspectImage(partialPath);
          const selected: CachedSource = {
            version: 1,
            sourceUrl: normalizedSourceUrl,
            selectedUrl: candidate,
            bytes: streamed.bytes,
            sha256: streamed.sha256,
            mime: inspection.mime,
            format: inspection.format,
            width: inspection.width,
            height: inspection.height,
            ...(inspection.orientation
              ? { orientation: inspection.orientation }
              : {}),
          };
          await rename(partialPath, cachePath);
          await writeFile(
            metadataPath,
            `${JSON.stringify(selected, null, 2)}\n`,
            'utf8',
          );
          return {
            ...inspection,
            sourceUrl: normalizedSourceUrl,
            selectedUrl: candidate,
            cachePath,
            bytes: streamed.bytes,
            sha256: streamed.sha256,
          };
        } finally {
          timed.cancel();
        }
      } catch (error) {
        await rm(partialPath, { force: true });
        lastError =
          error instanceof Error
            ? error
            : new ImageProcessorError(errorMessage(error));
        if (error instanceof InsecureRedirectError) throw error;
        // A requested rendition can exceed the hard cap. Move to the next
        // bounded Squarespace rendition rather than ever accepting a partial
        // response; if every rendition is too large the final error remains
        // DownloadTooLargeError.
        if (error instanceof DownloadTooLargeError) break;
        if (attempt + 1 < retryCount) await sleep(retryDelayMs * (attempt + 1));
      }
    }
  }
  throw new ImageProcessorError(
    `Unable to download ${normalizedSourceUrl}: ${lastError.message}`,
  );
}

function imageResizeOptions(width: number): import('sharp').ResizeOptions {
  return {
    width,
    fit: 'inside',
    withoutEnlargement: true,
    kernel: sharp.kernel.lanczos3,
  };
}

async function encodeWebp(
  input: string | Buffer,
  width: number,
  quality: number,
  label: string,
): Promise<EncodedImage> {
  const { data, info } = await sharp(input, { failOn: 'error' })
    .rotate()
    .resize(imageResizeOptions(width))
    .toColourspace('srgb')
    .webp({ quality, effort: WEBP_EFFORT })
    .toBuffer({ resolveWithObject: true });
  const output = Buffer.from(data);
  assertEncodedFileSize(output.byteLength, label);
  const metadata = await inspectImage(output);
  if (metadata.format !== 'webp' || metadata.mime !== 'image/webp') {
    throw new ImageProcessorError('Sharp did not produce a WebP image');
  }
  if (metadata.width > width)
    throw new ImageProcessorError(
      `Encoded image exceeded target width ${width}`,
    );
  if (metadata.orientation !== undefined)
    throw new ImageProcessorError(
      'Encoded image retained orientation metadata',
    );
  if (info.width !== metadata.width || info.height !== metadata.height) {
    throw new ImageProcessorError(
      'Sharp output metadata disagrees with decoded dimensions',
    );
  }
  return {
    data: output,
    bytes: output.byteLength,
    sha256: sha256Hex(output),
    width: metadata.width,
    height: metadata.height,
    mime: 'image/webp',
  };
}

export async function encodeImagePair(
  sourcePath: string,
): Promise<EncodedPair> {
  const large = await encodeWebp(
    sourcePath,
    LARGE_WIDTH,
    LARGE_QUALITY,
    'large',
  );
  // The thumbnail must derive from the already oriented, colour-converted
  // large image so both outputs share exactly the same crop and orientation.
  const thumbnail = await encodeWebp(
    large.data,
    THUMB_WIDTH,
    THUMB_QUALITY,
    'thumbnail',
  );
  return { large, thumbnail };
}

export function assertEncodedFileSize(bytes: number, label: string): void {
  if (!Number.isFinite(bytes) || bytes < 0)
    throw new ImageProcessorError(`Invalid encoded ${label} byte count`);
  if (bytes >= MAX_SERVING_FILE_BYTES) {
    throw new ImageProcessorError(
      `Encoded ${label} file is ${bytes} bytes; serving files must be smaller than ${MAX_SERVING_FILE_BYTES} bytes`,
    );
  }
}

async function writeAtomic(
  filePath: string,
  contents: string | Uint8Array,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, contents);
  await rename(temporaryPath, filePath);
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const limit = Math.max(1, Math.floor(concurrency));
  const results: R[] = new Array(values.length);
  let nextIndex = 0;
  const run = async (): Promise<void> => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      results[index] = await worker(values[index], index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, () => run()),
  );
  return results;
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf8')) as T;
}

interface BudgetProjection {
  assets?: {
    large?: { gallery_weighted_average_bytes?: number };
    thumbnail?: { gallery_weighted_average_bytes?: number };
  };
}

async function projectedSample(
  projectionPath: string,
  sampleSize: number,
): Promise<number> {
  const projection = await readJson<BudgetProjection>(projectionPath);
  const large = projection.assets?.large?.gallery_weighted_average_bytes;
  const thumbnail =
    projection.assets?.thumbnail?.gallery_weighted_average_bytes;
  if (
    typeof large !== 'number' ||
    typeof thumbnail !== 'number' ||
    !Number.isFinite(large) ||
    !Number.isFinite(thumbnail) ||
    large < 0 ||
    thumbnail < 0
  ) {
    throw new ImageProcessorError(
      `Budget projection has no valid gallery-weighted image averages: ${projectionPath}`,
    );
  }
  return (large + thumbnail) * sampleSize;
}

async function writeStagedPair(
  stageDirectory: string,
  contentHash: string,
  pair: EncodedPair,
): Promise<{ largePath: string; thumbnailPath: string }> {
  const largePath = path.join(stageDirectory, `${contentHash}.webp`);
  const thumbnailPath = path.join(stageDirectory, `${contentHash}-thumb.webp`);
  await writeFile(largePath, pair.large.data);
  await writeFile(thumbnailPath, pair.thumbnail.data);
  return { largePath, thumbnailPath };
}

async function readCachedEncodedPair(
  outputDirectory: string,
  image: ImageManifestImage,
): Promise<EncodedPair | undefined> {
  const largePath = path.join(outputDirectory, path.basename(image.large.path));
  const thumbnailPath = path.join(
    outputDirectory,
    path.basename(image.thumbnail.path),
  );
  try {
    const [largeData, thumbnailData] = await Promise.all([
      readFile(largePath),
      readFile(thumbnailPath),
    ]);
    if (
      largeData.byteLength !== image.large.bytes ||
      thumbnailData.byteLength !== image.thumbnail.bytes ||
      sha256Hex(largeData) !== image.large.sha256 ||
      sha256Hex(thumbnailData) !== image.thumbnail.sha256
    ) {
      return undefined;
    }
    assertEncodedFileSize(largeData.byteLength, 'large');
    assertEncodedFileSize(thumbnailData.byteLength, 'thumbnail');
    const [largeInspection, thumbnailInspection] = await Promise.all([
      inspectImage(largeData),
      inspectImage(thumbnailData),
    ]);
    if (
      largeInspection.mime !== 'image/webp' ||
      thumbnailInspection.mime !== 'image/webp' ||
      largeInspection.width !== image.large.width ||
      largeInspection.height !== image.large.height ||
      thumbnailInspection.width !== image.thumbnail.width ||
      thumbnailInspection.height !== image.thumbnail.height
    ) {
      return undefined;
    }
    return {
      large: {
        data: largeData,
        bytes: largeData.byteLength,
        sha256: image.large.sha256,
        width: largeInspection.width,
        height: largeInspection.height,
        mime: 'image/webp',
      },
      thumbnail: {
        data: thumbnailData,
        bytes: thumbnailData.byteLength,
        sha256: image.thumbnail.sha256,
        width: thumbnailInspection.width,
        height: thumbnailInspection.height,
        mime: 'image/webp',
      },
    };
  } catch {
    return undefined;
  }
}

async function commitStagedPair(
  stageDirectory: string,
  outputDirectory: string,
  contentHash: string,
): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });
  await rename(
    path.join(stageDirectory, `${contentHash}.webp`),
    path.join(outputDirectory, `${contentHash}.webp`),
  );
  await rename(
    path.join(stageDirectory, `${contentHash}-thumb.webp`),
    path.join(outputDirectory, `${contentHash}-thumb.webp`),
  );
}

function manifestOutputPublicPaths(
  manifest: ImagesManifest | undefined,
): Set<string> {
  const paths = new Set<string>();
  for (const image of manifest?.images ?? []) {
    for (const publicPath of [image.large.path, image.thumbnail.path]) {
      const normalised = publicPath.replaceAll('\\', '/');
      if (/^\/images\/[A-Za-z0-9._-]+\.webp$/.test(normalised))
        paths.add(normalised);
    }
  }
  return paths;
}

function safeOutputPath(
  outputDirectory: string,
  publicPath: string,
): string | undefined {
  const normalised = publicPath.replaceAll('\\', '/');
  if (!/^\/images\/[A-Za-z0-9._-]+\.webp$/.test(normalised)) return undefined;
  return path.join(outputDirectory, path.basename(normalised));
}

async function pruneOutputPaths(
  outputDirectory: string,
  publicPaths: Iterable<string>,
): Promise<void> {
  const files = [...new Set(publicPaths)]
    .map((publicPath) => safeOutputPath(outputDirectory, publicPath))
    .filter((filePath): filePath is string => Boolean(filePath));
  await Promise.all(files.map((filePath) => rm(filePath, { force: true })));
}

function safeStageDirectory(
  outputDirectory: string,
  stageDirectory: string,
  transactionId: string,
): string | undefined {
  const outputRoot = path.resolve(outputDirectory);
  const stageRoot = path.resolve(stageDirectory);
  if (path.dirname(stageRoot) !== outputRoot) return undefined;
  if (path.basename(stageRoot) !== `.staging-${transactionId}`)
    return undefined;
  return stageRoot;
}

function pendingManifestPath(imagesManifestPath: string): string {
  return `${imagesManifestPath}${PENDING_MANIFEST_SUFFIX}`;
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

function sameSnapshot(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

async function readOptionalJson<T>(filePath: string): Promise<T | undefined> {
  try {
    return await readJson<T>(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function transactionJournal(value: unknown): TransactionJournal {
  if (!value || typeof value !== 'object')
    throw new ImageProcessorError('Pending image transaction is malformed');
  const journal = value as Partial<TransactionJournal>;
  if (
    journal.version !== 1 ||
    typeof journal.transactionId !== 'string' ||
    typeof journal.outputDirectory !== 'string' ||
    typeof journal.sitePath !== 'string' ||
    typeof journal.stageDirectory !== 'string' ||
    !Array.isArray(journal.outputPaths) ||
    journal.outputPaths.some((publicPath) => typeof publicPath !== 'string') ||
    !journal.nextManifest ||
    typeof journal.nextManifest !== 'object' ||
    Array.isArray(journal.nextManifest) ||
    !journal.previousSite ||
    typeof journal.previousSite !== 'object' ||
    Array.isArray(journal.previousSite) ||
    !journal.nextSite ||
    typeof journal.nextSite !== 'object' ||
    Array.isArray(journal.nextSite)
  ) {
    throw new ImageProcessorError('Pending image transaction is malformed');
  }
  return journal as TransactionJournal;
}

async function recoverPendingTransaction(
  imagesManifestPath: string,
  sitePath: string,
  outputDirectory: string,
  currentManifest: ImagesManifest | undefined,
  currentSite: InputSite,
): Promise<RecoveryState> {
  const journalPath = pendingManifestPath(imagesManifestPath);
  const rawJournal = await readOptionalJson<unknown>(journalPath);
  if (rawJournal === undefined)
    return { manifest: currentManifest, site: currentSite };
  const journal = transactionJournal(rawJournal);
  const stageDirectory = safeStageDirectory(
    outputDirectory,
    journal.stageDirectory,
    journal.transactionId,
  );
  if (path.resolve(journal.outputDirectory) !== path.resolve(outputDirectory)) {
    throw new ImageProcessorError(
      `Pending image transaction targets a different output directory: ${journal.outputDirectory}`,
    );
  }
  if (path.resolve(journal.sitePath) !== path.resolve(sitePath)) {
    throw new ImageProcessorError(
      `Pending image transaction targets a different site path: ${journal.sitePath}`,
    );
  }

  const manifestPublished =
    currentManifest?.status === 'complete' &&
    currentManifest.transactionId === journal.transactionId;
  const sitePublished =
    !sameSnapshot(journal.previousSite, journal.nextSite) &&
    sameSnapshot(currentSite, journal.nextSite);
  if (manifestPublished || sitePublished) {
    // Either metadata file may have been written immediately before an
    // interruption. Complete both from the journal before removing it.
    await writeAtomic(
      imagesManifestPath,
      `${JSON.stringify(journal.nextManifest, null, 2)}\n`,
    );
    await writeAtomic(
      sitePath,
      `${JSON.stringify(journal.nextSite, null, 2)}\n`,
    );
    if (stageDirectory)
      await rm(stageDirectory, { recursive: true, force: true });
    await rm(journalPath, { force: true });
    return { manifest: journal.nextManifest, site: journal.nextSite };
  }

  const protectedPaths = new Set(
    manifestOutputPublicPaths(
      currentManifest ?? journal.previousManifest ?? undefined,
    ),
  );
  await pruneOutputPaths(
    outputDirectory,
    journal.outputPaths.filter((publicPath) => !protectedPaths.has(publicPath)),
  );
  if (stageDirectory)
    await rm(stageDirectory, { recursive: true, force: true });
  await rm(journalPath, { force: true });
  return {
    manifest: currentManifest ?? journal.previousManifest ?? undefined,
    site: currentSite,
  };
}

async function recoverPendingCleanup(
  imagesManifestPath: string,
  outputDirectory: string,
  manifest: ImagesManifest | undefined,
): Promise<ImagesManifest | undefined> {
  if (!manifest?.pendingCleanupPaths?.length) return manifest;
  await pruneOutputPaths(outputDirectory, manifest.pendingCleanupPaths);
  const cleaned: ImagesManifest = { ...manifest };
  delete cleaned.pendingCleanupPaths;
  await writeAtomic(
    imagesManifestPath,
    `${JSON.stringify(cleaned, null, 2)}\n`,
  );
  return cleaned;
}

function publicImagePath(contentHash: string, thumbnail = false): string {
  return `/images/${contentHash}${thumbnail ? '-thumb' : ''}.webp`;
}

function encodedPairKey(pair: EncodedPair): string {
  return `${pair.large.sha256}:${pair.thumbnail.sha256}`;
}

function contentGroups(sourceResults: SourceResult[]): ContentGroup[] {
  const groups = new Map<string, ContentGroup>();
  for (const source of sourceResults) {
    const existing = groups.get(source.sha256);
    if (existing) {
      existing.sourceResults.push(source);
      existing.photoIds.push(...source.sourcePhotoIds);
    } else {
      groups.set(source.sha256, {
        contentHash: source.sha256,
        sourceResults: [source],
        photoIds: [...source.sourcePhotoIds],
      });
    }
  }
  return [...groups.values()];
}

function sourceForGroup(group: ContentGroup): SourceResult {
  const source = group.sourceResults[0];
  if (!source)
    throw new ImageProcessorError(
      `Content group ${group.contentHash} has no source`,
    );
  return source;
}

function servingGroups(encoded: EncodedResult[]): ServingGroup[] {
  const groups = new Map<string, ServingGroup>();
  for (const item of encoded) {
    const key = encodedPairKey(item.pair);
    const existing = groups.get(key);
    if (existing) {
      existing.members.push(item);
    } else {
      groups.set(key, {
        contentHash: item.group.contentHash,
        pair: item.pair,
        members: [item],
      });
    }
  }
  return [...groups.values()];
}

function sourceVariant(result: SourceResult): SourceVariant {
  return {
    sourceSha256: result.sha256,
    photoIds: [...result.sourcePhotoIds],
    sourceUrls: [
      ...new Set([result.sourceUrl, result.selectedUrl, ...result.sourceUrls]),
    ],
    selectedUrl: result.selectedUrl,
    sourceBytes: result.bytes,
    sourceMime: result.mime,
    sourceFormat: result.format,
    sourceWidth: result.width,
    sourceHeight: result.height,
    ...(result.orientation ? { sourceOrientation: result.orientation } : {}),
  };
}

function createManifestImage(serving: ServingGroup): ImageManifestImage {
  const sourceResults = serving.members.flatMap(
    (member) => member.group.sourceResults,
  );
  const source = sourceResults[0];
  if (!source)
    throw new ImageProcessorError(
      `Serving group ${serving.contentHash} has no source`,
    );
  const photoIds = serving.members.flatMap((member) => member.group.photoIds);
  const sourceVariants = sourceResults.map(sourceVariant);
  return {
    contentHash: serving.contentHash,
    photoIds: [...new Set(photoIds)],
    sourceUrls: [
      ...new Set(
        sourceResults.flatMap((result) => [
          result.sourceUrl,
          result.selectedUrl,
          ...result.sourceUrls,
        ]),
      ),
    ],
    sourceVariants,
    selectedUrl: source.selectedUrl,
    sourceBytes: source.bytes,
    sourceMime: source.mime,
    sourceFormat: source.format,
    sourceWidth: source.width,
    sourceHeight: source.height,
    ...(source.orientation ? { sourceOrientation: source.orientation } : {}),
    large: {
      path: publicImagePath(serving.contentHash),
      bytes: serving.pair.large.bytes,
      sha256: serving.pair.large.sha256,
      width: serving.pair.large.width,
      height: serving.pair.large.height,
      mime: 'image/webp',
    },
    thumbnail: {
      path: publicImagePath(serving.contentHash, true),
      bytes: serving.pair.thumbnail.bytes,
      sha256: serving.pair.thumbnail.sha256,
      width: serving.pair.thumbnail.width,
      height: serving.pair.thumbnail.height,
      mime: 'image/webp',
    },
    status: serving.members.every((member) => member.cached)
      ? 'cached'
      : 'processed',
  };
}

function updatedPhoto(
  photo: SourcePhoto,
  image: ImageManifestImage,
): Photo & Record<string, unknown> {
  return {
    id: photo.id,
    large: image.large.path,
    thumbnail: image.thumbnail.path,
    width: image.large.width,
    height: image.large.height,
    thumbnailWidth: image.thumbnail.width,
    thumbnailHeight: image.thumbnail.height,
  } as Photo & Record<string, unknown>;
}

export async function processSite(
  options: ProcessOptions = {},
): Promise<ProcessResult> {
  const assetManifestPath =
    options.assetManifestPath ?? DEFAULT_ASSET_MANIFEST_PATH;
  const sitePath = options.sitePath ?? DEFAULT_SITE_PATH;
  const mode = options.mode ?? 'preflight';
  const assetManifest = await readJson<InputAssetManifest>(assetManifestPath);
  let site = await readJson<InputSite>(sitePath);
  const budgetProjectionPath =
    options.budgetProjectionPath ?? DEFAULT_BUDGET_PROJECTION_PATH;
  const sampleSize = options.sampleSize ?? PREFLIGHT_SAMPLE_SIZE;
  let sampleBytes = options.sampleBytes;
  let sampleSource: string | undefined;
  if (sampleBytes === undefined) {
    try {
      sampleBytes = await projectedSample(budgetProjectionPath, sampleSize);
      sampleSource = budgetProjectionPath;
    } catch (error) {
      if (mode === 'run') throw error;
    }
  } else {
    sampleSource = 'cli';
  }
  const plan = preflightPlan(assetManifest, {
    maxServingBytes: options.maxServingBytes,
    sampleBytes,
    sampleSize,
    sampleSource,
  });
  if (mode === 'preflight') return { mode, plan };
  if (plan.withinBudget !== true) {
    throw new ServingBudgetExceededError(
      plan.estimatedServingBytes === undefined
        ? 'Bulk image processing requires a measured budget projection.'
        : `Projected serving bytes ${plan.estimatedServingBytes} exceed budget ${plan.servingBudgetBytes}`,
    );
  }

  const downloadsDirectory = options.downloadsDirectory ?? DEFAULT_DOWNLOAD_DIR;
  const outputDirectory = options.outputDirectory ?? DEFAULT_OUTPUT_DIR;
  const imagesManifestPath = options.imagesManifestPath ?? DEFAULT_IMAGES_PATH;
  const maxDownloadBytes = options.maxDownloadBytes ?? MAX_DOWNLOAD_BYTES;
  const maxServingBytes = options.maxServingBytes ?? MAX_SERVING_BYTES;
  const now = options.now ?? (() => new Date());
  let existingManifest =
    await readOptionalJson<ImagesManifest>(imagesManifestPath);
  const recovery = await recoverPendingTransaction(
    imagesManifestPath,
    sitePath,
    outputDirectory,
    existingManifest,
    site,
  );
  existingManifest = recovery.manifest;
  site = recovery.site;
  existingManifest = await recoverPendingCleanup(
    imagesManifestPath,
    outputDirectory,
    existingManifest,
  );
  const groups = assetSourceGroups(assetManifest);
  const existingImages = new Map<string, ImageManifestImage>();
  for (const image of existingManifest?.images ?? []) {
    existingImages.set(image.contentHash, image);
    for (const variant of image.sourceVariants ?? [])
      existingImages.set(variant.sourceSha256, image);
  }

  const outcomes = await mapWithConcurrency<SourceGroup, DownloadOutcome>(
    groups,
    asPositiveInteger(options.downloadConcurrency, DOWNLOAD_CONCURRENCY),
    async (group) => {
      try {
        return {
          ok: true,
          result: {
            ...(await downloadSource(group.normalizedSourceUrl, {
              downloadsDirectory,
              fetchImpl: options.fetchImpl,
              maxDownloadBytes,
              retryCount: options.retryCount,
              retryDelayMs: options.retryDelayMs,
            })),
            sourcePhotoIds: group.photoIds,
            sourceUrls: group.sourceUrls,
          },
        };
      } catch (error) {
        return {
          ok: false,
          group,
          error: errorMessage(error),
        };
      }
    },
  );
  const failures = outcomes.filter(
    (outcome): outcome is Extract<DownloadOutcome, { ok: false }> =>
      !outcome.ok,
  );
  if (failures.length) {
    const failureManifest: ImagesManifest = {
      version: 1,
      generatedAt: now().toISOString(),
      assetManifestPath,
      sitePath,
      outputDirectory,
      downloadDirectory: downloadsDirectory,
      sourceCount: assetManifest.assets.length,
      ...(existingManifest?.sourceContentCount === undefined
        ? {}
        : { sourceContentCount: existingManifest.sourceContentCount }),
      uniqueContentCount: existingManifest?.uniqueContentCount ?? 0,
      servingBytes: existingManifest?.servingBytes ?? 0,
      servingBudgetBytes: maxServingBytes,
      images: existingManifest?.images ?? [],
      status: 'failed',
      failures: failures.map((failure) => ({
        photoIds: failure.group.photoIds,
        sourceUrl: failure.group.normalizedSourceUrl,
        error: failure.error,
      })),
      error: `${failures.length} image source download(s) failed`,
    };
    await writeAtomic(
      imagesManifestPath,
      `${JSON.stringify(failureManifest, null, 2)}\n`,
    );
    throw new ImageProcessorError(failureManifest.error);
  }
  const sources = outcomes.map((outcome) => {
    if (!outcome.ok) throw new ImageProcessorError(outcome.error);
    return outcome.result;
  });
  const groupedContent = contentGroups(sources);
  const transactionId = `${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
  const stageDirectory = path.join(
    outputDirectory,
    `.staging-${transactionId}`,
  );
  await mkdir(stageDirectory, { recursive: true });

  try {
    const encoded = await mapWithConcurrency<ContentGroup, EncodedResult>(
      groupedContent,
      asPositiveInteger(options.encodeConcurrency, ENCODE_CONCURRENCY),
      async (group) => {
        const source = sourceForGroup(group);
        const cachedImage = existingImages.get(group.contentHash);
        const cachedPair = cachedImage
          ? await readCachedEncodedPair(outputDirectory, cachedImage)
          : undefined;
        if (cachedPair)
          return { group, source, pair: cachedPair, cached: true };
        const pair = await encodeImagePair(source.cachePath);
        return { group, source, pair, cached: false };
      },
    );
    const serving = servingGroups(encoded);
    const servingBytes = serving.reduce(
      (total, item) =>
        total + item.pair.large.bytes + item.pair.thumbnail.bytes,
      0,
    );
    if (servingBytes > maxServingBytes) {
      throw new ServingBudgetExceededError(
        `Encoded serving bytes ${servingBytes} exceed budget ${maxServingBytes}`,
      );
    }

    const manifestImages = serving.map((item) => createManifestImage(item));
    const byPhotoId = new Map<string, ImageManifestImage>();
    for (const image of manifestImages)
      for (const photoId of image.photoIds) byPhotoId.set(photoId, image);
    const updatedPhotos: Record<string, Photo & Record<string, unknown>> = {};
    for (const asset of assetManifest.assets) {
      const image = byPhotoId.get(asset.id);
      if (!image)
        throw new ImageProcessorError(
          `No processed image for asset ${asset.id}`,
        );
      const existingPhoto = site.photos[asset.id];
      updatedPhotos[asset.id] = updatedPhoto(
        {
          ...(existingPhoto ?? {}),
          id: asset.id,
          sourceUrl: existingPhoto?.sourceUrl ?? asset.sourceUrl,
        },
        image,
      );
    }

    const manifest: ImagesManifest = {
      version: 1,
      generatedAt: now().toISOString(),
      assetManifestPath,
      sitePath,
      outputDirectory,
      downloadDirectory: downloadsDirectory,
      sourceCount: assetManifest.assets.length,
      sourceContentCount: groupedContent.length,
      uniqueContentCount: serving.length,
      servingBytes,
      servingBudgetBytes: maxServingBytes,
      images: manifestImages,
      status: 'complete',
    };

    const previousOutputPaths = manifestOutputPublicPaths(existingManifest);
    const nextOutputPaths = manifestOutputPublicPaths(manifest);
    const pendingCleanupPaths = [...previousOutputPaths].filter(
      (publicPath) => !nextOutputPaths.has(publicPath),
    );
    const nextManifest: ImagesManifest = {
      ...manifest,
      transactionId,
      ...(pendingCleanupPaths.length > 0 ? { pendingCleanupPaths } : {}),
    };
    const updatedSite: InputSite = { ...site, photos: updatedPhotos };
    const journal: TransactionJournal = {
      version: 1,
      transactionId,
      outputDirectory,
      sitePath,
      stageDirectory,
      outputPaths: [...nextOutputPaths],
      previousManifest: existingManifest ?? null,
      nextManifest,
      previousSite: site,
      nextSite: updatedSite,
    };
    await writeAtomic(
      pendingManifestPath(imagesManifestPath),
      `${JSON.stringify(journal, null, 2)}\n`,
    );

    for (const item of serving) {
      await writeStagedPair(stageDirectory, item.contentHash, item.pair);
      await commitStagedPair(stageDirectory, outputDirectory, item.contentHash);
    }
    await writeAtomic(
      imagesManifestPath,
      `${JSON.stringify(nextManifest, null, 2)}\n`,
    );
    await writeAtomic(sitePath, `${JSON.stringify(updatedSite, null, 2)}\n`);
    await rm(pendingManifestPath(imagesManifestPath), { force: true });
    await pruneOutputPaths(outputDirectory, pendingCleanupPaths);
    const finalManifest: ImagesManifest = { ...nextManifest };
    delete finalManifest.pendingCleanupPaths;
    await writeAtomic(
      imagesManifestPath,
      `${JSON.stringify(finalManifest, null, 2)}\n`,
    );
    return { mode, manifest: finalManifest, site: updatedSite };
  } finally {
    await rm(stageDirectory, { recursive: true, force: true });
  }
}

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function printHelp(): void {
  console.log(`Usage: npm run images -- [--preflight|--run] [options]

The default is a read-only preflight. Bulk download and encoding require --run.

Options:
  --assets PATH     Input migration/manifests/assets.json
  --site PATH       Input src/content/site.json
  --manifest PATH  Output migration/manifests/images.json
  --downloads PATH  Ignored raw-download cache directory
  --output PATH     public/images output directory
  --budget PATH     Existing measured budget projection JSON
  --sample-bytes N  Sample bytes measured by a preflight run (for budget estimate)
  --help            Show this help
`);
}

function cliSummary(result: ProcessResult): Record<string, unknown> {
  if (result.plan) {
    return {
      mode: 'preflight',
      sourceCount: result.plan.sourceCount,
      uniqueSourceCount: result.plan.uniqueSourceCount,
      sampleSize: result.plan.sampleSize,
      ...(result.plan.sampleBytes === undefined
        ? {}
        : {
            sampleBytes: result.plan.sampleBytes,
            estimatedServingBytes: result.plan.estimatedServingBytes,
            sampleSource: result.plan.sampleSource,
          }),
      servingBudgetBytes: result.plan.servingBudgetBytes,
      withinBudget: result.plan.withinBudget,
    };
  }
  const manifest = result.manifest;
  if (!manifest) return { mode: result.mode };
  return {
    mode: 'run',
    status: manifest.status ?? 'complete',
    sourceCount: manifest.sourceCount,
    uniqueContentCount: manifest.uniqueContentCount,
    servingBytes: manifest.servingBytes,
    servingBudgetBytes: manifest.servingBudgetBytes,
    failures: manifest.failures?.length ?? 0,
  };
}

async function cli(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help')) return printHelp();
  const mode = args.includes('--run') ? 'run' : 'preflight';
  const result = await processSite({
    mode,
    assetManifestPath: flagValue(args, '--assets'),
    sitePath: flagValue(args, '--site'),
    imagesManifestPath: flagValue(args, '--manifest'),
    downloadsDirectory: flagValue(args, '--downloads'),
    outputDirectory: flagValue(args, '--output'),
    budgetProjectionPath: flagValue(args, '--budget'),
    sampleBytes: flagValue(args, '--sample-bytes')
      ? Number(flagValue(args, '--sample-bytes'))
      : undefined,
  });
  console.log(JSON.stringify(cliSummary(result), null, 2));
  if (result.plan?.withinBudget === false) process.exitCode = 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cli().catch((error: unknown) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
