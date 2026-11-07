/** Aggregates per-file download events from the model loader into one percentage. */
export interface LoaderEvent { status?: string; file?: string; loaded?: number; total?: number }
export interface DownloadProgress { percent: number; loadedMB: number; totalMB: number }

export class ProgressAggregator {
  private files = new Map<string, { loaded: number; total: number }>();

  update(e: LoaderEvent): DownloadProgress {
    if (e.file && typeof e.total === "number" && e.total > 0) {
      const loaded = Math.min(typeof e.loaded === "number" ? e.loaded : 0, e.total);
      this.files.set(e.file, { loaded: e.status === "done" ? e.total : loaded, total: e.total });
    }
    let loaded = 0, total = 0;
    for (const f of this.files.values()) { loaded += f.loaded; total += f.total; }
    return {
      percent: total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0,
      loadedMB: Math.round(loaded / 1e5) / 10,
      totalMB: Math.round(total / 1e5) / 10,
    };
  }
}
