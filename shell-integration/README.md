# tabby-ai shell integration (OSC 133)

tabby-ai's **auto-explain failed commands** feature needs to know, reliably,
**when a command finished** and **what its exit code was**. Terminals have no
framework-level API for this — the standard way to expose it is for your shell
to emit [OSC 133 / FinalTerm](https://iterm2.com/documentation-escape-codes.html)
command markers around each command:

| Marker | Meaning |
| ------ | ------- |
| `OSC 133;A` | prompt start |
| `OSC 133;B` | command-line start (end of prompt) |
| `OSC 133;C` | command execution start (output begins) |
| `OSC 133;D;<exit_code>` | command finished, carrying the exit code |

Source the snippet for your shell so these markers are emitted. tabby-ai parses
them out of the terminal stream (they are invisible — they do not render).

## bash

Add to `~/.bashrc`:

```bash
source /path/to/osc133.bash
```

For the most accurate marking (the `C` "output start" marker), install
[bash-preexec](https://github.com/rcaloras/bash-preexec) and source it **before**
`osc133.bash`. Without bash-preexec the snippet falls back to a
`PROMPT_COMMAND`-only mode that still reports exit codes reliably (it just omits
the `C` marker).

## zsh

Add to `~/.zshrc` (no extra dependencies — zsh has native `precmd`/`preexec`
hooks):

```zsh
source /path/to/osc133.zsh
```

## fish

**fish 4.0+ emits OSC 133 natively — you do not need this file.**

For **fish 3.x**, copy the snippet into your `conf.d` (auto-loaded on startup):

```fish
cp /path/to/osc133.fish ~/.config/fish/conf.d/osc133.fish
```

or source it from `config.fish`:

```fish
source /path/to/osc133.fish
```

## Verifying it works

After sourcing, run a command that fails, e.g. `cat nope` or `false`. With the
markers flowing, tabby-ai will pop up an explanation panel for the failure
(unless you have turned the feature off in **Settings → AI Assistant →
Auto-explain failed commands**).

If nothing happens, confirm your shell is actually emitting the markers:

```sh
# you should see ...133;D;1... in the (escaped) output
false; printf '%q\n' "$(tput sgr0)"   # sanity check that escapes reach the term
```

Re-sourcing is safe: every snippet guards against double-loading and
double-appending its prompt marker.
