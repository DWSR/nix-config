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
#include <sys/types.h>
#include <unistd.h>

#define TARGET_PROCESS_NAME "deskflow-core"

struct process_record {
  pid_t pid;
  uint32_t ppid;
  char *path;
};

static void free_records(struct process_record *records, size_t count) {
  for (size_t i = 0; i < count; ++i) {
    free(records[i].path);
  }
  free(records);
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

  char *path_copy = strdup(path);
  if (path_copy == NULL) {
    fprintf(stderr, "copying path for PID %jd failed: %s\n", (intmax_t)pid,
            strerror(errno));
    return -1;
  }

  record->pid = pid;
  record->ppid = info.pbi_ppid;
  record->path = path_copy;
  return 1;
}

int main(void) {
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
    if (printf("%jd\t%" PRIu32 "\t%s\n", (intmax_t)records[i].pid,
               records[i].ppid, records[i].path) < 0) {
      fprintf(stderr, "writing process snapshot failed: %s\n", strerror(errno));
      free_records(records, record_count);
      return EXIT_FAILURE;
    }
  }

  if (fflush(stdout) != 0) {
    fprintf(stderr, "writing process snapshot failed: %s\n", strerror(errno));
    free_records(records, record_count);
    return EXIT_FAILURE;
  }

  free_records(records, record_count);
  return EXIT_SUCCESS;
}
