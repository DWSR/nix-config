#include <errno.h>
#include <libproc.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>
#include <sys/sysctl.h>
#include <sys/types.h>
#include <unistd.h>

enum mock_failure {
  MOCK_OK,
  MOCK_DISAPPEAR,
  MOCK_ERROR,
  MOCK_MALFORMED_ARGS,
};

struct mock_process {
  pid_t pid;
  uint32_t ppid;
  uid_t uid;
  const char *name;
  const char *path;
  const char *const *argv;
  size_t argc;
  enum mock_failure info_failure;
  enum mock_failure path_failure;
  enum mock_failure args_failure;
};

static const struct mock_process *mock_processes;
static size_t mock_process_count;

static uid_t mock_getuid(void);
static int mock_proc_listpids(uint32_t type, uint32_t typeinfo, void *buffer,
                             int buffersize);
static int mock_proc_pidinfo(int pid, int flavor, uint64_t arg, void *buffer,
                             int buffersize);
static int mock_proc_pidpath(int pid, void *buffer, uint32_t buffersize);
static int mock_sysctl(int *name, u_int namelen, void *oldp, size_t *oldlenp,
                       void *newp, size_t newlen);

#define getuid mock_getuid
#define main process_snapshot_program_main
#define proc_listpids mock_proc_listpids
#define proc_pidinfo mock_proc_pidinfo
#define proc_pidpath mock_proc_pidpath
#define sysctl mock_sysctl
#ifndef PROCESS_SNAPSHOT_SOURCE
#define PROCESS_SNAPSHOT_SOURCE                                                 \
  "../../home-manager/common/hammerspoon-deskflow-watchdog/process-snapshot.c"
#endif
#include PROCESS_SNAPSHOT_SOURCE
#undef sysctl
#undef proc_pidpath
#undef proc_pidinfo
#undef proc_listpids
#undef main
#undef getuid

#define CHECK(condition)                                                       \
  do {                                                                         \
    if (!(condition)) {                                                        \
      fprintf(stderr, "%s:%d: check failed: %s\n", __FILE__, __LINE__,       \
              #condition);                                                     \
      return false;                                                            \
    }                                                                          \
  } while (0)

static const struct mock_process *find_mock_process(pid_t pid) {
  for (size_t i = 0; i < mock_process_count; ++i) {
    if (mock_processes[i].pid == pid) {
      return &mock_processes[i];
    }
  }
  return NULL;
}

static size_t mock_args_size(const struct mock_process *process) {
  size_t size = sizeof(int) + strlen(process->path) + 3;
  for (size_t i = 0; i < process->argc; ++i) {
    size += strlen(process->argv[i]) + 1;
  }
  if (process->args_failure == MOCK_MALFORMED_ARGS && process->argc > 0) {
    --size;
  }
  return size;
}

static void write_mock_args(const struct mock_process *process,
                            unsigned char *buffer) {
  int argc = (int)process->argc;
  memcpy(buffer, &argc, sizeof(argc));
  size_t offset = sizeof(argc);

  size_t path_size = strlen(process->path) + 1;
  memcpy(buffer + offset, process->path, path_size);
  offset += path_size;
  buffer[offset++] = '\0';
  buffer[offset++] = '\0';

  for (size_t i = 0; i < process->argc; ++i) {
    size_t argument_size = strlen(process->argv[i]) + 1;
    if (process->args_failure == MOCK_MALFORMED_ARGS &&
        i + 1 == process->argc) {
      --argument_size;
    }
    memcpy(buffer + offset, process->argv[i], argument_size);
    offset += argument_size;
  }
}

static uid_t mock_getuid(void) { return 501; }

static int mock_proc_listpids(uint32_t type, uint32_t typeinfo, void *buffer,
                             int buffersize) {
  if (type != PROC_UID_ONLY || typeinfo != mock_getuid()) {
    errno = EINVAL;
    return -1;
  }

  size_t required = mock_process_count * sizeof(pid_t);
  if (buffer == NULL) {
    return (int)required;
  }

  size_t available = (size_t)buffersize / sizeof(pid_t);
  size_t count = available < mock_process_count ? available : mock_process_count;
  pid_t *pids = buffer;
  for (size_t i = 0; i < count; ++i) {
    pids[i] = mock_processes[i].pid;
  }
  return (int)(count * sizeof(pid_t));
}

static int mock_proc_pidinfo(int pid, int flavor, uint64_t arg, void *buffer,
                             int buffersize) {
  const struct mock_process *process = find_mock_process(pid);
  if (process == NULL || flavor != PROC_PIDTBSDINFO || arg != 0 ||
      buffersize != (int)sizeof(struct proc_bsdinfo)) {
    errno = EINVAL;
    return 0;
  }
  if (process->info_failure != MOCK_OK) {
    errno = process->info_failure == MOCK_DISAPPEAR ? ESRCH : EIO;
    return 0;
  }

  struct proc_bsdinfo *info = buffer;
  memset(info, 0, sizeof(*info));
  info->pbi_pid = (uint32_t)process->pid;
  info->pbi_ppid = process->ppid;
  info->pbi_uid = process->uid;
  (void)snprintf(info->pbi_name, sizeof(info->pbi_name), "%s", process->name);
  return (int)sizeof(*info);
}

static int mock_proc_pidpath(int pid, void *buffer, uint32_t buffersize) {
  const struct mock_process *process = find_mock_process(pid);
  if (process == NULL) {
    errno = EINVAL;
    return 0;
  }
  if (process->path_failure != MOCK_OK) {
    errno = process->path_failure == MOCK_DISAPPEAR ? ESRCH : EIO;
    return 0;
  }

  size_t path_size = strlen(process->path) + 1;
  if (path_size > buffersize) {
    errno = ENOSPC;
    return 0;
  }
  memcpy(buffer, process->path, path_size);
  return (int)(path_size - 1);
}

static int mock_sysctl(int *name, u_int namelen, void *oldp, size_t *oldlenp,
                       void *newp, size_t newlen) {
  if (namelen != 3 || name[0] != CTL_KERN || name[1] != KERN_PROCARGS2 ||
      oldlenp == NULL || newp != NULL || newlen != 0) {
    errno = EINVAL;
    return -1;
  }

  const struct mock_process *process = find_mock_process((pid_t)name[2]);
  if (process == NULL) {
    errno = EINVAL;
    return -1;
  }
  if (process->args_failure == MOCK_DISAPPEAR ||
      process->args_failure == MOCK_ERROR) {
    errno = process->args_failure == MOCK_DISAPPEAR ? ESRCH : EIO;
    return -1;
  }

  size_t required = mock_args_size(process);
  if (oldp == NULL) {
    *oldlenp = required;
    return 0;
  }
  if (*oldlenp < required) {
    *oldlenp = required;
    errno = ENOMEM;
    return -1;
  }

  write_mock_args(process, oldp);
  *oldlenp = required;
  return 0;
}

static char *read_stream(FILE *stream) {
  CHECK(fflush(stream) == 0);
  CHECK(fseek(stream, 0, SEEK_END) == 0);
  long length = ftell(stream);
  CHECK(length >= 0);
  CHECK(fseek(stream, 0, SEEK_SET) == 0);

  char *contents = malloc((size_t)length + 1);
  CHECK(contents != NULL);
  size_t bytes_read = fread(contents, 1, (size_t)length, stream);
  CHECK(bytes_read == (size_t)length);
  contents[bytes_read] = '\0';
  return contents;
}

static bool test_encoding(void) {
  char *encoded = NULL;
  CHECK(encode_field("snowman \xE2\x98\x83%\t\r\n", &encoded) == 0);
  CHECK(strcmp(encoded, "snowman \xE2\x98\x83%25%09%0D%0A") == 0);
  free(encoded);
  return true;
}

static bool test_argv_parsing(void) {
  const char *arguments[] = {"deskflow-core", "--verbose", "ser\tver%\n"};
  const struct mock_process process = {
      .pid = 9,
      .path = "/Applications/Deskflow.app/Contents/MacOS/deskflow-core",
      .argv = arguments,
      .argc = sizeof(arguments) / sizeof(arguments[0]),
  };
  size_t size = mock_args_size(&process);
  unsigned char *buffer = malloc(size);
  CHECK(buffer != NULL);
  write_mock_args(&process, buffer);

  char *role = NULL;
  CHECK(extract_role(buffer, size, &role) == 0);
  CHECK(strcmp(role, "ser\tver%\n") == 0);
  free(role);

  CHECK(extract_role(buffer, size - 1, &role) != 0);
  free(buffer);

  const char *no_role_arguments[] = {"deskflow-core", "--verbose"};
  const struct mock_process no_role_process = {
      .pid = 10,
      .path = process.path,
      .argv = no_role_arguments,
      .argc = sizeof(no_role_arguments) / sizeof(no_role_arguments[0]),
  };
  size = mock_args_size(&no_role_process);
  buffer = malloc(size);
  CHECK(buffer != NULL);
  write_mock_args(&no_role_process, buffer);
  CHECK(extract_role(buffer, size, &role) == 0);
  CHECK(strcmp(role, "") == 0);
  free(role);
  free(buffer);
  return true;
}

static bool test_sorted_encoded_output(void) {
  const char *later_argv[] = {"deskflow-core", "server"};
  const char *earlier_argv[] = {"deskflow-core", "cli\tent%\r\n"};
  const struct mock_process processes[] = {
      {
          .pid = 42,
          .ppid = 12,
          .uid = 501,
          .name = "deskflow-core",
          .path = "/Applications/Deskflow%\t\r\n.app/deskflow-core",
          .argv = later_argv,
          .argc = sizeof(later_argv) / sizeof(later_argv[0]),
      },
      {
          .pid = 7,
          .ppid = 3,
          .uid = 501,
          .name = "deskflow-core",
          .path = "/Applications/Deskflow.app/deskflow-core",
          .argv = earlier_argv,
          .argc = sizeof(earlier_argv) / sizeof(earlier_argv[0]),
      },
  };
  mock_processes = processes;
  mock_process_count = sizeof(processes) / sizeof(processes[0]);

  FILE *output = tmpfile();
  CHECK(output != NULL);
  CHECK(snapshot_processes(output) == 0);
  char *contents = read_stream(output);
  CHECK(strcmp(contents,
               "7\t3\t/Applications/Deskflow.app/deskflow-core\t"
               "cli%09ent%25%0D%0A\n"
               "42\t12\t/Applications/Deskflow%25%09%0D%0A.app/"
               "deskflow-core\tserver\n") == 0);
  free(contents);
  CHECK(fclose(output) == 0);
  return true;
}

static bool test_disappearing_candidates_are_skipped(void) {
  const char *arguments[] = {"deskflow-core", "server"};
  const struct mock_process processes[] = {
      {.pid = 1,
       .uid = 501,
       .name = "deskflow-core",
       .path = "/gone-info",
       .argv = arguments,
       .argc = 2,
       .info_failure = MOCK_DISAPPEAR},
      {.pid = 2,
       .uid = 501,
       .name = "deskflow-core",
       .path = "/gone-path",
       .argv = arguments,
       .argc = 2,
       .path_failure = MOCK_DISAPPEAR},
      {.pid = 3,
       .uid = 501,
       .name = "deskflow-core",
       .path = "/gone-args",
       .argv = arguments,
       .argc = 2,
       .args_failure = MOCK_DISAPPEAR},
      {.pid = 4,
       .ppid = 1,
       .uid = 501,
       .name = "deskflow-core",
       .path = "/present",
       .argv = arguments,
       .argc = 2},
  };
  mock_processes = processes;
  mock_process_count = sizeof(processes) / sizeof(processes[0]);

  FILE *output = tmpfile();
  CHECK(output != NULL);
  CHECK(snapshot_processes(output) == 0);
  char *contents = read_stream(output);
  CHECK(strcmp(contents, "4\t1\t/present\tserver\n") == 0);
  free(contents);
  CHECK(fclose(output) == 0);
  return true;
}

static bool test_errors_emit_no_partial_output(void) {
  const char *arguments[] = {"deskflow-core", "server"};
  const struct mock_process processes[] = {
      {.pid = 1,
       .ppid = 1,
       .uid = 501,
       .name = "deskflow-core",
       .path = "/valid",
       .argv = arguments,
       .argc = 2},
      {.pid = 2,
       .uid = 501,
       .name = "deskflow-core",
       .path = "/error",
       .argv = arguments,
       .argc = 2,
       .args_failure = MOCK_ERROR},
  };
  mock_processes = processes;
  mock_process_count = sizeof(processes) / sizeof(processes[0]);

  FILE *output = tmpfile();
  CHECK(output != NULL);
  CHECK(snapshot_processes(output) != 0);
  char *contents = read_stream(output);
  CHECK(strcmp(contents, "") == 0);
  free(contents);
  CHECK(fclose(output) == 0);

  struct mock_process malformed_processes[2] = {processes[0], processes[0]};
  malformed_processes[1].pid = 3;
  malformed_processes[1].args_failure = MOCK_MALFORMED_ARGS;
  mock_processes = malformed_processes;
  mock_process_count = 2;
  output = tmpfile();
  CHECK(output != NULL);
  CHECK(snapshot_processes(output) != 0);
  contents = read_stream(output);
  CHECK(strcmp(contents, "") == 0);
  free(contents);
  CHECK(fclose(output) == 0);
  return true;
}

int main(void) {
  const struct {
    const char *name;
    bool (*run)(void);
  } tests[] = {
      {"encoding", test_encoding},
      {"argv parsing", test_argv_parsing},
      {"sorting and output contract", test_sorted_encoded_output},
      {"disappearance handling", test_disappearing_candidates_are_skipped},
      {"no partial output", test_errors_emit_no_partial_output},
  };

  for (size_t i = 0; i < sizeof(tests) / sizeof(tests[0]); ++i) {
    if (!tests[i].run()) {
      fprintf(stderr, "not ok - %s\n", tests[i].name);
      return EXIT_FAILURE;
    }
    printf("ok - %s\n", tests[i].name);
  }
  return EXIT_SUCCESS;
}
