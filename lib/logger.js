function debugEnabled() {
  return /^(?:1|true|yes)$/i.test(process.env.LILY_DEBUG || "");
}

export const logger = {
  debug(...args) {
    if (debugEnabled()) {
      console.log(...args);
    }
  },
  warn(message) {
    if (debugEnabled()) {
      console.warn(message);
    }
  },
  error(message, error) {
    const detail = error?.message || String(error || "");
    console.error(detail ? `${message}: ${detail}` : message);
  }
};
