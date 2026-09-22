#include "orc_support.h"
#include <sodium.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#include <errno.h>
#include <string.h>
#include <readpassphrase.h>
#include <spawn.h>
#include <libproc.h>
#include <fcntl.h>

int orc_spawn_backend(const char *executable, char *const argv[], char *const envp[], const char *cwd, int log_fd, int *pid) {
    posix_spawnattr_t attrs;
    posix_spawn_file_actions_t actions;
    int result = posix_spawnattr_init(&attrs);
    if (result) return result;
    result = posix_spawn_file_actions_init(&actions);
    if (result) { posix_spawnattr_destroy(&attrs); return result; }
    // A separate session survives the app/CLI and its terminal.
    if (!(result = posix_spawnattr_setflags(&attrs, POSIX_SPAWN_SETSID | POSIX_SPAWN_CLOEXEC_DEFAULT)) &&
        !(result = posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0)) &&
        !(result = posix_spawn_file_actions_adddup2(&actions, log_fd, STDOUT_FILENO)) &&
        !(result = posix_spawn_file_actions_adddup2(&actions, log_fd, STDERR_FILENO)) &&
        !(result = posix_spawn_file_actions_addchdir_np(&actions, cwd))) {
        pid_t child;
        result = posix_spawn(&child, executable, &actions, &attrs, argv, envp);
        if (!result) *pid = child;
    }
    posix_spawn_file_actions_destroy(&actions);
    posix_spawnattr_destroy(&attrs);
    return result;
}

uint64_t orc_process_start_time(int pid) {
    struct proc_bsdinfo info;
    if (pid <= 0 || proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info)) return 0;
    return info.pbi_start_tvsec * 1000000ULL + info.pbi_start_tvusec;
}

int orc_is_orca_process(int pid) {
    char path[PROC_PIDPATHINFO_MAXSIZE];
    if (pid <= 0 || proc_pidpath(pid, path, sizeof(path)) <= 0) return 0;
    const char *name = strrchr(path, '/');
    return name && strcmp(name + 1, "Orca") == 0;
}

char *orc_read_pairing(char *buffer, size_t capacity) {
    // The system reader restores terminal echo before forwarding exit signals.
    int flags = isatty(STDIN_FILENO) ? RPP_REQUIRE_TTY : RPP_STDIN;
    return readpassphrase("", buffer, capacity, RPP_ECHO_OFF | flags);
}

int orc_connect_unix(const char *path, int timeout_seconds) {
    struct sockaddr_un addr = {0};
    if (strlen(path) >= sizeof(addr.sun_path)) { errno = ENAMETOOLONG; return -1; }
    addr.sun_family = AF_UNIX;
    strcpy(addr.sun_path, path);
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return -1;
    int one = 1;
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one));
    struct timeval timeout = {.tv_sec = timeout_seconds};
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        int saved = errno; close(fd); errno = saved; return -1;
    }
    return fd;
}
int orc_crypto_keypair(uint8_t *pk, uint8_t *sk) {
    if (sodium_init() < 0) return -1;
    return crypto_box_keypair(pk, sk);
}
int orc_crypto_shared(uint8_t *shared, const uint8_t *pk, const uint8_t *sk) {
    return crypto_box_beforenm(shared, pk, sk);
}
int orc_crypto_seal(uint8_t *out, const uint8_t *message, size_t length, const uint8_t *key) {
    randombytes_buf(out, crypto_box_NONCEBYTES);
    return crypto_box_easy_afternm(out + crypto_box_NONCEBYTES, message, length, out, key);
}
int orc_crypto_open(uint8_t *out, const uint8_t *bundle, size_t length, const uint8_t *key) {
    if (length < crypto_box_NONCEBYTES + crypto_box_MACBYTES) return -1;
    return crypto_box_open_easy_afternm(out, bundle + crypto_box_NONCEBYTES,
        length - crypto_box_NONCEBYTES, bundle, key);
}
