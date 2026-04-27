/**
 * Resolve a frontmatter status value to its configured SUMMARY-prefix icon.
 * Matching is case-insensitive after trim — YAML quoting and casing in
 * Obsidian notes is inconsistent, and a "Complete" status shouldn't fail to
 * match because someone wrote "complete".
 */
export function resolveStatusIcon(
  status: string | null | undefined,
  iconMap: Record<string, string> | undefined,
): string | undefined {
  if (!status || !iconMap) return undefined;
  const norm = status.trim().toLowerCase();
  for (const [key, icon] of Object.entries(iconMap)) {
    if (key.trim().toLowerCase() === norm) return icon;
  }
  return undefined;
}
