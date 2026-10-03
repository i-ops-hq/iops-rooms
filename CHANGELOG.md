# Changelog

## 0.7.4

### Rooms starts where you are, and reads main from any branch

`rooms` on its own used to print every command, about fifty of them. It now says what it found where
it was run, and the few commands that fit:
- a project, by name and branch, and how far that branch is from the default one;
- a folder without git, with why nothing can be read there and what would change that;
- a folder of projects, with which to go into;
- a project linked to a team room, with its board and setups.

It writes nothing, and `rooms help` still lists everything.

On a branch other than the default one, `rooms week`, `rooms badge` and the board read the default
branch's history: origin's copy as your last `git fetch` left it, or your own `main` without a
remote. They used to read the branch you were on without saying so. Rooms never switches your
checkout. The week names the branch it read, and ends with what your branch adds: how many commits,
and which agents they record. `--json` carries the same, under `history`. `rooms file` and
`rooms branch` still read your checkout, as before.

Reports and the board name the project as its remote does, `owner/repo` on GitHub or another host,
instead of after the folder it happens to be cloned into. A project with no remote keeps its room's
name, or its folder's.

The board's line under the room code said "Another machine: rooms join … — sync among your devices
only", which read as if teammates joined that way and as if the code synced something. It now says
how a teammate joins, through the team room, and that a room code opens the same room on your own
other machines.

## 0.7.3

### The README says what Rooms does now

The README opened with one thing Rooms does: who built a project, and which AI helped. Since 0.6.0 it
has also kept a team room in a private GitHub repository, and since 0.7.0 it has shared AI setups,
but a reader met both only far down the page. The opening now names all three, and links to the team
room and setups sections. The package's description on npm, which still called Rooms "shared rooms
for agent sessions", says the same now, and its keywords name Claude Code, Codex and GitHub.

Nothing else changed but the version.

## 0.7.2

### Cursor setups

`rooms setup` now carries Cursor as well. Export reads, from a project, `.cursorrules`, the rules in
`.cursor/rules/`, the skills, subagents, commands and hook scripts under `.cursor/`, and only the MCP
servers, hooks and permission rules of `.cursor/mcp.json`, `.cursor/hooks.json` and `.cursor/cli.json`;
and, with `--user`, the same from `~/.cursor`, where the CLI's `cli-config.json` gives its permission
rules and nothing else. `--tool cursor` takes Cursor only.

Never the approval mode or sandbox, User Rules, which live inside Cursor's settings rather than in a
file, Cursor's own `skills-cursor`, plugins, an `envFile`, `.cursor/environment.json` or
`.cursor/worktrees.json`. Cursor reads `Shell(git)` as git with any arguments, so a `Shell` rule for a
shell, `sudo`, or, alone, an interpreter or launcher (`Shell(node)`, `Shell(npx)`) is left out, as
`Shell(*)` is.

Cursor's documentation says its MCP config fills in `${env:NAME}`, `${userHome}` and
`${workspaceFolder}`. Its editor does; its CLI, 2026.04.17, passed all three on as written, a header
included, and fills in only `${NAME}`. So export reads Cursor's forms as the setup's own names and
placeholders, and adopt writes `${NAME}` for each variable and the adopter's own paths, which both fill
in. The real CLI was given what adopt wrote: it started the server with the adopter's home and token,
and sent the adopter's header.

Adopting merges servers, hooks and rules into `.cursor/mcp.json`, `.cursor/hooks.json` and
`.cursor/cli.json`, keeping what the person has, and, with `--user`, into those in `~/.cursor`. The
CLI's `cli-config.json` is found where the CLI keeps it, which `CURSOR_CONFIG_DIR` or `XDG_CONFIG_HOME`
can move, and is added to only once the CLI has made it. The plan marks a hook that can answer
"allow" for the agent: Cursor's `beforeShellExecution` and five other events, and now Claude Code's
`PreToolUse` and `PermissionRequest` too.

Cursor's agent also runs the hooks in Claude Code's settings files and reads Claude Code's commands,
as its CLI's code shows, so a Claude Code setup's hooks can run under Cursor as well. SECURITY.md says
so.

## 0.7.1

### Codex setups

`rooms setup` now carries Codex as well as Claude Code. Export reads, from a project, `AGENTS.md`, the
skills in `.agents/skills/`, and the MCP servers in `.codex/config.toml`; and, with `--user`, the
`AGENTS.md`, `AGENTS.override.md` and `prompts/` in `~/.codex` (or `CODEX_HOME`), the skills in
`~/.agents/skills/`, and from `~/.codex/config.toml` the model, reasoning effort, approval policy,
sandbox mode, `notify` and MCP servers. `--tool codex` or `--tool claude-code` takes one tool only.

Codex keeps its config in TOML, so Rooms reads TOML itself, still with no dependency, and strictly: what
TOML 1.0 does not allow stops the reading with the line and the reason. Of the config it keeps only the
keys above. Never `[projects]`, whose names are folders on the machine; never the values of
`[shell_environment_policy]`; never `sandbox_mode = "danger-full-access"`, a rules folder (an `allow`
there runs commands outside the sandbox), per-tool approvals, or `http_headers_helper`, which runs a
command. Codex does not read `${VAR}` in its config, so a server's environment values become names
Codex passes through (`env_vars`), and a header written out becomes the name of a variable holding it.
A skill whose `agents/openai.yaml` declares dependencies is left out.

Adopting writes Codex's files to their places, adds a project's servers to its `.codex/config.toml`,
which Codex reads only in a project the person trusts, and, with `--user`, adds the settings and
servers to `~/.codex/config.toml`. It adds to the file's text and rewrites nothing else: comments,
order and blank lines stay, a key the setup sets is replaced on its own lines, and a server the person
already has by that name is kept as theirs. The plan shows an approval policy or sandbox mode as what
it lets Codex do. Codex CLI 0.159.0 itself was given what adopt wrote, and listed every server as set.

Also: a setup whose manifest names a file kind such as `constructor` crashed `rooms setup show` and
`adopt` in 0.7.0 (`PLACES[scope][kind].test is not a function`). Such names are now refused, with the
reason. The tests give every test person their own home, Claude Code folder and Codex folder, so no test
can read or write `~/.claude`, `~/.codex` or `~/.agents`.

## 0.7.0

### Setups: share a Claude Code setup through the team room, and adopt one with a plan and a rollback

A setup is how someone has Claude Code set up for a kind of work: their `CLAUDE.md`, rules, agents,
commands, skills, hook scripts, permission rules, hooks and MCP servers. `rooms setup export`, run in a
project, reads those from an allowlist of files and keys, the project's by default and the person's
own from `~/.claude` with `--user`, and commits them to the branch `setup/<role>/<name>` in their clone
of the team room. It shows every file and every part it leaves out, and asks first. It never pushes,
and it leaves the clone's checkout as it was, so `rooms team sync` cannot carry a setup by accident.

What a setup may carry is narrow on purpose. Every environment value and header becomes a
placeholder naming the variable; the value stays on the machine. Of `~/.claude.json`, which also holds
the account, only its MCP servers are read. A file is refused whole if a line looks like a secret,
names a folder in the home or the project's own folder, or acts in a way a setup may not: hooks or servers in its frontmatter, a
permission mode or pre-approved rule that stops Claude asking, or a command it runs as it loads
without an exact version. Every launcher, wherever it stands in a command, must name one exact
version. Paths in the home and the project become `${HOME}` and `${PROJECT}`; any other is refused.
Nothing is read through a link.

`rooms setup show` lists a team room's setups, or shows one: its files, each subagent's model and
tools, every rule as what it allows, what it runs, with the commit that added each part and its
author, what it needs, and a cost its owner declared, if any, which is shown as declared.

`rooms setup adopt` builds a plan from the setup as it is at a commit: every file it would write or
replace, every settings change, everything that would run on this machine, and what Claude could
then do without asking, with a digest of exactly that plan. Nothing is written until a person approves
it at a terminal, or passes `--approve` with that digest; `--yes` is never enough, since adopting
runs a teammate's code as you. Settings merge into the project's personal
`.claude/settings.local.json`, never the shared one, and the person's own Claude Code folder is
written only with `--user`. A setup is checked again before it is shown or adopted, with every rule
export applies, so one edited in the team room since, by hand or in GitHub's editor, is refused for
what changed: a file that no longer matches its hash, a hook missing from the list of what it runs, a
file aimed outside the places a setup may write, a value where only a variable's name may be.

Every file an adoption changes is copied to `~/.iops-rooms/backups/` first. `rooms setup rollback`
puts each back byte for byte, with its mode, and removes what the adoption created, folders
included; if a file changed since, it stops and names it, and `--force` puts it back anyway after
keeping the changed version. `rooms setup status` says whether anything changed since, and whether the
team room has a newer revision. The format is documented in `docs/format/SETUP.md`. Codex and Cursor
follow.

Also: the guardrail that keeps the network out of `src/` now reads every file under it, folders
included, and a new one keeps the attribution half of Rooms from importing the setup code, which reads
file contents.

## 0.6.2

### BOARD.md, for the people who only read GitHub

A stakeholder who can read the team room on GitHub, and runs nothing, now has a page there.
`rooms team workflow`, run once in the team room's clone, adds a GitHub Action that rebuilds
`BOARD.md` from the members' status files every hour (`--hours`, up to a day) and on demand. GitHub
shows it only to people who can read the repository; nothing is published anywhere else.

The workflow runs on a schedule and on demand, never on a push, so its own commit cannot start it
again. It may only write the repository, uses Actions pinned to a commit, and runs one exact version
of iops-rooms from an empty npm prefix, the way the attribution action does. `BOARD.md` carries no
time of its own, only each member's, so an hour with nothing new commits nothing. The command shows
the file and what it costs, about 720 runs a month at hourly, each billed as at least a minute of a
private repository's Actions minutes, and asks before writing it. It commits locally and does not
push: pushing a workflow needs a login that may change workflows, and it says how to get one.

`rooms team board --markdown` builds the page, from the clone it runs in or from the registered
team. A teammate's status is escaped for Markdown as well as HTML: a branch named
`![x](https://…)` would otherwise load an image for everyone who opens `BOARD.md`, and a `|` would
open a column of its own. GitHub's own renderer was asked to draw such a row, and drew text.

## 0.6.1

### The team board, kept current while it is open

`rooms team live` serves the team board on this machine and keeps it current. Every five minutes
(`--every`, thirty seconds at the least) it fetches the team room with git, which asks nothing of
GitHub's API, and reloads the page only when something arrived; otherwise the page just updates
the line that says when it last looked, since "live" is only ever "as of then". If the member
already said yes to sharing with this team, with `rooms team sync`, it also shares their status for
this project whenever it changed; `--no-share` keeps it read-only, and without that earlier yes it
never shares. It runs only while it is open, with no background service to install or forget.

Before each push it asks GitHub again whether the team room is private, so a room made public while
the board is open gets nothing more, and the page says why. Closing waits for a check already
running, so nothing is fetched, committed or pushed after it returns.

The page is served on 127.0.0.1, only to a request that asked for this machine by name, through a
`serveLocal` that `src/live.js` now exports: that file stays the one place in Rooms that opens a
socket, which a test already enforces, and a new page cannot leave the Host check out.

## 0.6.0

### A team room, through the team's own GitHub

Rooms was one person's view of one project. A team room is a private repository the team owns, where
each member's Rooms shares a small status of the work on their machine and reads everyone else's.
GitHub is the medium and the access control; nothing goes through an I-Ops server.

- `rooms team init`, in a clone of a new repository, writes the team room's four files and makes one
  local commit. It does not push.
- `rooms team join <owner/repo>`, in a project, clones the team room into Rooms's own folder with the
  member's git, and links the project to it. A folder works too.
- `rooms team sync` writes `status/<login>/<project>.json`, commits that one path, and pushes it. The
  first push shows the whole file and asks. An unchanged status is not pushed again, and a push that
  loses a race with a teammate's is caught up once, which cannot conflict, since no one else writes
  that file.
- `rooms team board` builds everyone's status into a page on the viewer's machine and opens it in
  the board's own window, with projects and members in alphabetical order and nothing ranked.

A status holds counts and states from an allowlist: the project, optionally the branch and its
upstream (`--no-branch` leaves them out), ahead and behind, the pull request's state, what is not
committed as counts of files and lines, and agent sessions and files edited in the last seven days.
Never a file name, a line of code, a commit message or a prompt; a test plants a file called
`secret-plan.txt` and fails if its name or content reaches the team room.

The team room must be private. Every sync asks GitHub through the member's own `gh` and refuses a
public repository unless `--public` is given, since a public one would publish every status to the
internet; where Rooms cannot ask, the member confirms with `--confirm-private`. The board is built
locally rather than served by GitHub Pages, which publishes to the whole internet on every plan
except Enterprise Cloud. A status read from the team room is checked field by field, and one filed
under another member's folder, with a negative count or with a field too long is left out and
counted. Every value is escaped, and a test plants HTML in a teammate's status.

This is the first minor release since 0.5.0: Rooms now pushes, one file, with the member's consent.

## 0.5.18

### A board to double-click

`rooms shortcut` writes a file that opens the project's board in its own window: an application on
the macOS Desktop, a `.cmd` on the Windows Desktop, or an entry in the Linux applications menu. It is
for the people on a team who never open a terminal. Someone who does runs it once on their machine,
and from then on the board is an icon. It shows what it will write and asks first, or needs `--yes`
without a terminal. `rooms shortcut remove` takes the launcher away, and neither command touches a
file Rooms did not write.

A launcher is a command kept in a file and run later, from a double-click, with nobody watching.
The project's folder name is written into it, and a folder name is text anyone can choose. So each
format quotes every path in its own way: single-quoted for the shell inside the macOS application,
doubled `%`, no delayed expansion and UTF-8 in the `.cmd` (cmd reads a batch file in the console's
code page, which turned `C:\Users\José` into something else), and the Desktop Entry's two layers of escaping,
which a path ending in a backslash needs both of, with `%` doubled so a folder called `%f` never
becomes a field code. Tests run the macOS script through AppleScript itself, the shell command
through `sh`, and the `.cmd` through `cmd` on Windows, each against a folder whose name is an attack
(`x'; touch pwned; '`), and read the Desktop Entry back by the specification's rules. A path holding
a control character is refused outright.

The launcher runs this Node and this install of Rooms, since a double-click gets a bare PATH, not the
one a shell profile builds. Run from npx's cache, which npm may clear, it refuses and says to install
globally first. On macOS a failure shows a dialog, and on Windows a project that has moved stops the
launcher instead of making a room wherever `cmd` started.

## 0.5.17

### Right now: this checkout's uncommitted work, its upstream and its pull request

The board's Git card said "3 uncommitted changes". It now says what they are, as counts:
"uncommitted: +1,000 −21 in 14 files, and 3 new files", and, on a branch that is not the default,
whether it has a pull request: "no pull request yet", "pull request #42, open", "a draft", "merged"
or "closed without merging". `rooms week` ends with the same lines, from the same words, and
`--json` carries them as `now`. These are the counts a member's status will carry to their team
room, shown to the member first. Which files is never kept.

The pull request is asked of GitHub through the person's own `gh`: one `gh pr view <branch>`,
which sends the repository and the branch name to the GitHub the remote already points at, at most
once a minute per branch, and never on the default branch. Only a branch the remote already has is
asked about. A branch only on this machine reads "not pushed yet, so no pull request", known without
asking, so a name like `fix-the-ceo-bug` is never sent anywhere it was not pushed. Not knowing is
kept apart from none. No `gh`, `gh` signed out, a remote that is not on GitHub, or no answer in time
each read "pull request unknown", with the reason; only GitHub saying there is none reads "no pull
request yet". `ROOMS_NO_GH=1` turns the question off, and the test suite runs with it off, so no
test asks GitHub anything.

Before the first commit there is nothing to compare with, so the lines are unknown rather than
zero, and the card counts the files alone.

## 0.5.16

### The board says what the terminal says

Everything `rooms week` printed about the last seven days, and everything the hooks observed, was
terminal-only: a teammate who never opens one saw none of it. The board now has both, in its own
window as before, near the top:

- **This week:** the finding line, the rows with their counts, shares and change on the week before,
  and every caveat printed under them: the floor, what the repository is configured for, why nothing
  was recorded. Built from the same report as `rooms week`, with the same sentences, so the two cannot
  disagree, and a test compares them on one repository.
- **Agent sessions on this machine:** the observed counts, as counts and never shares, then each
  session with its agent, model, when it was first seen and the files it edited. Claude Code reports
  a start again when it compacts a session, so a session is "started" only when its start came first,
  and one with no end is "no end recorded", never "running". With nothing recorded, the section says
  so and how to start, rather than showing zeros.

An open `rooms live` board now reloads when the activity log changes, so it shows an agent's edits as
they happen, once per change: the backup poll used to refresh it a second time for a change the
watcher had already caught. Closing it now waits for a refresh already running. One that outlived
`close` kept running git in the project, and Windows refused to delete the folder, which is how this
pull request's Windows checks found it. The log is shared through git in a team room, so every value from it is escaped, and a
test puts a path, a model and an agent name holding HTML into it. Long words in room posts wrap: a
path or commit subject with no space in it made the whole page wider than a 375px phone screen.

### Work committed in pieces carries the agent's edits in each piece

Which of a commit's files an agent edited was judged from the commit before it, so work split into
two commits lost every edit made before the first. Seen here: a commit holding two files written with
Claude Code's Write tool, made less than a second after a commit that did not include them, recorded
nothing.
Each file is now judged since its own last commit, to the millisecond where the hook recorded it; a
file the commit deletes is not carried. Commits recorded before this keep what was recorded.

## 0.5.15

### The install says a copy is kept only when it keeps one

`rooms hooks install --agent claude-code` said "a copy is kept beside it" on every install into a
settings file that already existed. Installing again, into a file that already held Rooms hooks,
made no copy, and rightly: a copy of Rooms hooks would put them back on uninstall. The preview and
the write now read one decision, and the preview says which happens: a copy of the file as it is now
is kept; the copy from before Rooms first changed the file is kept; or the Rooms hooks already in
it are replaced, and nothing is copied. Seen the first time a working install was pointed at a
global 0.5.14.

### Uninstall with nothing to take out changes nothing

Whether a file held Rooms hooks was decided by comparing it with itself minus them, and that
comparison also counted the tidying done on the way. A settings file with an empty `"hooks": {}`
and no Rooms hooks was answered "removed the Rooms hooks" and rewritten, without the empty object
and in Rooms' formatting instead of the person's. Install had its own version: it searched the text
for the hook's command, so a permission rule naming that command read as an install, and no copy
was made. Both now look at the hooks themselves.

### Each version gets a GitHub Release

The Releases page stopped at v0.5.0, the last one made by hand, while npm reached 0.5.14. Once npm
has a version, the publish workflow now makes its Release: titled with the first heading of its
CHANGELOG section, described by the section. The lines of each paragraph are joined first, because
a Release shows every newline inside a paragraph as a line break. It is a job of its own, whose
token can write to the repository and holds no npm identity; the publishing job's stays read-only.

## 0.5.14

### An agent's edits, committed by hand, are seen

The commonest way to use a CLI agent left no trace: it edits, and you commit by hand from another
terminal, so the commit carries no trailer and none of the agent's variables. Claude Code's own
hooks do see the edits. `rooms hooks install --agent claude-code` adds them, and `rooms week` gains
a line in the observed block:

    carry files an agent edited   1 of 2 observed (Claude Code 1)

Each edit is kept as which session (a hash of its id) edited which file of this project, and when.
The git hook then notes, on each commit, which of its files an agent edited in this checkout since
the commit before it. An edit in another worktree is not credited to this one's commit.

Claude Code's hook payload also carries the whole file for `Write`, the tool's output, the last
message and the transcript's path. None of it is kept, and a test fails if any of it reaches the
log. The hook prints nothing and exits 0 whatever happens, because Claude Code adds a SessionStart
hook's output to the model's context and shows a failing hook's stderr to the agent.

The install shows what it will change and asks, or needs `--yes` without a terminal. It merges into
`.claude/settings.local.json`, keeps every other hook, keeps the file as it was beside it, and lists
it in `.git/info/exclude` so it cannot be committed by accident. `rooms hooks uninstall --agent
claude-code` takes out only what Rooms added: byte for byte when nothing else changed since.

Tried on two live sessions before release. On Claude Code Desktop the hook took effect on the
session's next edit, without a restart. On a fresh terminal session, `claude` wrote one file and
edited another, and a commit made afterwards from the person's own shell carried both, credited to
Claude Code, with the session kept only as a hash of its id. An edit made through the agent's shell,
with `sed` or a script, is not reported, and the output says so. The agent's version and
entrypoint reach the commands it runs but not its hooks, so a session records its model and not
those two. The install's undo line names the command that ran, rather than whichever `rooms` is on
the PATH.

## 0.5.13

### Commits made inside an agent session

Most agents write no `Co-Authored-By` trailer, and Claude Code writes one only on commits it makes
itself, so the trailers leave most agent work unrecorded. The git hook from `rooms hooks install`
now records one more fact about each commit: whether it was made inside an agent's session. Agents
set variables for the commands they run, and a commit made from inside the session inherits them:
Claude Code sets `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT` and `AI_AGENT`, and any agent, a custom one
included, can set `AI_AGENT=<name>_<version>_agent` and `AI_AGENT_MODEL`.

`rooms week` shows what the hook observed in a block of its own, as counts, with the date it began
observing and how many commits it did not see. It is never added to the trailer rows, and `--json`
carries it as `observed`, beside `rows` rather than in them. Where the hook has never run there is
no block and `observed` is `null`, which is not the same as zero.

Only those four variables are read, and nothing else from the environment; a test puts tokens in
the environment and fails if one reaches the record. Where a commit was made is not who wrote it,
and the output says what the hook cannot see: a commit made by hand in another terminal shows no
session, even when an agent edited its files. Run `rooms hooks install` again to add this to a hook
installed earlier.

### Hooks install where git looks for them

`rooms hooks install` wrote into `<top>/.git/hooks`. In a worktree `.git` is a file, so installing
failed, and agents running in parallel are exactly who get a worktree each. With `core.hooksPath`
set, as husky sets it, git never ran the hook at all. It now asks git where hooks go.

### A quiet week's age is rounded

0.5.12 said "11 days old" of a commit ten days and a few seconds old, found by probing the
published package. It rounds to the nearest day now.

## 0.5.12

### A first run that records nothing says what it could not see

Reproduced on a clean profile holding only Claude Code CLI sessions, which is how a first-time user
reported that Rooms "returned empty":

- **Committing by hand is named.** Claude Code writes its `Co-Authored-By` trailer only on commits
  it makes itself, so letting it edit and then committing by hand records nothing. The note under an
  empty result offered two causes, turned off or predates it, and left this one out. It is named
  first now. With nothing declared at all, the note no longer says "if none was used this is simply
  the answer": an agent that leaves the committing to you writes nothing, so the history reads the
  same either way.
- **The board's agent card counts what was read.** It said `none agent-assisted`, a claim about use
  made from an absence of trailers. It now says `0 of 6 commits record an agent`. A share under half
  a percent rounded to `none` with the agent named beneath it; it reads `<1%`.
- **A quiet week says where the last commit is.** `rooms week` answered a repository last committed
  ten days ago with "0 commits" and nothing more. It now says how old the newest commit is and names
  a window that reaches it, `rooms week --since 14d`, which a test runs to check it does.
- **`doctor` over MCP knows it is over MCP.** A server registered with `claude mcp add` leaves no
  project file, so `doctor`, called through MCP, warned that MCP was not set up.
- **Help says attribution needs nothing installed.** It said Cursor and Claude Code "only show up if
  the Rooms MCP is installed", which is true of room posts and not of attribution.
- **`rooms week` outside a repository is recognised in any locale.** git translates its messages,
  and under a German locale the not-a-repository case printed git's German failure without the hint.

### SECURITY.md says what is written outside `.room/`

It listed writing outside `.room/` among the things this package never does, and the first
`rooms open` has always appended `.room/` to the project's `.gitignore`. It now names that line and
every command that writes elsewhere, and a test fails if the first `rooms open` in a new repository
writes anything else.

## 0.5.11

### A board that cannot read git says why

A first-time user got a board reading "no git" and nothing about the project, for a repository with
a full history. The board read the checkout through a helper that turned every git failure into
"not a git checkout" and advised `git init`, while `rooms week` had named git's real failure since
0.5.2. Four different things produce that board, and it now says which:

- **git refused the repository** for dubious ownership, which WSL paths, external drives and clones
  made with `sudo` all produce. The board quotes git, and shows the fix git itself suggests:
  `git config --global --add safe.directory <path>`.
- **There is no git on the PATH** Rooms was started with.
- **git failed**, such as macOS's stub before the command line tools are installed, with the line
  git printed.
- **The folder is not a repository.** This is the only one still told to run `git init`.

`rooms doctor` has a `git` line with the same reason, puts git's fix first, and no longer calls a
board healthy while git can read nothing from it. git is asked in English whatever the locale,
because the reasons are told apart by its words, and under a German locale "not a git repository"
arrives as "Kein Git-Repository".

### A room belongs to its own repository

`rooms open` in the folder that holds your projects made a room there. Every repository under that
folder then found that room, because the search walked all the way up, and opened its board, which
can read none of them. Moving to the right folder and trying again changed nothing. The search now
stops at the top of the repository.

In a folder that holds repositories, `rooms open` names them and makes nothing. A room an earlier
version made there still opens, and says why its board is empty.

Every worktree of a repository now shares the main checkout's room. A worktree beside the main
checkout found no room before, and one nested inside it found the room only because the folders
happened to line up.

## 0.5.10

### The first line is the finding

A week was a title, a count, a bar and two caveat paragraphs, and the thing anybody would repeat
was inside the bar. It is the first line now:

    Claude co-authored 68 of the last 137 commits here, and Cursor 1.

Most repositories have no such line, and that is the more interesting finding rather than a reason
to stay quiet. Cursor and Copilot write no `Co-Authored-By` trailer, so an ordinary repository got
the dashboard back and nothing said. It now reads:

    None of the last 3 commits here records an agent, and Cursor is configured in this repository.

It says what was read and never who wrote the code. A missing trailer is not a missing agent — the
note underneath has always argued that, and a headline contradicting it would be worse than no
headline, so the line carries none of "wrote", "AI" or "human" and a test holds it to that. A
configured agent is named only where the repository commits the config.

Both caveat paragraphs are exactly where they were. A floor stated after the number is honesty;
stated instead of the number it is a tool that will not say what it found.

The default output of `week` gained a line at the top; `branch` and `file` are as they were. Nothing
was removed and no flag changed, and `--json` is exactly as it was, so anything reading the output
should read that.

## 0.5.9

### The Host header is parsed, not split at the first colon

The live board is served only to this machine, and the Host header is the whole of that boundary:
binding to 127.0.0.1 stops another host reaching the socket, but not a page the user is visiting
whose domain has been pointed at 127.0.0.1. The check took everything before the first colon as the
name and everything after it as the port, so `localhost:7840:evil.test` was a name it liked and a
port it liked, and the board — the project's whole git history — was served for it.

Nothing could reach it. A URL with a non-numeric port does not parse, and a page cannot set Host, so
the only client that can send that is one able to send a well-formed `Host: localhost:7840` already.
A check that says yes to a string no client can form is still not a check, and this one now parses
the header: a name or a bracketed IPv6 address, at most one port, and nothing else. User-info, a
second colon, a space and a port written `07840` are refused. The old split had also left `::1`
unmatchable, because it became an empty string before anything compared it.

Eight authorities that must be served and nineteen that must not, three of them refused on the wire
through a running server. Found by an outside review that read the source and could not run it.

## 0.5.8

### The timeline, rebuilt so it can be read

The board's branch graph was one wide drawing: main as a rail, branches as arcs above and below it,
a dot per commit. On OpenHands, 8,269 commits, the rail was 500 dots thirteen pixels apart, twelve
arcs crossed each other and main, names were cut off at the edges of the drawing, and commits hung
in empty space where an arc had already turned back towards main.

- **A row per branch, most recent first,** with the whole name in a column of its own.
- **A busy row shows commits per day, stacked by agent.** A quiet one keeps a dot per commit.
- **One time axis, zoomable to 30 days, 90 days, a year or all.** It opens at the smallest window
  that still shows every row, and each window says how many commits it leaves out. A row says how
  many of its marks are earlier than the window on screen.
- **Every row opens into the list of what is on it:** date, message, person, agent and lines. That
  list is also what a keyboard or a screen reader can reach. The old page had two focusable
  elements in 12,000 pixels.

On OpenHands the board went from 551 KB to 241 KB, and from 12,378 to 7,707 pixels tall.

### Three things on the board that were wrong

- **An avatar sat half outside its row.** The base rule centres an avatar on a point with
  `translate(-50%, -50%)`, which is right on a track, and the row never reset it. People who posted
  on a branch now sit inside that branch's row.
- **"Live · localhost" showed from page load, with or without a server.** It now says Connecting,
  Live, Reconnecting or Offline, with the time the page was loaded.
- **Built by said "From 8269 commits"** over figures computed from the newest slice, with the
  correction in a note at the bottom. The first sentence now counts what was read.

## 0.5.7

### `--json` on `week`, `branch` and `file`

Nothing downstream could consume this tool's output, which is why the action below could not exist.
One object on stdout and nothing else, and **every caveat the prose carries is a field**: the floor
note itself rather than a flag pointing at it, `multiAgentCommits` so a consumer knows the rows
overlap, `truncated`, the models nested under their agent, the two co-author buckets kept apart, what
the repository declares, and why nothing was recorded when nothing was.

A caveat that exists only in the terminal does not survive contact with the surface most likely to
misquote it.

A refusal is JSON too. `rooms branch` on the base branch declines, and under `--json` that used to
be prose on stdout with exit 0 — unparseable and reported as success, the worst pair available.

### A GitHub Action that comments the attribution on a pull request

```yaml
- uses: i-ops-hq/iops-rooms/actions/attribution@attribution-action-v1.0.0
```

Most of its design is about who reads it. Everything else this tool prints is read by somebody who
just typed a command and can see the caveat underneath. **A comment on a pull request is read by
people who never ran anything**, did not choose to see it, and will take a number at face value.

- **It says nothing when nothing was attributed.** Most pull requests will be that — 1.5% of commits
  across six well-known repositories carried a trailer. A bot posting "0 agents found" every time is
  noise that teaches people to scroll past the one that matters.
- **Counts, never a bare percentage.** `3 of 10 commits` is harder to misquote than `30%`, and the
  number repeated in a meeting is the one to be careful about.
- **The floor note is in the comment**, not behind a link. A reader who has to click will not click.
- One comment, edited in place.
- **A pull request from a fork is not a failed check.** GitHub gives a fork's workflow a read-only
  token, so the comment cannot be posted. The first version of this action failed the check there,
  on exactly the outside contributions it exists to read. It now notices, says so in a notice, leaves
  the attribution in the job summary, and passes. Any other failure to post still fails.

The version it runs is pinned to the package beside it and it refuses to guess, for the same reason
the coverage action in `assurance` does: an action that floats changes what a comment said without
anybody editing a workflow.


## 0.5.6

### An empty result now says whether it is expected, broken, or nothing to go on

`no agent recorded 100%` is the most common first run, and three different situations produce it:
the setup is broken, the tool in use never wrote trailers, or no agent was involved. A bar at 100%
cannot tell them apart, so a reader could not tell whether to go looking — and **in two of the three
the honest answer is that nothing is wrong**, which the output had never said.

Since 0.5.5 reads what the repository declares, the cases can be told apart:

```
Cursor does not write a Co-Authored-By trailer, so an empty result here is
the expected one rather than a fault. There is nothing to switch on.
```
```
Claude Code writes this trailer itself, and none of these commits carries
one — so either it was turned off, or this window predates it.
```

Silent the moment anything is attributed. Not a threshold: at any attribution at all the reader has
evidence the mechanism works. Silent too for an agent this does not have a position on, because
silence beats a guess about a tool nobody checked.

### No command is offered, and the reason is the interesting part

This was first scoped around printing `rooms hooks install` — on the belief, written into the issue,
that it writes the trailer. **It does not.** That hook writes a board activity post and never
touches a commit message, and the repository said so in two places that were not read first:
`src/cli.js:80` and `src/board.js:943`, both "trailers the agents write themselves".

Shipping it would have told people to fix an attribution problem with something that does not touch
attribution. And rooms **should not** write trailers: one added by a git hook is a claim about
authorship made by something that was not there. These numbers are worth something because the agent
attested to its own work; manufacturing the evidence we then measure would be the most complete
version of the defect this project exists to avoid.


## 0.5.5

### The trailers are 1.5% of commits, and the repository was already saying more than that

This tool rested entirely on `Co-Authored-By` trailers. Measured across the newest 500 commits of
six well-known repositories — Anthropic's, OpenAI's, LangChain's, Astral's, Vercel's and tinygrad's,
3,000 commits — **45 of them carried a trailer that could be attributed to an agent.** On
`sindresorhus/execa`, picked at random, the whole output was one row: `no agent recorded 100%`.

That was not a bug. It was the product measuring something that mostly is not there, while the
denser signal sat in the same checkout and nothing opened it: **five of those six repositories
declare their agents in a committed file**, and `AGENTS.md` alone is in five of six.

So there is a second source now, answering a different question. Not *which commits recorded an
agent* — sparse, honestly caveated, unchanged — but *which agents is this project set up for*.

```
Configured for: Claude Code (CLAUDE.md, .claude/), Codex (.codex/) and a
cross-vendor AGENTS.md.
A config file says a tool was set up here, never that it was used — and never
how much. These are not commits and do not belong in the percentages above.
```

**The two are never combined into one number**, and the commit percentages are untouched — a test
asserts that adding a config file moves no share. A figure averaging "6% attributed" with
"configured for three agents" would mean nothing, and would be the 47% row of 0.5.4 wearing a
different hat.

### Three decisions inside it

**Only the filename is read, never the contents.** What is inside a `CLAUDE.md` is somebody's
prompt. A test fails if `src/agent-config.js` so much as references `readFile`.

**It asks git, not the filesystem.** An untracked `.claude/` left in a working tree by somebody's
own session is not a declaration by the project, and reporting it as one would tell a reader this
repository is set up for Claude Code on the evidence of their own scratch directory.

**Declaring nothing is stated rather than omitted**, because otherwise "declared nothing" and "did
not look" read identically — and the first is the reason the trailer count is the only evidence
there is.

### On the tests

Two of them proved nothing on the first pass and were rewritten. A sentinel that wrote a secret into
`CLAUDE.md` and checked it never surfaced **passed with the reader mutated to read every file** —
the result is assembled from a fixed vocabulary, so file data has nowhere to ride. It is now an
assertion that every string returned comes from that vocabulary, which does fail when something
file-derived is added.


## 0.5.4

Found by installing the published 0.5.3 and pointing it at six repositories that have never heard of
it — Anthropic's, OpenAI's, LangChain's, Astral's, Vercel's and tinygrad's, 3,000 commits. Every
defect below is about what the output *reads as*, which is not something a fixture can catch.

### Human maintainers were filed under a heading that said "agent"

On `astral-sh/uv` the row `co-author, not a known agent` sat at 47% with a long bar directly above
`no agent recorded` at 51%, so the block said — to any eye scanning it — that half the repository was
agent-written. Inside that row: Zanie Blue with 157 commits, Charlie Marsh with 14, `zaniebot`,
`astral-automations-bot`, `github-actions`. Not one AI agent in the top twelve. The label was
literally true and the number read as something else, which is the failure this tool exists to
refuse.

It is now two rows, and neither says "agent": `co-author that says it is a bot` and `co-author, no
bot marker — usually a person`. The split is on `[bot]`, which GitHub appends to every App account,
so it is the platform's own marker rather than a guess from anybody's name. A release bot that does
not mark itself lands with the people, which understates automation rather than overstating it —
the safe direction, and the alternative reads a person named Abbot as a robot.

### One agent appeared as five, so the agent nobody could see was the main one

`anthropic-sdk-python` reported `Claude` 26, `Claude Opus 4.6` 1, `Claude Opus 4.7` 1, `Claude Opus
4.7 (1M context)` 1 and `Claude Code (${CLAUDE_PROJECT_DIR})` 1 — five rows, all Claude Code, and
the number a reader wanted (30) was nowhere on the page. Rows were keyed on the trailer's own text,
and Claude Code writes the model into it. **The agent and the model are two questions.** Rows are
now keyed by family, with the models listed beneath, and a commit carrying two trailers of one
family counts once.

### An unexpanded shell variable was printed as an agent's name

`Claude Code (${CLAUDE_PROJECT_DIR})` is a hook that wrote its template instead of its value. The
variable is not information about the agent, so it is stripped from the display name.

### The README promised a first run the tool will not deliver

Its example was this repository's own output — 37% attributed — while the realistic result on a
stranger's repository is `no agent recorded 100%`. Across the six repositories above, 1.5% of
commits carried an attributable trailer. The README now shows both, and says which one to expect.


## 0.5.3

Found by installing the published 0.5.2 from npm and probing it the way an outside tester would,
rather than by re-reading the diff that shipped it. Both are defects 0.5.2 introduced.

### A repository with no commits reported a git failure

0.5.2 stopped swallowing git's errors, which was right for `rooms branch nonexistent-base` and wrong
for `git init` with nothing committed. HEAD is an unborn branch there, so every git call exits 128,
and a brand new repository answered `rooms week` with `fatal: ambiguous argument 'HEAD'` and exit 1.
0.5.1 said "0 commits", which is the truth.

An unborn HEAD is now read as the empty repository it is. Only for the default HEAD: a range the
caller named is still their assertion, and one that does not resolve is still an error.

### `--version`

There was none. `rooms --version` printed the whole help text and warned that `--version` was an
unknown flag. It prints the version now, read from `package.json` at runtime so there is no second
copy of the number to drift.

## 0.5.2

Everything here came from three reports filed against 0.5.1 by an outside reader who ran the tool
and read the source. Each one is a case where the output was confident and wrong, which is the
failure this project exists to argue against. All three reproduced exactly as filed.

### git failures were reported as "0 commits", with exit 0

`git()` caught every error and returned an empty string, which `readCommits` turned into a total of
zero — indistinguishable from a window that really has no commits. `rooms branch nonexistent-base`
printed `0 commits` and exited 0 while git itself was exiting 128. The same silence covered a 20s
timeout, a `maxBuffer` overflow, and git disappearing from `PATH` between the checkout probe and the
log. A CI step pasting that into a PR published a wrong number with nothing to signal it.

git's own message is now the answer, and the commands exit 1. The "run them inside a repository"
hint is scoped back to the one case where it is true.

### `--since` with no value silently became `--since=true`

The parser took any following token that did not start with `-` as a value, so `rooms week --since`
set `since` to boolean true and passed `--since=true` to git. git's date parser does not reject
that — it reads it as *now*, so the window silently became "nothing before this instant". The same
rule ate legitimate values: `--since -5d` lost its `-5d`, which git parses perfectly well.

The parser now knows which flags take values. A missing value is refused with exit 2; a value may
look like a short flag but never like a long one; and an unknown `--flag` prints a warning instead
of being accepted and ignored.

### Trailers from five widely used agents read as "no agent recorded"

Gemini CLI, Jules, aider, Amazon Q and Windsurf were not in the table, so their commits were shown
under a label the README defines as "the person's own". aider has appended
`Co-authored-by: aider (<model>)` to every commit it makes for years, so a repo built with it read
0% agent-assisted with the evidence sitting in `git log`.

All five are added, by name first and mailbox second — a company's domain is still never an agent,
because that is also where its people have their email. Beyond the table, a trailer no family claims
now gets its own row, `co-author, not a known agent`, so the next tool to appear lowers no floor
silently.

### A commit with two agent trailers was counted twice

Every trailer added one to an agent row, so a commit carrying the same trailer twice — an amend that
re-ran the tool, a squash repeating its parents' trailers — counted twice for that agent, and a
commit with two different agents counted in both rows. The rows then summed past the commit count
and the percentages past 100, in output whose header, bars and badge all read as shares of one
whole. `rooms badge` draws those rows as adjacent segments of a fixed-width bar, so the segments ran
off the end of it.

Duplicate trailers are now one agent on one commit. A commit with two different agents appears in
both counts, because both of them were there, but contributes half of itself to each percentage —
so the rows are a partition again, the badge fits its own bar, and the output says how many commits
were split rather than leaving a reader to notice.

## 0.5.1

### The live board answered to any hostname (DNS rebinding)

`rooms live` binds 127.0.0.1, which stops another *machine* reaching the socket. It does not stop a
*page* the user is visiting. An attacker points `evil.example.com` at 127.0.0.1 with a short TTL,
the browser then treats `http://evil.example.com:7840/` as same-origin with the attacker's page —
and same-origin means CORS never applies. The board is the project's entire git history, so the
reply is every contributor name and address, every branch, every commit subject, and any room posts.

Nothing was reading the `Host` header, which is the only thing separating that from a real visit.
Verified against the running server before and after: a request claiming `Host: evil.example.com`
was served 178 KB including the repo identity, and is now refused with 403 before anything is read.
`localhost`, `127.0.0.1` and `[::1]` are served as before; a correct name on the wrong port is not.

Anyone who has run `rooms live` on an untrusted network, or while browsing, should take 0.5.1.

**A git pathspec uses forward slashes on every platform.** `relative()` returns
`src\api\thing.js` on Windows, and while git tolerates that for a bare path, pathspec magic —
which `--not` produces as `:(exclude)…` — is specified with `/`. 0.5.0 left that to chance, so
`rooms file` and `rooms week --not` could behave differently on Windows than everywhere else. It is
also what the report prints, so a path now reads the same way on every platform.

No other shipped code changed. The README gained a section answering "can't I just use `git log`?"
with this repository's own numbers, and the screenshots were refreshed.

## 0.5.0

### A repository is one project, from any directory inside it

`rooms open` in `src/api/` created `src/api/.room/` and called the project "api". Two people in the
same repo working from different subdirectories got two different rooms; the `.gitignore` and the
union merge driver landed where git would not apply them to the events log at the root; and every
board and report was titled after a folder.

Everything now anchors to the repository root, so a command typed in `packages/web/src` is about the
whole project. A path you type stays the file you meant — `rooms file app.ts` in that directory is
`packages/web/src/app.ts`, rebased onto the root rather than reinterpreted there.

The answer is also spelled the way you spelled it. `git rev-parse --show-toplevel` resolves
symlinks, so a workspace under a symlinked home was told its project lives at a path its owner has
never typed.

### It offers, once, to link your GitHub account

Verified identity was worth having and nobody was ever told how to get it: the board said
"unverified — rooms auth github" and that was the whole of the onboarding. The first `rooms open` in
a project now offers to link the account your `gh` CLI is already signed in to.

Almost all of this feature is the refusal to ask. There is no prompt when stdin or stdout is not a
terminal — a question in `npx … | tee log` is not a question, it is a hang — nor in CI, nor with
`ROOMS_NO_PROMPT`, nor when an account is already linked, nor when `gh` cannot answer (offering and
then failing is worse than never offering), nor ever again after a no. Walking away is not an answer
and is not recorded as one.

It runs after the board has been written and opened, so someone who ignores it still got what they
asked for. And asking does not create an identity: the check reads the verified-identity file
directly rather than going through the call that writes a device file when one is missing.

### A Windows clone reported its drive letter as the remote

`C:\Users\me\origin.git` matches the scp-style remote shape — `host:path` — with a host of `C`. A
Windows user cloning from a local directory saw a remote of `C/Users/...`, which is not a forge and
not a place anybody can visit. Found by the Windows matrix on the run that shipped this release, on
a test written for a completely different reason. An ssh alias has no dot in it either and *is* a
real remote, so the guard is the drive letter, not the dot.

### `approve` recorded a row and said "approved"

An agent reads a tool's description to decide what it does, and hears its reply as the outcome.
`approve` was described as "record an approval in the local audit trail" and answered `approved` —
both of which read like a gate that opened. Nothing here permits anything: there is no policy, no
check, no merge. Rooms answers who acted and which agent signed it. Whether an action is *allowed*
is a different question with a different answer, and a tool that blurs the two lets an agent believe
it has cleared itself to proceed.

Both tools now say what they do, in the description, in the reply, in the CLI and in the skill: a
row in a log. `approve` "does NOT grant permission, authorise an action, or merge anything, and is
not a substitute for a human approving the work". `request_review` notifies nobody. Tests fail if
either description drifts back toward "audit trail".

### Four commands that answer the question without opening anything

The board is the poster. These are the habit — all read-only, all reading git, none of which needs a
room, a server, an account or a browser. They work on a repo that has never heard of this tool.

```
rooms week [--since 7d] [--path src/] [--not vendor,dist]
rooms branch [<base>]
rooms file src/auth.ts
rooms badge --out agents.svg
```

`rooms week` prints the mix with a bar per agent and, when there is a previous week to compare to,
the change against it. `rooms branch` reports only the commits on this branch, which is the number
worth reading before opening a PR. `rooms file` answers "was this an agent dump" with the commits
that touched one path. `rooms badge` writes an SVG you can paste into a README.

**`--since`, `--path` and `--not` filter the denominator, not just the sample.** A monorepo or a
week of lockfile churn otherwise makes every percentage a ratio of two different populations.

**"no agent recorded" is a row, not a remainder.** It has the same label, the same bar and the same
weight as every agent, on every surface including the badge — because a plain commit is not evidence
that no agent was used. Cursor and Copilot often write no `Co-Authored-By` trailer, so every share
is a floor and each of these commands says so in as many words. That sentence is why the number is
worth more than a vendor dashboard's, and it travels with it.

The README now leads with `npx iops-rooms week` and a section saying what this will **not** tell
you: which lines an agent wrote, how much of a codebase is AI-written, or anything about a person
you could not already read in `git log`.

### A human co-author was being counted as Copilot

`attributeAgent` matched on the email DOMAIN, and `github.com` is not only where Copilot lives — it
is the domain of `users.noreply.github.com`, the address GitHub gives every human with an account and
sets as the commit email by default. On a normal GitHub repo **every human co-author was attributed
to Copilot**, and the board's headline "agent-assisted" figure was inflated by exactly those people.
The same trap was set for anyone with an `@anthropic.com`, `@openai.com` or `@cursor.com` address:
their employees.

The trailer NAME decides now, because the name is what an agent writes about itself. A domain can no
longer match; only a specific mailbox a tool commits from, like `noreply@anthropic.com`, which no
person holds. The two errors are not symmetric: missing an agent understates a figure the board
already calls a floor, while calling a person an agent is a false statement about a named human.

The old test used `ben@example.com` — a domain nothing matched — so it proved the matcher rejects
unrelated addresses, not that it rejects a human at a matched one.

### `rooms open` opened a tab; `rooms live` opened a window

Same flag, same session, two different results. `--app=` takes a URL and a board is a filesystem
path, so the guard — which only accepted `http(s)` — rejected every `rooms open` and fell through to
the system opener, producing the browser tab app mode exists to avoid. `rooms live` worked because it
already had a URL. Paths are converted now, and `open` prints which mode it got.

### A slider under the graph

The graph is wider than its window as soon as a history runs past about sixty commits, and nothing
said so. Two things were wrong underneath: `flex-direction: row-reverse`, the usual CSS-only way to
open a scroller at its right edge, reported `scrollLeft: 0` with the OLDEST commits in view — so the
board opened on the wrong end of history; and `scrollbar-width: thin` makes Chrome ignore
`::-webkit-scrollbar` entirely, leaving a macOS overlay bar that is invisible until you already knew
to scroll and occupies no layout space.

There is now a visible slider, keyboard-operable, that hides itself when the graph fits. The scroll
position is set explicitly, which is also the only version that can be measured and tested.

### Who posted where, instead of a second timeline

Under the graph was a lane per branch, each with a rail and avatars positioned by **time** — beneath
a graph on a **commit-order** axis. Two x-axes that could never agree, drawn as though they did. And
a branch nobody had posted on still got a full-width row saying "no posters yet".

It is a compact row per branch that somebody actually posted on: name, count, faces, with the same
hover detail as before. One line says how many other branches are on the graph with no posts.

### Doctor was a version behind the product

A repo with a hundred commits and nobody posting renders a full board — commits, contributors, agent
split, branch graph — and `rooms doctor` called it empty and exited 2. Telling someone their working
tool is broken is worse than saying nothing. A board is empty when it has neither git history nor
posts; posts on their own are optional, which is what they are.

### CI costs about a fifth of what it did

The matrix was 3 OS x 3 Node on every push and PR. GitHub bills macOS at 10x minutes and Windows at
2x, so three macOS jobs were roughly three quarters of every run — for the one platform that gets
tested by hand every day. macOS moved to a weekly run and `workflow_dispatch`; Windows stays on
every run, because four of the bugs it found were real. Roughly 124 billed minutes a run to 26.

**The push trigger said `master`.** After the rename to `main` nothing matched it, so from that day a
push ran no checks at all — silently, with a green repo behind it. Fixed, and the matrix had to
shrink first so turning it back on did not cost a full run per push. A test now fails if the trigger
and the branch drift apart again, or if macOS creeps back onto the every-push list.

### One command, and a real window

`rooms open` in a folder with no room creates one and opens it, instead of failing with
instructions to run `rooms init` first. Install and start is now two commands with nothing
between them.

The board opens in an application window — Chrome, Brave, Edge or Chromium in `--app` mode, whichever
is installed — rather than as a tab in whatever the browser had open. `--tab` forces the old
behaviour, and a machine with none of those falls back to the system opener.

### Branches that were never merged are branches too

The graph reconstructed branches from merge commits, which meant a branch you are still working on,
or one that was deployed and never merged back, did not exist as far as the board was concerned. On
one repo that was the difference between drawing zero branches and drawing ten. Every ref is now
read, and anything holding commits the trunk does not have is drawn and marked open.

### A graph you can read

Branches curve above and below main instead of stacking downward from it, six at a time with a `+`
for the rest, and the axis is commit order rather than elapsed time.

The last of those is what made the rest work. On a time axis a branch that lived forty minutes
inside a two-day history has no width, so its route degenerated into a vertical spike as tall as its
lane was far from main — seventeen branches drew as a comb. Every commit now takes the same step,
which is what `git log --graph` does. The cost is that a quiet month and a busy hour are the same
width; the axis says so, and the real timestamp is still on every dot and at both ends.

The drawing is as wide as the history is long, in its own scroller, opening at the newest end.
Branches outside the collapsed view are hidden rather than merely cropped — cropping alone left
their risers crossing the visible band as lines to nowhere.

### The top of the board is about the project

The cards were facts about the tool: posters, events, network off, `.room` on disk. They now read
**commits · people · agent-assisted · branches · since the last change**, all from git history the
repo already has, so they are full on the first run before anyone has posted. Each carries a line
saying what the number means.

The agent share is of the commits actually read, and it is a floor: an agent that writes no trailer
leaves no trace, so the true share can only be higher.

A rail says who you are — verified, unverified, or a name asserted through `ROOMS_ACTOR` that
nothing can check — and what this checkout is connected to: the remote, the branch and SHA, whether
the tree is clean, and how far it is from its upstream. Three things came out of building it:

- **A remote URL can carry a credential.** `https://x-access-token:ghp_…@github.com/o/r` is what a
  shared box or a CI checkout configures, and a board is a file people screenshot into issues. It is
  stripped where the URL is read.
- **Verified elsewhere is not verified here.** A restored `identity.json`, a copied home directory or
  a VM template leaves an account linked to a different device. That now says so rather than showing
  a check this machine has not earned.
- **Rendering must not mint an identity.** `loadIdentity` writes `device.json` when it is missing, so
  a renderer that called it would make opening a board the thing that gives the machine an identity.

### The Branches panel says what is still happening

It listed every local ref as an equal row — twenty-four on this repo, twenty of which read "0 posts
· —" and "no room posts yet". The default, the branch you have checked out, anything holding commits
the default does not have, and anything anyone posted about keep their own row; the rest collapse
into one line and a disclosure.

A row now says which of three different things its silence means: `merged in #24`, `nothing on it
that main does not have`, or `not a branch in this checkout` — a name that only ever appeared as a
post stamp. All three used to render as "0 posts".

**Exactly one branch is badged default, and git decides which.** The badge matched
`/^(main|master)$/`, so a repo part-way through a rename had two of them — and a page that names two
defaults has told the reader it does not know. It now comes from `origin/HEAD`, falling back to
whichever of main/master/trunk/develop the repo actually has.

The local branch list was also silently cut at sixteen refs, which is how a real branch ended up
described as "not a branch in this checkout".

### The test suite was writing into your real identity store

`npm test` resolved `ROOMS_HOME` to `~/.iops-rooms` in every file that did not set its own, which was
most of them. On the machine this was found on it had left a display name of `cmd-test` and a
verified GitHub login of `octocat` — and the board rendered that fixture back as "verified". Nothing
failed; the suite passed while replacing the identity the developer's own posts are signed with.

Fixed for every file at once with a `--import` hook that points `ROOMS_HOME` at a temp directory, and
guarded by a test that fails if the hook is ever dropped. The smoke scripts got the same treatment.

## 0.4.1

**`rooms auth github` works with no setup.** It reads your account from the `gh` CLI you already
have — one read-only `gh api user`, with your own credential. No OAuth App to register, nothing of
ours in your GitHub authorised-apps list, no token stored. `--device-flow` with
`ROOMS_GITHUB_CLIENT_ID` remains for machines without `gh`.

Before this, `rooms auth github` threw unless you had registered an OAuth App and exported its
client id — so the first thing a new user hit was a wall.

**A shorter README.** 371 lines to 191. It now opens with what the tool does, gives one plain
three-step flow for a single person, and says honestly that individual is the finished path and
teams are newer. The reference material that made the front page hard to read is gone or collapsed.

## 0.4.0

The board stopped being only about the room and started being about the project.

### It reads your git history

Point it at a repo and it shows every commit, who made it, and **which AI helped** — from the
`Co-Authored-By` trailers Claude Code and Cursor already write. A few hundred commits are read in
about a second and split by agent — how much each one wrote, and how much carries no attribution
at all.

No MCP, no network, no vendor's private state — `.cursor/` holds configuration, not a commit
ledger, and reading another tool's session database is not something this package will do. A commit
with no trailer is shown as the person's own, not as an unknown.

- **Built by panel** — per-person commits, merges, `+`/`−` lines, and which agent each person leans
  on. An agent's share is of that person's *attributed* commits, because a plain commit is not
  evidence that no agent was used, only that none was recorded.
- **Merges are counted separately.** git records no line changes for a merge, so a maintainer who
  merges every PR was showing as `+0 −0` — as if they had written nothing.
- **Split identities are flagged, never merged.** One person committing under two addresses is
  listed twice, with a pointer to `.mailmap`. Guessing would eventually merge two different people.

### A branch graph

Main is a rail across the whole span; every other branch splits off at its first event and rejoins
at its last, with a dot per commit and per post and a light travelling each wire. Branches that were
merged and deleted still appear, reconstructed from their merge commits with PR numbers.

Hovering a commit gives the whole answer:

```
85d970d · AshPlayer-1415 · Claude Opus 5 · +750 −1 · 9/7/2026, 4:22:28 PM
```

A repo that works on `main` with no merges draws as one rail. A repo that merges PRs draws a rail
plus a lane per branch. Both are normal and both are handled.

### Windows

Now tested on Windows, macOS and Linux across Node 20, 22 and 24 — every combination, on every
change. Four bugs this found, three of which affect real users:

- **`fs.watch` aborted the process.** On a path containing an 8.3 short name (`C:\Users\RUNNER~1\…`,
  or any shortened Windows profile) libuv fails an internal assertion and *aborts* rather than
  throwing. `rooms live` died the instant anything touched `.room/`. Now watches the resolved path
  and degrades to polling if watching is unavailable.
- **`rooms live --port 0` bound 7840** instead of picking a free port, because the CLI passes a
  string and `Number("0") || 7840` falls through on a falsy zero. Two boards on one machine
  collided.
- **`npm test` was broken on Node 20 + Windows** — `node --test test/*.test.js` needs a shell or
  Node 22+ to expand the glob, and `cmd.exe` does neither.
- **The MCP server did not exit when its pipe closed**, only on a clean `end`, leaving orphaned
  processes.

`device.key` cannot be mode 0600 on Windows — POSIX permission bits do not exist there, so it is
protected by the NTFS profile ACL instead. That is a weaker and different guarantee, and
`SECURITY.md` now says so rather than implying otherwise.

### Team rooms through git actually work

`rooms init --share` now writes a `.gitattributes` setting `merge=union` on `events.jsonl` and a
`.gitignore` excluding the generated `board.html`.

Before this, the documented team workflow **conflicted on every concurrent post** — an append-only
log where two people append between pulls conflicts every time, which for a shared room is the
normal case rather than an edge case. Verified with three machines, three device ids and one shared
remote: all three post, all three push, and every machine ends with the same events and all three
actors.

Duplicate ids are dropped when the log is read, so a union merge can never render a post twice.

### `share-diff` no longer reads whatever it is pointed at

Three independent controls, because confinement alone fixes only the first:

- Outside the project is refused; `--allow-outside` is the deliberate way through.
- Secret-looking names are refused **inside** the project too — `.env` lives in the project, so
  confinement does nothing for it. The two are independent.
- The read is bounded to the cap. Previously the whole file was read and then sliced, which on a
  file past Node's maximum string length was not a slow read but an `Invalid string length` crash.

Truncation is recorded on the event and shown on the board instead of being applied silently.

### Identity in a VM

A cloned VM template hands every clone the same `device.json`, and an ephemeral VM loses it on each
spin-up, so the machine must set `ROOMS_DEVICE_ID` — which used to stamp every event `unverified`
regardless of a valid signature. Running in a VM and being verified were mutually exclusive.

`ROOMS_ACTOR` claims to be a *person* and nothing can check it, so it stays unverified.
`ROOMS_DEVICE_ID` names a *machine*, which is not an identity claim, so it signs normally and the
event records `deviceAsserted`. `deviceId` is now 16 bytes rather than 4 — 32 bits collide at
roughly 1% by 9,300 devices, and a fleet of ephemeral VMs counts runs, not machines.

### Also

- `ROOMS_NO_OPEN=1` skips launching a browser, for headless boxes and VMs.
- CI: the suite, both smokes, a coverage floor, and a job that installs the packed tarball and runs
  the CLI from it — because `npm publish` packs the working tree while git records what you added.
- The two-device smoke now verifies two devices instead of printing instructions for a human.
- Documentation corrected where it had drifted, and gated so it cannot drift again.

## 0.3.1 and earlier

Local rooms for agent sessions: CLI, MCP server, offline board, live board, branch awareness,
device sync, opt-in git hooks, and optional verified GitHub/GitLab identity.
