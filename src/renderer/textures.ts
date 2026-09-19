/**
 * 贴图加载：支持按最长边降采样后再上传，避免 8K 贴图吃掉 1.4GB 显存
 * （许可：Live2D Cubism SDK 的使用遵守 vendor/cubism/LICENSE.md）
 */
export interface LoadedTexture {
  file: string;
  url: string;
  srcWidth: number;
  srcHeight: number;
  uploadedWidth: number;
  uploadedHeight: number;
  downscaled: boolean;
  vramBytes: number;
  glTexture: WebGLTexture;
}

export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.addEventListener('load', () => resolve(img), { passive: true, once: true });
    img.addEventListener(
      'error',
      () => reject(new Error(`图片加载失败: ${url}`)),
      { passive: true, once: true }
    );
    img.src = url;
  });
}

export function maxTextureSize(gl: WebGL2RenderingContext): number {
  return gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
}

/** 需要时用 canvas 降采样（保持非预乘 alpha，交给 GL 上传时预乘） */
function downscale(img: HTMLImageElement, maxEdge: number): HTMLCanvasElement | null {
  const longest = Math.max(img.width, img.height);
  if (longest <= maxEdge) return null;
  const k = maxEdge / longest;
  const w = Math.max(1, Math.round(img.width * k));
  const h = Math.max(1, Math.round(img.height * k));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return canvas;
}

export async function createModelTexture(
  gl: WebGL2RenderingContext,
  url: string,
  file: string,
  maxEdge: number
): Promise<LoadedTexture> {
  const img = await loadImage(url);
  const hardLimit = maxTextureSize(gl);
  const limit = Math.max(2, Math.min(maxEdge, hardLimit));
  const scaled = downscale(img, limit);
  const source: TexImageSource = scaled ?? img;
  const width = scaled ? scaled.width : img.width;
  const height = scaled ? scaled.height : img.height;

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  // Cubism 内部按预乘 alpha 处理，磁盘上的 PNG 是非预乘的，这里交给 GL 预乘
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.bindTexture(gl.TEXTURE_2D, null);

  return {
    file,
    url,
    srcWidth: img.width,
    srcHeight: img.height,
    uploadedWidth: width,
    uploadedHeight: height,
    downscaled: !!scaled,
    vramBytes: width * height * 4,
    glTexture: tex,
  };
}
