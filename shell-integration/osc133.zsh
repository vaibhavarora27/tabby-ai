# OSC 133 (FinalTerm) shell integration for zsh — tabby-ai error explainer.
#
# Emits the FinalTerm command markers so tabby-ai can reliably detect when a
# command finishes and what its exit code was:
#
#   OSC 133;A  prompt start
#   OSC 133;B  command-line start (end of prompt)
#   OSC 133;C  command execution start (output begins)
#   OSC 133;D;<exit_code>  command finished, carrying $?
#
# zsh has native precmd/preexec hooks, so no extra dependency is required.
#
# Usage: add to ~/.zshrc
#     source /path/to/osc133.zsh

# Avoid double-sourcing.
if [[ -n "${__TABBY_OSC133_LOADED:-}" ]]; then
  return 0
fi
typeset -g __TABBY_OSC133_LOADED=1

# Emit a marker. $1 = body, e.g. "A", "C", "D;0".
__tabby_osc133() {
  printf '\033]133;%s\007' "$1"
}

__tabby_osc133_precmd() {
  local ret=$?                                   # capture exit code FIRST
  if [[ -n "${__tabby_osc133_executing:-}" ]]; then
    __tabby_osc133 "D;${ret}"                    # previous command finished
  fi
  __tabby_osc133 "A"                             # prompt start
  __tabby_osc133_executing=""
}

__tabby_osc133_preexec() {
  __tabby_osc133 "C"                             # output starts
  __tabby_osc133_executing=1
}

# Append the B (end-of-prompt) marker to PROMPT, wrapped in %{ %} so zsh does
# not count the bytes toward the prompt width. Guard against double-append.
if [[ "$PROMPT" != *'133;B'* ]]; then
  PROMPT="${PROMPT}"$'%{\033]133;B\007%}'
fi

autoload -Uz add-zsh-hook
add-zsh-hook precmd  __tabby_osc133_precmd
add-zsh-hook preexec __tabby_osc133_preexec
