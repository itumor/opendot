/**
 * dot-report.entry — stable-URL mount shim for dot-report.js.
 *
 * Preset rows point HERE, never at dot-report.js directly. Why: DSH imports a
 * file row once per process and Node caches modules by URL forever, so a row
 * aimed at the organ itself would reuse the first evaluation it ever saw for
 * every later mount — edits would only take effect on a harness restart, and
 * a stale downstream helper even fails the whole mount with "does not provide
 * an export named …". This shim is therefore permanent and logic-free:
 *
 *   - the module itself is evaluated ONCE per process (fine: it never changes);
 *   - every MOUNT calls apply(), which re-imports the organ behind a
 *     per-mount-unique query, so organ edits always take effect on remount;
 *   - the organ in turn imports its lib/* helpers behind mtime-stamped
 *     queries, so helper edits take effect too, while unedited helpers stay
 *     single-instance across all organs.
 *
 * Two deliberate boundaries, both loud rather than silent:
 *   - `name`/`inject` are discovered from the first load and frozen — they
 *     are plugin identity, not code; changing them asks for a harness restart;
 *   - each mount adds one small module record (switch mounts, not heartbeats).
 * Never add behavior to this file.
 */
const organ = new URL('./dot-report.js', import.meta.url);
let mountSerial = 0;

const loadOrgan = () => {
  const url = new URL(organ.href);
  url.search = `?mount=${Date.now().toString(36)}-${(mountSerial += 1).toString(36)}`;
  return import(url.href);
};

const first = await loadOrgan();

export const name = first.name ?? 'dot-report';
export const inject = first.inject;

export async function apply(ctx, config) {
  const mod = await loadOrgan();
  return mod.apply(ctx, config);
}
