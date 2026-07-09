/** 标题里常见的通用页面词（整段完全匹配才丢弃）：这些词代表页面而非站点本身。 */
const GENERIC_TITLE_SEGMENT =
  /^(首页|主页|门户|欢迎|欢迎(登录|使用|访问)|登录|登陆|登录页(面)?|用户登录|系统登录|账号登录|扫码登录|注册|统一身份认证|统一认证|单点登录|认证中心|身份认证|控制台|工作台|管理后台|后台管理|后台|home(page)?|index|portal|dashboard|console|welcome|log ?in|sign ?in|sign ?up|signin|signup|register|sso|auth(entication)?|admin)$/i;

/**
 * 标题分段：竖线/书名号/间隔号任意间距都算分隔；连字符类（- – — －）需两侧带空格，
 * 或至少一侧紧邻中日韩字符（如「登录-XX平台」），避免拆散 "K3s-Dashboard" 这类名字。
 */
const TITLE_SEPARATOR =
  /\s*[|｜«»·•]\s*|\s+[-–—－_]\s+|(?<=[⺀-鿿豈-﫿])\s*[-–—－]\s*|\s*[-–—－]\s*(?=[⺀-鿿豈-﫿])/;

/**
 * 从网页标题提取站点名：按分隔符拆段、丢弃「首页 / 登录」等通用页面词，
 * 取剩余最长的一段。没有标题或全部是通用词时返回 undefined（调用方回退 host）。
 */
export function siteNameFromTitle(title?: string): string | undefined {
  const clean = (title ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return undefined;
  const parts = clean
    .split(TITLE_SEPARATOR)
    .map((s) => s.trim())
    .filter(Boolean);
  let pick = '';
  for (const part of parts) {
    if (GENERIC_TITLE_SEGMENT.test(part)) continue;
    if (part.length > pick.length) pick = part;
  }
  return pick ? pick.slice(0, 60) : undefined;
}
