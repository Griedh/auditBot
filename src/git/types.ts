export interface CommitDetails {
  branch: string;
  commitSha: string;
  commitMessage: string;
}

export interface GitRemoteInfo {
  remoteName: string;
  url: string;
}
