import { MAX_IMAGE_PIXELS, MAX_IMAGE_SIDE } from "../domain/limits";
import { PosterError, type PosterAsset } from "../domain/types";
import { cancelled } from "./cancellation";

const MAX_CACHED_IMAGES = 8;
const MAX_REGISTERED_FONTS = 16;
let rendererSequence = 0;

export function createRenderAssets(signal: AbortSignal) {
  const prefix = `poster_font_${++rendererSequence}`;
  let fontSequence = 0;
  let fonts = new WeakMap<Blob, Promise<FontFace>>();
  const registered = new Set<FontFace>();
  const pendingImages = new WeakMap<Blob, Promise<HTMLImageElement>>();
  const images = new Map<Blob, HTMLImageElement>();
  let cachedPixels = 0;

  function font(asset: PosterAsset): Promise<FontFace> {
    const existing = fonts.get(asset.blob);
    if (existing) return existing;
    const family = `${prefix}_${++fontSequence}`;
    const pending = (async () => {
      try {
        const bytes = await asset.blob.arrayBuffer();
        if (signal.aborted) throw cancelled();
        // 字体字节完成加载后可直接注册，无需等待页面其他字体。
        return await new FontFace(family, bytes).load();
      } catch (error) {
        if (error instanceof PosterError) throw error;
        throw new PosterError(
          "FONT_LOAD_FAILED",
          `字体“${asset.name}”加载失败，请重新上传有效字体`,
        );
      }
    })();
    fonts.set(asset.blob, pending);
    void pending.catch(() => fonts.delete(asset.blob));
    return pending;
  }

  function registerFonts(faces: FontFace[]) {
    for (const face of faces) {
      if (!registered.delete(face)) document.fonts.add(face);
      registered.add(face);
    }
  }

  function trimFonts() {
    // 绘制完成后再淘汰，确保一张海报使用的全部字体在绘制期间可用。
    while (registered.size > MAX_REGISTERED_FONTS) {
      const oldest = registered.values().next().value!;
      document.fonts.delete(oldest);
      registered.delete(oldest);
    }
  }

  function background(asset: PosterAsset): Promise<HTMLImageElement> {
    if (!/^image\/(png|jpeg|webp|gif|avif|bmp)$/i.test(asset.mimeType)) {
      return Promise.reject(
        new PosterError("INVALID_ASSET", "底图必须为 PNG、JPEG、WebP 等位图文件"),
      );
    }
    const { blob } = asset;
    const cached = images.get(blob);
    if (cached) {
      images.delete(blob);
      images.set(blob, cached);
      return Promise.resolve(cached);
    }
    const existing = pendingImages.get(blob);
    if (existing) return existing;
    const pending = new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      const url = URL.createObjectURL(blob);
      const cleanup = () => {
        URL.revokeObjectURL(url);
        image.onload = image.onerror = null;
        signal.removeEventListener("abort", abort);
      };
      const abort = () => {
        cleanup();
        image.removeAttribute("src");
        reject(cancelled());
      };
      const fail = (message: string) => {
        cleanup();
        reject(new PosterError("INVALID_ASSET", message));
      };
      const cannotDecode = () => fail(`底图“${asset.name}”无法解码`);
      signal.addEventListener("abort", abort, { once: true });
      image.onload = () => {
        const { naturalWidth: width, naturalHeight: height } = image;
        if (!width || !height) return fail("底图尺寸无效");
        if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE || width * height > MAX_IMAGE_PIXELS)
          return fail("底图尺寸过大");
        void image.decode().then(
          () => {
            if (signal.aborted) return;
            cleanup();
            resolve(image);
          },
          () => {
            if (!signal.aborted) cannotDecode();
          },
        );
      };
      image.onerror = cannotDecode;
      image.src = url;
    }).then((image) => {
      if (signal.aborted) throw cancelled();
      // 以实际解码像素控制底图缓存，避免高压缩比素材持续占用大量位图内存。
      images.set(blob, image);
      cachedPixels += image.naturalWidth * image.naturalHeight;
      while (images.size > MAX_CACHED_IMAGES || cachedPixels > MAX_IMAGE_PIXELS) {
        const [oldest, removed] = images.entries().next().value!;
        images.delete(oldest);
        cachedPixels -= removed.naturalWidth * removed.naturalHeight;
      }
      return image;
    });
    pendingImages.set(blob, pending);
    const forget = () => pendingImages.delete(blob);
    void pending.then(forget, forget);
    return pending;
  }

  return {
    background,
    font,
    registerFonts,
    trimFonts,
    dispose() {
      for (const face of registered) document.fonts.delete(face);
      registered.clear();
      images.clear();
      cachedPixels = 0;
      fonts = new WeakMap();
    },
  };
}
