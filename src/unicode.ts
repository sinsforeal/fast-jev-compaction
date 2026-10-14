/** Slice by UTF-16 offset without cutting a surrogate pair in half. */
export function safeSlice(text: string, start = 0, end = text.length): string {
  const offset = (n: number): number => n < 0 ? Math.max(0, text.length + n) : Math.min(text.length, n);
  let a = offset(start);
  let b = offset(end);
  const split = (i: number): boolean => i > 0 && i < text.length &&
    text.charCodeAt(i - 1) >= 0xd800 && text.charCodeAt(i - 1) <= 0xdbff &&
    text.charCodeAt(i) >= 0xdc00 && text.charCodeAt(i) <= 0xdfff;
  if (split(a)) a += 1;
  if (split(b)) b -= 1;
  return text.slice(a, Math.max(a, b));
}

/** Repair malformed source strings too; JSON escaping alone does not repair them. */
export function wellFormed(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
}
