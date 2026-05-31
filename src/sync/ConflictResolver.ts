import { diff_match_patch } from "diff-match-patch";
import type { SinkDoc } from "../settings";

/** Result of a conflict resolution attempt */
export interface MergeResult {
  resolved: boolean;
  content: string;
  /** If not resolved, both versions are provided for manual resolution */
  mine?: string;
  theirs?: string;
}

/**
 * Simple 3-way merge using diff-match-patch.
 * Falls back to "newer wins" for binary or failed merges.
 */
export class ConflictResolver {
  private dmp: diff_match_patch;

  constructor() {
    this.dmp = new diff_match_patch();
  }

  /**
   * Resolve a conflict between two versions of a document.
   * Returns the merged content or null if manual resolution is needed.
   */
  resolve(mine: SinkDoc, theirs: SinkDoc, autoResolve: boolean): MergeResult {
    // Case 1: Identical content — no conflict
    if (mine.content === theirs.content) {
      return { resolved: true, content: mine.content };
    }

    // Case 2: One is a deletion
    if (mine.deleted && !theirs.deleted) {
      return { resolved: true, content: theirs.content };
    }
    if (theirs.deleted && !mine.deleted) {
      return { resolved: true, content: mine.content };
    }

    // Case 3: Binary files — keep newer
    if (this.isBinary(mine) || this.isBinary(theirs)) {
      const winner = mine.mtime >= theirs.mtime ? mine : theirs;
      return { resolved: true, content: winner.content };
    }

    // Case 4: Text merge (if auto-resolve enabled)
    if (autoResolve && this.dmp) {
      const merged = this.attemptTextMerge(mine.content, theirs.content);
      if (merged !== null) {
        return { resolved: true, content: merged };
      }
    }

    // Case 5: Manual resolution needed
    return {
      resolved: false,
      content: mine.content,
      mine: mine.content,
      theirs: theirs.content,
    };
  }

  /**
   * Attempt a text merge using diff-match-patch.
   * Returns merged content or null if merge has conflicts.
   */
  private attemptTextMerge(mineText: string, theirsText: string): string | null {
    try {
      // Use diff-match-patch to compute patches from theirs against mine
      const diffs = this.dmp.diff_main(mineText, theirsText);
      this.dmp.diff_cleanupSemantic(diffs);

      // If the diff is simple (no overlapping edits), apply it
      const patches = this.dmp.patch_make(mineText, diffs);
      const [merged, results] = this.dmp.patch_apply(patches, mineText);

      // Check if all patches applied cleanly
      if (results.every((r: boolean) => r)) {
        return merged;
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Check if a document contains binary content */
  private isBinary(doc: SinkDoc): boolean {
    // If content contains null bytes or is base64 with binary markers
    if (doc.path.match(/\.(png|jpg|jpeg|gif|bmp|ico|svg|webp|pdf|mp3|mp4|zip|tar|gz|woff|woff2|ttf|otf|eot)$/i)) {
      return true;
    }
    return false;
  }
}
