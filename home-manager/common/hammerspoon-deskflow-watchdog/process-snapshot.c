#include <errno.h>
#include <inttypes.h>
#include <libproc.h>
#include <limits.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>
#include <sys/sysctl.h>
#include <sys/types.h>
#include <unistd.h>

#define TARGET_PROCESS_NAME "deskflow-core"

struct process_record {
  pid_t pid;
  uint32_t ppid;
  char *path;
  char *role;
};

static void free_records(struct process_record *records, size_t count) {
  for (size_t i = 0; i < count; ++i) {
    free(records[i].path);
    free(records[i].role);
  }
  free(records);
}

static int encode_field(const char *input, char **output) {
  size_t encoded_size = 0;
  for (const unsigned char *cursor = (const unsigned char *)input;
       *cursor != '\0'; ++cursor) {
    size_t width = *cursor == '%' || *cursor == '\t' || *cursor == '\r' ||
                           *cursor == '\n'
                       ? 3
                       : 1;
    if (encoded_size > SIZE_MAX - width) {
      fputs("encoded process field is too large\n", stderr);
      return -1;
    }
    encoded_size += width;
  }
  if (encoded_size == SIZE_MAX) {
    fputs("encoded process field is too large\n", stderr);
    return -1;
  }

  char *encoded = malloc(encoded_size + 1);
  if (encoded == NULL) {
    fprintf(stderr, "allocating encoded process field failed: %s\n",
            strerror(errno));
    return -1;
  }

  char *destination = encoded;
  for (const unsigned char *cursor = (const unsigned char *)input;
       *cursor != '\0'; ++cursor) {
    const char *escape = NULL;
    switch (*cursor) {
    case '%':
      escape = "%25";
      break;
    case '\t':
      escape = "%09";
      break;
    case '\r':
      escape = "%0D";
      break;
    case '\n':
      escape = "%0A";
      break;
    default:
      *destination++ = (char)*cursor;
      break;
    }
    if (escape != NULL) {
      memcpy(destination, escape, 3);
      destination += 3;
    }
  }
  *destination = '\0';
  *output = encoded;
  return 0;
}

static int copy_argument(const unsigned char *argument, size_t length,
                         char **output) {
  if (length == SIZE_MAX) {
    fputs("process argument is too large\n", stderr);
    return -1;
  }
  char *copy = malloc(length + 1);
  if (copy == NULL) {
    fprintf(stderr, "copying process argument failed: %s\n", strerror(errno));
    return -1;
  }
  memcpy(copy, argument, length);
  copy[length] = '\0';
  *output = copy;
  return 0;
}

static int extract_role(const unsigned char *arguments, size_t size,
                        char **role) {
  if (size < sizeof(int)) {
    fputs("KERN_PROCARGS2 returned incomplete argument data\n", stderr);
    return -1;
  }

  int argument_count = 0;
  memcpy(&argument_count, arguments, sizeof(argument_count));
  if (argument_count < 0) {
    fputs("KERN_PROCARGS2 returned an invalid argument count\n", stderr);
    return -1;
  }

  const unsigned char *cursor = arguments + sizeof(argument_count);
  const unsigned char *end = arguments + size;
  const unsigned char *executable_end = memchr(cursor, '\0', (size_t)(end - cursor));
  if (executable_end == NULL) {
    fputs("KERN_PROCARGS2 returned an unterminated executable path\n", stderr);
    return -1;
  }
  cursor = executable_end + 1;
  while (cursor < end && *cursor == '\0') {
    ++cursor;
  }

  bool options_ended = false;
  for (int i = 0; i < argument_count; ++i) {
    if (cursor >= end) {
      fputs("KERN_PROCARGS2 returned incomplete argv data\n", stderr);
      return -1;
    }
    const unsigned char *argument_end =
        memchr(cursor, '\0', (size_t)(end - cursor));
    if (argument_end == NULL) {
      fputs("KERN_PROCARGS2 returned an unterminated argument\n", stderr);
      return -1;
    }

    size_t length = (size_t)(argument_end - cursor);
    if (i > 0) {
      if (!options_ended && length == 2 && cursor[0] == '-' &&
          cursor[1] == '-') {
        options_ended = true;
      } else if (options_ended || length == 0 || cursor[0] != '-' ||
                 (length == 1 && cursor[0] == '-')) {
        return copy_argument(cursor, length, role);
      }
    }
    cursor = argument_end + 1;
  }

  return copy_argument((const unsigned char *)"", 0, role);
}

static int read_process_role(pid_t pid, char **role) {
  int name[] = {CTL_KERN, KERN_PROCARGS2, pid};
  size_t size = 0;
  errno = 0;
  if (sysctl(name, 3, NULL, &size, NULL, 0) != 0) {
    int error = errno;
    if (error == ESRCH) {
      return 0;
    }
    fprintf(stderr, "KERN_PROCARGS2 size query failed for PID %jd: %s\n",
            (intmax_t)pid, strerror(error));
    return -1;
  }
  if (size < sizeof(int)) {
    fprintf(stderr, "KERN_PROCARGS2 returned invalid data for PID %jd\n",
            (intmax_t)pid);
    return -1;
  }

  unsigned char *arguments = malloc(size);
  if (arguments == NULL) {
    fprintf(stderr, "allocating arguments for PID %jd failed: %s\n",
            (intmax_t)pid, strerror(errno));
    return -1;
  }

  size_t returned_size = size;
  errno = 0;
  if (sysctl(name, 3, arguments, &returned_size, NULL, 0) != 0) {
    int error = errno;
    free(arguments);
    if (error == ESRCH) {
      return 0;
    }
    fprintf(stderr, "KERN_PROCARGS2 failed for PID %jd: %s\n", (intmax_t)pid,
            strerror(error));
    return -1;
  }
  if (returned_size > size) {
    free(arguments);
    fprintf(stderr, "KERN_PROCARGS2 overflowed its buffer for PID %jd\n",
            (intmax_t)pid);
    return -1;
  }

  int result = extract_role(arguments, returned_size, role);
  free(arguments);
  if (result != 0) {
    fprintf(stderr, "parsing arguments failed for PID %jd\n", (intmax_t)pid);
    return -1;
  }
  return 1;
}

static int compare_records(const void *left, const void *right) {
  const struct process_record *left_record = left;
  const struct process_record *right_record = right;

  if (left_record->pid < right_record->pid) {
    return -1;
  }
  if (left_record->pid > right_record->pid) {
    return 1;
  }
  return 0;
}

static bool is_target_process(const struct proc_bsdinfo *info) {
  static const char target[] = TARGET_PROCESS_NAME;

  return strncmp(info->pbi_name, target, sizeof(target)) == 0;
}

static int list_current_user_pids(uid_t uid, pid_t **pids,
                                  size_t *pid_count) {
  int required_bytes = proc_listpids(PROC_UID_ONLY, uid, NULL, 0);
  if (required_bytes < 0) {
    fprintf(stderr, "proc_listpids size query failed: %s\n", strerror(errno));
    return -1;
  }

  size_t capacity = (size_t)required_bytes / sizeof(pid_t) + 64;
  if (capacity < 64) {
    capacity = 64;
  }

  for (;;) {
    if (capacity > (size_t)INT_MAX / sizeof(pid_t)) {
      fputs("process list is too large\n", stderr);
      return -1;
    }

    size_t buffer_size = capacity * sizeof(pid_t);
    pid_t *buffer = calloc(capacity, sizeof(*buffer));
    if (buffer == NULL) {
      fprintf(stderr, "allocating process list failed: %s\n", strerror(errno));
      return -1;
    }

    int result = proc_listpids(PROC_UID_ONLY, uid, buffer, (int)buffer_size);
    if (result < 0) {
      int error = errno;
      free(buffer);
      fprintf(stderr, "proc_listpids failed: %s\n", strerror(error));
      return -1;
    }
    if ((size_t)result % sizeof(pid_t) != 0) {
      free(buffer);
      fputs("proc_listpids returned an incomplete PID entry\n", stderr);
      return -1;
    }

    if ((size_t)result < buffer_size) {
      *pids = buffer;
      *pid_count = (size_t)result / sizeof(pid_t);
      return 0;
    }

    free(buffer);
    if (capacity > (size_t)INT_MAX / sizeof(pid_t) / 2) {
      fputs("process list grew beyond the supported size\n", stderr);
      return -1;
    }
    capacity *= 2;
  }
}

static int inspect_process(pid_t pid, uid_t uid,
                           struct process_record *record) {
  struct proc_bsdinfo info = {0};

  errno = 0;
  int info_size = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info));
  if (info_size != (int)sizeof(info)) {
    int error = errno;
    if (info_size == 0 && error == ESRCH) {
      return 0;
    }
    fprintf(stderr, "proc_pidinfo failed for PID %jd: %s\n", (intmax_t)pid,
            error == 0 ? "incomplete process information" : strerror(error));
    return -1;
  }

  if (info.pbi_pid != (uint32_t)pid) {
    fprintf(stderr, "proc_pidinfo returned a mismatched PID for %jd\n",
            (intmax_t)pid);
    return -1;
  }
  if (info.pbi_uid != uid || !is_target_process(&info)) {
    return 0;
  }

  char path[PROC_PIDPATHINFO_MAXSIZE] = {0};
  errno = 0;
  int path_size = proc_pidpath(pid, path, sizeof(path));
  if (path_size <= 0) {
    int error = errno;
    if (error == ESRCH) {
      return 0;
    }
    fprintf(stderr, "proc_pidpath failed for PID %jd: %s\n", (intmax_t)pid,
            error == 0 ? "empty executable path" : strerror(error));
    return -1;
  }
  if (memchr(path, '\0', sizeof(path)) == NULL || path[0] != '/') {
    fprintf(stderr, "proc_pidpath returned an invalid path for PID %jd\n",
            (intmax_t)pid);
    return -1;
  }

  char *role = NULL;
  int role_result = read_process_role(pid, &role);
  if (role_result <= 0) {
    free(role);
    return role_result;
  }

  char *encoded_path = NULL;
  char *encoded_role = NULL;
  if (encode_field(path, &encoded_path) != 0 ||
      encode_field(role, &encoded_role) != 0) {
    free(role);
    free(encoded_path);
    free(encoded_role);
    fprintf(stderr, "encoding fields failed for PID %jd\n", (intmax_t)pid);
    return -1;
  }
  free(role);

  record->pid = pid;
  record->ppid = info.pbi_ppid;
  record->path = encoded_path;
  record->role = encoded_role;
  return 1;
}

static int snapshot_processes(FILE *output) {
  uid_t uid = getuid();
  pid_t *pids = NULL;
  size_t pid_count = 0;
  if (list_current_user_pids(uid, &pids, &pid_count) != 0) {
    return EXIT_FAILURE;
  }

  struct process_record *records = calloc(pid_count, sizeof(*records));
  if (pid_count != 0 && records == NULL) {
    fprintf(stderr, "allocating process records failed: %s\n", strerror(errno));
    free(pids);
    return EXIT_FAILURE;
  }

  size_t record_count = 0;
  for (size_t i = 0; i < pid_count; ++i) {
    if (pids[i] <= 0) {
      continue;
    }

    int result = inspect_process(pids[i], uid, &records[record_count]);
    if (result < 0) {
      free(pids);
      free_records(records, record_count);
      return EXIT_FAILURE;
    }
    if (result > 0) {
      ++record_count;
    }
  }
  free(pids);

  if (record_count > 1) {
    qsort(records, record_count, sizeof(*records), compare_records);
  }
  for (size_t i = 0; i < record_count; ++i) {
    if (fprintf(output, "%jd\t%" PRIu32 "\t%s\t%s\n",
                (intmax_t)records[i].pid, records[i].ppid, records[i].path,
                records[i].role) < 0) {
      fprintf(stderr, "writing process snapshot failed: %s\n", strerror(errno));
      free_records(records, record_count);
      return -1;
    }
  }

  if (fflush(output) != 0) {
    fprintf(stderr, "writing process snapshot failed: %s\n", strerror(errno));
    free_records(records, record_count);
    return -1;
  }

  free_records(records, record_count);
  return 0;
}

int main(void) {
  return snapshot_processes(stdout) == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
