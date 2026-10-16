# Undo Branches

An undo tree for VS Code.

In plain VS Code, if you undo a few steps and then type something, the steps you undid are gone. Redo cannot bring them back. Undo Branches keeps them. Every version of the file stays in a tree, and you can click any of them to go back, or compare it with what you have now.

This is the feature asked for in [microsoft/vscode#20889](https://github.com/microsoft/vscode/issues/20889) "Undo branches", open since 2017. It works the way the undo tree works in Vim and Emacs.

## How to use it

Open the **Undo Branches** view in the Explorer side bar. It shows the history of the file you are editing.

- **Click a state** to put the file back to it. This is one normal edit, so Ctrl+Z (Cmd+Z on Mac) takes you straight back.
- **Compare with Now** (the diff icon on a state) opens that version next to the file as it is.
- A state with a **branch** under it is where you undid and then typed something else. Open the branch to see the versions you would have lost.
- **Earlier in Time** and **Later in Time** (the view's title bar) step through every version in the order you made them, across branches. These are Vim's `g-` and `g+`.
- Each version shows how long ago it was made and what changed. Versions you saved say **saved**, the newest of them **last save**, and the one redo would take you to says **next redo**.

Ctrl+Z and Ctrl+Y keep working exactly as before. Undo Branches follows them and only adds what they cannot do.

## Commands

All in the Command Palette under "Undo Branches", ready for your own key bindings:

| Command | What it does |
| --- | --- |
| `undoBranches.earlier` | The version made just before this one, on any branch |
| `undoBranches.later` | The version made just after this one, on any branch |
| `undoBranches.undo` | Back to the parent version in the tree |
| `undoBranches.redo` | Forward to the child version, on the branch you last took |
| `undoBranches.forget` | Clear the history of the current file |

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `undoBranches.groupDelay` | 1000 | Typing is kept as one version until you pause this many milliseconds. Saving, undo, redo and switching files also close a version. |
| `undoBranches.maxStates` | 1000 | The most versions kept per file. The oldest go first, never the one you are on. |
| `undoBranches.maxFileSize` | 5000000 | Files longer than this many characters are not tracked. |
| `undoBranches.persist` | false | Keep each file's history after VS Code closes, like Vim's `undofile`. |

## Good to know

- By default the history lives in memory while VS Code is open. It survives closing and reopening a file as long as the file has not changed in between.
- With `undoBranches.persist` on, it also survives a restart. It is written to VS Code's own storage for this extension when you save, close a file or quit, and only comes back if the file is exactly as it was left. It is off by default because the stored history holds earlier versions of your files.
- Works on local files, files on SSH, WSL and dev containers, settings files, notebook cells and untitled files.
- Each version stores only what changed, not a copy of the file.
- Nothing is sent anywhere. The extension makes no network calls.

## License

MIT
