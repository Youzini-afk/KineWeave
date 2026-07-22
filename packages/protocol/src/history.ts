import type { JsonValue } from "./json.js";
import type { HistoryCommit } from "./operation.js";

export interface KineWeaveHistory {
  readonly historyFormatVersion: number;
  readonly rootCommitId: string;
  readonly mainBranchName: string;
  readonly rootDocuments: Readonly<Record<string, JsonValue>>;
  readonly commits: Readonly<Record<string, HistoryCommit>>;
  readonly branches: Readonly<Record<string, string>>;
}
