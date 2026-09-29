#pragma once
#include <sys/types.h>

// Starts argv[0] (an absolute path) as a session leader whose controlling terminal is a new PTY.
// Returns the child pid and stores the nonblocking, close-on-exec master in *master, or returns -1
// and stores errno (from the parent or from the child's failed chdir/exec) in *error.
pid_t holder_spawn(char *const argv[], char *const envp[], const char *cwd,
                   unsigned short cols, unsigned short rows, int *master, int *error);

// Foreground process group of the PTY, or -1.
pid_t holder_foreground_group(int master);

int holder_resize(int master, unsigned short cols, unsigned short rows);

#include <stdint.h>

struct holder_event {
    uintptr_t ident;
    int16_t filter;
};

// kqueue helpers; Swift cannot name both `struct kevent` and `kevent()` in one scope.
int holder_watch(int queue, uintptr_t ident, int16_t filter, uint16_t flags, uint32_t fflags, intptr_t data);
int holder_wait(int queue, struct holder_event *events, int capacity);
