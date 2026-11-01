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
 * Conflict classification only. Divergent versions require an explicit side
 * choice because no common ancestor is available here.
 */
export class ConflictResolver {
  /**
   * Resolve a conflict between two versions of a document.
   * The ancestor parameter is retained for signature compatibility only; until a
   * real three-way merge exists, it is never treated as proof that merging is safe.
   */
  resolve(mine: SinkDoc, theirs: SinkDoc, _autoResolve: boolean, _ancestor?: string): MergeResult {
    if (mine.content === theirs.content
      && !!mine.deleted === !!theirs.deleted
      && mine.iv === theirs.iv
      && JSON.stringify(mine.chunks ?? []) === JSON.stringify(theirs.chunks ?? [])) {
      return { resolved: true, content: mine.content };
    }

    return {
      resolved: false,
      content: mine.content,
      mine: mine.content,
      theirs: theirs.content,
    };
  }
}
