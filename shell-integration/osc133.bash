# OSC 133 (FinalTerm) shell integration for bash — tabby-ai error explainer.
#
# Emits the FinalTerm command markers so tabby-ai can reliably detect when a
# command finishes and what its exit code was:
#
#   OSC 133;A  prompt start
#   OSC 133;B  command-line start (end of prompt)
#   OSC 133;C  command execution start (output begins)
#   OSC 133;D;<exit_code>  command finished, carrying $?
#
# Bash has no native preexec/precmd hooks, so reliable 133;C emission needs
# bash-preexec (https://github.com/rcaloras/bash-preexec). If bash-preexec is
# already sourced, this file wires into its precmd_functions / preexec_functions
# arrays. If it is NOT present, we fall back to a PROMPT_COMMAND-only mode that
# still emits A / B / D (so exit codes work); only the C "output start" marker is
# skipped in that mode.
#
# Usage: add to ~/.bashrc
#     source /path/to/osc133.bash

# Avoid double-sourcing.
if [[ -n "${__TABBY_OSC133_LOADED:-}" ]]; then
  return 0 2>/dev/null || true
fi
__TABBY_OSC133_LOADED=1

# Emit a marker. $1 = body, e.g. "A", "C", "D;$?".
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

# Append the B (end-of-prompt) marker to PS1, wrapped in \[ \] so bash does not
# count the bytes toward the prompt width.
case "$PS1" in
  *'133;B'*) : ;;                                # already present
  *) PS1='\[\033]133;B\007\]'"$PS1" ;;
esac

if [[ -n "${bash_preexec_imported:-}" || -n "${__bp_imported:-}" ]] \
   || declare -p preexec_functions &>/dev/null; then
  # bash-preexec is available: use its hook arrays for full A/B/C/D support.
  precmd_functions+=(__tabby_osc133_precmd)
  preexec_functions+=(__tabby_osc133_preexec)
else
  # Fallback: no bash-preexec. Drive A + D off PROMPT_COMMAND. Without a preexec
  # hook we cannot emit C, and we mark "executing" right after the prompt so the
  # NEXT precmd reports the exit code. This still yields reliable exit codes.
  __tabby_osc133_prompt_command() {
    local ret=$?
    if [[ -n "${__tabby_osc133_executing:-}" ]]; then
      __tabby_osc133 "D;${ret}"
    fi
    __tabby_osc133 "A"
    __tabby_osc133_executing=1
  }
  case "${PROMPT_COMMAND:-}" in
    *__tabby_osc133_prompt_command*) : ;;
    '') PROMPT_COMMAND='__tabby_osc133_prompt_command' ;;
    *) PROMPT_COMMAND='__tabby_osc133_prompt_command; '"$PROMPT_COMMAND" ;;
  esac
fi
