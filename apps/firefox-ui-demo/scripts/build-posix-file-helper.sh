#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
source_file="$script_dir/../helper/posix-file-helper/egdesk-file-create.c"
build_dir="$script_dir/../helper/posix-file-helper/build"
binary="$build_dir/egdesk-file-create"
compiler=${CC:-cc}

mkdir -p "$build_dir"
temporary=$(mktemp "$build_dir/.egdesk-file-create.XXXXXX")
trap 'rm -f "$temporary"' 0 HUP INT TERM

if [ "$(uname -s)" = Darwin ]; then
    sdk=$(xcrun --show-sdk-path)
    "$compiler" -isysroot "$sdk" -std=c11 -D_POSIX_C_SOURCE=200809L \
        -Wall -Wextra -Werror -O2 "$source_file" -o "$temporary"
else
    "$compiler" -std=c11 -D_POSIX_C_SOURCE=200809L -Wall -Wextra -Werror -O2 \
        "$source_file" -o "$temporary"
fi
chmod 0700 "$temporary"
mv -f "$temporary" "$binary"
trap - 0 HUP INT TERM
printf '%s\n' "$binary"
