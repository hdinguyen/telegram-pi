const IMAGE_STORE = new Map();
const DEFAULT_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

function purgeExpired(maxAgeMs = DEFAULT_MAX_AGE_MS) {
  const now = Date.now();
  for (const [id, entry] of IMAGE_STORE.entries()) {
    if (now - entry.createdAt > maxAgeMs) {
      IMAGE_STORE.delete(id);
    }
  }
}

export function registerImagePayloads(entries, options = {}) {
  const { maxAgeMs = DEFAULT_MAX_AGE_MS } = options;
  purgeExpired(maxAgeMs);
  const now = Date.now();
  for (const entry of entries) {
    IMAGE_STORE.set(entry.id, {
      ...entry.data,
      createdAt: now,
      maxAgeMs,
    });
  }
}

export function getImagePayloads(ids, { consume = false, maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
  purgeExpired(maxAgeMs);
  const results = [];
  for (const id of ids) {
    const record = IMAGE_STORE.get(id);
    if (!record) continue;
    results.push({ id, ...record });
    if (consume) {
      IMAGE_STORE.delete(id);
    }
  }
  return results;
}

export function clearImagePayloads(ids) {
  for (const id of ids) {
    IMAGE_STORE.delete(id);
  }
}

export function describeImagePayload(id) {
  const record = IMAGE_STORE.get(id);
  if (!record) return undefined;
  const sizeKb = record.size ? Math.round(record.size / 1024) : undefined;
  const dimensions = record.width && record.height ? `${record.width}×${record.height}` : undefined;
  return {
    id,
    mimeType: record.mimeType,
    sizeKb,
    dimensions,
    storedAt: record.createdAt,
  };
}
