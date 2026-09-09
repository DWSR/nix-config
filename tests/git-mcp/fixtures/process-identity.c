#include <errno.h>
#include <limits.h>
#include <libproc.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <unistd.h>

static int parse_pid(const char *text, pid_t *pid) {
  char *end = NULL;
  long value;

  errno = 0;
  value = strtol(text, &end, 10);
  if (errno != 0 || end == text || *end != '\0' || value <= 0 || value > INT_MAX) {
    return 0;
  }
  *pid = (pid_t)value;
  return 1;
}

static int print_process_identity(pid_t requested_pid) {
  struct proc_bsdinfo info;
  char executable[PROC_PIDPATHINFO_MAXSIZE];
  pid_t process_group;
  int bytes;

  errno = 0;
  bytes = proc_pidinfo(requested_pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info));
  if (bytes != sizeof(info)) {
    if (bytes == 0 || errno == ESRCH) return 3;
    perror("proc_pidinfo");
    return 70;
  }

  errno = 0;
  process_group = getpgid(requested_pid);
  if (process_group == -1) {
    if (errno == ESRCH) return 3;
    perror("getpgid");
    return 70;
  }

  errno = 0;
  bytes = proc_pidpath(requested_pid, executable, sizeof(executable));
  if (bytes <= 0) {
    if (errno == ESRCH) return 3;
    perror("proc_pidpath");
    return 70;
  }

  printf("%d\t%d\t%llu\t%llu\t%s\n", requested_pid, process_group,
         (unsigned long long)info.pbi_start_tvsec,
         (unsigned long long)info.pbi_start_tvusec, executable);
  return 0;
}

static int compare_pids(const void *left, const void *right) {
  const pid_t left_pid = *(const pid_t *)left;
  const pid_t right_pid = *(const pid_t *)right;

  return (left_pid > right_pid) - (left_pid < right_pid);
}

static int print_process_group_identities(pid_t process_group) {
  int bytes;
  int attempts;
  int count;
  int found = 0;
  size_t capacity;
  pid_t *pids;

  errno = 0;
  bytes = proc_listpids(PROC_ALL_PIDS, 0, NULL, 0);
  if (bytes <= 0) {
    if (errno != 0) perror("proc_listpids");
    else fprintf(stderr, "proc_listpids returned no process IDs\n");
    return 70;
  }
  capacity = (size_t)bytes / sizeof(*pids) + 64;
  pids = malloc(capacity * sizeof(*pids));
  if (pids == NULL) {
    perror("malloc");
    return 70;
  }

  for (attempts = 0; attempts < 8; attempts += 1) {
    if (capacity > (size_t)INT_MAX / sizeof(*pids)) {
      fprintf(stderr, "process list exceeds supported size\n");
      free(pids);
      return 70;
    }
    errno = 0;
    bytes = proc_listpids(PROC_ALL_PIDS, 0, pids, (int)(capacity * sizeof(*pids)));
    if (bytes < 0) {
      perror("proc_listpids");
      free(pids);
      return 70;
    }
    if ((size_t)bytes < capacity * sizeof(*pids)) break;

    if (capacity > (size_t)INT_MAX / (2 * sizeof(*pids))) {
      fprintf(stderr, "process list exceeds supported size\n");
      free(pids);
      return 70;
    }
    capacity *= 2;
    {
      pid_t *expanded = realloc(pids, capacity * sizeof(*pids));
      if (expanded == NULL) {
        perror("realloc");
        free(pids);
        return 70;
      }
      pids = expanded;
    }
  }
  if (attempts == 8) {
    fprintf(stderr, "process list changed while inspecting process group\n");
    free(pids);
    return 70;
  }

  count = bytes / (int)sizeof(*pids);
  qsort(pids, (size_t)count, sizeof(*pids), compare_pids);
  for (int index = 0; index < count; index += 1) {
    pid_t pid = pids[index];
    pid_t member_group;
    int status;

    if (pid <= 0) continue;
    errno = 0;
    member_group = getpgid(pid);
    if (member_group == -1) {
      if (errno == ESRCH) continue;
      perror("getpgid");
      free(pids);
      return 70;
    }
    if (member_group != process_group) continue;

    status = print_process_identity(pid);
    if (status == 3) continue;
    if (status != 0) {
      free(pids);
      return status;
    }
    found = 1;
  }

  free(pids);
  return found ? 0 : 3;
}

int main(int argc, char **argv) {
  pid_t pid;

  if (argc == 3 && strcmp(argv[1], "--group") == 0) {
    if (!parse_pid(argv[2], &pid)) {
      fprintf(stderr, "invalid process group: %s\n", argv[2]);
      return 64;
    }
    return print_process_group_identities(pid);
  }
  if (argc != 2) {
    fprintf(stderr, "usage: process-identity <pid> | --group <process-group>\n");
    return 64;
  }
  if (!parse_pid(argv[1], &pid)) {
    fprintf(stderr, "invalid pid: %s\n", argv[1]);
    return 64;
  }
  return print_process_identity(pid);
}
