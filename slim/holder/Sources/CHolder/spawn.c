#include "CHolder.h"
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>
#include <util.h>

static void report_and_exit(int fd) {
    int error = errno;
    while (write(fd, &error, sizeof error) < 0 && errno == EINTR) {}
    _exit(127);
}

pid_t holder_spawn(char *const argv[], char *const envp[], const char *cwd,
                   unsigned short cols, unsigned short rows, int *master, int *error) {
    struct winsize size = {.ws_row = rows, .ws_col = cols};
    int parent = -1, child = -1, status_pipe[2];
    if (openpty(&parent, &child, NULL, NULL, &size) != 0) { *error = errno; return -1; }
    if (pipe(status_pipe) != 0) { *error = errno; close(parent); close(child); return -1; }
    fcntl(parent, F_SETFD, FD_CLOEXEC);
    fcntl(status_pipe[0], F_SETFD, FD_CLOEXEC);
    fcntl(status_pipe[1], F_SETFD, FD_CLOEXEC);
    pid_t pid = fork();
    if (pid < 0) {
        *error = errno;
        close(parent); close(child); close(status_pipe[0]); close(status_pipe[1]);
        return -1;
    }
    if (pid == 0) {
        // Only async-signal-safe calls until exec: the holder may have other threads.
        struct sigaction action = {.sa_handler = SIG_DFL};
        sigemptyset(&action.sa_mask);
        for (int signal_number = 1; signal_number < NSIG; signal_number++) sigaction(signal_number, &action, NULL);
        sigset_t none;
        sigemptyset(&none);
        sigprocmask(SIG_SETMASK, &none, NULL);
        if (setsid() < 0 || ioctl(child, TIOCSCTTY, 0) < 0) report_and_exit(status_pipe[1]);
        if (dup2(child, STDIN_FILENO) < 0 || dup2(child, STDOUT_FILENO) < 0 || dup2(child, STDERR_FILENO) < 0)
            report_and_exit(status_pipe[1]);
        if (child > STDERR_FILENO) close(child);
        if (cwd && chdir(cwd) != 0) report_and_exit(status_pipe[1]);
        execve(argv[0], argv, envp);
        report_and_exit(status_pipe[1]);
    }
    close(child);
    close(status_pipe[1]);
    int child_error = 0;
    ssize_t count;
    do { count = read(status_pipe[0], &child_error, sizeof child_error); } while (count < 0 && errno == EINTR);
    close(status_pipe[0]);
    if (count == sizeof child_error) {
        int status;
        while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {}
        close(parent);
        *error = child_error;
        return -1;
    }
    fcntl(parent, F_SETFL, fcntl(parent, F_GETFL) | O_NONBLOCK);
    *master = parent;
    return pid;
}

pid_t holder_foreground_group(int master) { return tcgetpgrp(master); }

int holder_resize(int master, unsigned short cols, unsigned short rows) {
    struct winsize size = {.ws_row = rows, .ws_col = cols};
    return ioctl(master, TIOCSWINSZ, &size);
}

#include <sys/event.h>

int holder_watch(int queue, uintptr_t ident, int16_t filter, uint16_t flags, uint32_t fflags, intptr_t data) {
    struct kevent change;
    EV_SET(&change, ident, filter, flags, fflags, data, NULL);
    return kevent(queue, &change, 1, NULL, 0, NULL);
}

int holder_wait(int queue, struct holder_event *events, int capacity) {
    struct kevent received[64];
    if (capacity > 64) capacity = 64;
    int count = kevent(queue, NULL, 0, received, capacity, NULL);
    for (int index = 0; index < count; index++) {
        events[index].ident = received[index].ident;
        events[index].filter = received[index].filter;
    }
    return count;
}
