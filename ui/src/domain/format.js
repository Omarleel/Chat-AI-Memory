export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024, i = 0;
  while (value >= 1024 && i < units.length - 1) {value /= 1024; i++;}
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`;
}
export function formatDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('es', {dateStyle: 'short', timeStyle: 'short'});
}
export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.round(ms / 60_000);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
export const formatNumber = n => Number(n ?? 0).toLocaleString('es');
