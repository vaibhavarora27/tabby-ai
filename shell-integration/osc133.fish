# OSC 133 (FinalTerm) shell integration for fish — tabby-ai error explainer.
#
# Emits the FinalTerm command markers so tabby-ai can reliably detect when a
# command finishes and what its exit code was:
#
#   OSC 133;A  prompt start
#   OSC 133;B  command-line start (end of prompt)
#   OSC 133;C  command execution start (output begins)
#   OSC 133;D;<exit_code>  command finished, carrying $status
#
# fish >= 4.0 emits OSC 133 NATIVELY — you do NOT need this file there. This is
# for fish 3.x (and any setup where the native marking is disabled). On fish 4+
# you can disable the built-in marking with:  set -Ua fish_features no-mark-prompt
#
# Usage (fish 3.x): copy to ~/.config/fish/conf.d/osc133.fish
#     cp osc133.fish ~/.config/fish/conf.d/osc133.fish
#   or source it from config.fish:
#     source /path/to/osc133.fish

# Avoid double-loading.
if set -q __TABBY_OSC133_LOADED
    exit 0 2>/dev/null
end
set -g __TABBY_OSC133_LOADED 1

function __tabby_osc133 --description 'emit an OSC 133 marker'
    printf '\033]133;%s\007' $argv[1]
end

function __tabby_osc133_prompt_start --on-event fish_prompt
    __tabby_osc133 A
end

function __tabby_osc133_preexec --on-event fish_preexec
    __tabby_osc133 C
end

function __tabby_osc133_postexec --on-event fish_postexec
    # $status here is the exit code of the command that just ran.
    __tabby_osc133 "D;$status"
end

# fish has no clean hook for "end of prompt", so emit the B marker by wrapping
# the user's fish_prompt function: call the original, then print 133;B. Guard
# against re-wrapping on re-source.
if not functions -q __tabby_osc133_orig_fish_prompt
    if functions -q fish_prompt
        functions --copy fish_prompt __tabby_osc133_orig_fish_prompt
    else
        function __tabby_osc133_orig_fish_prompt
            printf '%s ' (prompt_pwd) '>'
        end
    end

    function fish_prompt
        __tabby_osc133_orig_fish_prompt
        __tabby_osc133 B
    end
end
