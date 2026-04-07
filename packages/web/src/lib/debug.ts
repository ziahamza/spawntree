export function debugLog(scope: string, message: string, details?: unknown) {
  if (details === undefined) {
    console.debug(`[spawntree-web:${scope}] ${message}`);
    return;
  }
  console.debug(`[spawntree-web:${scope}] ${message}`, details);
}
