export const OFFICIAL_KEYCAP_IDS = [
  "FAST", "APPR", "REJ", "SPLIT", "MIC", "CODEX", "BUG", "OAI", "TERM", "DWN",
  "DEL", "NEW", "NAV", "MAGIC", "DIFF", "PLAY", "GIT", "BRCH", "MRG", "PR",
  "PAINT", "LAB", "PARTY", "TIME", "MIND+", "MIND-", "SETUP", "FOLD", "UPL", "APPS"
] as const;

export type OfficialKeycapId = typeof OFFICIAL_KEYCAP_IDS[number];

export const ADDITIONAL_KEYCAPS = [
  { id: "FAST", slug: "fast", name: "Fast Mode", tooltip: "Toggle Fast mode through the native Codex Micro command." },
  { id: "APPR", slug: "approve", name: "Approve", tooltip: "Approve the current Codex request." },
  { id: "REJ", slug: "reject", name: "Reject", tooltip: "Reject the current Codex request." },
  { id: "SPLIT", slug: "split", name: "Fork Chat", tooltip: "Fork the current Codex chat." },
  { id: "NEW", slug: "new-task", name: "New Task", tooltip: "Create a new Codex task through the native command." },
  { id: "MIND+", slug: "reasoning-up", name: "Reasoning Up", tooltip: "Increase the current composer reasoning effort." },
  { id: "MIND-", slug: "reasoning-down", name: "Reasoning Down", tooltip: "Decrease the current composer reasoning effort." },
  { id: "CODEX", slug: "codex", name: "Codex / Submit", tooltip: "Submit the current composer through the native Codex Micro command." },
  { id: "BUG", slug: "bug", name: "Bug / Feedback", tooltip: "Open Codex feedback through the native Codex Micro command." },
  { id: "OAI", slug: "openai-docs", name: "OpenAI Docs", tooltip: "Open the official OpenAI developer documentation." },
  { id: "TERM", slug: "terminal", name: "Terminal", tooltip: "Toggle the Codex terminal." },
  { id: "DWN", slug: "download", name: "Copy Chat Markdown", tooltip: "Copy the current conversation as Markdown." },
  { id: "DEL", slug: "archive", name: "Archive Chat", tooltip: "Archive the current Codex chat." },
  { id: "NAV", slug: "browser", name: "Browser", tooltip: "Open a Codex browser tab." },
  { id: "MAGIC", slug: "pin", name: "Pin / Unpin Chat", tooltip: "Toggle the pinned state of the current chat." },
  { id: "DIFF", slug: "diff", name: "Review", tooltip: "Toggle the Codex review view." },
  { id: "PLAY", slug: "play", name: "Run Environment Action", tooltip: "Run the first configured environment action." },
  { id: "GIT", slug: "git-commit", name: "Git Commit", tooltip: "Open the native Codex Git commit flow." },
  { id: "BRCH", slug: "branch", name: "Branch Review", tooltip: "Open the Codex review view with the branch keycap." },
  { id: "MRG", slug: "merge", name: "Merge Review", tooltip: "Open the Codex review view with the merge keycap." },
  { id: "PR", slug: "pull-request", name: "Create Pull Request", tooltip: "Open the native Codex pull-request flow." },
  { id: "PAINT", slug: "add-photos", name: "Add Photos", tooltip: "Add photos to the current composer." },
  { id: "LAB", slug: "lab", name: "Lab / Settings", tooltip: "Open Codex settings with the lab keycap." },
  { id: "PARTY", slug: "side-chat", name: "Side Chat", tooltip: "Open a Codex side chat." },
  { id: "TIME", slug: "tasks", name: "Manage Tasks", tooltip: "Open Codex task management." },
  { id: "SETUP", slug: "settings", name: "Settings", tooltip: "Open Codex settings." },
  { id: "FOLD", slug: "open-folder", name: "Open Folder", tooltip: "Open a folder in Codex." },
  { id: "UPL", slug: "add-files", name: "Add Files", tooltip: "Add files to the current composer." },
  { id: "APPS", slug: "skills", name: "Skills", tooltip: "Open Codex Skills." }
] as const satisfies readonly { id: OfficialKeycapId; slug: string; name: string; tooltip: string }[];
