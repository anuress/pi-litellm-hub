const KEY_SHAPE = /sk-[A-Za-z0-9_-]{8,}/g;
const URL_USERINFO = /(https?:\/\/)[^/\s?#]*@/gi;

export function redact(text: string, key?: string): string {
  let result = text;

  // Ignore short caller keys so ordinary text is not corrupted; the shape rule handles key-like values.
  if (key && key.length >= 8) {
    result = result.split(key).join("sk-***");
  }

  result = result.replace(KEY_SHAPE, "sk-***");
  // Userinfo belongs to the URL authority, so path and query text remain untouched.
  return result.replace(URL_USERINFO, "$1");
}
