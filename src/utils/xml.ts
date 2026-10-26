/**
 * @module utils/xml
 * @description SOAP / XML 字串處理工具（零外部相依套件，相容 Cloudflare Workers 執行環境）。
 */

/**
 * 將字串中的 XML 特殊字元進行標準實體跳脫，防止帳號或密碼含有 `&`, `<`, `>` 等符號時破壞 SOAP Request 結構。
 */
export function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 還原常見的 XML 實體跳脫字元（作為未來若上游改將 JSON 包入 XML 元素內時的相容處理）。
 */
export function unescapeXml(escaped: string): string {
  return escaped
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
