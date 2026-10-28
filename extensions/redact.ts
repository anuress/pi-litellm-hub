const KEY_SHAPE = /sk-[A-Za-z0-9_-]{8,}/g;
const URL_USERINFO = /(https?:\/\/)[^/\s?#]*@/gi;

export function redact(text: string, key?: string): string {
  let result = text;

  // Caller-supplied keys can be shorter or differently shaped than the generic pattern.
  if (key && key.length > 0) {
    result = result.split(key).join("sk-***");
  }

  result = result.replace(KEY_SHAPE, "sk-***");
  // Userinfo belongs to the URL authority, so path and query text remain untouched.
  return result.replace(URL_USERINFO, "$1");
}
