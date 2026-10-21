// The main executable of Orc Runtime.app: runs the command after "--" as its child, passes on the signals
// it receives, and exits as the child did. macOS attributes privacy permissions such as Local Network to
// the app responsible for a process, so a runtime started under this app, with responsibility disclaimed,
// keeps one identity of its own whichever Orc client started it. Its sessions inherit that identity.
#include <errno.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>

extern char **environ;

static const int forwarded[] = {SIGHUP, SIGINT, SIGQUIT, SIGTERM, SIGUSR1, SIGUSR2};
static volatile pid_t child = 0;

static void forward(int number) {
    if (child > 0) kill(child, number);
}

int main(int argc, char **argv) {
    if (argc < 3 || strcmp(argv[1], "--") != 0) {
        fprintf(stderr, "usage: %s -- COMMAND [ARGUMENT...]\n", argv[0]);
        return 64;
    }
    // Signals wait until the child exists, so none is lost before it can be passed on.
    sigset_t blocked, empty;
    sigemptyset(&blocked);
    sigemptyset(&empty);
    struct sigaction action = {.sa_handler = forward};
    sigemptyset(&action.sa_mask);
    for (size_t i = 0; i < sizeof(forwarded) / sizeof(*forwarded); i++) {
        sigaddset(&blocked, forwarded[i]);
        sigaction(forwarded[i], &action, NULL);
    }
    sigprocmask(SIG_BLOCK, &blocked, NULL);

    posix_spawnattr_t attributes;
    posix_spawnattr_init(&attributes);
    posix_spawnattr_setsigmask(&attributes, &empty);
    posix_spawnattr_setsigdefault(&attributes, &blocked);
    posix_spawnattr_setflags(&attributes, POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF);
    pid_t pid;
    int result = posix_spawn(&pid, argv[2], NULL, &attributes, argv + 2, environ);
    posix_spawnattr_destroy(&attributes);
    if (result != 0) {
        fprintf(stderr, "Orc Runtime: cannot start %s: %s\n", argv[2], strerror(result));
        return 127;
    }
    child = pid;
    sigprocmask(SIG_UNBLOCK, &blocked, NULL);

    int status;
    while (waitpid(pid, &status, 0) < 0) {
        if (errno != EINTR) return 1;
    }
    if (WIFSIGNALED(status)) {
        signal(WTERMSIG(status), SIG_DFL);
        sigprocmask(SIG_SETMASK, &empty, NULL);
        raise(WTERMSIG(status));
    }
    return WIFEXITED(status) ? WEXITSTATUS(status) : 1;
}
