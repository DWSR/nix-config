{
  bash,
  lib,
  removeNames,
  shellAllowlist,
  stdenv,
  writeText,
}:
assert lib.unique shellAllowlist == shellAllowlist;
assert lib.all (name: builtins.match "[A-Z_][A-Z0-9_]*" name != null) (
  shellAllowlist ++ removeNames
);
let
  effectiveAllowlist = builtins.filter (name: !(builtins.elem name removeNames)) shellAllowlist;
  renderedAllowlist = lib.concatMapStringsSep ",\n" (
    name: "  ${builtins.toJSON name}"
  ) effectiveAllowlist;
  source = writeText "pi-agent-shell.c" ''
    #include <errno.h>
    #include <stdint.h>
    #include <stdio.h>
    #include <stdlib.h>
    #include <string.h>
    #include <unistd.h>

    static const char *const allowed_names[] = {
    ${renderedAllowlist}
    };
    static char bash_path[] = "${bash}/bin/bash";

    static void allocation_failure(void) {
      fputs("pi-agent-shell: out of memory\n", stderr);
      exit(125);
    }

    static char *environment_entry(const char *name, const char *value) {
      const size_t name_length = strlen(name);
      const size_t value_length = strlen(value);
      if (name_length > SIZE_MAX - 2 || value_length > SIZE_MAX - name_length - 2) {
        allocation_failure();
      }

      const size_t entry_length = name_length + value_length + 2;
      char *entry = malloc(entry_length);
      if (entry == NULL) {
        allocation_failure();
      }
      memcpy(entry, name, name_length);
      entry[name_length] = '=';
      memcpy(entry + name_length + 1, value, value_length + 1);
      return entry;
    }

    int main(int argc, char *argv[]) {
      const size_t allowed_name_count = sizeof(allowed_names) / sizeof(allowed_names[0]);
      char **environment = calloc(allowed_name_count + 1, sizeof(*environment));
      if (environment == NULL) {
        allocation_failure();
      }

      size_t environment_count = 0;
      for (size_t index = 0; index < allowed_name_count; index++) {
        const char *value = getenv(allowed_names[index]);
        if (value != NULL) {
          environment[environment_count++] = environment_entry(allowed_names[index], value);
        }
      }

      char **bash_arguments = calloc((size_t)argc + 1, sizeof(*bash_arguments));
      if (bash_arguments == NULL) {
        allocation_failure();
      }
      bash_arguments[0] = bash_path;
      for (int index = 1; index < argc; index++) {
        bash_arguments[index] = argv[index];
      }

      execve(bash_path, bash_arguments, environment);
      const int error_number = errno;
      fprintf(stderr, "pi-agent-shell: cannot execute managed Bash: %s\n", strerror(error_number));
      return error_number == ENOENT ? 127 : 126;
    }
  '';
in
stdenv.mkDerivation {
  pname = "pi-agent-shell";
  version = "1";
  dontUnpack = true;
  strictDeps = true;

  buildPhase = ''
    runHook preBuild
    $CC -std=c11 -O2 -Wall -Wextra -Werror -o pi-agent-shell ${source}
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm555 pi-agent-shell "$out/bin/pi-agent-shell"
    runHook postInstall
  '';

  postFixup = ''
    /usr/bin/codesign \
      --sign - \
      --identifier com.dwsr.pi-agent-shell \
      --options runtime \
      "$out/bin/pi-agent-shell"
  '';

  meta = {
    mainProgram = "pi-agent-shell";
    platforms = lib.platforms.darwin;
  };
}
