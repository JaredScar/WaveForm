# Multi-Branch Workspaces

This is the design note for WaveForm's defining feature: holding several
branches of a repository open at once, in one window, so multiple agents can
work in parallel without taking turns on a single checkout.

> Quick summary: upstream mounts exactly one folder — the active session's —
> and swaps it when you focus a different session. WaveForm mounts the union of
> every *visible* session's folders instead. Each session's branch is
> materialized on disk as either a git worktree or a full local clone.

## Contents

- [Why](#why)
- [The Two Layers](#the-two-layers)
- [Isolation Kinds](#isolation-kinds)
- [Mounting Rules](#mounting-rules)
- [Labels](#labels)
- [Settings](#settings)
- [Folder-Index Assumptions](#folder-index-assumptions)
- [Known Gaps](#known-gaps)

## Why

A git working tree holds one branch at a time. An IDE opened on a folder is
therefore an IDE looking at one branch, and an agent working in that folder is
an agent working on one branch. Running a second agent on a second branch means
a second window, a second window's worth of extension hosts and language
servers, and no shared view of the work.

The Agents window already renders several sessions side by side, but its
workspace tracked only the active one, so only one checkout was ever reachable
from the explorer, search, source control, and terminals. Everything below
exists to lift that restriction.

## The Two Layers

Multi-branch is two independent halves that meet at `ISessionFolder.workingDirectory`.

| Layer | Where | Responsibility |
|---|---|---|
| Materialization | `src/vs/platform/agentHost/node/shared/worktreeIsolation.ts` | Create the checkout on disk for a session, and manage its lifecycle across archive, unarchive, resume, and delete. |
| Mounting | `browser/workspaceFolderManagement.ts` (this folder) | Keep the window's workspace folders in sync with the sessions visible in the grid. |

The mounting layer knows nothing about git. It consumes whatever working
directory a session reports and reconciles the workspace against it, so a
session backed by a plain folder, a worktree, or a clone all mount the same
way.

## Isolation Kinds

`IsolationKind` is `'folder' | 'worktree' | 'clone'`. It is a per-session
setting, so different branches in one grid may use different kinds.

| Kind | Materializes | Cost | Can two sessions hold the same branch? |
|---|---|---|---|
| `folder` | Nothing — the agent works in the repository itself | None | No |
| `clone` | An independent clone, with its own object store and HEAD | A full copy of the repository | Yes |
| `worktree` | A linked worktree sharing the parent's object store | A checkout | No |

`worktree` is the default when the session's directory is a git repository,
because it is much cheaper. `clone` exists for the case worktrees cannot serve:
git refuses to check out one branch in two worktrees of the same repository, so
two sessions on `main` require two repositories.

Checkouts land in sibling directories of the repository, kept separate per kind
so they never collide on a name and so tooling already ignoring one does not
silently pick up the other:

```
/src/vscode              the repository
/src/vscode.worktrees/   worktree checkouts
/src/vscode.clones/      clone checkouts
```

### Lifecycle differences

The kinds diverge wherever the answer depends on **who owns the commits**. A
worktree's branch lives in the parent repository, so removing the checkout
loses nothing. A clone's objects exist only inside the clone until they are
pushed or fetched, so the same removal would destroy the session's work.

| Event | `worktree` | `clone` |
|---|---|---|
| Archive | Directory removed when the tree is clean, reclaiming disk | Left on disk |
| Unarchive | Recreated from the preserved branch | Nothing to restore |
| Resume with the directory missing | Recreated | Unrecoverable; the session reports the clone as gone |
| Delete | `git worktree remove --force` | Directory deleted |

A session persisted before clone isolation existed has no recorded kind and is
read back as a worktree.

## Mounting Rules

`WorkspaceFolderManagementContribution` runs one reconciliation pass whenever
the active session, the visible sessions, or a session's resolved folders
change. Passes are serialized through a queue, since each one awaits workspace
edits.

The rules, and why each exists:

- **Union, not just active.** The desired set is every visible session's
  folders plus the active session's, deduplicated by URI. This is the change
  that makes parallel branches usable.
- **Append, never reorder.** Reconciliation only adds and removes, so a folder
  keeps its position for as long as it stays mounted. Refocusing or rearranging
  the grid must not renumber workspace folders, which would churn every
  consumer keyed on folder index.
- **Capped, with the active session pinned.** Each mounted folder costs file
  watchers, an SCM repository, and language-service work, so the total is
  bounded. The active session's folders are exempt: focusing a session must
  always make its files reachable, whatever the cap says.
- **Trust is granted for what is mounted.** A session whose workspace demands
  trust has its checkouts trusted as they mount, rather than blocking on a
  prompt per branch.

Removals are applied before additions, so a folder that moved on disk — an
unarchived worktree recreated at a new path — does not briefly collide with its
successor.

## Labels

Mounting several checkouts of one repository makes folder names ambiguous, and
the folder name is the user's primary "which branch am I looking at" cue.

`IWorkspaceFolderLabelService` already qualifies an isolated checkout by its
branch (`my-app (agents/fix-auth)`), which is usually distinct on its own. What
it cannot separate is two checkouts of the same repository on the *same* branch
— exactly what clone isolation makes possible. Those fall back to the
checkout's directory name, which is unique on disk:

```
my-app (main) — my-app-main-a
my-app (main) — my-app-main-b
```

Only colliding folders are qualified; a name that is already unique is left
alone. Appending the branch a second time would just repeat what the label
already says, which is why the tie-breaker is the directory rather than the
branch.

## Settings

| Setting | Default | Effect |
|---|---|---|
| `waveform.multiBranch.enabled` | `true` | When off, reverts to upstream behavior: only the active session's folder is mounted. |
| `waveform.multiBranch.maxFolders` | `8` | Upper bound on concurrently mounted folders. The active session's folders are always mounted, even past the limit. |

Both are application-scoped, since they describe how the window is composed
rather than anything about a particular workspace.

## Folder-Index Assumptions

Upstream code could assume `workspace.folders[0]` was the active session's
checkout, because it was the only folder. That is now false: folder 0 is
whichever branch mounted first.

Anything meaning "the repository behind the session in focus" must resolve it
from the active session via `getActiveSessionFolderUri`
(`src/vs/sessions/services/sessions/browser/activeSessionFolder.ts`), which
falls back to the first mounted folder only when no session is active. The
source-control sync affordances in `contrib/files` use it.

Terminals have the same problem in a different shape. A new terminal in a
multi-root workspace normally prompts for a folder, which would be a pointless
question in a window that knows which session the user is looking at. The
Agents window answers it instead: `IAgentHostTerminalService.defaultCwd`
tracks the active session's checkout and takes priority over the picker.

Treat both as the pattern for future work. A new consumer that reaches for
`folders[0]` in this window is almost certainly a bug.

## Known Gaps

- Clone creation copies the whole repository and is slow on large repos. It
  uses `git clone --local`, so objects are hardlinked where the filesystem
  allows, but the checkout is still a full write.
- A clone's commits are invisible to the parent repository until pushed or
  fetched. There is no UI yet for moving work from a clone back to the parent.
- Nothing deduplicates language-server or extension work across mounted
  checkouts of the same repository, so N branches cost roughly N times the
  background work. The folder cap is the only mitigation.
