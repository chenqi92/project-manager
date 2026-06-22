// ---------------------------------------------------------------------------
// 从图片文件里识别二维码,返回其文本内容。纯本地(jsqr,无网络/无远程代码),
// 符合扩展严格 CSP。用于:单条 otpauth:// 二维码、Google Authenticator 导出码。
// ---------------------------------------------------------------------------
import jsQR from 'jsqr';

export async function decodeQrImage(file: File): Promise<string> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('无法读取该图片');
  }
  const { width, height } = bitmap;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    throw new Error('无法创建画布以解析图片');
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const img = ctx.getImageData(0, 0, width, height);
  const result = jsQR(img.data, width, height);
  if (!result || !result.data) throw new Error('未能在图片中识别到二维码');
  return result.data;
}
